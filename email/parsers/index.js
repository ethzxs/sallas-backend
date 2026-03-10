function selectParser(from, subject) {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();

  if (f.includes('guia') || s.includes('guia')) return 'guia';
  if (f.includes('cotefrete') || s.includes('cotefrete')) return 'cotefrete';
  if (f.includes('cargas') || s.includes('cargas')) return 'cargas';

  return null;
}

module.exports = {
  selectParser
};
