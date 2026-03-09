const express = require('express');
const router = express.Router();
const { makeUserClient } = require('../supabaseClients');

// GET /api/finance-race?companyId=...
// Mounted under `/api` in the main app, so the route here is `/finance-race`.
router.get('/finance-race', async (req, res) => {
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

  // read optional membershipId provided by frontend and validate it; fallback to latest membership for user/company
  const membershipIdParam = req.query.membershipId ? String(req.query.membershipId) : null;

  let myMembershipId = null;

  if (membershipIdParam) {
    const { data: mem, error: memErr } = await userClient
      .from('memberships')
      .select('id')
      .eq('id', membershipIdParam)
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle();

    if (memErr || !mem?.id) {
      return res.status(403).json({ error: 'Invalid membershipId for this user/company' });
    }
    myMembershipId = mem.id;
  } else {
    const { data: mem, error: memErr } = await userClient
      .from('memberships')
      .select('id,created_at')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (memErr || !mem?.id) {
      return res.status(403).json({ error: 'Membership not found for this company' });
    }
    myMembershipId = mem.id;
  }

  // membership check (qualquer role ativa pode visualizar)
  const { data: memList, error: memErr } = await userClient
    .from('memberships')
    .select('id,role,is_active,created_at')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (memErr) return res.status(500).json({ error: 'Failed to validate membership' });
  if (!Array.isArray(memList) || memList.length === 0) {
    return res.status(403).json({ error: 'Not authorized (no active membership)' });
  }

  // opcional: preferir admin aqui também
  const mem = memList.find(m => String(m.role || '').toLowerCase() === 'admin') || memList[0];

  // company config
  const { data: company, error: compErr } = await userClient
    .from('companies')
    .select('id,meta_por_fretes,meta_fretes,meta_lucro,meta_mensal_fretes,meta_mensal_lucro,comissao_pct')
    .eq('id', companyId)
    .maybeSingle();

  console.log('[FINANCEIRO][COMPANY_CONFIG] companyId=', companyId);
  console.log('[FINANCEIRO][COMPANY_CONFIG] compErr=', compErr);
  console.log('[FINANCEIRO][COMPANY_CONFIG] company=', company);

  if (compErr) return res.status(500).json({ error: 'Failed to load company config' });
  if (!company) return res.status(404).json({ error: 'Company not found' });

  console.log('[FINANCEIRO] company=', companyId, 'meta_por_fretes=', company.meta_por_fretes);

  // mês do calendário de São Paulo, mas em ISO UTC para filtrar no banco
  const now = new Date();
  const y = Number(new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', year:'numeric' }).format(now));
  const m = Number(new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo', month:'2-digit' }).format(now));

  const monthStartIso = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0)).toISOString();   // 00:00 SP == 03:00Z
  const monthEndIso   = new Date(Date.UTC(y, m,     1, 3, 0, 0)).toISOString();
  console.log('[FINANCEIRO] month_start=', monthStartIso);

  const parseMoney = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v !== 'string') return 0;

    // remove moeda/espaços, mantém dígitos e separadores
    let s = v.trim().replace(/[^\d,.-]/g, '');

    // se vier "10,50" vira "10.50"
    // se vier "1.234,56" vira "1234.56"
    if (s.includes(',') && s.includes('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (s.includes(',') && !s.includes('.')) {
      s = s.replace(',', '.');
    }

    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };

  const round2 = (n) => {
    const x = Number(n);
    return Number.isFinite(x) ? (Math.round(x * 100) / 100) : 0;
  };

  const calcComissao = (q) => {
    const comissaoDb = Number(q?.comissao_value || 0);
    if (Number.isFinite(comissaoDb) && comissaoDb > 0) return round2(comissaoDb);

    const quotePct = Number(q?.comissao_pct || 0);
    const companyPct = Number(company?.comissao_pct || 0);
    const pct = quotePct > 0 ? quotePct : companyPct;
    if (!(pct > 0)) return 0;

    // base preferida: freight_value (no seu caso, a comissão é sobre o valor do frete)
    let base = Number(q?.freight_value || 0);

    // fallback se você realmente quiser base por lucro em alguns casos
    if (!Number.isFinite(base) || base <= 0) {
      base = Number(q?.lucro_bruto ?? q?.lucro_value ?? 0);
    }

    if (!Number.isFinite(base) || base <= 0) return 0;
    return round2(base * (pct / 100));
  };

  // traz só o necessário e agrega em JS (mais simples / sem RPC por enquanto)
  // Aprovados no mês (usado na corrida e no numerador do Card 2)
  const { data: approvedQuotes, error: approvedErr } = await userClient
    .from('quotes')
    .select('id,responsible_member_id,approved_at,lucro_value,comissao_value')
    .eq('company_id', companyId)
    .eq('is_approved', true)
    .not('responsible_member_id', 'is', null)
    .not('approved_at', 'is', null)
    .gte('approved_at', monthStartIso)
    .lt('approved_at', monthEndIso);

  if (approvedErr) {
    console.log('[FINANCEIRO][QUOTES_APPROVED] approvedErr=', approvedErr);
    return res.status(500).json({ error: 'Failed to load approved quotes', details: approvedErr });
  }

  // Total sob responsabilidade no mês (denominador do Card 2)
  // Definição prática: cotações com created_at no mês OU que foram aprovadas no mês.
  // Dedupe por quote id para não contar duas vezes.
  const { data: createdQuotes, error: createdErr } = await userClient
    .from('quotes')
    .select('id,responsible_member_id')
    .eq('company_id', companyId)
    .not('responsible_member_id', 'is', null)
    .gte('created_at', monthStartIso)
    .lt('created_at', monthEndIso);

  if (createdErr) {
    console.log('[FINANCEIRO][QUOTES_CREATED] createdErr=', createdErr);
    return res.status(500).json({ error: 'Failed to load created quotes', details: createdErr });
  }

  // (remoção: commissionQuotes não é mais necessário — usamos approvedQuotes para a base de comissões)

  const totalQuoteToUser = new Map();
  for (const q of (createdQuotes || [])) {
    if (!q?.id || !q?.responsible_member_id) continue;
    totalQuoteToUser.set(q.id, q.responsible_member_id);
  }
  for (const q of (approvedQuotes || [])) {
    if (!q?.id || !q?.responsible_member_id) continue;
    totalQuoteToUser.set(q.id, q.responsible_member_id);
  }

  const totalByUser = new Map();
  for (const memberId of totalQuoteToUser.values()) {
    totalByUser.set(memberId, (totalByUser.get(memberId) || 0) + 1);
  }

  const approvedByUser = new Map();
  for (const q of (approvedQuotes || [])) {
    const k = q.responsible_member_id; // memberships.id (responsável atual)
    if (!k) continue;
    const cur = approvedByUser.get(k) || { user_id: k, fretes: 0, lucro: 0, comissao: 0 };
    cur.fretes += 1;
    cur.lucro += Number(q.lucro_value || 0);
    approvedByUser.set(k, cur);
  }

  const comissaoByUser = new Map();
  console.log('[FINANCE_RACE][approved sample]', (approvedQuotes || []).slice(0, 3));
  for (const q of (approvedQuotes || [])) {
    const k = q.responsible_member_id;
    if (!k) continue;

    const v = comissaoByUser.get(k) || 0;
    const add = parseMoney(q?.comissao_value); // valor direto vindo do banco (parse seguro)
    comissaoByUser.set(k, round2(v + add));
  }

  const allUserIds = new Set([ ...Array.from(totalByUser.keys()), ...Array.from(approvedByUser.keys()), ...Array.from(comissaoByUser.keys()) ]);
  const items = Array.from(allUserIds).map((membershipId) => {
    const approved = approvedByUser.get(membershipId) || { user_id: membershipId, fretes: 0, lucro: 0, comissao: 0 };
    console.log('[AGGREGATE CHECK]', {
      membershipId,
      comissaoFromMap: comissaoByUser.get(membershipId)
    });
    return {
      user_id: membershipId,
      fretes: approved.fretes,
      lucro: approved.lucro,
      comissao: round2(comissaoByUser.get(membershipId) || 0),
      total_responsible: totalByUser.get(membershipId) || 0,
    };
  });

  // meta e percentual por usuário (fallback para colunas legacy/meta_mensal_*)
  const effectiveMetaFretes = (company.meta_mensal_fretes != null ? company.meta_mensal_fretes : company.meta_fretes);
  const effectiveMetaLucro = (company.meta_mensal_lucro != null ? company.meta_mensal_lucro : company.meta_lucro);
  const meta = company.meta_por_fretes ? Number(effectiveMetaFretes || 0) : Number(effectiveMetaLucro || 0);

  const out = items.map(x => {
    const corrida = company.meta_por_fretes ? x.fretes : x.lucro;
    const pct = meta > 0 ? (corrida / meta) * 100 : 0;
    return { ...x, corrida, value: corrida, meta, pct };
  });

  // ordenação determinística: primeiro por corrida desc, depois por name asc
  out.sort((a, b) => (Number(b.corrida || 0) - Number(a.corrida || 0)) || String(a.name || '').localeCompare(String(b.name || '')));

  const __debug_version = 'finance-race-DEBUG-2026-03-02-A';

  const __debug_period = { monthStartIso, monthEndIso, companyId, userId, myMembershipId };

  const __debug_approved_sample = (approvedQuotes || []).slice(0, 10).map(q => ({
    id: q.id,
    responsible_member_id: q.responsible_member_id,
    approved_at: q.approved_at,
    comissao_value: q.comissao_value,
    lucro_value: q.lucro_value,
  }));

  return res.json({
    __debug_version,
    __debug_period,
    __debug_approved_sample,
    company: {
      id: company.id,
      meta_por_fretes: company.meta_por_fretes,
      meta_fretes: (effectiveMetaFretes != null ? effectiveMetaFretes : company.meta_fretes),
      meta_lucro: (effectiveMetaLucro != null ? effectiveMetaLucro : company.meta_lucro),
      meta_mensal_fretes: company.meta_mensal_fretes,
      meta_mensal_lucro: company.meta_mensal_lucro,
      comissao_pct: company.comissao_pct
    },
    month_start: monthStartIso,
    period: { start: monthStartIso, end: monthEndIso },
    items: out
  });
});

module.exports = router;
