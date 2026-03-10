const express = require('express');
const router = express.Router();
const { makeUserClient, serviceClient } = require('../utils/supabaseClients');

// POST /api/extract-quotes
router.post('/api/extract-quotes', async (req, res) => {
  const authHeader = req.header('authorization') || req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization header' });
  const token = authHeader.split(' ')[1];

  const { companyId } = req.body || {};
  if (!companyId) return res.status(400).json({ error: 'companyId is required in body' });

  let userClient;
  try {
    userClient = makeUserClient(token);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user supabase client' });
  }

  // Get user info from token
  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData || !authData.user) return res.status(401).json({ error: 'Invalid token' });
  const userId = authData.user.id;

  // Validate membership
  const { data: memberships, error: memErr } = await userClient
    .from('memberships')
    .select('id,role,is_active')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('is_active', true);

  if (memErr) return res.status(500).json({ error: 'Failed to validate membership' });
  if (!memberships || memberships.length === 0) return res.status(403).json({ error: 'Not authorized (no active membership)' });

  const role = memberships[0].role;
  if (!(role === 'admin' || role === 'comercial')) return res.status(403).json({ error: 'Not authorized (insufficient role)' });

  // Authorized: create extraction job using service client
  const jobRecord = {
    company_id: companyId,
    status: 'running',
    triggered_by: userId,
  };

  const { data: jobData, error: jobErr } = await serviceClient.from('extraction_jobs').insert(jobRecord).select('*').single();
  if (jobErr || !jobData) return res.status(500).json({ error: 'Failed to create extraction job' });
  const jobId = jobData.id;

  try {
    // Delegate actual extraction work to the job runner
    const { runExtractionJob } = require('../jobs/extractQuotes.job');
    const result = await runExtractionJob(jobId, companyId);

    // If the job reports an invalid encryption key, mark job error and return 409
    if (result && result.success === false && result.reason === 'invalid_encryption_key') {
      const updateErr = {
        status: 'error',
        finished_at: new Date().toISOString(),
        error_message: result.message || 'Invalid encryption key for IMAP passwords',
      };
      try {
        await serviceClient.from('extraction_jobs').update(updateErr).eq('id', jobId);
      } catch (updateJobErr) {
        // ignore update error
      }
      return res.status(409).json({ error: 'ENCRYPTION_KEY_MISMATCH', message: result.message });
    }

    // If the job reports missing password, mark job error and return 409 with actionable message
    if (result && result.success === false && result.reason === 'missing_password') {
      const updateErr = {
        status: 'error',
        finished_at: new Date().toISOString(),
        error_message: result.message || 'Missing IMAP password for email connection',
      };
      try {
        await serviceClient.from('extraction_jobs').update(updateErr).eq('id', jobId);
      } catch (updateJobErr) {
        // ignore update error
      }
      return res.status(409).json({ error: 'MISSING_IMAP_PASSWORD', message: 'Senha IMAP ausente — por favor atualize a conexão de e-mail com a senha IMAP atual.' });
    }

    // If the job returned a generic failure object, throw to be handled below
    if (result && result.success === false) {
      throw new Error(result.message || 'Extraction job failed');
    }

    // Mark job as done (details like counts may be set by the runner later)
    const update = {
      status: 'done',
      finished_at: new Date().toISOString(),
      quotes_found: 0,
      quotes_inserted: 0,
    };
    await serviceClient.from('extraction_jobs').update(update).eq('id', jobId);

    return res.status(200).json({ jobId, quotesInserted: 0 });
  } catch (err) {
    // On any failure, mark job as error
    const updateErr = {
      status: 'error',
      finished_at: new Date().toISOString(),
      error_message: err.message || String(err),
    };
    try {
      await serviceClient.from('extraction_jobs').update(updateErr).eq('id', jobId);
    } catch (updateJobErr) {
      // don't throw further; we will return 500 below
    }
    return res.status(500).json({ error: 'Extraction failed', details: err.message || err });
  }
});

module.exports = router;
