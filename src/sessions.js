import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");

import pino from "pino";
import { rm, readdir, unlink, mkdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { toDataURL } from "qrcode";
import { stmts } from "./db.js";

const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

const sessions = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authDir(id) {
  return `./auth_info/${id}`;
}

function logConnection(session, event, data) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  session.connectionLog.push(entry);
  if (session.connectionLog.length > 200) session.connectionLog.shift();
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function getAllSessionsList() {
  const rows = stmts.getAllSessions.all();
  return rows.map((r) => {
    const live = sessions.get(r.id);
    return {
      ...r,
      connected: live?.sock?.user != null,
      phone: live?.sock?.user?.id?.replace(/:.*/, "") || r.phone,
      hasQr: !!live?.qr,
    };
  });
}

export function getSessionSocket(id) {
  const s = sessions.get(id);
  if (!s?.sock?.user) return null;
  return s.sock;
}

export function getSessionQr(id) {
  return sessions.get(id)?.qr || null;
}

export function getSessionConnectionLog(id) {
  return sessions.get(id)?.connectionLog || [];
}

export async function createSession(id, name, logger) {
  if (stmts.getSession.get(id)) throw new Error(`Session "${id}" already exists`);

  const dir = authDir(id);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  stmts.insertSession.run(id, name);

  sessions.set(id, {
    id,
    name,
    sock: null,
    qr: null,
    pairingCode: null,
    reconnectAttempt: 0,
    connectionLog: [],
  });

  await initSession(id, logger);
  return { id, name };
}

export async function removeSession(id, logger) {
  const live = sessions.get(id);
  if (live?.sock) {
    try { await live.sock.logout(); } catch {}
    try { live.sock.end(); } catch {}
  }
  sessions.delete(id);
  stmts.deleteSession.run(id);
  try {
    await rm(authDir(id), { recursive: true, force: true });
  } catch {}
  logger.info({ sessionId: id }, "Session removed");
}

export async function requestSessionPairingCode(id, phoneNumber, logger) {
  const live = sessions.get(id);
  if (!live?.sock) throw new Error("Session not initialized");
  const code = await live.sock.requestPairingCode(phoneNumber);
  live.pairingCode = code;
  logger.info({ sessionId: id }, "Pairing code generated");
  return code;
}

// ─── Socket init ──────────────────────────────────────────────────────────

async function initSession(sessionId, logger) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const dir = authDir(sessionId);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);

  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {
    version = [2, 3000, 1015901307];
  }

  const baileysLogger = pino({ level: "silent" });
  const makeSock = typeof makeWASocket === "function" ? makeWASocket : baileys;

  const sock = makeSock({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore
        ? makeCacheableSignalKeyStore(state.keys, baileysLogger)
        : state.keys,
    },
    version,
    logger: baileysLogger,
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    browser: ["Chrome", "Windows", "10.0"],
  });

  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  // ── Incoming messages ──
  sock.ev.on("messages.upsert", ({ messages: msgs }) => {
    for (const msg of msgs) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid === "status@broadcast") continue;

      const content =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "[media]";

      try {
        stmts.insertMessage.run(
          sessionId, jid, "incoming", content,
          msg.key.id, "received", null, msg.pushName || null,
        );
      } catch (err) {
        logger.warn({ sessionId, err: err.message }, "Failed to store incoming message");
      }
    }
  });

  // ── Outgoing message status updates ──
  sock.ev.on("messages.update", (updates) => {
    const statusMap = { 2: "sent", 3: "delivered", 4: "read", 5: "read" };
    for (const { key, update } of updates) {
      const mapped = statusMap[update?.status];
      if (!mapped || !key.id) continue;
      try {
        stmts.updateMessageStatus.run(mapped, key.id, sessionId);
      } catch (err) {
        logger.warn({ sessionId, messageId: key.id, err: err.message }, "Failed to update message status");
      }
    }
  });

  // ── Connection lifecycle ──
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    logger.info(
      { sessionId, connection, hasQr: !!qr, statusCode: lastDisconnect?.error?.output?.statusCode },
      "connection.update",
    );

    if (qr) {
      session.qr = await toDataURL(qr);
      session.reconnectAttempt = 0;
      logConnection(session, "qr_ready", {});
      stmts.updateSessionStatus.run("waiting_qr", sessionId);
    }

    if (connection === "open") {
      session.qr = null;
      session.pairingCode = null;
      session.reconnectAttempt = 0;
      logConnection(session, "connected", { user: sock?.user?.id });

      const phone = sock?.user?.id?.replace(/:.*/, "") || null;
      if (phone) stmts.updateSessionPhone.run(phone, sessionId);
      else stmts.updateSessionStatus.run("connected", sessionId);

      logger.info({ sessionId, phone }, "Session connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logConnection(session, "disconnected", { statusCode, errorMsg, loggedOut });
      stmts.updateSessionStatus.run("disconnected", sessionId);

      if (loggedOut) {
        logger.warn({ sessionId }, "Logged out — clearing session for fresh QR");
        try { sock.end(); } catch {}
        session.sock = null;
        await sleep(2000);
        try {
          const files = await readdir(dir);
          for (const f of files) {
            try { await unlink(`${dir}/${f}`); } catch {}
          }
        } catch {}
        session.reconnectAttempt = 0;
        await sleep(2000);
        await initSession(sessionId, logger);
        return;
      }

      session.reconnectAttempt++;
      if (session.reconnectAttempt > 8) {
        logConnection(session, "max_reconnect", { attempt: session.reconnectAttempt });
        logger.error({ sessionId }, "Max reconnect attempts (8) — stopping");
        session.sock = null;
        return;
      }

      const base = Math.min(session.reconnectAttempt * 5000, 60000);
      const jitter = Math.floor(Math.random() * 3000);
      const delay = base + jitter;
      logConnection(session, "reconnecting", { attempt: session.reconnectAttempt, delaySec: delay / 1000 });
      logger.info({ sessionId, attempt: session.reconnectAttempt }, `Reconnecting in ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
      await initSession(sessionId, logger);
    }
  });
}

// ─── Startup: restore sessions + legacy migration ─────────────────────────

export async function restoreSessions(logger) {
  let rows = stmts.getAllSessions.all();

  if (rows.length === 0 && existsSync("./auth_info")) {
    const entries = await readdir("./auth_info").catch(() => []);
    const jsonFiles = entries.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length > 0) {
      const dest = authDir("default");
      await mkdir(dest, { recursive: true });
      for (const f of jsonFiles) {
        await copyFile(`./auth_info/${f}`, `${dest}/${f}`).catch(() => {});
      }
      stmts.insertSession.run("default", "Default");
      logger.info("Migrated legacy session to multi-session format");
      rows = stmts.getAllSessions.all();
    }
  }

  for (const r of rows) {
    sessions.set(r.id, {
      id: r.id,
      name: r.name,
      sock: null,
      qr: null,
      pairingCode: null,
      reconnectAttempt: 0,
      connectionLog: [],
    });
    await initSession(r.id, logger);
  }

  logger.info({ count: rows.length }, "Sessions restored");
}
