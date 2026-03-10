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
  const htmlLoose = htmlToLooseText(html);
  let text = String(texto || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = (text + '\n' + htmlLoose).replace(/\u200b|\ufeff/g, '');

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
    observacoes: null,
    cargo_desc: null,
    contact_name: null,
    contact_email: null,
    contact_whatsapp: null,
    contact_whatsapp_url: null,
  };

  const origemMatch = text.match(/Origem:\s*([A-Za-zÀ-ÿ\s.'-]+?)\s*-\s*([A-Z]{2})\s*(?=Destino:)/i);
  if (origemMatch) {
    result.origemCidade = origemMatch[1].trim();
    result.origemUF = origemMatch[2].trim();
  }

  const destinoMatch = text.match(/Destino:\s*([A-Za-zÀ-ÿ\s.'-]+?)\s*-\s*([A-Z]{2})\s*(?=Quantidade:|Peso:|Valor:|Informacoes adicionais:|Informações adicionais:|Dados de contato:|$)/i);
  if (destinoMatch) {
    result.destinoCidade = destinoMatch[1].trim();
    result.destinoUF = destinoMatch[2].trim();
  }

  const qtdMatch = text.match(/Quantidade:\s*(\d+)/i);
  if (qtdMatch) result.quantidade = parseInt(qtdMatch[1], 10);

  const pesoMatch = text.match(/Peso:\s*([0-9\.,]+)\s*(?:kg)?/i);
  if (pesoMatch) result.peso = parseNumeroBR(pesoMatch[1]);

  const cubagemMatch = text.match(/Cubagem:\s*([0-9\.,]+)\s*(?:m3|m³)?/i);
  if (cubagemMatch) result.cubagem = parseNumeroBR(cubagemMatch[1]);

  const modeloMatch = text.match(/^Modelo:\s*(.+)\s*$/mi);
  if (modeloMatch) result.descricaoItem = `Modelo: ${modeloMatch[1].trim()}`;

  const nameMatch = text.match(/Nome:\s*(.+?)(?=\s*(?:Email:|Telefone:|Enviar mensagem|$))/i);
  if (nameMatch) result.contact_name = nameMatch[1].trim();

  const emailMatch = text.match(/Email:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (emailMatch) result.contact_email = emailMatch[1].trim();

  const phoneMatch = text.match(/Telefone:\s*([^\n<]+)/i);
  if (phoneMatch) {
    const digits = phoneMatch[1].replace(/[^\d+]/g, '');
    result.contact_whatsapp = digits.replace(/\D/g, '').length >= 8 ? digits : null;
  }

  const whatsappUrlMatch = text.match(/(https?:\/\/cotefrete\.com\.br\/wpp\/\S+)/i);
  if (whatsappUrlMatch) result.contact_whatsapp_url = whatsappUrlMatch[1].trim();

  const obsStart = text.search(/Informa(c|ç)(oes|ções) adicionais:\s*/i);
  if (obsStart >= 0) {
    const headerMatch = text.match(/Informa(c|ç)(oes|ções) adicionais:\s*/i);
    const after = text.slice(obsStart + headerMatch[0].length);
    const endIndex = after.search(/Dados de contato:\s*/i);
    const obs = endIndex >= 0 ? after.slice(0, endIndex) : after;
    const lines = obs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^Enviar mensagem no WhatsApp$/i.test(line))
      .filter((line) => !/^Nome:\s*/i.test(line))
      .filter((line) => !/^Email:\s*/i.test(line))
      .filter((line) => !/^Telefone:\s*/i.test(line));

    if (lines.length) {
      result.observacoesInternas = lines.join(' | ');
      result.observacoes = result.observacoesInternas;
      result.cargo_desc = result.observacoesInternas || result.descricaoItem || null;
    }
  }

  return result;
}

module.exports = { parseCotacaoCotefrete };