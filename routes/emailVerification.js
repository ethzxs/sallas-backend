const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const router = express.Router();

const { makeUserClient, serviceClient } = require('../utils/supabaseClients');

function requireBearer(req) {
  const h = req.header('authorization') || req.header('Authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.split(' ')[1];
}

async function assertHost(token) {
  const userClient = makeUserClient(token);
  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData?.user) throw new Error('INVALID_TOKEN');
  const userId = authData.user.id;

  const { data: profile, error: profErr } = await userClient
    .from('profiles')
    .select('global_role')
    .eq('id', userId)
    .single();

  if (profErr || !profile) throw new Error('PROFILE_NOT_FOUND');
  if (profile.global_role !== 'host') throw new Error('NOT_HOST');
  return { userId };
}

// criar transporter SMTP usando variaveis de ambiente
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: String(process.env.SMTP_SECURE || 'false') === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
});

async function sendSMTPEmail({ to, subject, html }) {
  if (!process.env.SMTP_FROM) throw new Error('SMTP_FROM_MISSING');
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html
  });
  return info;
}

// POST /api/email-verification/request
// body: { companyId, email }
router.post('/api/email-verification/request', async (req, res) => {
  try {
    const token = requireBearer(req);
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    await assertHost(token);

    const { companyId, email } = req.body || {};
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    if (!email) return res.status(400).json({ error: 'email is required' });

    const verificationToken = crypto.randomBytes(24).toString('hex');

    // upsert por (company_id, email) usando o unique index que você acabou de criar
    const payload = {
      company_id: companyId,
      email,
      provider: 'outlook',
      is_verified: false,
      verification_token: verificationToken,
      verified_at: null
    };

    const { data, error } = await serviceClient
      .from('email_connections')
      .upsert(payload, { onConflict: 'company_id,email' })
      .select('id,company_id,email,is_verified')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to upsert email_connections', details: error.message });

    const baseUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;
    const link = `${baseUrl}/api/email-verification/verify?token=${verificationToken}`;

    await sendSMTPEmail({
      to: email,
      subject: 'Sallas — Verificação de e-mail',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.4">
          <p>Para validar este e-mail e habilitar a extração de cotações, clique no link abaixo:</p>
          <p><a href="${link}">${link}</a></p>
          <p>Se você não solicitou isso, ignore esta mensagem.</p>
        </div>
      `
    });

    return res.status(200).json({ ok: true, emailConnection: data });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === 'NOT_HOST') return res.status(403).json({ error: 'Not authorized' });
    if (msg === 'INVALID_TOKEN') return res.status(401).json({ error: 'Invalid token' });
    return res.status(500).json({ error: 'Request failed', details: msg });
  }
});

// GET /api/email-verification/verify?token=...
router.get('/api/email-verification/verify', async (req, res) => {
  try {
    const token = req.query?.token;
    if (!token) return res.status(400).send('Missing token');

    const { data: row, error: findErr } = await serviceClient
      .from('email_connections')
      .select('id,is_verified')
      .eq('verification_token', token)
      .single();

    if (findErr || !row) return res.status(404).send('Invalid token');

    if (!row.is_verified) {
      const { error: updErr } = await serviceClient
        .from('email_connections')
        .update({
          is_verified: true,
          verified_at: new Date().toISOString(),
          verification_token: null
        })
        .eq('id', row.id);

      if (updErr) return res.status(500).send('Failed to verify');
    }

    return res
      .status(200)
      .send('E-mail verificado com sucesso. Você já pode conectar e extrair cotações.');
  } catch (e) {
    return res.status(500).send('Verification failed');
  }
});

module.exports = router;
