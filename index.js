import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from 'url';
import QRCode from "qrcode";
import crypto from "crypto";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import puppeteer from "puppeteer";

async function rmrfSafe(targetPath) {
  if (!targetPath) return;
  try {
    await fsp.rm(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch (e) {
    try {
      const tmp = `${targetPath}.deleting-${Date.now()}`;
      await fsp.rename(targetPath, tmp);
      await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    } catch (_) {}
  }
}

dotenv.config();

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = (SB_URL && SB_SERVICE_KEY)
  ? createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// Handlers globais para visibilidade de erros
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

const app = express();
const __filename = fileURLToPath(import.meta.url);
app.use(cors());
// permitir payloads maiores para batches com PDFs em base64
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 4010);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normId(x) {
  return String(x || "").trim();
}

function sessionPath(companyId, membershipId) {
  const c = normId(companyId);
  const m = normId(membershipId);
  if (!c || !m) throw new Error("companyId e membershipId são obrigatórios.");
  return path.join(SESSION_DIR, c, m);
}

// Clients em memória (um por membership)
const clients = new Map(); // key = `${companyId}:${membershipId}` -> { client, lastQrDataUrl, status }
// keys que estão em processo de inicialização (para evitar inicializações concorrentes)
const initializing = new Set();

// Simple send mutex to avoid concurrent sends + throttle mínimo
let SEND_LOCK = Promise.resolve();
let LAST_SEND_AT = 0;
const MIN_SEND_INTERVAL_MS = 600; // reduzido para melhorar throughput em lote

// tempo máximo por tentativa de envio para evitar travar o lock
const SEND_TIMEOUT_MS = 45000; // 45s por envio de PDF

async function withTimeout(promise, ms, tag) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${tag || 'timeout'}_${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function enqueueSend(fn) {
  SEND_LOCK = SEND_LOCK.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, MIN_SEND_INTERVAL_MS - (now - LAST_SEND_AT));
    if (wait) await sleep(wait);

    const out = await withTimeout(fn(), SEND_TIMEOUT_MS, 'send_timeout');
    LAST_SEND_AT = Date.now();
    return out;
  }, async () => {
    // mantém o lock vivo mesmo se der erro anterior
    const now = Date.now();
    const wait = Math.max(0, MIN_SEND_INTERVAL_MS - (now - LAST_SEND_AT));
    if (wait) await sleep(wait);

    const out = await withTimeout(fn(), SEND_TIMEOUT_MS, 'send_timeout');
    LAST_SEND_AT = Date.now();
    return out;
  });

  return SEND_LOCK;
}

const SESSION_DIR =
  process.env.SESSION_DIR ||
  (process.platform === "win32" ? "C:\\wpp" : "/tmp/wpp");
const AUTH_DIR = path.join(SESSION_DIR, "auth");

