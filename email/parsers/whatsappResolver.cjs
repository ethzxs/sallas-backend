const GUIDE_WHATSAPP_URL_REGEX = /https?:\/\/guiadotransporte\.com\.br\/wa\/[A-Za-z0-9_-]+(?:\?[^\s"'<>)]*)?/ig;

function decodeLooseEntities(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractGuideWhatsappUrl(...values) {
  for (const value of values) {
    const decoded = decodeLooseEntities(value);
    const match = decoded.match(GUIDE_WHATSAPP_URL_REGEX);
    if (match && match[0]) return match[0].trim();
  }

  return null;
}

function normalizeWhatsappNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  digits = digits.replace(/^0+/, '');

  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) return digits;
  if (!digits.startsWith('55') && digits.length >= 12 && digits.length <= 15) return digits;

  return null;
}

function extractPhoneParam(value) {
  try {
    const url = new URL(String(value || ''));
    const phone = url.searchParams.get('phone') || url.searchParams.get('telefone');
    return normalizeWhatsappNumber(phone);
  } catch (_) {
    return null;
  }
}

function extractWhatsappNumberFromText(value) {
  const source = decodeLooseEntities(value);
  if (!source) return null;

  const urlPatterns = [
    /wa\.me\/(\d{10,15})/ig,
    /api\.whatsapp\.com\/send(?:\/)?\?[^\s"'<>]*phone=(\d{10,15})/ig,
    /(?:web\.)?whatsapp\.com\/send(?:\/)?\?[^\s"'<>]*phone=(\d{10,15})/ig,
  ];

  for (const regex of urlPatterns) {
    const match = regex.exec(source);
    regex.lastIndex = 0;
    if (match && match[1]) {
      const normalized = normalizeWhatsappNumber(match[1]);
      if (normalized) return normalized;
    }
  }

  const phoneFromParam = extractPhoneParam(source);
  if (phoneFromParam) return phoneFromParam;

  const scriptPatterns = [
    /(?:window\.)?location(?:\.href)?\s*=\s*["'`](.+?)["'`]/ig,
    /["'`](https?:\/\/[^"'`\s]+)["'`]/ig,
    /["']phone["']\s*[:=]\s*["']?(\d{10,15})["']?/ig,
    /\bphone\b\s*[:=]\s*["']?(\d{10,15})["']?/ig,
    /\btelefone\b\s*[:=]\s*["']?(\d{10,15})["']?/ig,
  ];

  for (const regex of scriptPatterns) {
    const match = regex.exec(source);
    regex.lastIndex = 0;
    if (!match || !match[1]) continue;

    const normalized = regex.source.includes('https?:')
      ? (extractPhoneParam(match[1]) || extractWhatsappNumberFromText(match[1]))
      : normalizeWhatsappNumber(match[1]);

    if (normalized) return normalized;
  }

  return null;
}

async function fetchTextWithTimeout(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('guia_whatsapp_timeout')), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; SallasBot/1.0; +https://guiadotransporte.com.br)',
      },
    });

    let body = '';
    try {
      body = await response.text();
    } catch (_) {}

    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWhatsappFromGuideUrl(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const debug = typeof options.debug === 'function' ? options.debug : null;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const maxHops = Number(options.maxHops) > 0 ? Number(options.maxHops) : 4;

  if (!url || typeof fetchImpl !== 'function') {
    return { phone: null, finalUrl: null, source: null, error: 'fetch_unavailable' };
  }

  let currentUrl = String(url).trim();

  for (let hop = 0; hop < maxHops; hop += 1) {
    try {
      debug && debug('guia whatsapp resolve request', { url: currentUrl, hop: hop + 1 });

      const { response, body } = await fetchTextWithTimeout(currentUrl, fetchImpl, timeoutMs);
      const responseUrl = response?.url || currentUrl;
      const location = response?.headers?.get('location');

      if (location) {
        const nextUrl = new URL(location, currentUrl).toString();
        const phoneFromLocation = extractWhatsappNumberFromText(nextUrl);
        debug && debug('guia whatsapp resolve redirect', {
          url: currentUrl,
          status: response.status,
          location: nextUrl,
          phone: phoneFromLocation,
        });

        if (phoneFromLocation) {
          return { phone: phoneFromLocation, finalUrl: nextUrl, source: 'redirect-location', error: null };
        }

        currentUrl = nextUrl;
        continue;
      }

      const phone = extractWhatsappNumberFromText(responseUrl) || extractWhatsappNumberFromText(body);

      debug && debug('guia whatsapp resolve response', {
        url: currentUrl,
        status: response.status,
        finalUrl: responseUrl,
        phone,
        contentLength: body ? body.length : 0,
      });

      if (phone) {
        return { phone, finalUrl: responseUrl, source: 'response-body', error: null };
      }

      return { phone: null, finalUrl: responseUrl, source: null, error: 'phone_not_found' };
    } catch (err) {
      const message = err?.name === 'AbortError' ? 'guia_whatsapp_timeout' : String(err?.message || err || 'resolve_error');
      debug && debug('guia whatsapp resolve failed', { url: currentUrl, hop: hop + 1, error: message });
      return { phone: null, finalUrl: currentUrl, source: null, error: message };
    }
  }

  return { phone: null, finalUrl: currentUrl, source: null, error: 'max_redirect_hops' };
}

module.exports = {
  extractGuideWhatsappUrl,
  extractWhatsappNumberFromText,
  normalizeWhatsappNumber,
  resolveWhatsappFromGuideUrl,
};