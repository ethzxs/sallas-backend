function pickCityUf(line) {
  const match =
    line.match(/:\s*([^,\-]+?)\s*(?:,|-)\s*([A-Z]{2})\b/) ||
    line.match(/^\s*([^,\-]+?)\s*(?:,|-)\s*([A-Z]{2})\b/);

  if (!match) return { city: null, uf: null };
  return { city: match[1].trim(), uf: match[2].trim() };
}

function cleanEmail(raw) {
  if (!raw) return null;
  return String(raw).replace(/^mailto:/i, '').replace(/[<>]/g, '').trim();
}

function extractEmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? cleanEmail(match[0]) : null;
}

function extractPhone(text) {
  const source = String(text || '');
  const match =
    source.match(/\+55\s*\d{2}\s*9?\s*\d{4,5}\s*\d{4}/) ||
    source.match(/\(\d{2}\)\s*9?\s*\d{4,5}[-\s]?\d{4}/) ||
    source.match(/\b\d{2}\s*9?\s*\d{4,5}[-\s]?\d{4}\b/);

  return match ? match[0].replace(/\s+/g, ' ').replace(' -', '-').trim() : null;
}

function sectionAfter(lines, headerRegex) {
  const index = lines.findIndex((line) => headerRegex.test(line));
  if (index < 0) return null;
  return { index, header: lines[index] };
}

function parseCargas(text) {
  const source = String(text || '');
  const lines = source
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let origin = { city: null, uf: null };
  let destination = { city: null, uf: null };

  for (const line of lines) {
    if (/^origem:/i.test(line)) origin = pickCityUf(line);
    if (/^destino:/i.test(line)) destination = pickCityUf(line);
  }

  let notes = null;
  const obs = sectionAfter(lines, /^observa/i);
  const info = sectionAfter(lines, /^informa(c|ç)(oes|ções)\s+adicionais\s*:/i);
  const start = obs?.index ?? info?.index ?? -1;

  if (start >= 0) {
    const collected = [];
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index];

      if (index === start) {
        const cleaned = line
          .replace(/^observa(c|ç)(oes|ções)\s*:\s*/i, '')
          .replace(/^informa(c|ç)(oes|ções)\s+adicionais\s*:\s*/i, '')
          .trim();
        if (cleaned) collected.push(cleaned);
        continue;
      }

      if (/^dados\s+de\s+contato\s*:/i.test(line)) break;
      if (/^atenciosamente\b/i.test(line)) break;
      if (/abrir\s+cota(c|ç)ao/i.test(line)) break;
      if (extractEmail(line) || extractPhone(line)) break;

      collected.push(line);
    }

    if (collected.length) notes = collected.join(' | ');
  }

  let contact_name = null;
  let contact_email = null;
  let contact_whatsapp = null;

  const dataContactIndex = lines.findIndex((line) => /^dados\s+de\s+contato\s*:/i.test(line));
  if (dataContactIndex >= 0) {
    for (let index = dataContactIndex; index < Math.min(dataContactIndex + 12, lines.length); index += 1) {
      const line = lines[index];
      const nameMatch = line.match(/^nome:\s*(.+)$/i);
      if (nameMatch) contact_name = nameMatch[1].trim();

      const phoneMatch = line.match(/^telefone:\s*(.+)$/i);
      if (phoneMatch) contact_whatsapp = extractPhone(phoneMatch[1]) || phoneMatch[1].trim();

      contact_email = contact_email || extractEmail(line);
      contact_whatsapp = contact_whatsapp || extractPhone(line);
    }
  } else {
    const regardsIndex = lines.findIndex((line) => /^atenciosamente\b/i.test(line));
    if (regardsIndex >= 0) {
      contact_name = lines[regardsIndex + 1] ? lines[regardsIndex + 1].trim() : null;
      const tail = lines.slice(regardsIndex, regardsIndex + 12).join(' \n ');
      contact_email = extractEmail(tail);
      contact_whatsapp = extractPhone(tail);
    } else {
      contact_email = extractEmail(source);
      contact_whatsapp = extractPhone(source);
    }
  }

  if (contact_name) contact_name = contact_name.replace(/\s+/g, ' ').trim();
  if (contact_email) contact_email = cleanEmail(contact_email);

  let packages = null;
  for (const line of lines) {
    const match = line.match(/^quantidade:\s*(\d+)/i) || line.match(/^quantidade\s+(\d+)/i);
    if (match) {
      packages = parseInt(match[1], 10);
      break;
    }
  }

  return {
    origemCidade: origin.city,
    origemUF: origin.uf,
    destinoCidade: destination.city,
    destinoUF: destination.uf,
    observacoes: notes,
    contact_name,
    contact_email,
    contact_whatsapp,
    packages,
  };
}

module.exports = { parseCargas };