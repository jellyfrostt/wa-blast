// Boots the real server with src/sessions.js replaced by fake connected sockets (no WhatsApp).
// Needs: node --experimental-test-module-mocks. The database and logs go to the current directory,
// so run through test/run.mjs, which uses a temporary folder.
import { mock } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { rmSync, mkdirSync } from "node:fs";

export const REPO = fileURLToPath(new URL("..", import.meta.url)).split("\\").join("/").replace(/\/$/, "");
export const PORT = 3999;
export const BASE = `http://localhost:${PORT}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sentLog = [];

const SEND_MS = Number(process.env.SEND_MS || 120);
let n = 0;

function fakeSock(id, phone) {
  return {
    user: { id: `${phone}:1@s.whatsapp.net` },
    sendMessage: async (jid, content) => {
      await sleep(SEND_MS);
      if (content.text.includes("FAIL")) throw new Error("not a valid number");
      sentLog.push({ sessionId: id, jid, text: content.text });
      return { key: { id: `MSG${++n}` } };
    },
  };
}

const N_SESSIONS = Number(process.env.N_SESSIONS || 0);
const defs = N_SESSIONS
  ? Array.from({ length: N_SESSIONS }, (_, i) => ({ id: `s${i + 1}`, name: `Nomor ${i + 1}`, phone: `62811${String(i + 1).padStart(6, "0")}` }))
  : [
      { id: "a", name: "Marketing", phone: "6281110001" },
      { id: "b", name: "Sales", phone: "6282220002" },
    ];
const socks = Object.fromEntries(defs.map((d) => [d.id, fakeSock(d.id, d.phone)]));
// Optional unlinked session that shows a QR, for checking the Numbers page.
const FAKE_QR = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#fff"/><rect x="20" y="20" width="60" height="60"/><rect x="140" y="20" width="60" height="60"/><rect x="20" y="140" width="60" height="60"/><rect x="100" y="100" width="30" height="30"/></svg>');
const pending = process.env.WITH_QR ? [{ id: "c", name: "O'Brien <b>CS</b>", phone: null, connected: false, hasQr: true, status: "waiting_qr" }] : [];

export async function boot() {
  const dataDir = `${process.cwd().replace(/\\/g, "/")}/data`;
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  process.env.DB_PATH = `${dataDir}/wa-blast.db`;
  process.env.PORT = String(PORT);
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

  mock.module(pathToFileURL(`${REPO}/src/sessions.js`).href, {
    namedExports: {
      restoreSessions: async () => {},
      getAllSessionsList: () => [...defs.map((d) => ({ ...d, connected: true, hasQr: false, status: "connected" })), ...pending],
      getSession: (id) => [...defs, ...pending].find((d) => d.id === id) ?? null,
      getSessionSocket: (id) => socks[id] ?? null,
      getSessionQr: (id) => (pending.some((p) => p.id === id) ? FAKE_QR : null),
      getSessionConnectionLog: () => [],
      createSession: async () => { throw new Error("not available in harness"); },
      removeSession: async () => {},
      requestSessionPairingCode: async () => { throw new Error("not available in harness"); },
      reconnectSession: async () => { throw new Error("not available in harness"); },
    },
  });

  const db = await import(pathToFileURL(`${REPO}/src/db.js`).href);
  for (const d of defs) {
    db.stmts.insertSession.run(d.id, d.name);
    db.stmts.updateSessionPhone.run(d.phone, d.id);
  }
  await import(pathToFileURL(`${REPO}/src/index.js`).href);
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/api/sessions`); return db; } catch { await sleep(100); }
  }
  throw new Error("server did not start");
}

export async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

export async function upload(csv, replaces) {
  const fd = new FormData();
  if (replaces) fd.append("replaces", replaces);
  fd.append("file", new Blob([csv]), "contacts.csv");
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", body: fd });
  return { status: r.status, json: await r.json() };
}

export async function waitJob(sessionId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await api("GET", `/api/status?sessionId=${sessionId}`);
    if (s.json && !["running", "idle"].includes(s.json.status)) return s.json;
    await sleep(100);
  }
  throw new Error(`job for ${sessionId} did not finish`);
}
