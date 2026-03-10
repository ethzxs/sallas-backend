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

<<<<<<< HEAD
  try {
    console.log('[extract-debug] request received', {
      companyId: companyId || null,
      hasAuthorization: !!authHeader,
    });
  } catch (_) {}

=======
>>>>>>> b7e1dbe14d2c9eaca76123c0e97c52aada0d2cd8
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

<<<<<<< HEAD
  try {
    console.log('[extract-debug] authenticated user', { companyId, userId });
  } catch (_) {}

=======
>>>>>>> b7e1dbe14d2c9eaca76123c0e97c52aada0d2cd8
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
<<<<<<< HEAD
  try {
    console.log('[extract-debug] membership validated', {
      companyId,
      userId,
      role,
      membershipCount: memberships.length,
    });
  } catch (_) {}
=======
>>>>>>> b7e1dbe14d2c9eaca76123c0e97c52aada0d2cd8
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
<<<<<<< HEAD
    console.log('[extract-debug] job created', { companyId, userId, jobId });
  } catch (_) {}

  try {
    const { data: companyRow } = await serviceClient
      .from('companies')
      .select('provider')
      .eq('id', companyId)
      .maybeSingle();

    const selectedProvider = String(companyRow?.provider || 'imap').trim().toLowerCase();
    if (selectedProvider === 'outlook') {
      await serviceClient
        .from('extraction_jobs')
        .update({
          status: 'error',
          finished_at: new Date().toISOString(),
          error_message: 'Provider outlook selecionado. Este botão executa apenas extração IMAP.',
        })
        .eq('id', jobId);

      return res.status(409).json({
        error: 'OUTLOOK_PROVIDER_SELECTED',
        message: 'Provider Outlook selecionado. Este botão executa apenas extração IMAP.',
      });
    }
  } catch (_) {}

  try {
    const { runExtractionJob } = require('../jobs/extractQuotes.job.cjs');
    const result = await runExtractionJob(jobId, companyId);

    try {
      console.log('[extract-debug] job result', { companyId, jobId, result });
    } catch (_) {}

=======
    const { runExtractionJob } = require('../jobs/extractQuotes.job.cjs');
    const result = await runExtractionJob(jobId, companyId);

>>>>>>> b7e1dbe14d2c9eaca76123c0e97c52aada0d2cd8
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
<<<<<<< HEAD
        quotes_found: Number(result?.candidates || 0),
        quotes_inserted: Number(result?.inserted || 0),
      })
      .eq('id', jobId);

    return res.status(200).json({
      jobId,
      quotesInserted: Number(result?.inserted || 0),
      candidates: Number(result?.candidates || 0),
      duplicates: Number(result?.duplicates || 0),
      ignored: Number(result?.ignored || 0),
      mailbox: result?.mailbox || null,
      scanned: Number(result?.scanned || 0),
      totalMessages: Number(result?.totalMessages || 0),
      debug: Array.isArray(result?.debug) ? result.debug : [],
    });
=======
        quotes_found: 0,
        quotes_inserted: 0,
      })
      .eq('id', jobId);

    return res.status(200).json({ jobId, quotesInserted: 0 });
>>>>>>> b7e1dbe14d2c9eaca76123c0e97c52aada0d2cd8
  } catch (err) {
    const details = toErrorDetails(err);

    try {
<<<<<<< HEAD
      console.error('[extract-debug] route failure', { companyId, jobId, details });
    } catch (_) {}

    try {
=======
>>>>>>> b7e1dbe14d2c9eaca76123c0e97c52aada0d2cd8
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