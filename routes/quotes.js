const express = require('express');
const router = express.Router();
const { makeUserClient, serviceClient } = require('../utils/supabaseClients');

// PATCH /api/quotes/:id
router.patch('/api/quotes/:id', async (req, res) => {
  const authHeader = req.header('authorization') || req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.split(' ')[1];

  let userClient;
  try {
    userClient = makeUserClient(token);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user supabase client' });
  }

  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData?.user) return res.status(401).json({ error: 'Invalid token' });

  const userId = authData.user.id;
  const quoteId = req.params.id;

  // 1) Load quote company_id
  const { data: quote, error: qErr } = await userClient
    .from('quotes')
    .select('id,company_id')
    .eq('id', quoteId)
    .maybeSingle();

  if (qErr) return res.status(500).json({ error: 'Failed to load quote' });
  if (!quote) return res.status(404).json({ error: 'Quote not found' });

  const companyId = quote.company_id;

  // 2) Validate membership
  const { data: memberships, error: memErr } = await userClient
    .from('memberships')
    .select('role,is_active')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('is_active', true);

  if (memErr) return res.status(500).json({ error: 'Failed to validate membership' });
  if (!memberships || memberships.length === 0) return res.status(403).json({ error: 'Not authorized (no active membership)' });

  const role = memberships[0].role;

  // 3) Build payload (server is source of truth for approved_at/approved_by)
  const body = req.body || {};
  const approving = body.is_approved === true;

  if (approving && !['admin', 'comercial'].includes(role)) {
    return res.status(403).json({ error: 'role not allowed to approve quote' });
  }

  console.log('[APPROVAL] quote=', quoteId, 'approved=', approving, 'role=', role);

  const update = {
    is_approved: approving,

    approved_at: approving ? new Date().toISOString() : null,
    approved_by: approving ? userId : null,

    cte_value: body.cte_value ?? null,
    tax_value: body.tax_value ?? null,
    lucro_value: body.lucro_value ?? null,

    coleta_paga: body.coleta_paga === true,
    coleta_valor: body.coleta_valor ?? null,

    entrega_paga: body.entrega_paga === true,
    entrega_valor: body.entrega_valor ?? null,

    operacional_adicionais_obs: body.operacional_adicionais_obs ?? null,
    operacional_adicionais_valor: body.operacional_adicionais_valor ?? null,
  };

  // 4) Update using service client (we already enforced auth/role above)
  const { data: updated, error: upErr } = await serviceClient
    .from('quotes')
    .update(update)
    .eq('id', quoteId)
    .select('*')
    .maybeSingle();

  if (upErr) return res.status(500).json({ error: 'Failed to update quote', details: upErr.message });
  return res.json({ ok: true, quote: updated });
});

module.exports = router;