function safeId(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function keyOf(companyId, membershipId) {
  const raw = `${normId(companyId)}:${normId(membershipId)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

async function upsertWhatsappSession({ companyId, membershipId, status }) {
  try {
    if (!sb) return;
    const session_key = keyOf(companyId, membershipId);
    await sb.from("whatsapp_sessions").upsert({
      company_id: companyId,
      membership_id: membershipId,
      session_key,
      status,
      updated_at: new Date().toISOString(),
    }, { onConflict: "company_id,membership_id" });
  } catch (e) {
    console.warn("[WPP] upsertWhatsappSession failed:", e?.message || e);
  }
}

function toWhatsAppJid(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  return `${withCountry}@c.us`;
}

async function getOrCreateClient(companyId, membershipId) {
  const key = keyOf(companyId, membershipId);
  if (clients.has(key)) return clients.get(key);

  // se já estiver inicializando, retorna o holder existente (ou temporário)
  if (initializing.has(key)) {
    const existing = clients.get(key);
    if (existing) return existing;
    return { client: null, lastQrDataUrl: null, status: "starting" };
  }

  // delega para builder por key
  return await buildClientForKey(key);
}

function buildClientForKey(key) {
  // retorna Promise resolving to holder
  return (async () => {
    ensureDir(SESSION_DIR);
    ensureDir(AUTH_DIR);

    const holder = {
      client: null,
      lastQrDataUrl: null,
      status: "starting",
      WA_READY: false,
    };
    // guarda a key para permitir restarts fáceis
    holder.key = key;

    const clientId = `session-${key}`;

    const resolvedExecPath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (typeof puppeteer?.executablePath === "function" ? puppeteer.executablePath() : undefined);

    console.log("[WPP] chrome env path =", process.env.PUPPETEER_EXECUTABLE_PATH || "");
    console.log("[WPP] chrome resolvedExecPath =", resolvedExecPath || "(empty)");

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId,
        dataPath: AUTH_DIR,
      }),
      puppeteer: {
        headless: "new",
        protocolTimeout: 300000,
        timeout: 300000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--disable-features=site-per-process",
        ],
        executablePath: resolvedExecPath,
      },
    });

    holder.client = client;

    client.on("qr", async (qr) => {
      holder.status = "qr";
      holder.lastQrDataUrl = await QRCode.toDataURL(qr);
      console.log(`[WPP] QR gerado para ${key}`);
    });

    client.on("ready", () => {
      holder.status = "ready";
      holder.lastQrDataUrl = null;
      holder.WA_READY = true;
      console.log(`[WPP] Ready: ${key}`);
    });

    client.on("authenticated", () => {
      console.log(`[WPP] Authenticated: ${key}`);
    });

    client.on("auth_failure", (msg) => {
      holder.status = "auth_failure";
      holder.WA_READY = false;
      console.log(`[WPP] Auth failure ${key}:`, msg);
    });

    client.on("disconnected", (reason) => {
      holder.status = "disconnected";
      holder.WA_READY = false;
      console.log(`[WPP] Disconnected ${key}:`, reason);
    });

    client.on("loading_screen", (percent, message) => {
      console.log(`[WPP] loading ${key}: ${percent}% - ${message}`);
    });

    client.on("change_state", (state) => {
      console.log(`[WPP] state ${key}:`, state);
    });

    client.on("error", (err) => {
      // marcar como não-ready em erros críticos
      try { holder.WA_READY = false; } catch (_) {}
      console.log(`[WPP] ERROR ${key}:`, err);
    });

    // registra ANTES de inicializar para evitar corrida
    clients.set(key, holder);
    initializing.add(key);

    try {
      console.log('[WPP] initializing...', key);
      await client.initialize();
      console.log('[WPP] initialize done', key);
    } catch (err) {
      console.error('[WPP] initialize failed (continuing API up):', err);
    } finally {
      try { initializing.delete(key); } catch (_) {}
    }
    return holder;
  })();
}

async function hardRestartClient(key) {
  const holder = clients.get(key);

  // se já está inicializando, só espera terminar
  if (initializing.has(key)) {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const h = clients.get(key);
      if (h?.WA_READY) return h;
    }
    return clients.get(key);
  }

  console.log('[WPP] hardRestartClient ->', key);

  try {
    if (holder?.client) {
      try { await holder.client.destroy(); } catch (e) {}
    }
  } catch (e) {}

  try { clients.delete(key); } catch (e) {}
  try { initializing.delete(key); } catch (e) {}

  // recria do zero
  const newHolder = await buildClientForKey(key);
  return newHolder;
}

// Safe send helper: checa estado e trata 'detached Frame' reiniciando cliente quando necessário
async function safeSendMessage(holder, chatId, message) {
  if (!holder || !holder.client) throw new Error('client_not_initialized');
  if (!holder.WA_READY) return { ok: false, error: 'whatsapp_not_ready' };

  try {
    const result = await enqueueSend(() => holder.client.sendMessage(chatId, String(message)));
    return { ok: true, result };
  } catch (err) {
    const msg = String(err?.message || err?.stack || err || '');
    const isDetached =
      /detached frame/i.test(msg) ||
      /execution context was destroyed/i.test(msg) ||
      /target closed/i.test(msg);

    if (isDetached) {
      try { holder.WA_READY = false; } catch (_) {}
      console.log('[WPP] browser/page invalid -> hard restart');

      try {
        await hardRestartClient(holder.key);
      } catch (e) {
        console.warn('[WPP] hardRestartClient failed', e);
      }

      return { ok: false, error: 'whatsapp_restarting' };
    }

    throw err;
  }
}

// Safe send helper for media (document, image etc.) that handles detached frames
async function safeSendMedia(holder, chatId, media, options) {
  if (!holder || !holder.client) throw new Error('client_not_initialized');
  if (!holder.WA_READY) return { ok: false, error: 'whatsapp_not_ready' };

  try {
    const result = await enqueueSend(() => withTimeout(holder.client.sendMessage(chatId, media, options || {}), SEND_TIMEOUT_MS, 'send_media_timeout'));
    return { ok: true, result };
  } catch (err) {
    const msg = String(err?.message || err?.stack || err || '');
    const isDetached =
      /detached frame/i.test(msg) ||
      /execution context was destroyed/i.test(msg) ||
      /target closed/i.test(msg);

    if (isDetached) {
      try { holder.WA_READY = false; } catch (_) {}
      console.log('[WPP] media send detected detached frame -> hard restart');
      try { await hardRestartClient(holder.key); } catch (e) { console.warn('[WPP] hardRestartClient failed', e); }
      return { ok: false, error: 'whatsapp_restarting' };
    }

    throw err;
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// DEBUG: prova qual app está na porta 3001
app.get('/__whoami', (req, res) => {
  res.json({ ok: true, file: __filename });
});

// makeUserClient helper (equivalent to backend/utils/supabaseClients.js)
function makeUserClient(userJwt) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!userJwt) throw new Error('userJwt is required to create user client');
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false },
  });
}

// Rota que o financeiro.html está chamando (lógica copiada de backend/routes/financeRace.js)
app.get('/api/finance-race', async (req, res) => {
  try {
    const authHeader = req.header('authorization') || req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const token = authHeader.split(' ')[1];

    const companyId = req.query.companyId;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });

    let userClient;
    try {
      userClient = makeUserClient(token);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create user supabase client' });
    }

    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) return res.status(401).json({ error: 'Invalid token' });
    const userId = authData.user.id;

    const { data: mem, error: memErr } = await userClient
      .from('memberships')
      .select('role,is_active')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle();

    if (memErr) return res.status(500).json({ error: 'Failed to validate membership' });
    if (!mem) return res.status(403).json({ error: 'Not authorized (no active membership)' });

    const { data: company, error: compErr } = await userClient
      .from('companies')
      .select('id,meta_por_fretes,meta_fretes,meta_lucro,meta_mensal_fretes,meta_mensal_lucro,comissao_pct')
      .eq('id', companyId)
      .maybeSingle();

    console.log('[FINANCEIRO][COMPANY_CONFIG] companyId=', companyId);
    console.log('[FINANCEIRO][COMPANY_CONFIG] compErr=', compErr);
    console.log('[FINANCEIRO][COMPANY_CONFIG] company=', company);

    if (compErr) return res.status(500).json({ error: 'Failed to load company config' });
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const now = new Date();
    const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).toISOString();
    const monthEndIso = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0).toISOString();
    console.log('[FINANCEIRO] month_start=', monthStartIso);

    const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

    const { data: approvedQuotes, error: approvedErr } = await userClient
      .from('quotes')
      .select('id,responsible_member_id,lucro_value,comissao_value')
      .eq('company_id', companyId)
      .eq('is_approved', true)
      .gte('approved_at', monthStartIso)
      .lt('approved_at', monthEndIso);

    if (approvedErr) {
      console.log('[FINANCEIRO][QUOTES_APPROVED] approvedErr=', approvedErr);
      return res.status(500).json({ error: 'Failed to load approved quotes', details: approvedErr });
    }

    const { data: createdQuotes, error: createdErr } = await userClient
      .from('quotes')
      .select('id,responsible_member_id')
      .eq('company_id', companyId)
      .not('responsible_member_id', 'is', null)
      .gte('created_at', monthStartIso)
      .lt('created_at', monthEndIso);

    if (createdErr) {
      console.log('[FINANCEIRO][QUOTES_CREATED] createdErr=', createdErr);
      return res.status(500).json({ error: 'Failed to load created quotes', details: createdErr });
    }

    const { data: commissionQuotes, error: commissionErr } = await userClient
      .from('quotes')
      .select('id,responsible_member_id,approved_at,comissao_value')
      .eq('company_id', companyId)
      .eq('is_approved', true)
      .not('responsible_member_id', 'is', null)
      .not('approved_at', 'is', null)
      .gte('approved_at', monthStartIso)
      .lt('approved_at', monthEndIso);

    if (commissionErr) {
      console.log('[FINANCEIRO][QUOTES_COMMISSION] commissionErr=', commissionErr);
      return res.status(500).json({ error: 'Failed to load commission quotes', details: commissionErr });
    }

    const totalQuoteToUser = new Map();
    for (const q of (createdQuotes || [])) {
      if (!q?.id || !q?.responsible_member_id) continue;
      totalQuoteToUser.set(q.id, q.responsible_member_id);
    }
    for (const q of (approvedQuotes || [])) {
      if (!q?.id || !q?.responsible_member_id) continue;
      totalQuoteToUser.set(q.id, q.responsible_member_id);
    }

    const totalByUser = new Map();
    for (const memberId of totalQuoteToUser.values()) {
      totalByUser.set(memberId, (totalByUser.get(memberId) || 0) + 1);
    }

    const approvedByUser = new Map();
    for (const q of (approvedQuotes || [])) {
      const k = q.responsible_member_id;
      if (!k) continue;
      const cur = approvedByUser.get(k) || { user_id: k, fretes: 0, lucro: 0, comissao: 0 };
      cur.fretes += 1;
      cur.lucro += Number(q.lucro_value || 0);
      approvedByUser.set(k, cur);
    }

    const comissaoByUser = new Map();
    for (const q of (commissionQuotes || [])) {
      const k = q.responsible_member_id;
      if (!k) continue;
      const v = comissaoByUser.get(k) || 0;
      const add = Number(q?.comissao_value || 0);
      comissaoByUser.set(k, round2(v + add));
    }

    const __debug_comissao_map = Array.from(comissaoByUser.entries()).map(([k, v]) => ({ k, v }));
    console.log('[FINANCE_RACE][DEBUG COMISSAO MAP]', __debug_comissao_map);

    const allUserIds = new Set([ ...Array.from(totalByUser.keys()), ...Array.from(approvedByUser.keys()), ...Array.from(comissaoByUser.keys()) ]);
    const items = Array.from(allUserIds).map((memberId) => {
      const approved = approvedByUser.get(memberId) || { user_id: memberId, fretes: 0, lucro: 0, comissao: 0 };
      const key = memberId; // memberId == responsible_member_id == memberships.id
      const com = comissaoByUser.get(key);
      const comissaoFinal = Number.isFinite(Number(com)) ? Number(com) : 0;
      return {
        user_id: memberId,
        fretes: approved.fretes,
        lucro: approved.lucro,
        comissao: comissaoFinal,
        total_responsible: totalByUser.get(memberId) || 0,
      };
    });

    const effectiveMetaFretes = (company.meta_mensal_fretes != null ? company.meta_mensal_fretes : company.meta_fretes);
    const effectiveMetaLucro = (company.meta_mensal_lucro != null ? company.meta_mensal_lucro : company.meta_lucro);
    const meta = company.meta_por_fretes ? Number(effectiveMetaFretes || 0) : Number(effectiveMetaLucro || 0);

    const out = [];
    for (const x of items) {
      const corrida = company.meta_por_fretes ? x.fretes : x.lucro;
      const pct = meta > 0 ? (corrida / meta) * 100 : 0;
      const item = { ...x, corrida, value: corrida, meta, pct };
      out.push(item);
      const memberId = x.user_id;
      const comissaoFinal = x.comissao;
      if (memberId === '8ade0d63-c65e-4fc5-b8b2-dacfd757f0dc') {
        console.log('[FINANCE_RACE][ADMIN ITEM]', { memberId, comissaoFinal, comissaoMapValue: comissaoByUser.get(memberId) });
      }
    }

    out.sort((a, b) => (Number(b.corrida || 0) - Number(a.corrida || 0)) || String(a.name || '').localeCompare(String(b.name || '')));

    const __debug_version = 'finance-race-DEBUG-2026-03-02-A';

    const __debug_period = { monthStartIso, monthEndIso, companyId, userId };

    const __debug_approved_sample = (approvedQuotes || []).slice(0, 10).map(q => ({
      id: q.id,
      responsible_member_id: q.responsible_member_id,
      approved_at: q.approved_at,
      comissao_value: q.comissao_value,
      lucro_value: q.lucro_value,
    }));

    return res.json({
      __debug_version,
      __debug_period,
      __debug_approved_sample,
      __debug_comissao_map,
      company: {
        id: company.id,
        meta_por_fretes: company.meta_por_fretes,
        meta_fretes: (effectiveMetaFretes != null ? effectiveMetaFretes : company.meta_fretes),
        meta_lucro: (effectiveMetaLucro != null ? effectiveMetaLucro : company.meta_lucro),
        meta_mensal_fretes: company.meta_mensal_fretes,
        meta_mensal_lucro: company.meta_mensal_lucro,
        comissao_pct: company.comissao_pct
      },
      month_start: monthStartIso,
      period: { start: monthStartIso, end: monthEndIso },
      items: out
    });
  } catch (e) {
    console.error('[/api/finance-race] error', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /wpp/status?companyId=...&membershipId=...
 * Retorna status e se existe QR pendente.
 */
app.get("/wpp/status", async (req, res) => {
  try {
    const { companyId, membershipId } = req.query || {};

    // Se faltar params, devolve debug com sessões em memória
    if (!companyId || !membershipId) {
      const active = Array.from(clients.entries()).map(([key, holder]) => ({
        key,
        status: holder?.status ?? "unknown",
        hasQr: Boolean(holder?.lastQrDataUrl),
      }));

      return res.json({ ok: true, status: "missing_params", active });
    }

    const key = keyOf(companyId, membershipId);
    const holder = clients.get(key);

    // persistir status básico no Supabase (não bloquear resposta)
    try { await upsertWhatsappSession({ companyId, membershipId, status: holder?.status || "disconnected" }); } catch(_) {}

    if (!holder) {
      return res.json({ ok: true, status: "disconnected", hasQr: false });
    }

    return res.json({
      ok: true,
      status: holder.status,
      hasQr: Boolean(holder.lastQrDataUrl),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /wpp/qr?companyId=...&membershipId=...
 * Retorna dataUrl do QR (ou null se já estiver ready).
 */
app.get("/wpp/qr", async (req, res) => {
  const { companyId, membershipId } = req.query;

  try {
    const key = keyOf(companyId, membershipId);
    const existing = clients.get(key);
    if (!existing) {
      // dispara init em background e responde imediatamente
      getOrCreateClient(companyId, membershipId).catch(e => console.error('[wpp/qr] init background failed', e));
      return res.json({ ok: true, status: "starting", qrDataUrl: null });
    }

    return res.json({ ok: true, status: existing.status, qrDataUrl: existing.lastQrDataUrl });
  } catch (e) {
    const msg = String(e?.message || e || "");
    console.error("[/wpp/qr] FAILED:", e);

    // devolve erro no JSON (pra você ver no DOM)
    return res.status(500).json({
      ok: false,
      error: msg,
    });
  }
});

/**
 * POST /wpp/reset-session
 * Body: { companyId, membershipId }
 */
app.post("/wpp/reset-session", async (req, res) => {
  try {
    const { companyId, membershipId } = req.body || {};
    if (!companyId || !membershipId) return res.status(400).json({ ok: false, error: "companyId e membershipId são obrigatórios" });

    const key = keyOf(companyId, membershipId);
    const holder = clients.get(key);

    if (holder && holder.client) {
      try { await holder.client.destroy(); } catch (_) {}
    }

    try { clients.delete(key); } catch (_) {}
    const sessionPath = path.join(AUTH_DIR, `session-session-${key}`);
    await rmrfSafe(sessionPath);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * POST /wpp/send
 * Body:
 * {
 *   "companyId": "...",
 *   "membershipId": "...",
 *   "to": "...",
 *   "message": "..."
 * }
 */

app.post("/wpp/send", async (req, res) => {
  try {
    const { companyId, membershipId, to, message, proposalPdfBase64, proposalPdfName, proposalPdfUrl } = req.body || {};
    if (!companyId || !membershipId) return res.status(400).json({ ok:false, error:"companyId e membershipId são obrigatórios" });
    if (!to || !message) return res.status(400).json({ ok:false, error:"to e message são obrigatórios" });

    const key = keyOf(companyId, membershipId);
    const holder = clients.get(key);
    if (!holder) {
      return res.status(409).json({ ok: false, error: "Sessão não inicializada. Abra /wpp/qr para conectar.", status: "disconnected" });
    }

    if (!holder.WA_READY) {
      return res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
    }

    // DEBUG: log incoming message to inspect newlines/escaping
    try { console.log('[WPP] /wpp/send incoming message (stringified):', JSON.stringify(message)); } catch (e) {}
    try { console.log('[WPP] /wpp/send incoming message (raw):\n', message); } catch (e) {}

    // Normaliza número:
    // - se vier "+55..." vira "55...@c.us"
    // - se já vier "...@c.us" usa direto
    // DEBUG: log incoming message to inspect newlines/escaping
    try { console.log('[WPP] /wpp/send-text incoming message (stringified):', JSON.stringify(message)); } catch (e) {}
    try { console.log('[WPP] /wpp/send-text incoming message (raw):\n', message); } catch (e) {}

    let chatId = String(to).trim();
    if (chatId.startsWith("+")) chatId = chatId.replace(/\D/g, "");
    if (/^\d+$/.test(chatId)) chatId = `${chatId}@c.us`;

    return enqueueSend(async () => {
      if (!holder.WA_READY) {
        res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
        return;
      }

      try {
        // 1) enviar a mensagem de texto primeiro
        const textResult = await holder.client.sendMessage(chatId, String(message));

        // 2) se houver PDF (URL assinada ou base64), baixar/converter e enviar como documento separado
        if (proposalPdfBase64 || proposalPdfUrl) {
          try {
            let b64 = null;
            if (proposalPdfBase64) {
              b64 = String(proposalPdfBase64 || '').replace(/^data:.*;base64,/, '');
            } else if (proposalPdfUrl) {
              const resp = await fetch(String(proposalPdfUrl));
              if (!resp.ok) throw new Error('fetch_failed');
              const arr = await resp.arrayBuffer();
              b64 = Buffer.from(arr).toString('base64');
            }
            if (!b64) throw new Error('no_pdf_data');
            const name = String(proposalPdfName || 'proposta.pdf');
            const media = new MessageMedia('application/pdf', b64, name);
            const mediaResult = await holder.client.sendMessage(chatId, media);
            return res.json({ ok: true, textResult, mediaResult });
          } catch (e) {
            console.error('[WPP] media send failed after text', e);
            // retornar sucesso no texto e informar falha do anexo
            return res.json({ ok: true, textResult, mediaError: String(e?.message || e) });
          }
        }

        return res.json({ ok: true, textResult });
      } catch (err) {
        const msg = String(err?.message || err?.stack || err || '');

        const isDetached =
          /detached frame/i.test(msg) ||
          /execution context was destroyed/i.test(msg) ||
          /target closed/i.test(msg);

        console.error('SEND ERROR:', err);

        if (isDetached) {
          // Responde para quem chamou, e reinicia o processo pra subir limpo
          try { return res.status(503).json({ ok: false, error: 'whatsapp_detached_frame_restarting' }); }
          finally {
            // Dá um tempo mínimo para flush do response e encerra o processo
            setTimeout(() => process.exit(1), 250);
          }
        }

        return res.status(500).json({ ok: false, error: msg });
      }
    });
  } catch (e) {
    console.error("SEND ERROR:", e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      stack: e?.stack,
    });
  }
});

// Alias compatível com a Edge Function: POST /wpp/send-text
app.post("/wpp/send-text", async (req, res) => {
  try {
    const { companyId, membershipId, to, message, quoteId } = req.body || {};
    if (!companyId || !membershipId) return res.status(400).json({ ok: false, error: "companyId e membershipId são obrigatórios" });

    // bypass temporário removido

    if (!to || !message) return res.status(400).json({ ok: false, error: "to e message são obrigatórios." });

    const key = keyOf(companyId, membershipId);
    const holder = clients.get(key);
    if (!holder) {
      return res.status(409).json({ ok: false, error: "Sessão não inicializada. Abra /wpp/qr para conectar.", status: "disconnected" });
    }

    if (!holder.WA_READY) {
      return res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
    }

    // registrar que a sessão está ready (persistência não bloqueante)
    try { await upsertWhatsappSession({ companyId, membershipId, status: "ready" }); } catch(_) {}

    let chatId = String(to).trim();
    if (chatId.startsWith("+")) chatId = chatId.replace(/\D/g, "");
    if (/^\d+$/.test(chatId)) chatId = `${chatId}@c.us`;

    const safe = await enqueueSend(() => safeSendMessage(holder, chatId, message));
    if (!safe.ok) {
      return res.status(503).json({ ok: false, error: safe.error });
    }

    res.json({ ok: true, messageId: safe.result?.id?._serialized || null });
  } catch (e) {
    console.error("SEND ERROR:", e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      stack: e?.stack,
    });
  }
});

// POST /api/whatsapp/send
// Body: { to, message, quoteId?, companyId?, membershipId? }
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { to, message, proposalPdfBase64, proposalPdfName, proposalPdfUrl } = req.body || {};
    if (!to || !message) return res.status(400).json({ ok: false });

    // choose any ready holder
    let anyHolder = null;
    for (const [k, holder] of clients.entries()) {
      if (holder && holder.WA_READY && holder.client) { anyHolder = holder; break; }
    }
    if (!anyHolder) return res.status(503).json({ ok: false, error: 'no_ready_client' });

    let chatId = String(to).trim();
    if (chatId.startsWith('+')) chatId = chatId.replace(/\D/g, '');
    if (/^\d+$/.test(chatId)) chatId = `${chatId}@c.us`;

    // 1) enviar texto primeiro
    const textSafe = await safeSendMessage(anyHolder, chatId, message);
    if (!textSafe.ok) {
      return res.status(503).json({ ok: false, error: textSafe.error });
    }

    // 2) se houver PDF, baixar e enviar como documento separado
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
        if (!b64) throw new Error('no_pdf_data');
        const name = String(proposalPdfName || 'proposta.pdf');
        const media = new MessageMedia('application/pdf', b64, name);
        const mediaResult = await enqueueSend(() => anyHolder.client.sendMessage(chatId, media));
        return res.json({ ok: true, textResult: textSafe, mediaResult });
      } catch (e) {
        console.error('[API WHATSAPP SEND] media send failed', e);
        return res.json({ ok: true, textResult: textSafe, mediaError: String(e?.message || e) });
      }
    }

    return res.json({ ok: true, textResult: textSafe });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

  // POST /api/whatsapp/send-mass
  // Body: { messages: [{ to, body|text }] }
  app.post('/api/whatsapp/send-mass', async (req, res) => {
    try {
      const { messages } = req.body || {};
      if (!Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'messages_required' });

      // find any ready holder
      let anyHolder = null;
      for (const [k, holder] of clients.entries()) {
        if (holder && holder.WA_READY && holder.client) { anyHolder = holder; break; }
      }
      if (!anyHolder) return res.status(503).json({ ok: false, error: 'no_ready_client' });

      // Pré-baixar/normalizar PDFs em paralelo (não trava o lock de envio)
      async function mapWithConcurrency(items, limit, mapper){
        const out = new Array(items.length);
        let idx = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
          while (true) {
            const i = idx++;
            if (i >= items.length) break;
            out[i] = await mapper(items[i], i);
          }
        });
        await Promise.all(workers);
        return out;
      }

      // 1) Pré-baixar/normalizar PDFs em paralelo (não trava o lock de envio)
      const prepared = await mapWithConcurrency(messages, 4, async (m) => {
        let b64 = null;
        if (m.proposalPdfBase64) {
          b64 = String(m.proposalPdfBase64).replace(/^data:.*;base64,/, '');
          return { ...m, __pdfB64: b64 };
        } else if (m.proposalPdfUrl) {
          try {
            const resp = await withTimeout(fetch(String(m.proposalPdfUrl)), 20000, 'pdf_fetch_timeout');
            if (!resp.ok) throw new Error(`fetch_failed_${resp.status}`);
            const arr = await withTimeout(resp.arrayBuffer(), 20000, 'pdf_buffer_timeout');
            b64 = Buffer.from(arr).toString('base64');
            return { ...m, __pdfB64: b64 };
          } catch (e) {
            const errMsg = String(e?.message || e);
            console.warn('[send-mass] prefetch pdf failed for', m?.to || m?.quoteId || '<unknown>', errMsg);
            return { ...m, __pdfB64: null, __pdfErr: errMsg };
          }
        }
        return { ...m, __pdfB64: null };
      });

      const results = [];

      for (const m of prepared) {
        try {
          let to = String(m.to || m.phone || m.toJid || '');
          if (to.startsWith('+')) to = to.replace(/\D/g, '');
          if (/^\d+$/.test(to)) to = `${to}@c.us`;

          const body = String(m.body || m.text || '');
          const name = String(m.proposalPdfName || 'proposta.pdf');

          // Se o pré-fetch falhou, não tente enviar o PDF — reportar e continuar
          if (m.__pdfErr) {
            results.push({ to: m.to, ok: false, error: m.__pdfErr });
            continue;
          }

          // Se tem PDF, envia UMA vez só: documento + caption
          if (m.__pdfB64) {
            const captionOk = body.length <= 1000; // limite seguro do caption
            const caption = captionOk ? body : body.slice(0, 997) + '...';

            const media = new MessageMedia('application/pdf', m.__pdfB64, name);

            const r = await safeSendMedia(anyHolder, to, media, { caption });
            if (!r.ok) {
              results.push({ to: m.to, ok: false, error: r.error });
            } else {
              // Se estourou o caption, manda o resto como 2ª msg (vai acontecer raramente)
              if (!captionOk) {
                const rest = body.slice(1000);
                if (rest.trim()) await safeSendMessage(anyHolder, to, rest);
              }
              results.push({ to: m.to, ok: true });
            }
            continue;
          }

          // Sem PDF (fallback)
          const textSafe = await safeSendMessage(anyHolder, to, body);
          if (!textSafe.ok) results.push({ to: m.to, ok: false, error: textSafe.error });
          else results.push({ to: m.to, ok: true });

        } catch (e) {
          results.push({ to: m.to, ok: false, error: String(e?.message || e) });
        }
      }

      return res.json({ ok: true, results });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

// POST /wpp/logout
app.post("/wpp/logout", async (req, res) => {
  try {
    const { companyId, membershipId } = req.body || {};

    // 1) if a global.client exists, use it
    if (global.client) {
      try {
        await global.client.logout();
      } catch (e) { console.warn('[WPP LOGOUT] global.client.logout failed', e); }
      return res.json({ ok: true, info: 'global_client_logged_out' });
    }

    // 2) if companyId+membershipId provided, logout that specific client
    if (companyId && membershipId) {
      try {
        const key = keyOf(companyId, membershipId);
        const holder = clients.get(key);
        if (!holder || !holder.client) return res.json({ ok: false, error: 'client_not_initialized' });
        await holder.client.logout();
        // destroy and remove holder
        try { await holder.client.destroy(); } catch(_) {}
        clients.delete(key);
        return res.json({ ok: true, info: 'client_logged_out', key });
      } catch (e) {
        console.error('[WPP LOGOUT] specific logout failed', e);
        return res.status(500).json({ ok: false, error: String(e) });
      }
    }

    // 3) otherwise try to logout any ready clients (best-effort)
    const loggedOut = [];
    for (const [k, holder] of Array.from(clients.entries())) {
      try {
        if (holder && holder.client) {
          try { await holder.client.logout(); } catch(e){ /* ignore per-client logout errors */ }
          try { await holder.client.destroy(); } catch(_) {}
          clients.delete(k);
          loggedOut.push(k);
        }
      } catch (e) {
        console.warn('[WPP LOGOUT] failed for', k, e);
      }
    }

    if (loggedOut.length === 0) return res.json({ ok: false, error: 'client_not_initialized' });
    return res.json({ ok: true, loggedOut });
  } catch (e) {
    console.error("[WPP LOGOUT]", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Evita que o processo finalize por stdin fechado
process.stdin.resume();

// Small heartbeat to keep the event loop active in weird environments.
// Isso é opcional, mas garante que o process não morra por falta de tarefas.
setInterval(() => {}, 60 * 1000);

const server = app.listen(PORT, '0.0.0.0');
server.on('error', console.error);
server.on('listening', () => {
  const addr = server.address();
  const host = addr && addr.address ? addr.address : '0.0.0.0';
  const port = addr && addr.port ? addr.port : PORT;
  console.log(`[WPP] service listening on http://${host}:${port}`);
  console.log(`[WPP] SESSION_DIR=${SESSION_DIR}`);
  // Bootstrapping sessions persisted by LocalAuth in SESSION_DIR/auth
  (async () => {
    try {
      const authDir = path.join(SESSION_DIR, "auth");
      if (!fs.existsSync(authDir)) return;

      const entries = fs.readdirSync(authDir, { withFileTypes: true });
      const prefix = "session-session-";
      const sessionDirs = entries.filter(e => e.isDirectory() && e.name.startsWith(prefix)).map(e => e.name);
      const keys = sessionDirs.map(name => name.slice(prefix.length));

      if (!keys.length) return;

      console.log(`[WPP] Bootstrapping ${keys.length} sessions from disk`);

      for (const key of keys) {
        if (clients.has(key)) continue;
        // fire-and-forget
        Promise.resolve().then(() => buildClientForKey(key)).catch(err => console.error("Bootstrap error for key", key, err));
      }
    } catch (err) {
      console.error("WPP bootstrap failed:", err);
    }
  })();
});

