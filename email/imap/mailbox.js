async function resolveMailbox(client, preferred) {
  const attempts = [];

  if (preferred) {
    attempts.push(preferred);
    if (preferred.includes('/')) {
      attempts.push(preferred.replace(/\//g, '.'));
    }
  }

  attempts.push('INBOX');
  attempts.push('INBOX.Novas');

  let lastError = null;
  for (const name of attempts) {
    try {
      await client.mailboxOpen(name);
      return name;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error('Não foi possível abrir nenhuma mailbox: ' + (lastError && lastError.message ? lastError.message : 'erro desconhecido'));
}

module.exports = {
  resolveMailbox
};
