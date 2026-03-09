const { ImapFlow } = require('imapflow');

function decorateImapError(err, action) {
  const parts = [action, err && err.message];

  if (err && err.responseText) parts.push(err.responseText);
  if (err && err.responseStatus) parts.push(`status=${err.responseStatus}`);
  if (err && err.serverResponseCode) parts.push(`code=${err.serverResponseCode}`);
  if (err && err.command) parts.push(`command=${err.command}`);

  const message = parts.filter(Boolean).join(' | ');
  if (!message) return err;

  if (err instanceof Error) {
    err.message = message;
    return err;
  }

  return new Error(message);
}

async function connectImap(connection) {
  const { host, port, username, password } = connection || {};
  const secure = Number(port) === 993;

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: {
      user: username,
      pass: password,
    },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    throw decorateImapError(err, `Falha ao conectar no IMAP ${host}:${port} secure=${secure}`);
  }

  return client;
}

module.exports = {
  connectImap,
  decorateImapError,
};