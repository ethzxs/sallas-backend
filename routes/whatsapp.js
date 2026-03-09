const express = require('express');
const router = express.Router();
const { start, stop, getStatus, sendText, sendDocument } = require('../services/wppClient');

router.get('/qr', async (req, res) => {
  try {
    const st0 = getStatus();
    if (st0.state === 'idle' || st0.state === 'error') {
      await start();
    }
    const st = getStatus();
    return res.json({ ok: true, status: st.state, qrDataUrl: st.qrDataUrl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/start', async (req, res) => {
  const st = await start();
  return res.json({ ok: true, ...st });
});

router.post('/stop', async (req, res) => {
  const st = await stop();
  return res.json({ ok: true, ...st });
});

// Frontend manda payload { messages: [{to, body}] } OU { quotes: [...] }
router.post('/send-mass', async (req, res) => {
  try {
    const status = getStatus();
    if (status.state !== 'ready') {
      return res.status(503).json({ ok: false, error: 'whatsapp_not_ready', ...status });
    }

    const results = [];
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    const quotes = Array.isArray(req.body?.quotes) ? req.body.quotes : null;

    // quick debug logs to confirm incoming payload and PDF link
    try {
      console.log('[send-mass] first msg keys', Object.keys(messages?.[0] || {}));
      console.log('[send-mass] proposalPdfUrl', messages?.[0]?.proposalPdfUrl);
    } catch (_) {}

    const list = messages
      ? messages.map(m => ({
          to: m.to,
          body: m.body,
          id: m.cotacaoId || m.quoteId || null,
          proposalPdfUrl: m.proposalPdfUrl || m.proposalPdfURL || m.proposal_pdf_url || null,
          proposalPdfName: m.proposalPdfName || m.proposalPdfFilename || m.proposal_pdf_name || null,
          proposalPdfBase64: m.proposalPdfBase64 || m.proposalPdf || null
        }))
      : (quotes || []).map(q => ({
          to: q.contact_whatsapp || q.whatsapp || q.phone || '',
          body: q.message || q.body || '',
          id: q.id || null,
          proposalPdfUrl: q.proposalPdfUrl || q.proposal_pdf_url || null,
          proposalPdfName: q.proposalPdfName || q.proposal_pdf_name || null,
          proposalPdfBase64: q.proposalPdfBase64 || q.proposal_pdf_base64 || null,
        }));

    for (const item of list) {
      try {
          const textResult = await sendText(item.to, item.body);

          // if there's a PDF (base64 or URL), fetch/normalize and send as document
          let mediaResult = null;
          if (item.proposalPdfBase64 || item.proposalPdfUrl) {
            try {
              let b64 = null;
              if (item.proposalPdfBase64) {
                b64 = String(item.proposalPdfBase64).replace(/^data:.*;base64,/, '');
              } else if (item.proposalPdfUrl) {
                console.log('[send-mass] fetching pdf', item.proposalPdfUrl);
                const resp = await fetch(String(item.proposalPdfUrl));
                console.log('[send-mass] pdf fetch status', resp.status, resp.headers.get('content-type'));
                if (!resp.ok) throw new Error('fetch_failed');
                const arr = await resp.arrayBuffer();
                b64 = Buffer.from(arr).toString('base64');
              }
              if (b64) {
                const name = String(item.proposalPdfName || 'proposta.pdf');
                mediaResult = await sendDocument(item.to, b64, name);
              }
            } catch (e) {
              results.push({ id: item.id, ok: false, error: 'media_send_failed: ' + String(e.message || e) });
              continue;
            }
          }

          results.push({ id: item.id, ok: true, textResult, mediaResult });
      } catch (e) {
          results.push({ id: item.id, ok: false, error: String(e.message || e) });
      }
    }

    return res.json({ ok: true, sent: results.filter(r => r.ok).length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/send-text', async (req, res) => {
  try {
    const to = req.body?.to;
    const message = req.body?.message ?? req.body?.body;
    const proposalPdfUrl = req.body?.proposalPdfUrl || req.body?.proposal_pdf_url || null;
    const proposalPdfName = req.body?.proposalPdfName || req.body?.proposal_pdf_name || null;
    const proposalPdfBase64 = req.body?.proposalPdfBase64 || req.body?.proposal_pdf_base64 || null;

    if (!to || !message) {
      return res.status(400).json({ ok: false, error: 'missing_to_or_message' });
    }

    const st = getStatus();
    if (st.state !== 'ready') {
      return res.status(503).json({ ok: false, error: 'whatsapp_not_ready', status: st.state });
    }

    const textResult = await sendText(to, message);

    // send PDF if provided
    if (proposalPdfBase64 || proposalPdfUrl) {
      try {
        let b64 = null;
        if (proposalPdfBase64) {
          b64 = String(proposalPdfBase64).replace(/^data:.*;base64,/, '');
        } else if (proposalPdfUrl) {
          const resp = await fetch(String(proposalPdfUrl));
          if (!resp.ok) throw new Error('fetch_failed');
          const arr = await resp.arrayBuffer();
          b64 = Buffer.from(arr).toString('base64');
        }
        if (b64) {
          const name = String(proposalPdfName || 'proposta.pdf');
          const mediaResult = await sendDocument(to, b64, name);
          return res.json({ ok: true, textResult, mediaResult });
        }
      } catch (e) {
        return res.json({ ok: true, textResult, mediaError: String(e.message || e) });
      }
    }

    return res.json({ ok: true, textResult });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
