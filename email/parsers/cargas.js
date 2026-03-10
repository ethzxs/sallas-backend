function pickCityUf(line) {
  // aceita "Origem: Macapá, AP" e "Origem: Aparecida de Goiânia - GO"
  const m =
    line.match(/:\s*([^,\-]+?)\s*(?:,|-)\s*([A-Z]{2})\b/) ||
    line.match(/^\s*([^,\-]+?)\s*(?:,|-)\s*([A-Z]{2})\b/);
  if (!m) return { city: null, uf: null };
  return { city: m[1].trim(), uf: m[2].trim() };
}

function cleanEmail(raw) {
  if (!raw) return null;
  return String(raw).replace(/^mailto:/i, '').replace(/[<>]/g, '').trim();
}

function extractEmail(text) {
  const m = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? cleanEmail(m[0]) : null;
}

function extractPhone(text) {
  const t = String(text || '');
  // +55 67 99669 1136 | (96) 9 8100-0347 | (11) 9484-4623 | 67 99669-1136
  const m =
    t.match(/\+55\s*\d{2}\s*9?\s*\d{4,5}\s*\d{4}/) ||
    t.match(/\(\d{2}\)\s*9?\s*\d{4,5}[-\s]?\d{4}/) ||
    t.match(/\b\d{2}\s*9?\s*\d{4,5}[-\s]?\d{4}\b/);
  return m ? m[0].replace(/\s+/g, ' ').replace(' -', '-').trim() : null;
}

function sectionAfter(lines, headerRegex) {
  const idx = lines.findIndex(l => headerRegex.test(l));
  if (idx < 0) return null;
  return { idx, header: lines[idx] };
}

function parseCargas(text) {
  const t = String(text || '');
  const lines = t
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let origin = { city: null, uf: null };
  let dest = { city: null, uf: null };

  for (const line of lines) {
    if (/^origem:/i.test(line)) origin = pickCityUf(line);
    if (/^destino:/i.test(line)) dest = pickCityUf(line);
  }

  // OBSERVAÇÕES / INFORMAÇÕES ADICIONAIS (pega só o bloco útil)
  let notes = null;

  const obs = sectionAfter(lines, /^observa/i);
  const info = sectionAfter(lines, /^informa(c|ç)(ões|oes)\s+adicionais\s*:/i);

  const start = obs?.idx ?? info?.idx ?? -1;
  if (start >= 0) {
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];

      // remove o prefixo do header na primeira linha
      if (i === start) {
        const cleaned = line
          .replace(/^observa(c|ç)(ões|oes)\s*:\s*/i, '')
          .replace(/^informa(c|ç)(ões|oes)\s+adicionais\s*:\s*/i, '')
          .trim();
        if (cleaned) out.push(cleaned);
        continue;
      }

      // para quando chegar no bloco de contato/assinatura
      if (/^dados\s+de\s+contato\s*:/i.test(line)) break;
      if (/^atenciosamente\b/i.test(line)) break;
      if (/abrir\s+cota(c|ç)ão/i.test(line)) break;
      if (extractEmail(line)) break;
      if (extractPhone(line)) break;

      out.push(line);
    }
    if (out.length) notes = out.join(' | ');
  }

  // CONTATO (2 formatos)
  let contact_name = null;
  let contact_email = null;
  let contact_whatsapp = null;

  // formato 1: "Dados de contato: Nome: X Telefone: Y"
  const dcIdx = lines.findIndex(l => /^dados\s+de\s+contato\s*:/i.test(l));
  if (dcIdx >= 0) {
    for (let i = dcIdx; i < Math.min(dcIdx + 12, lines.length); i++) {
      const l = lines[i];

      const mn = l.match(/^nome:\s*(.+)$/i);
      if (mn) contact_name = mn[1].trim();

      const mt = l.match(/^telefone:\s*(.+)$/i);
      if (mt) contact_whatsapp = extractPhone(mt[1]) || mt[1].trim();

      contact_email = contact_email || extractEmail(l);
      contact_whatsapp = contact_whatsapp || extractPhone(l);
    }
  } else {
    // formato 2/3: assinatura após "Atenciosamente,"
    const attIdx = lines.findIndex(l => /^atenciosamente\b/i.test(l));
    if (attIdx >= 0) {
      contact_name = lines[attIdx + 1] ? lines[attIdx + 1].trim() : null;

      // pega até 10 linhas depois pra achar tel/email
      const tail = lines.slice(attIdx, attIdx + 12).join(' \n ');
      contact_email = extractEmail(tail);
      contact_whatsapp = extractPhone(tail);
    } else {
      // fallback geral: tenta do corpo todo
      contact_email = extractEmail(t);
      contact_whatsapp = extractPhone(t);
    }
  }

  // normaliza
  if (contact_name) contact_name = contact_name.replace(/\s+/g, ' ').trim();
  if (contact_email) contact_email = cleanEmail(contact_email);

  // QUANTIDADE / PACKAGES
  let packages = null;

  for (const l of lines) {
    const m =
      l.match(/^quantidade:\s*(\d+)/i) ||
      l.match(/^quantidade\s+(\d+)/i);

    if (m) {
      packages = parseInt(m[1], 10);
      break;
    }
  }

  return {
    origemCidade: origin.city,
    origemUF: origin.uf,
    destinoCidade: dest.city,
    destinoUF: dest.uf,
    observacoes: notes,
    contact_name,
    contact_email,
    contact_whatsapp,
    packages
  };
}

module.exports = { parseCargas };
