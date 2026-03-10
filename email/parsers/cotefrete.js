function parseNumeroBR(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function htmlToLooseText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parseCotacaoCotefrete(texto, html) {
  // Normalize text: combine plain text with a loose HTML-to-text fallback, remove invisible chars
  const htmlLoose = htmlToLooseText(html);
  let t = String(texto || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = (t + '\n' + htmlLoose).replace(/\u200b|\ufeff/g, '');

  const lines = t
    .split('\n')
    .map(l => l.replace(/[\u200b\ufeff]/g, '').trim())
    .filter(Boolean);

  const result = {
    origemCidade: null,
    origemUF: null,
    destinoCidade: null,
    destinoUF: null,
    quantidade: null,
    peso: null,
    cubagem: null,
    descricaoItem: null,
    observacoesInternas: null,
    contact_name: null,
    contact_email: null,
    contact_whatsapp: null,
    contact_whatsapp_url: null
  };

  // Origem / Destino regexes (funcionam mesmo com tudo na mesma linha)
  const origemRe = /Origem:\s*([A-Za-zÀ-ÿ\s.'-]+?)\s*-\s*([A-Z]{2})\s*(?=Destino:)/i;
  const destinoRe = /Destino:\s*([A-Za-zÀ-ÿ\s.'-]+?)\s*-\s*([A-Z]{2})\s*(?=Quantidade:|Peso:|Valor:|Informações adicionais:|Dados de contato:|$)/i;

  const origemMatch = t.match(origemRe);
  if (origemMatch) {
    result.origemCidade = origemMatch[1].trim();
    result.origemUF = origemMatch[2].trim();
  }

  const destinoMatch = t.match(destinoRe);
  if (destinoMatch) {
    result.destinoCidade = destinoMatch[1].trim();
    result.destinoUF = destinoMatch[2].trim();
  }

  // Quantidade / Peso / Cubagem (mais permissivas, funcionam inline)
  const qtdRe  = /Quantidade:\s*(\d+)/i;
  const pesoRe = /Peso:\s*([0-9\.,]+)\s*(?:kg)?/i;
  const cubRe  = /Cubagem:\s*([0-9\.,]+)\s*(?:m3|m³)?/i;

  const qtdM = t.match(qtdRe);
  if (qtdM) result.quantidade = parseInt(qtdM[1], 10);

  const pesoM = t.match(pesoRe);
  if (pesoM) result.peso = parseNumeroBR(pesoM[1]);

  const cubM = t.match(cubRe);
  if (cubM) result.cubagem = parseNumeroBR(cubM[1]);

  // Descrição / Modelo
  const modeloRe = /^Modelo:\s*(.+)\s*$/mi;
  const modeloM = t.match(modeloRe);
  if (modeloM) result.descricaoItem = `Modelo: ${modeloM[1].trim()}`;

  // Extract contact fields (Nome, Email, Telefone)
  const nomeMatch = String(t || '').match(/Nome:\s*(.+?)(?=\s*(?:Email:|Telefone:|Enviar mensagem|$))/i);
  const contact_name_detected = nomeMatch ? nomeMatch[1].trim() : null;
  if (contact_name_detected) result.contact_name = contact_name_detected;

  function cleanEmail(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const unwrapped = s.replace(/^<+|>+$/g, '').replace(/^mailto:/i, '').trim();
    const m = unwrapped.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : null;
  }

  const emailAny = t.match(/Email:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const contact_email = cleanEmail(emailAny?.[1]);
  if (contact_email) result.contact_email = contact_email;

  function cleanPhone(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const noLabel = s.replace(/enviar mensagem no whatsapp/ig, '').trim();
    const digits = noLabel.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length < 8) return null;
    return digits;
  }

  function extractPhoneFromText(text) {
    const s = String(text || '');
    const idx = s.toLowerCase().indexOf('telefone:');
    if (idx < 0) return null;
    let tail = s.slice(idx + 'telefone:'.length);
    tail = tail.split(/<|https?:\/\/|Enviar mensagem no WhatsApp|Dados de contato:|Email:|Nome:/i)[0];
    return cleanPhone(tail);
  }

  const phoneFinal = extractPhoneFromText(t);
  if (phoneFinal) result.contact_whatsapp = phoneFinal;

  // === fallback WhatsApp Cotefrete (sem regex literal, sem quebra) ===
  if (!result.contact_whatsapp) {
    const src = String(t || '');

    const re1 = new RegExp("&lt;\\s*(https?:\\/\\/cotefrete\\.com\\.br\\/wpp\\/[^\\s&]+)\\s*&gt;", "i");
    const re2 = new RegExp("\\b(https?:\\/\\/cotefrete\\.com\\.br\\/wpp\\/\\S+)\\b", "i");

    let m = src.match(re1);
    if (!m) m = src.match(re2);

    if (m && m[1]) result.contact_whatsapp_url = m[1].trim();
  }

  // Observações entre "Informações adicionais:" e "Dados de contato:"
  const infoStartRe = /Informações adicionais:\s*/i;
  const dadosContatoRe = /Dados de contato:\s*/i;

  let obs = null;
  const startIdx = t.search(infoStartRe);
  if (startIdx >= 0) {
    const after = t.slice(startIdx + t.match(infoStartRe)[0].length);
    const endMatch = after.search(dadosContatoRe);
    if (endMatch >= 0) {
      obs = after.slice(0, endMatch);
    } else {
      obs = after;
    }
  }
  if (obs != null) {
    const obsLines = obs
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !/^Enviar mensagem no WhatsApp$/i.test(l))
      .filter(l => !/^Nome:\s*/i.test(l))
      .filter(l => !/^Email:\s*/i.test(l))
      .filter(l => !/^Telefone:\s*/i.test(l));

    if (obsLines.length) result.observacoesInternas = obsLines.join(' | ');

    result.observacoes = result.observacoesInternas || null;
    result.cargo_desc = result.observacoesInternas ? result.observacoesInternas : (result.descricaoItem || null);
  }

  return result;
}

module.exports = { parseCotacaoCotefrete };
function parseNumeroBR(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function htmlToLooseText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parseCotacaoCotefrete(texto, html) {
  // Normalize text: combine plain text with a loose HTML-to-text fallback, remove invisible chars
  const htmlLoose = htmlToLooseText(html);
  let t = String(texto || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = (t + '\n' + htmlLoose).replace(/\u200b|\ufeff/g, '');

  const lines = t
    .split('\n')
    .map(l => l.replace(/[\u200b\ufeff]/g, '').trim())
    .filter(Boolean);

  const result = {
    origemCidade: null,
    origemUF: null,
    destinoCidade: null,
    destinoUF: null,
    quantidade: null,
    peso: null,
    cubagem: null,
    descricaoItem: null,
    observacoesInternas: null,
    contact_name: null,
    contact_email: null,
    contact_whatsapp: null,
    contact_whatsapp_url: null
  };

  // Origem / Destino regexes (funcionam mesmo com tudo na mesma linha)
  const origemRe = /Origem:\s*([A-Za-zÀ-ÿ\s.'-]+?)\s*-\s*([A-Z]{2})\s*(?=Destino:)/i;
  const destinoRe = /Destino:\s*([A-Za-zÀ-ÿ\s.'-]+?)\s*-\s*([A-Z]{2})\s*(?=Quantidade:|Peso:|Valor:|Informações adicionais:|Dados de contato:|$)/i;

  const origemMatch = t.match(origemRe);
  if (origemMatch) {
    result.origemCidade = origemMatch[1].trim();
    result.origemUF = origemMatch[2].trim();
  }

  const destinoMatch = t.match(destinoRe);
  if (destinoMatch) {
    result.destinoCidade = destinoMatch[1].trim();
    result.destinoUF = destinoMatch[2].trim();
  }

  // Quantidade / Peso / Cubagem (mais permissivas, funcionam inline)
  const qtdRe  = /Quantidade:\s*(\d+)/i;
  const pesoRe = /Peso:\s*([0-9\.,]+)\s*(?:kg)?/i;
  const cubRe  = /Cubagem:\s*([0-9\.,]+)\s*(?:m3|m³)?/i;

  const qtdM = t.match(qtdRe);
  if (qtdM) result.quantidade = parseInt(qtdM[1], 10);

  const pesoM = t.match(pesoRe);
  if (pesoM) result.peso = parseNumeroBR(pesoM[1]);

  const cubM = t.match(cubRe);
  if (cubM) result.cubagem = parseNumeroBR(cubM[1]);

  // Descrição / Modelo
  const modeloRe = /^Modelo:\s*(.+)\s*$/mi;
  const modeloM = t.match(modeloRe);
  if (modeloM) result.descricaoItem = `Modelo: ${modeloM[1].trim()}`;

  // Extract contact fields (Nome, Email, Telefone)
  const nomeMatch = String(t || '').match(/Nome:\s*(.+?)(?=\s*(?:Email:|Telefone:|Enviar mensagem|$))/i);
  const contact_name_detected = nomeMatch ? nomeMatch[1].trim() : null;
  if (contact_name_detected) result.contact_name = contact_name_detected;

  function cleanEmail(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const unwrapped = s.replace(/^<+|>+$/g, '').replace(/^mailto:/i, '').trim();
    const m = unwrapped.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : null;
  }

  const emailAny = t.match(/Email:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const contact_email = cleanEmail(emailAny?.[1]);
  if (contact_email) result.contact_email = contact_email;

  function cleanPhone(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const noLabel = s.replace(/enviar mensagem no whatsapp/ig, '').trim();
    const digits = noLabel.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length < 8) return null;
    return digits;
  }

  function extractPhoneFromText(text) {
    const s = String(text || '');
    const idx = s.toLowerCase().indexOf('telefone:');
    if (idx < 0) return null;
    let tail = s.slice(idx + 'telefone:'.length);
    tail = tail.split(/<|https?:\/\/|Enviar mensagem no WhatsApp|Dados de contato:|Email:|Nome:/i)[0];
    return cleanPhone(tail);
  }

  const phoneFinal = extractPhoneFromText(t);
  if (phoneFinal) result.contact_whatsapp = phoneFinal;

  // === fallback WhatsApp Cotefrete (sem regex literal, sem quebra) ===
  if (!result.contact_whatsapp) {
    const src = String(t || '');

    const re1 = new RegExp("&lt;\\s*(https?:\\/\\/cotefrete\\.com\\.br\\/wpp\\/[^\\s&]+)\\s*&gt;", "i");
    const re2 = new RegExp("\\b(https?:\\/\\/cotefrete\\.com\\.br\\/wpp\\/\\S+)\\b", "i");

    let m = src.match(re1);
    if (!m) m = src.match(re2);

    if (m && m[1]) result.contact_whatsapp_url = m[1].trim();
  }

  // Observações entre "Informações adicionais:" e "Dados de contato:"
  const infoStartRe = /Informações adicionais:\s*/i;
  const dadosContatoRe = /Dados de contato:\s*/i;

  let obs = null;
  const startIdx = t.search(infoStartRe);
  if (startIdx >= 0) {
    const after = t.slice(startIdx + t.match(infoStartRe)[0].length);
    const endMatch = after.search(dadosContatoRe);
    if (endMatch >= 0) {
      obs = after.slice(0, endMatch);
    } else {
      obs = after;
    }
  }

  if (obs != null) {
    const obsLines = obs
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !/^Enviar mensagem no WhatsApp$/i.test(l))
      .filter(l => !/^Nome:\s*/i.test(l))
      .filter(l => !/^Email:\s*/i.test(l))
      .filter(l => !/^Telefone:\s*/i.test(l));

    if (obsLines.length) result.observacoesInternas = obsLines.join(' | ');

    result.observacoes = result.observacoesInternas || null;
    result.cargo_desc = result.observacoesInternas
      ? result.observacoesInternas
      : (result.descricaoItem || null);
  }

  return result;
}

module.exports = { parseCotacaoCotefrete };
