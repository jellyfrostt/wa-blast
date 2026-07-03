import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");

import pino from "pino";
import { rm } from "fs/promises";
import { toDataURL } from "qrcode";

const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

let sock = null;
let latestQr = null;
let pairingCode = null;
let reconnectAttempt = 0;

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
    browser: ["WA Blast", "Chrome", "1.0.0"],
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
      logger.info("QR code ready — visit /qr to scan");
    }

    if (connection === "open") {
      latestQr = null;
      pairingCode = null;
      reconnectAttempt = 0;
      logger.info("WhatsApp connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.warn("Logged out — removing session and exiting");
        await rm("./auth_info", { recursive: true, force: true });
        process.exit(1);
      }

      reconnectAttempt++;
      const delay = Math.min(reconnectAttempt * 5000, 60000);
      logger.info(`Connection closed (attempt ${reconnectAttempt}), reconnecting in ${delay / 1000}s...`);
      await sleep(delay);
      await initWhatsApp(logger);
    }
  });
}

export async function requestPairingCode(phoneNumber, logger) {
  if (!sock) throw new Error("Socket not initialized");
  const code = await sock.requestPairingCode(phoneNumber);
  pairingCode = code;
  logger.info("Pairing code generated");
  return code;
}
