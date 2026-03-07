import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from 'url';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

export async function rmrfSafe(targetPath) {
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

export const clients = new Map(); // key = `${companyId}:${membershipId}` -> holder
export const initPromises = new Map(); // key -> Promise resolving to holder

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function normId(x) {
  return String(x || "").trim();
}

export function safeId(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function keyOf(companyId, membershipId) {
  const raw = `${normId(companyId)}:${normId(membershipId)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = (SB_URL && SB_SERVICE_KEY)
  ? createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

export async function upsertWhatsappSession({ companyId, membershipId, status }) {
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

export function toWhatsAppJid(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  const withCountry = digits.startsWith("55") ? digits : `55${digits}`;
  return `${withCountry}@c.us`;
}

export const SESSION_DIR =
  process.env.SESSION_DIR ||
  (process.platform === "win32" ? "C:\\wpp" : "/tmp/wpp");
export const AUTH_DIR = path.join(SESSION_DIR, "auth");

export async function getOrCreateClient(companyId, membershipId) {
  const key = keyOf(companyId, membershipId);
  if (clients.has(key)) return clients.get(key);

  if (initPromises.has(key)) {
    const existing = clients.get(key);
    if (existing) return existing;
    return { client: null, lastQrRaw: null, status: "starting", hasQr: false };
  }

  return await buildClientForKey(key);
}

export function buildClientForKey(key) {
  if (initPromises.has(key)) return initPromises.get(key);

  const promise = (async () => {
    ensureDir(SESSION_DIR);
    ensureDir(AUTH_DIR);

    const now = Date.now();
    const holder = {
      client: null,
      lastQrRaw: null,
      lastQrAt: null,
      hasQr: false,
      status: "starting",
      WA_READY: false,
      key,
      error: null,
      createdAt: now,
      initializingAt: now,
      lastStatusAt: now,
      lastDisconnectReason: null,
      lastAuthFailure: null,
      lastAuthenticatedAt: null,
      lastReadyAt: null,
    };

    const clientId = `session-${key}`;

    const resolvedExecPath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (typeof puppeteer?.executablePath === "function" ? puppeteer.executablePath() : undefined);

    console.log("[WPP] chrome env path =", process.env.PUPPETEER_EXECUTABLE_PATH || "");
    console.log("[WPP] chrome resolvedExecPath =", resolvedExecPath || "(empty)");

    // NOTE: removed single-session enforcement — do not destroy other clients here

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId,
        dataPath: AUTH_DIR,
      }),
      puppeteer: {
        headless: true,
        protocolTimeout: 900000,
        timeout: 900000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--disable-features=site-per-process",
        ],
        executablePath: resolvedExecPath,
      },
    });

    holder.client = client;

    client.on("qr", async (qr) => {
      try {
        holder.status = "qr";
        holder.hasQr = true;
        holder.lastQrRaw = qr;
        holder.lastQrAt = Date.now();
        holder.WA_READY = false;
        holder.error = null;
        holder.lastStatusAt = Date.now();
        // persistência via upsertWhatsappSession requer company/membership; não disponível aqui
        console.log(`[WPP] QR raw recebido para ${key}`);
      } catch (e) {
        console.warn('[WPP] qr handler failed', e?.message || e);
      }
    });

    client.on("ready", () => {
      holder.status = "ready";
      holder.lastQrRaw = null;
      holder.lastQrAt = null;
      holder.hasQr = false;
      holder.WA_READY = true;
      holder.error = null;
      holder.lastReadyAt = Date.now();
      holder.lastStatusAt = Date.now();
      console.log(`[WPP] Ready: ${key}`);
    });

    client.on("authenticated", () => {
      console.log(`[WPP] Authenticated: ${key}`);
      holder.lastAuthenticatedAt = Date.now();
      holder.error = null;
    });

    client.on("auth_failure", (msg) => {
      holder.status = "auth_failure";
      holder.WA_READY = false;
      holder.hasQr = false;
      holder.lastQrRaw = null;
      holder.lastQrAt = null;
      holder.error = String(msg || 'auth_failure');
      holder.lastAuthFailure = { at: Date.now(), message: String(msg || 'auth_failure') };
      holder.lastStatusAt = Date.now();
      console.log(`[WPP] Auth failure ${key}:`, msg);
    });

    client.on("disconnected", (reason) => {
      holder.status = "disconnected";
      holder.WA_READY = false;
      holder.hasQr = false;
      holder.lastQrRaw = null;
      holder.lastQrAt = null;
      holder.lastDisconnectReason = String(reason || 'disconnected');
      holder.lastStatusAt = Date.now();
      console.log(`[WPP] Disconnected ${key}:`, reason);
    });

    client.on("loading_screen", (percent, message) => {
      console.log(`[WPP] loading ${key}: ${percent}% - ${message}`);
    });

    client.on("change_state", (state) => {
      console.log(`[WPP] state ${key}:`, state);
    });

    client.on("error", (err) => {
      try { holder.WA_READY = false; } catch (_) {}
      holder.status = "error";
      holder.error = String(err?.message || err || 'error');
      holder.lastStatusAt = Date.now();
      console.log(`[WPP] ERROR ${key}:`, err);
    });

    clients.set(key, holder);

    try {
      console.log('[WPP] initializing...', key);
      await client.initialize();
      console.log('[WPP] initialize done', key);
      // Não forçar 'ready' automaticamente — manter 'qr' se houver,
      // ou marcar 'ready' somente se o evento 'ready' já definiu WA_READY.
      // Importante: não sobrescrever estados reais (auth_failure, disconnected, error)
      if (holder.status === 'qr') {
        // manter 'qr'
      } else if (holder.WA_READY) {
        holder.status = 'ready';
      } else {
        // manter status atual (não mascarar auth_failure/disconnected/error com 'starting')
      }
    } catch (err) {
      console.error('[WPP] initialize failed (continuing API up):', err?.message || err);
      holder.status = 'error';
      holder.error = String(err?.message || err);
    } finally {
      try { initPromises.delete(key); } catch (_) {}
    }

    return holder;
  })();

  initPromises.set(key, promise);
  return promise;
}

// Exports are declared on the functions/consts above; no aggregated export here to avoid duplicate export errors.