const express = require('express');
const router = express.Router();
const { serviceClient } = require('../utils/supabaseClients');
const { encryptImapPassword } = require('../utils/imapCrypto');

router.post('/email-connections/:id/set-imap-password', async (req, res) => {
  const id = req.params.id;
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) return res.status(400).json({ error: 'password must be a non-empty string' });

  try {
    const encrypted = encryptImapPassword(password);

    const { data, error } = await serviceClient
      .from('email_connections')
      .update({
        password_encrypted: encrypted,
        provider: 'imap',
        is_verified: true,
        last_message_id: null,
        last_sync_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to update email connection', details: error.message || error });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Encryption failed', details: err.message || String(err) });
  }
});

module.exports = router;

// PUT /email-connections/:id -> update connection fields and invalidate credentials when host/port/username/mailbox change
router.put('/email-connections/:id', async (req, res) => {
  const id = req.params.id;
  const { host, port, username, mailbox } = req.body || {};

  try {
    const { data: existing, error: getErr } = await serviceClient
      .from('email_connections')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (getErr) return res.status(500).json({ error: 'Failed to fetch email connection', details: getErr.message || getErr });
    if (!existing) return res.status(404).json({ error: 'Email connection not found' });

    const updates = {};
    let changed = false;

    if (typeof host !== 'undefined' && host !== existing.host) { updates.host = host; changed = true; }
    if (typeof port !== 'undefined') {
      const newPort = Number(port);
      const oldPort = existing.port == null ? null : Number(existing.port);
      if (Number.isFinite(newPort) && newPort !== oldPort) { updates.port = newPort; changed = true; }
    }
    if (typeof username !== 'undefined' && username !== existing.username) { updates.username = username; changed = true; }
    if (typeof mailbox !== 'undefined' && mailbox !== existing.mailbox) { updates.mailbox = mailbox; changed = true; }

    if (changed) {
      updates.is_verified = false;
      updates.password_encrypted = null;
      updates.last_message_id = null;
      updates.last_sync_at = null;
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ ok: true, updated: existing });
    }

    updates.updated_at = new Date().toISOString();

    const { data: updated, error: updateErr } = await serviceClient
      .from('email_connections')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (updateErr) return res.status(500).json({ error: 'Failed to update email connection', details: updateErr.message || updateErr });

    return res.json({ ok: true, updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update email connection', details: err.message || String(err) });
  }
});
