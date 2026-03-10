const express = require('express');
const router = express.Router();
const { makeUserClient } = require('../utils/supabaseClients');

// GET /api/company-config?companyId=...
router.get('/api/company-config', async (req, res) => {
  const authHeader = req.header('authorization') || req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.split(' ')[1];

  const companyId = req.query.companyId;
  if (!companyId) return res.status(400).json({ error: 'companyId is required' });

  let userClient;
  try {
    userClient = makeUserClient(token);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user supabase client' });
  }

  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData?.user) return res.status(401).json({ error: 'Invalid token' });
  const userId = authData.user.id;

  // membership check (active membership required)
  const { data: mem, error: memErr } = await userClient
    .from('memberships')
    .select('id,is_active')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle();

  if (memErr) return res.status(500).json({ error: 'Failed to validate membership' });
  if (!mem) return res.status(403).json({ error: 'Not authorized (no active membership)' });

  const { data: company, error: compErr } = await userClient
    .from('companies')
    .select('id,aliquota')
    .eq('id', companyId)
    .maybeSingle();

  if (compErr) return res.status(500).json({ error: 'Failed to load company config' });
  if (!company) return res.status(404).json({ error: 'Company not found' });

  return res.json({ company });
});

module.exports = router;
