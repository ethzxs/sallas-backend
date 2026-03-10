const crypto = require('crypto');

function generateFingerprint({ from, subject, date, body } = {}) {
  const parts = [from || '', subject || '', date || '', body || ''];
  let s = parts.join(' ').toLowerCase();
  s = s.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

module.exports = {
  generateFingerprint
};
