const express = require('express');

const router = express.Router();
const { makeUserClient, serviceClient } = require('../utils/supabaseClients.cjs');

function toErrorDetails(err) {
  if (!err) return 'erro desconhecido';
  if (typeof err === 'string') return err;

  const parts = [err.message];
  if (err.responseText) parts.push(err.responseText);
  if (err.responseStatus) parts.push(`status=${err.responseStatus}`);
  if (err.serverResponseCode) parts.push(`code=${err.serverResponseCode}`);
  if (err.command) parts.push(`command=${err.command}`);

  return parts.filter(Boolean).join(' | ');
}

router.get('/api/extract-quotes', (req, res) => {
  res.status(405).json({
    error: 'METHOD_NOT_ALLOWED',
    message: 'Use POST /api/extract-quotes com Authorization Bearer e { companyId } no body.',
  });
});

router.post('/api/extract-quotes', async (req, res) => {
  const authHeader = req.header('authorization') || req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  const { companyId } = req.body || {};

  if (!companyId) {
    return res.status(400).json({ error: 'companyId is required in body' });
  }

  let userClient;
  try {
    userClient = makeUserClient(token);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user supabase client' });
  }

  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const userId = authData.user.id;

  const { data: memberships, error: memErr } = await userClient
    .from('memberships')
    .select('id,role,is_active')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('is_active', true);

  if (memErr) {
    return res.status(500).json({ error: 'Failed to validate membership' });
  }
  if (!memberships || memberships.length === 0) {
    return res.status(403).json({ error: 'Not authorized (no active membership)' });
  }

  const role = memberships[0].role;
  if (!(role === 'admin' || role === 'comercial')) {
    return res.status(403).json({ error: 'Not authorized (insufficient role)' });
  }

  const { data: jobData, error: jobErr } = await serviceClient
    .from('extraction_jobs')
    .insert({
      company_id: companyId,
      status: 'running',
      triggered_by: userId,
    })
    .select('*')
    .single();

  if (jobErr || !jobData) {
    return res.status(500).json({ error: 'Failed to create extraction job' });
  }

  const jobId = jobData.id;

  try {
    const { runExtractionJob } = require('../jobs/extractQuotes.job.cjs');
    const result = await runExtractionJob(jobId, companyId);

    if (result?.success === false && result.reason === 'invalid_encryption_key') {
      await serviceClient
        .from('extraction_jobs')
        .update({
          status: 'error',
          finished_at: new Date().toISOString(),
          error_message: result.message || 'Invalid encryption key for IMAP passwords',
        })
        .eq('id', jobId);

      return res.status(409).json({ error: 'ENCRYPTION_KEY_MISMATCH', message: result.message });
    }

    if (result?.success === false && result.reason === 'missing_password') {
      await serviceClient
        .from('extraction_jobs')
        .update({
          status: 'error',
          finished_at: new Date().toISOString(),
          error_message: result.message || 'Missing IMAP password for email connection',
        })
        .eq('id', jobId);

      return res.status(409).json({
        error: 'MISSING_IMAP_PASSWORD',
        message: 'Senha IMAP ausente. Atualize a conexão de e-mail com a senha IMAP atual.',
      });
    }

    if (result?.success === false) {
      throw new Error(result.message || 'Extraction job failed');
    }

    await serviceClient
      .from('extraction_jobs')
      .update({
        status: 'done',
        finished_at: new Date().toISOString(),
        quotes_found: 0,
        quotes_inserted: 0,
      })
      .eq('id', jobId);

    return res.status(200).json({ jobId, quotesInserted: 0 });
  } catch (err) {
    const details = toErrorDetails(err);

    try {
      await serviceClient
        .from('extraction_jobs')
        .update({
          status: 'error',
          finished_at: new Date().toISOString(),
          error_message: details,
        })
        .eq('id', jobId);
    } catch (_) {}

    return res.status(500).json({ error: 'Extraction failed', details });
  }
});

module.exports = router;