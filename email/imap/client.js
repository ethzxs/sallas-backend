const { ImapFlow } = require('imapflow');

async function connectImap(connection) {
  const { host, port, username, password, mailbox } = connection || {};

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: {
      user: username,
      pass: password
    },
    logger: false
  });

  await client.connect();
  await client.mailboxOpen(mailbox || 'Novas');
  return client;
}

module.exports = {
  connectImap
};