// PATCH /api/quotes/:id  (same behavior as backend/routes/quotes.js)
app.patch('/api/quotes/:id', async (req, res) => {
  try {
    const authHeader = req.header('authorization') || req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const token = authHeader.split(' ')[1];

    let userClient;
    try { userClient = makeUserClient(token); } catch (err) { return res.status(500).json({ error: 'Failed to create user supabase client' }); }

    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) return res.status(401).json({ error: 'Invalid token' });

    const userId = authData.user.id;
    const quoteId = req.params.id;

    // 1) Load quote company_id
    const { data: quote, error: qErr } = await userClient
      .from('quotes')
      .select('id,company_id')
      .eq('id', quoteId)
      .maybeSingle();

    if (qErr) return res.status(500).json({ error: 'Failed to load quote' });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    const companyId = quote.company_id;

    // 2) Validate membership
    const { data: memberships, error: memErr } = await userClient
      .from('memberships')
      .select('role,is_active')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .eq('is_active', true);

    if (memErr) return res.status(500).json({ error: 'Failed to validate membership' });
    if (!memberships || memberships.length === 0) return res.status(403).json({ error: 'Not authorized (no active membership)' });

    const role = memberships[0].role;

    // 3) Build payload
    const body = req.body || {};
    const approving = body.is_approved === true;

    if (approving && !['admin', 'comercial'].includes(role)) {
      return res.status(403).json({ error: 'role not allowed to approve quote' });
    }

    console.log('[APPROVAL] quote=', quoteId, 'approved=', approving, 'role=', role);

    const update = {
      is_approved: approving,
      approved_at: approving ? new Date().toISOString() : null,
      approved_by: approving ? userId : null,
      cte_value: body.cte_value ?? null,
      tax_value: body.tax_value ?? null,
      lucro_value: body.lucro_value ?? null,
      coleta_paga: body.coleta_paga === true,
      coleta_valor: body.coleta_valor ?? null,
      entrega_paga: body.entrega_paga === true,
      entrega_valor: body.entrega_valor ?? null,
      operacional_adicionais_obs: body.operacional_adicionais_obs ?? null,
      operacional_adicionais_valor: body.operacional_adicionais_valor ?? null,
    };

    const { data: updated, error: upErr } = await sb
      .from('quotes')
      .update(update)
      .eq('id', quoteId)
      .select('*')
      .maybeSingle();

    if (upErr) return res.status(500).json({ error: 'Failed to update quote', details: upErr.message });
    return res.json({ ok: true, quote: updated });
  } catch (e) {
    console.error('[/api/quotes/:id] error', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});