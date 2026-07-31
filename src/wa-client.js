import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");

import pino from "pino";
import { rm, readdir, unlink } from "fs/promises";
import { toDataURL } from "qrcode";

const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

let sock = null;
let latestQr = null;
let pairingCode = null;
let reconnectAttempt = 0;
let connectionLog = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getSocket() {
  return sock;
}

export function getQrDataUrl() {
  return latestQr;
}

export function getPairingCode() {
  return pairingCode;
}

export function getConnectionLog() {
  return connectionLog;
}

function logConnection(event, data) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  connectionLog.push(entry);
  if (connectionLog.length > 200) connectionLog.shift();
}

export async function initWhatsApp(logger) {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
    logger.info({ version }, "Fetched WA version");
  } catch {
    version = [2, 3000, 1015901307];
    logger.warn("Failed to fetch WA version, using fallback");
  }

  const baileysLogger = pino({ level: "silent" });

  const makeSocket = typeof makeWASocket === "function" ? makeWASocket : baileys;

  sock = makeSocket({
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    logger.info(
      { connection, hasQr: !!qr, error: lastDisconnect?.error?.message, statusCode: lastDisconnect?.error?.output?.statusCode },
      "connection.update"
    );

    if (qr) {
      latestQr = await toDataURL(qr);
      reconnectAttempt = 0;
      logConnection("qr_ready", {});
      logger.info("QR code ready — visit /qr to scan");
    }

    if (connection === "open") {
      latestQr = null;
      pairingCode = null;
      reconnectAttempt = 0;
      logConnection("connected", { user: sock?.user?.id });
      logger.info("WhatsApp connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logConnection("disconnected", { statusCode, errorMsg, loggedOut, attempt: reconnectAttempt + 1 });

      if (loggedOut) {
        logConnection("logged_out", { reason: "Session terminated by WhatsApp" });
        logger.warn("Logged out — clearing session for fresh QR");
        try { sock.end(); } catch {}
        sock = null;
        await sleep(2000);
        try {
          const files = await readdir("./auth_info");
          for (const f of files) {
            try { await unlink(`./auth_info/${f}`); } catch {}
          }
          logger.info({ cleared: files.length }, "Session files cleared");
        } catch (e) {
          logger.warn({ err: e.message }, "Could not clear session files");
        }
        reconnectAttempt = 0;
        await sleep(2000);
        await initWhatsApp(logger);
        return;
      }

      reconnectAttempt++;
      if (reconnectAttempt > 8) {
        logConnection("max_reconnect", { attempt: reconnectAttempt });
        logger.error("Max reconnect attempts (8) — stopping. Re-scan QR to reconnect.");
        sock = null;
        return;
      }
      const base = Math.min(reconnectAttempt * 5000, 60000);
      const jitter = Math.floor(Math.random() * 3000);
      const delay = base + jitter;
      logConnection("reconnecting", { attempt: reconnectAttempt, delaySec: delay / 1000 });
      logger.info(`Connection closed (attempt ${reconnectAttempt}/8), reconnecting in ${(delay / 1000).toFixed(1)}s...`);
      await sleep(delay);
      await initWhatsApp(logger);
    }
  });
}

export async function disconnectAndClear(logger) {
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  await sleep(2000);
  try {
    const files = await readdir("./auth_info");
    for (const f of files) {
      try { await unlink(`./auth_info/${f}`); } catch {}
    }
    logger.info({ cleared: files.length }, "Session files cleared via disconnect");
  } catch {}
  reconnectAttempt = 0;
  await sleep(1000);
  await initWhatsApp(logger);
}

export async function requestPairingCode(phoneNumber, logger) {
  if (!sock) throw new Error("Socket not initialized");
  const code = await sock.requestPairingCode(phoneNumber);
  pairingCode = code;
  logger.info("Pairing code generated");
  return code;
}
