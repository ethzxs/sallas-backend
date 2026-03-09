const express = require('express');
const { supabaseAdmin } = require('../services/supabaseAdmin');

const router = express.Router();

async function getCallerContext(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { error: { status: 401, body: { ok: false, message: 'Missing token (Authorization Bearer)' } } };
  }

  const token = match[1];
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return {
      error: {
        status: 401,
        body: {
          ok: false,
          message: 'Invalid session',
          debug: { status: r.status, body: text }
        }
      }
    };
  }

  const authUser = await r.json().catch(() => null);
  const callerId = (authUser && (authUser.id || (authUser.user && authUser.user.id))) || null;
  if (!callerId) {
    return { error: { status: 401, body: { ok: false, message: 'Invalid session (no user id returned)' } } };
  }

  let isHost = false;
  try {
    const { data: callerProfile, error: cpErr } = await supabaseAdmin
      .from('profiles')
      .select('global_role')
      .eq('id', callerId)
      .maybeSingle();

    if (!cpErr && callerProfile && (callerProfile.global_role === 'host' || callerProfile.global_role === 'superadmin')) {
      isHost = true;
    }
  } catch (e) {}

  return { token, callerId, isHost };
}

async function ensureCompanyAdminAccess({ callerId, companyId, isHost }) {
  if (isHost) return null;

  try {
    const { data: callerMembership, error: cmErr } = await supabaseAdmin
      .from('memberships')
      .select('is_active, role')
      .eq('user_id', callerId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (cmErr) {
      console.error && console.error('[adminEmployees] membership lookup failed', cmErr);
      return { status: 500, body: { ok: false, message: 'membership lookup failed', debug: { cmErr } } };
    }
    if (!callerMembership || callerMembership.is_active !== true) {
      return { status: 403, body: { ok: false, message: 'Membership inactive for this company' } };
    }
    if (String(callerMembership.role) !== 'admin') {
      return { status: 403, body: { ok: false, message: 'Requires admin role for this company' } };
    }
  } catch (e) {
    console.error && console.error('[adminEmployees] membership check error', e);
    return { status: 500, body: { ok: false, message: 'server error' } };
  }

  return null;
}

router.get('/api/admin/companies/:companyId/employees', async (req, res) => {
  try {
    const context = await getCallerContext(req);
    if (context.error) {
      return res.status(context.error.status).json(context.error.body);
    }

    const companyId = String(req.params.companyId || '').trim();
    if (!companyId) {
      return res.status(400).json({ ok: false, message: 'Missing company id' });
    }

    const accessError = await ensureCompanyAdminAccess({
      callerId: context.callerId,
      companyId,
      isHost: context.isHost
    });
    if (accessError) {
      return res.status(accessError.status).json(accessError.body);
    }

    const { data: memberships, error: mErr } = await supabaseAdmin
      .from('memberships')
      .select('user_id, role, is_active, avatar_url, avatar_path')
      .eq('company_id', companyId)
      .order('created_at', { ascending: true });

    if (mErr) {
      return res.status(500).json({ ok: false, message: 'Membership lookup failed', debug: { mErr } });
    }

    const userIds = Array.isArray(memberships)
      ? memberships.map((item) => item && item.user_id).filter(Boolean)
      : [];

    let profilesById = new Map();
    if (userIds.length) {
      const { data: profiles, error: pErr } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, username, email, whatsapp')
        .in('id', userIds);

      if (pErr) {
        return res.status(500).json({ ok: false, message: 'Profile lookup failed', debug: { pErr } });
      }

      profilesById = new Map((profiles || []).map((profile) => [String(profile.id), profile]));
    }

    const employees = (memberships || []).map((membership) => {
      const profile = profilesById.get(String(membership.user_id)) || {};
      const displayName = [profile.full_name, profile.username, profile.email]
        .map((value) => String(value || '').trim())
        .find(Boolean) || '';

      return {
        id: membership.user_id,
        nome: displayName,
        whatsapp: profile.whatsapp || '',
        func: membership.role || '',
        is_active: membership.is_active,
        avatar_url: membership.avatar_url || null,
        avatar_path: membership.avatar_path || null,
        email: profile.email || '',
        username: profile.username || '',
        full_name: profile.full_name || ''
      };
    });

    return res.json({ ok: true, employees });
  } catch (e) {
    console.error('adminEmployees list error', e);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// POST /api/admin/employees
router.post('/api/admin/employees', async (req, res) => {
  try {
    const context = await getCallerContext(req);
    if (context.error) {
      return res.status(context.error.status).json(context.error.body);
    }

    // 3) validar payload do formulário
    const { email, password, full_name, whatsapp, company_id, role } = req.body || {};
    if (!email || !password || !full_name || !company_id || !role) {
      return res.status(400).json({ ok: false, message: 'Missing required fields' });
    }

    // 4) verificar permissões: host/superadmin passa; senão exige admin ativo na company
    const accessError = await ensureCompanyAdminAccess({
      callerId: context.callerId,
      companyId: company_id,
      isHost: context.isHost
    });
    if (accessError) {
      return res.status(accessError.status).json(accessError.body);
    }

    // 5) criar usuário (service role)
    const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
      email: String(email).toLowerCase(),
      password,
      email_confirm: true
    });

    if (cErr) {
      const msg = String(cErr.message || cErr);
      if (/already registered|exists/i.test(msg)) {
        return res.status(409).json({ ok: false, message: 'User already exists', debug: { cErr } });
      }
      return res.status(500).json({ ok: false, message: 'Create user failed', debug: { cErr } });
    }

    const uid = created.user.id;

    // O schema salva o nome humano em profiles.full_name; username segue como fallback legível.
    const profile = {
      id: uid,
      full_name,
      username: full_name,
      email: String(email).toLowerCase(),
      whatsapp,
      global_role: 'user' // ou outro valor permitido pelo CHECK
    };
    const { error: pErr } = await supabaseAdmin.from('profiles').upsert(profile, { onConflict: 'id' });
    if (pErr) {
      try { await supabaseAdmin.auth.admin.deleteUser(uid); } catch (_) {}
      return res.status(500).json({ ok: false, message: 'Profile upsert failed, reverted', debug: { pErr } });
    }

    // 6) inserir membership
    const membership = { user_id: uid, company_id, role, is_active: true };
    const { error: mErr } = await supabaseAdmin.from('memberships').insert(membership);
    if (mErr) {
      try { await supabaseAdmin.auth.admin.deleteUser(uid); } catch (_) {}
      try { await supabaseAdmin.from('profiles').delete().eq('id', uid); } catch (_) {}
      return res.status(500).json({ ok: false, message: 'Membership insert failed, reverted', debug: { mErr } });
    }

    return res.json({ ok: true, user_id: uid });
  } catch (e) {
    console.error('adminEmployees error', e);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

module.exports = router;