const { simpleParser } = require('mailparser');

const { serviceClient } = require('../utils/supabaseClients.cjs');
const { connectImap, decorateImapError } = require('../email/imap/client.cjs');
const { resolveMailbox } = require('../email/imap/mailbox.cjs');
const { decryptImapPassword } = require('../utils/imapCrypto.cjs');
const { parseCotacaoCotefrete } = require('../email/parsers/cotefrete.cjs');
const { parseCargas } = require('../email/parsers/cargas.cjs');
const { parseGuia } = require('../email/parsers/guia.cjs');

function toLogMessage(err) {
  if (!err) return 'erro desconhecido';
  if (typeof err === 'string') return err;

  const parts = [err.message];
  if (err.responseText) parts.push(err.responseText);
  if (err.responseStatus) parts.push(`status=${err.responseStatus}`);
  if (err.serverResponseCode) parts.push(`code=${err.serverResponseCode}`);
  if (err.command) parts.push(`command=${err.command}`);

  return parts.filter(Boolean).join(' | ');
}

function summarizeText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = Number(maxLength) || 120;
  return text.length > limit ? text.slice(0, limit) + '...' : text;
}

async function runExtractionJob(jobId, companyId) {
  const stats = {
    mailbox: null,
    totalMessages: 0,
    scanned: 0,
    candidates: 0,
    inserted: 0,
    duplicates: 0,
    ignored: 0,
    errors: 0,
  };
  const debugEvents = [];

  function pushDebug(event, details) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...(details || {}),
    };
    debugEvents.push(entry);
    if (debugEvents.length > 200) debugEvents.shift();
    try {
      console.log('[extract-debug]', entry);
    } catch (_) {}
  }

  const { data: connection, error } = await serviceClient
    .from('email_connections')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .limit(1)
    .single();

  if (error || !connection) {
    throw new Error('No active email connection found for company ' + companyId);
  }

  try {
    pushDebug('connection loaded', {
      jobId,
      companyId,
      connectionId: connection.id,
      provider: connection.provider,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      mailboxConfigured: connection.mailbox || null,
      isActive: connection.is_active,
      isVerified: connection.is_verified,
      hasPassword: connection.password_encrypted != null,
    });
  } catch (_) {}

  if (connection.password_encrypted == null) {
    return {
      success: false,
      reason: 'missing_password',
      message: 'Email connection sem senha IMAP salva (password_encrypted null)',
    };
  }

  let password;
  try {
    password = decryptImapPassword(connection.password_encrypted);
  } catch (err) {
    if (String(err.message || '').startsWith('ENCRYPTION_KEY_MISMATCH')) {
      try {
        await serviceClient
          .from('email_connections')
          .update({
            is_verified: false,
            last_message_id: null,
            last_sync_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', connection.id);
      } catch (_) {}

      return { success: false, reason: 'invalid_encryption_key', message: err.message };
    }

    throw err;
  }

  const imapConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password,
    mailbox: connection.mailbox,
  };

  let client;
  try {
    client = await connectImap(imapConfig);
    try {
      pushDebug('imap connected', {
        jobId,
        companyId,
        host: imapConfig.host,
        port: imapConfig.port,
        username: imapConfig.username,
        mailboxRequested: imapConfig.mailbox || null,
      });
    } catch (_) {}
    const mailboxName = await resolveMailbox(client, connection.mailbox || 'Novas');
    stats.mailbox = mailboxName;
    try {
      pushDebug('mailbox resolved', {
        jobId,
        companyId,
        mailboxResolved: mailboxName,
        mailboxConfigured: connection.mailbox || null,
      });
    } catch (_) {}
    let messages;

    try {
      messages = await client.search({ seen: false });
    } catch (err) {
      throw decorateImapError(err, `Falha ao buscar mensagens nao lidas na mailbox ${mailboxName}`);
    }

    try {
      pushDebug('unread search result', {
        jobId,
        companyId,
        mailbox: mailboxName,
        unreadCount: Array.isArray(messages) ? messages.length : 0,
        unreadUids: Array.isArray(messages) ? messages.slice(0, 20) : [],
      });
    } catch (_) {}

    const userId = await getJobUserId(jobId);

    const maxMessages = 50;
    const uids = Array.isArray(messages)
      ? [...messages].sort((left, right) => right - left).slice(0, maxMessages)
      : [];
    stats.totalMessages = Array.isArray(messages) ? messages.length : 0;
    stats.scanned = uids.length;

    for (const uid of uids) {
      let full;

      try {
        full = await client.fetchOne(uid, { envelope: true, source: true });
      } catch (err) {
        throw decorateImapError(err, `Falha ao ler mensagem uid=${uid} mailbox=${mailboxName}`);
      }

      if (!full?.envelope) {
        stats.ignored += 1;
        try { pushDebug('skipped message without envelope', { jobId, companyId, uid, mailbox: mailboxName }); } catch (_) {}
        continue;
      }

      const fromAddr = full.envelope.from?.[0]?.address || '';
      const subjectTxt = full.envelope.subject || '';
      const fromLower = fromAddr.toLowerCase();
      const subjLower = subjectTxt.toLowerCase();

      if (fromLower.includes('mailer-daemon')) {
        stats.ignored += 1;
        try { pushDebug('skipped mailer-daemon', { jobId, companyId, uid, from: fromAddr, subject: subjectTxt }); } catch (_) {}
        continue;
      }

      const isGuia = fromLower.includes('guiadotransporte.com.br') || fromLower.includes('cotacao@guiadotransporte.com.br');
      const isCotefrete = !isGuia && (fromLower.includes('cotefrete') || subjLower.startsWith('cotação:') || subjLower.startsWith('cotacao:'));
      const isCargas = !isGuia && (fromLower.includes('cargas.com.br') || subjLower.includes('nova cotação') || subjLower.includes('nova cotacao'));

      try {
        pushDebug('message classification', {
          jobId,
          companyId,
          uid,
          mailbox: mailboxName,
          from: fromAddr,
          subject: subjectTxt,
          isGuia,
          isCotefrete,
          isCargas,
        });
      } catch (_) {}

      if (!isGuia && !isCotefrete && !isCargas) {
        stats.ignored += 1;
        try {
          pushDebug('ignored message by filter', {
            jobId,
            companyId,
            uid,
            from: fromAddr,
            subject: subjectTxt,
          });
        } catch (_) {}
        continue;
      }

      stats.candidates += 1;
      if (isGuia) {
        const result = await processGuia({
          uid,
          client,
          companyId,
          userId,
          sourceMessageId,
          subjectTxt,
          fromAddr,
          date,
          text,
          html,
          debug: pushDebug,
        });
        if (result?.inserted) stats.inserted += 1;
        if (result?.error) stats.errors += 1;
        try {
          pushDebug('guia result', {
            jobId,
            companyId,
            uid,
            sourceMessageId,
            inserted: !!result?.inserted,
            error: !!result?.error,
          });
        } catch (_) {}
        continue;
      }


      const messageId = full.envelope.messageId || null;
      const sourceMessageId = messageId || `uid:${uid}:${mailboxName}`;

      const { data: existing, error: existingError } = await serviceClient
        .from('quotes')
        .select('id')
        .eq('company_id', companyId)
        .eq('source_message_id', sourceMessageId)
        .maybeSingle();

      if (existingError) throw existingError;
      if (existing?.id) {
        stats.duplicates += 1;
        try {
          pushDebug('skipped duplicate message', {
            jobId,
            companyId,
            uid,
            sourceMessageId,
            existingQuoteId: existing.id,
          });
        } catch (_) {}
        continue;
      }

      const date = full.envelope.date || null;
      const rawEml = full.source || '';
      let parsed;

      try {
        parsed = await simpleParser(rawEml);
      } catch (err) {
        throw new Error(`Falha ao parsear email uid=${uid} mailbox=${mailboxName}: ${toLogMessage(err)}`);
      }

      const html = parsed.html || '';
      const text = parsed.text || '';

      try {
        pushDebug('parsed raw email', {
          jobId,
          companyId,
          uid,
          sourceMessageId,
          textPreview: summarizeText(text, 180),
          htmlPreview: summarizeText(html, 180),
        });
      } catch (_) {}

      if (isCotefrete) {
        const result = await processCotefrete({
          uid,
          client,
          companyId,
          userId,
          sourceMessageId,
          subjectTxt,
          fromAddr,
          date,
          text,
          html,
          debug: pushDebug,
        });
        if (result?.inserted) stats.inserted += 1;
        if (result?.error) stats.errors += 1;
        try {
          pushDebug('cotefrete result', {
            jobId,
            companyId,
            uid,
            sourceMessageId,
            inserted: !!result?.inserted,
            error: !!result?.error,
          });
        } catch (_) {}
        continue;
      }

      if (isCargas) {
        const result = await processCargas({
          uid,
          client,
          companyId,
          userId,
          sourceMessageId,
          subjectTxt,
          fromAddr,
          date,
          text,
          html,
          debug: pushDebug,
        });
        if (result?.inserted) stats.inserted += 1;
        if (result?.error) stats.errors += 1;
        try {
          pushDebug('cargas result', {
            jobId,
            companyId,
            uid,
            sourceMessageId,
            inserted: !!result?.inserted,
            error: !!result?.error,
          });
        } catch (_) {}
      }
    }
  } finally {
    try {
      if (client) await client.logout();
    } catch (_) {}
  }

  try { pushDebug('extraction summary', { jobId, companyId, ...stats }); } catch (_) {}

  return { success: true, ...stats, debug: debugEvents };
}

