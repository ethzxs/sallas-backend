const { decorateImapError } = require('./client.cjs');

async function resolveMailbox(client, preferred) {
  const attempts = [];
  const seen = new Set();
  const normalizedPreferred = String(preferred || '').trim().toLowerCase();
  const preferGenericInbox = normalizedPreferred === 'inbox';

  function pushAttempt(name) {
    const value = String(name || '').trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(value);
  }

  pushAttempt('INBOX.Cotações.Novas');
  pushAttempt('INBOX/Cotações/Novas');
  pushAttempt('INBOX.Novas');
  pushAttempt('INBOX/Novas');

  if (preferred && !preferGenericInbox) {
    pushAttempt(preferred);
    if (preferred.includes('/')) pushAttempt(preferred.replace(/\//g, '.'));
    if (preferred.includes('.')) pushAttempt(preferred.replace(/\./g, '/'));
  }

  pushAttempt('INBOX');

  let lastError = null;
  for (const name of attempts) {
    try {
      await client.mailboxOpen(name);
      return name;
    } catch (err) {
      lastError = decorateImapError(err, `Falha ao abrir mailbox ${name}`);
    }
  }

  throw new Error('Nao foi possivel abrir nenhuma mailbox: ' + (lastError?.message || 'erro desconhecido'));
}

module.exports = {
  resolveMailbox,
};