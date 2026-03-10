const { extractGuideWhatsappUrl, resolveWhatsappFromGuideUrl } = require('./whatsappResolver.cjs');

function parseNumeroBR(value) {
  if (value == null) return null;
  const normalized = String(value).trim().replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function htmlToLooseText(html) {
  if (!html) return '';

  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/pre>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function normalizeGuideText(value) {
  return String(value || '')
    .replace(/\u200b|\ufeff/g, '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(value) {
  return String(value || '')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDescription(value) {
  return String(value || '')
    .replace(/\s+Lista\s+/gi, ' | Lista: ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function parseGuia(text, html, options = {}) {
  const debug = typeof options.debug === 'function' ? options.debug : null;
  const rawText = String(text || '');
  const rawHtml = String(html || '');
  const looseHtml = htmlToLooseText(rawHtml);
  const source = normalizeGuideText([rawText, looseHtml].filter(Boolean).join(' '));
  const result = {
    origemCidade: null,
    origemUF: null,
    destinoCidade: null,
    destinoUF: null,
    quantidade: null,
    packages: null,
    peso: null,
    cubagem: null,
    valorNota: null,
    descricaoItem: null,
    observacoes: null,
    cargo_desc: null,
    contact_name: null,
    contact_email: null,
    contact_whatsapp: null,
    contact_whatsapp_url: null,
  };

  const origemMatch = source.match(/Origem\s+(.+?)\s*-\s*([A-Z]{2})(?=\s+Destino\b)/i);
  if (origemMatch) {
    result.origemCidade = cleanName(origemMatch[1]);
    result.origemUF = origemMatch[2].trim();
  }

  const destinoMatch = source.match(/Destino\s+(.+?)\s*-\s*([A-Z]{2})(?=\s+Valor\s+da\s+nota:|\s+Quantidade:|\s+Peso:|\s+Cubagem:|\s+Atenciosamente,|$)/i);
  if (destinoMatch) {
    result.destinoCidade = cleanName(destinoMatch[1]);
    result.destinoUF = destinoMatch[2].trim();
  }

  const valorNotaMatch = source.match(/Valor\s+da\s+nota:\s*R\$\s*([0-9\.,]+)/i);
  if (valorNotaMatch) result.valorNota = parseNumeroBR(valorNotaMatch[1]);

  const quantidadeMatch = source.match(/Quantidade:\s*(\d+)/i);
  if (quantidadeMatch) {
    result.quantidade = parseInt(quantidadeMatch[1], 10);
    result.packages = result.quantidade;
  }

  const pesoMatch = source.match(/Peso:\s*([0-9\.,]+)\s*KG\b/i);
  if (pesoMatch) result.peso = parseNumeroBR(pesoMatch[1]);

  const cubagemMatch = source.match(/Cubagem:\s*([0-9\.,]+)\s*M(?:3|³)?\b/i) || source.match(/Cubagem:\s*([0-9\.,]+)\s*M\b/i);
  if (cubagemMatch) result.cubagem = parseNumeroBR(cubagemMatch[1]);

  result.contact_whatsapp_url = extractGuideWhatsappUrl(rawHtml, rawText, source);
  if (result.contact_whatsapp_url) {
    debug && debug('guia whatsapp url found', {
      url: result.contact_whatsapp_url,
      sourceMessageId: options.sourceMessageId || null,
    });
  }

  const nameMatch = source.match(/Atenciosamente,\s*(.+?)(?=\s*<?https?:\/\/guiadotransporte\.com\.br\/wa\/|\s+Abrir\s+esta\s+cotacao\s+no\s+WhatsApp|\s+E-mail\s+enviado\s+pelo\s+Guia\s+do\s+Transporte|$)/i);
  if (nameMatch) result.contact_name = cleanName(nameMatch[1]);

  const descriptionStart = [
    /Peso Cubado:\s*[0-9\.,]+\s*KG\b/i,
    /Cubagem:\s*[0-9\.,]+\s*M(?:3|³)?\b/i,
    /Cubagem:\s*[0-9\.,]+\s*M\b/i,
    /Peso:\s*[0-9\.,]+\s*KG\b/i,
    /Quantidade:\s*\d+\s*Un\b/i,
    /Valor\s+da\s+nota:\s*R\$\s*[0-9\.,]+/i,
  ].reduce((maxEnd, regex) => {
    const match = source.match(regex);
    if (!match || match.index == null) return maxEnd;
    return Math.max(maxEnd, match.index + match[0].length);
  }, -1);

  const thanksIndex = source.search(/\s+Atenciosamente,/i);
  if (descriptionStart >= 0 && thanksIndex > descriptionStart) {
    const rawDescription = source.slice(descriptionStart, thanksIndex).trim();
    const normalizedDescription = normalizeDescription(rawDescription);
    if (normalizedDescription) {
      result.descricaoItem = normalizedDescription;
      result.observacoes = normalizedDescription;
      result.cargo_desc = normalizedDescription;
    }
  }

  if (!result.contact_whatsapp && result.contact_whatsapp_url) {
    const resolution = await resolveWhatsappFromGuideUrl(result.contact_whatsapp_url, {
      debug,
      fetchImpl: options.fetchImpl,
      maxHops: options.maxHops,
      timeoutMs: options.timeoutMs || 8000,
    });

    if (resolution.phone) {
      result.contact_whatsapp = resolution.phone;
      debug && debug('guia whatsapp resolved', {
        sourceMessageId: options.sourceMessageId || null,
        url: result.contact_whatsapp_url,
        finalUrl: resolution.finalUrl,
        phone: resolution.phone,
        resolutionSource: resolution.source,
      });
    } else {
      debug && debug('guia whatsapp unresolved', {
        sourceMessageId: options.sourceMessageId || null,
        url: result.contact_whatsapp_url,
        finalUrl: resolution.finalUrl,
        error: resolution.error,
      });
    }
  }

  return result;
}

module.exports = { parseGuia };