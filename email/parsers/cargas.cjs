function pickCityUf(line) {
  const match =
    line.match(/:\s*([^,\-]+?)\s*(?:,|-)\s*([A-Z]{2})\b/) ||
    line.match(/^\s*([^,\-]+?)\s*(?:,|-)\s*([A-Z]{2})\b/);

  if (!match) return { city: null, uf: null };
  return { city: match[1].trim(), uf: match[2].trim() };
}

function htmlToLooseText(html) {
  if (!html) return '';

  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function normalizeBrokenText(value) {
  return String(value || '')
    .replace(/\u200b|\ufeff/g, '')
    .replace(/([A-Za-zÀ-ÿ0-9])\?(?=[A-Za-zÀ-ÿ0-9])/g, '$1')
    .replace(/([A-Za-zÀ-ÿ])�(?=[A-Za-zÀ-ÿ])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNormalizedLines(text, html) {
  const joined = [String(text || '').replace(/\r/g, ''), htmlToLooseText(html)]
    .filter(Boolean)
    .join('\n');

  const normalized = joined
    .split('\n')
    .map((line) => normalizeBrokenText(line))
    .filter(Boolean);

  return normalized;
}

function cleanEmail(raw) {
  if (!raw) return null;
  return String(raw).replace(/^mailto:/i, '').replace(/[<>]/g, '').trim();
}

function extractEmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? cleanEmail(match[0]) : null;
}

function isPlatformEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.endsWith('@guiadotransporte.com.br') || normalized.endsWith('@cotefrete.com.br');
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

function parseCargas(text, html) {
  const source = normalizeBrokenText(String(text || ''));
  const lines = buildNormalizedLines(text, html);
  const sourceJoined = lines.join('\n');

  let origin = { city: null, uf: null };
  let destination = { city: null, uf: null };

  for (const line of lines) {
    if (/^origem:/i.test(line)) origin = pickCityUf(line);
    if (/^destino:/i.test(line)) destination = pickCityUf(line);
  }

  if (!origin.city || !destination.city) {
    const origemDestinoRegex = /origem:\s*([^\n]+?)\s*-\s*([A-Z]{2}).*?destino:\s*([^\n]+?)\s*-\s*([A-Z]{2})/i;
    const joinedMatch = sourceJoined.match(origemDestinoRegex);
    if (joinedMatch) {
      origin = { city: joinedMatch[1].trim(), uf: joinedMatch[2].trim() };
      destination = { city: joinedMatch[3].trim(), uf: joinedMatch[4].trim() };
    }
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
      if (extractPhone(line)) break;

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

      const foundEmail = extractEmail(line);
      if (!contact_email && foundEmail && !isPlatformEmail(foundEmail)) contact_email = foundEmail;
      contact_whatsapp = contact_whatsapp || extractPhone(line);
    }
  } else {
    const regardsIndex = lines.findIndex((line) => /^atenciosamente\b/i.test(line));
    if (regardsIndex >= 0) {
      contact_name = lines[regardsIndex + 1] ? lines[regardsIndex + 1].trim() : null;
      const tail = lines.slice(regardsIndex, regardsIndex + 12).join(' \n ');
      const tailEmail = extractEmail(tail);
      contact_email = tailEmail && !isPlatformEmail(tailEmail) ? tailEmail : null;
      contact_whatsapp = extractPhone(tail);
    } else {
      const fallbackEmail = extractEmail(sourceJoined || source);
      contact_email = fallbackEmail && !isPlatformEmail(fallbackEmail) ? fallbackEmail : null;
      contact_whatsapp = extractPhone(sourceJoined || source);
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

  if (packages == null) {
    const pkgMatch = sourceJoined.match(/quantidade:\s*(\d+)/i);
    if (pkgMatch) packages = parseInt(pkgMatch[1], 10);
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