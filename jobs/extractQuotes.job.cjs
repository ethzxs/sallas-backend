const { simpleParser } = require('mailparser');

const { serviceClient } = require('../utils/supabaseClients.cjs');
const { connectImap } = require('../email/imap/client.cjs');
const { resolveMailbox } = require('../email/imap/mailbox.cjs');
const { decryptImapPassword } = require('../utils/imapCrypto.cjs');
const { parseCotacaoCotefrete } = require('../email/parsers/cotefrete.cjs');
const { parseCargas } = require('../email/parsers/cargas.cjs');

async function runExtractionJob(jobId, companyId) {
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
    const mailboxName = await resolveMailbox(client, connection.mailbox || 'Novas');
    const messages = await client.search({ seen: false });
    const userId = await getJobUserId(jobId);

    const maxMessages = 20;
    const uids = Array.isArray(messages)
      ? [...messages].sort((left, right) => right - left).slice(0, maxMessages)
      : [];

    for (const uid of uids) {
      const full = await client.fetchOne(uid, { envelope: true, source: true });
      if (!full?.envelope) continue;

      const fromAddr = full.envelope.from?.[0]?.address || '';
      const subjectTxt = full.envelope.subject || '';
      const fromLower = fromAddr.toLowerCase();
      const subjLower = subjectTxt.toLowerCase();

      if (fromLower.includes('mailer-daemon')) continue;

      const isCotefrete = fromLower.includes('cotefrete') || subjLower.startsWith('cotação:') || subjLower.startsWith('cotacao:');
      const isCargas = fromLower.includes('cargas.com.br') || subjLower.includes('nova cotação') || subjLower.includes('nova cotacao');
      if (!isCotefrete && !isCargas) continue;

      const messageId = full.envelope.messageId || null;
      const sourceMessageId = messageId || `uid:${uid}:${mailboxName}`;

      const { data: existing, error: existingError } = await serviceClient
        .from('quotes')
        .select('id')
        .eq('company_id', companyId)
        .eq('source_message_id', sourceMessageId)
        .maybeSingle();

      if (existingError) throw existingError;
      if (existing?.id) continue;

      const date = full.envelope.date || null;
      const rawEml = full.source ? full.source.toString('utf8') : '';
      const parsed = await simpleParser(rawEml);
      const html = parsed.html || '';
      const text = parsed.text || '';

      if (isCotefrete) {
        await processCotefrete({
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
        });
        continue;
      }

      if (isCargas) {
        await processCargas({
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
        });
      }
    }
  } finally {
    try {
      if (client) await client.logout();
    } catch (_) {}
  }

  return { success: true };
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
  const { uid, client, companyId, userId, sourceMessageId, subjectTxt, fromAddr, date, text, html } = context;
  let quote = null;

  try {
    const data = parseCotacaoCotefrete(text, html);
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
  } finally {
    await markSeen(client, uid);
  }
}

async function processCargas(context) {
  const { uid, client, companyId, userId, sourceMessageId, subjectTxt, fromAddr, date, text, html } = context;
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

    const data = parseCargas(text);

    const { error: itemError } = await serviceClient.from('quote_items').insert({
      quote_id: quoteId,
      seq: 1,
      origin_city: data.origemCidade,
      origin_state: data.origemUF,
      dest_city: data.destinoCidade,
      dest_state: data.destinoUF,
      cargo_desc: data.observacoes,
      notes: null,
      packages: data.packages,
    });

    if (itemError) throw itemError;

    await serviceClient
      .from('quotes')
      .update({
        contact_name: data.contact_name,
        contact_email: data.contact_email,
        contact_whatsapp: data.contact_whatsapp,
        status: 'parsed',
      })
      .eq('id', quoteId);

    await markSeen(client, uid);
  } catch (err) {
    if (quoteId) {
      await serviceClient
        .from('quotes')
        .update({ status: 'error', error_message: err.message || String(err) })
        .eq('id', quoteId);
    }
  }
}

async function markSeen(client, uid) {
  try {
    await client.messageFlagsAdd(uid, ['\\Seen']);
  } catch (_) {}
}

module.exports = {
  runExtractionJob,
};