async function getJobUserId(jobId) {
  const { data: jobRow } = await serviceClient
    .from('extraction_jobs')
    .select('triggered_by')
    .eq('id', jobId)
    .maybeSingle();

  return jobRow?.triggered_by || null;
}

async function processCotefrete(context) {
  const { uid, client, companyId, userId, sourceMessageId, subjectTxt, fromAddr, date, text, html, debug } = context;
  let quote = null;

  try {
    const data = parseCotacaoCotefrete(text, html);
    try {
      debug && debug('cotefrete parsed fields', {
        companyId,
        uid,
        sourceMessageId,
        parsed: data,
      });
    } catch (_) {}
    const contact_name = data.contact_name ?? null;

    const emailMatch = String(data.contact_email || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const contact_email = emailMatch ? emailMatch[0] : null;

    const whatsappDigits = String(data.contact_whatsapp || '').replace(/[^\d+]/g, '');
    const contact_whatsapp = whatsappDigits.replace(/\D/g, '').length >= 8 ? whatsappDigits : null;

    const { data: quoteData, error: quoteError } = await serviceClient
      .from('quotes')
      .insert({
        company_id: companyId,
        created_by: userId,
        source: 'email',
        status: 'parsed',
        subject: subjectTxt,
        from_email: fromAddr,
        received_at: date,
        extracted_at: new Date().toISOString(),
        raw_text: text,
        raw_html: html,
        source_message_id: sourceMessageId,
        contact_name,
        contact_email,
        contact_whatsapp,
      })
      .select('id')
      .single();

    if (quoteError) throw quoteError;
    quote = quoteData;

    const cargoDesc = data.observacoesInternas ? String(data.observacoesInternas).trim() : (data.descricaoItem ? String(data.descricaoItem).trim() : null);

    const { error: itemError } = await serviceClient
      .from('quote_items')
      .insert({
        quote_id: quote.id,
        seq: 1,
        origin_city: data.origemCidade,
        origin_state: data.origemUF,
        dest_city: data.destinoCidade,
        dest_state: data.destinoUF,
        weight_kg: data.peso,
        volume_m3: data.cubagem,
        packages: data.quantidade,
        cargo_desc: cargoDesc,
        notes: null,
      });

    if (itemError) throw itemError;
  } catch (err) {
    try {
      debug && debug('cotefrete processing error', {
        companyId,
        uid,
        sourceMessageId,
        message: err.message || String(err),
      });
    } catch (_) {}
    if (quote?.id) {
      await serviceClient
        .from('quotes')
        .update({ status: 'error', error_message: err.message || String(err) })
        .eq('id', quote.id);
    } else {
      await serviceClient.from('quotes').insert({
        company_id: companyId,
        created_by: userId,
        source: 'email',
        status: 'error',
        subject: subjectTxt,
        from_email: fromAddr,
        received_at: date,
        extracted_at: new Date().toISOString(),
        raw_text: text,
        raw_html: html,
        source_message_id: sourceMessageId,
        error_message: err.message || String(err),
      });
    }
    return { inserted: false, error: true };
  } finally {
    await ensureUnseen(client, uid);
  }

  return { inserted: true, error: false };
}

async function processCargas(context) {
  return processMarketplaceQuote(context, parseCargas, 'cargas');
}

async function processGuia(context) {
  return processMarketplaceQuote(context, parseGuia, 'guia');
}

async function processMarketplaceQuote(context, parser, parserName) {
  const { uid, client, companyId, userId, sourceMessageId, subjectTxt, fromAddr, date, text, html, debug } = context;
  let quoteId = null;

  try {
    const { data: quoteData, error: quoteError } = await serviceClient
      .from('quotes')
      .insert({
        company_id: companyId,
        created_by: userId,
        source: 'email',
        status: 'new',
        subject: subjectTxt,
        from_email: fromAddr,
        received_at: date,
        extracted_at: new Date().toISOString(),
        raw_text: text,
        raw_html: html,
        source_message_id: sourceMessageId,
      })
      .select('id')
      .single();

    if (quoteError) throw quoteError;
    quoteId = quoteData.id;

    const data = parser(text, html);
    try {
      debug && debug(`${parserName} parsed fields`, {
        companyId,
        uid,
        sourceMessageId,
        parsed: data,
      });
    } catch (_) {}

    const cargoDesc = data.cargo_desc || data.observacoes || data.descricaoItem || null;

    const { error: itemError } = await serviceClient.from('quote_items').insert({
      quote_id: quoteId,
      seq: 1,
      origin_city: data.origemCidade,
      origin_state: data.origemUF,
      dest_city: data.destinoCidade,
      dest_state: data.destinoUF,
      weight_kg: data.peso ?? null,
      volume_m3: data.cubagem ?? null,
      cargo_desc: cargoDesc,
      notes: null,
      packages: data.packages ?? data.quantidade ?? null,
    });

    if (itemError) throw itemError;

    await serviceClient
      .from('quotes')
      .update({
        contact_name: data.contact_name,
        contact_email: data.contact_email,
        contact_whatsapp: data.contact_whatsapp,
        invoice_value: data.valorNota ?? null,
        status: 'parsed',
      })
      .eq('id', quoteId);

    return { inserted: true, error: false };
  } catch (err) {
    try {
      debug && debug(`${parserName} processing error`, {
        companyId,
        uid,
        sourceMessageId,
        message: err.message || String(err),
      });
    } catch (_) {}
    if (quoteId) {
      await serviceClient
        .from('quotes')
        .update({ status: 'error', error_message: err.message || String(err) })
        .eq('id', quoteId);
    }
    return { inserted: false, error: true };
  } finally {
    await ensureUnseen(client, uid);
  }
}

async function ensureUnseen(client, uid) {
  try {
    await client.messageFlagsRemove(uid, ['\\Seen']);
  } catch (_) {}
}

module.exports = {
  runExtractionJob,
};