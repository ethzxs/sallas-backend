import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = (SB_URL && SB_SERVICE_KEY)
  ? createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

export const SESSION_DIR =
  process.env.SESSION_DIR || (process.platform === "win32" ? "C:\\wpp" : "/tmp/wpp");
export const AUTH_DIR = path.join(SESSION_DIR, "auth");

export const clients = new Map();
export const initPromises = new Map();

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeRm(targetPath) {
  if (!targetPath) return Promise.resolve();
  return fsp.rm(targetPath, { recursive: true, force: true }).catch(() => {});
}

export function keyOf(companyId, membershipId) {
  const raw = `${String(companyId || "").trim()}:${String(membershipId || "").trim()}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

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

export async function buildClientForKey(key) {
  if (!key) throw new Error('key required');

  // if already initializing, return the existing promise
  if (initPromises.has(key)) return initPromises.get(key);

  const promise = (async () => {
    ensureDir(SESSION_DIR);
    ensureDir(AUTH_DIR);

    const holder = {
      client: null,
      lastQrDataUrl: null,
      status: "starting",
      WA_READY: false,
    };
    holder.key = key;

    const clientId = `session-${key}`;

    const resolvedExecPath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (typeof puppeteer?.executablePath === "function" ? puppeteer.executablePath() : undefined);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId, dataPath: AUTH_DIR }),
      puppeteer: {
        headless: "new",
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
      try { holder.WA_READY = false; } catch (_) {}
      console.log(`[WPP] ERROR ${key}:`, err);
    });

    // registra ANTES de inicializar para evitar corrida
    clients.set(key, holder);

    try {
      await client.initialize();
    } catch (err) {
      console.error('[WPP] initialize failed (continuing API up):', err?.message || err);
    } finally {
      try { initPromises.delete(key); } catch (_) {}
    }

    return holder;
  })();

  initPromises.set(key, promise);
  return promise;
}

export async function getOrCreateClient(companyId, membershipId) {
  const key = keyOf(companyId, membershipId);
  if (clients.has(key)) return clients.get(key);

  if (initPromises.has(key)) {
    const existing = clients.get(key);
    if (existing) return existing;
    return { client: null, lastQrDataUrl: null, status: "starting" };
  }

  return await buildClientForKey(key);
}

export async function hardRestartClient(key) {
  try {
    const holder = clients.get(key);
    if (holder?.client) {
      try { await holder.client.destroy(); } catch (e) {}
    }
  } catch (e) {}

  try { clients.delete(key); } catch (e) {}
  try { initPromises.delete(key); } catch (e) {}

  const newHolder = await buildClientForKey(key);
  return newHolder;
}
