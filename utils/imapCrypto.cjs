const crypto = require('crypto');

function decryptImapPassword(payloadB64) {
  if (!payloadB64) throw new Error('payloadB64 is required');

  const keyB64 = process.env.IMAP_ENC_KEY_B64;
  if (!keyB64) throw new Error('IMAP_ENC_KEY_B64 not set in environment');

  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('IMAP_ENC_KEY_B64 must decode to 32 bytes');

  const buf = Buffer.from(payloadB64, 'base64');
  if (buf.length < 29) throw new Error('invalid encrypted payload');

  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    err.message = 'ENCRYPTION_KEY_MISMATCH: IMAP_ENC_KEY_B64 nao corresponde a usada na criptografia - ' + (err.message || 'decryption failed');
    throw err;
  }
}

module.exports = {
  decryptImapPassword,
};