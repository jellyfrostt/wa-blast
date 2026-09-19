import express from "express";
import pino from "pino";
import multer from "multer";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { restoreSessions, getAllSessionsList, getSession, getSessionSocket, getSessionQr, getSessionConnectionLog, createSession, removeSession, requestSessionPairingCode } from "./sessions.js";
import { stmts } from "./db.js";
import { startBlast, getJobStatus, cancelJob, sendWithRetry } from "./blast.js";
import { newJobId, recordJobStart, recordJobItem, recordJobFinish } from "./history.js";
import { formatPhone, displayPhone } from "./phone.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS) || 10);
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const uploads = new Map();
let lastUploadId = null;

// An explicit uploadId never falls back to someone else's upload.
function getUpload(uploadId) {
  return uploads.get(uploadId || lastUploadId) ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getDefaultSessionId() {
  const sessions = getAllSessionsList();
  const connected = sessions.find(s => s.connected);
  return connected?.id || sessions[0]?.id || null;
}

// ─── Health ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  const sessions = getAllSessionsList();
  const connected = sessions.filter(s => s.connected);
  res.status(connected.length > 0 ? 200 : 503).json({
    status: connected.length > 0 ? "connected" : "disconnected",
    sessions: sessions.map(s => ({ id: s.id, name: s.name, phone: s.phone ? `+${s.phone}` : null, connected: s.connected })),
    contacts: getUpload()?.rows.length ?? 0,
  });
});

// ─── QR (backward compat) ────────────────────────────────────────────────

app.get("/qr", (_req, res) => {
  const sessions = getAllSessionsList();
  const connected = sessions.filter(s => s.connected);
  if (connected.length > 0) return res.send("<h2>WhatsApp sudah terhubung</h2>");

  let html = `<html><body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;flex-direction:column;font-family:sans-serif;gap:20px">`;
  const withQr = sessions.filter(s => s.hasQr);
  if (withQr.length > 0) {
    for (const s of withQr) {
      const qr = getSessionQr(s.id);
      if (qr) html += `<h3>${s.name}</h3><img src="${qr}" style="width:250px;height:250px"/>`;
    }
    html += `<p>WhatsApp &rarr; Linked Devices &rarr; Link a Device</p>`;
  } else if (sessions.length > 0) {
    html += `<h2>Menghubungkan ke WhatsApp...</h2><p>Tunggu sebentar lalu refresh.</p>`;
  } else {
    html += `<h2>Belum ada session</h2><p>Buat session dulu lewat dashboard.</p>`;
  }
  html += `<meta http-equiv='refresh' content='5'></body></html>`;
  res.send(html);
});

// ─── Session management ──────────────────────────────────────────────────

app.get("/api/limits", (_req, res) => {
  res.json({ maxSessions: MAX_SESSIONS });
});

app.post("/api/sessions", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name wajib diisi" });
  if (getAllSessionsList().length >= MAX_SESSIONS) {
    return res.status(400).json({ error: `Sudah mencapai batas ${MAX_SESSIONS} nomor. Hapus dulu nomor yang tidak dipakai.` });
  }
  const id = `s_${Date.now()}`;
  try {
    const session = await createSession(id, name, logger);
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(getAllSessionsList());
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const list = getAllSessionsList();
  const info = list.find(s => s.id === req.params.id);
  res.json({ ...info, connectionLog: getSessionConnectionLog(req.params.id) });
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await removeSession(req.params.id, logger);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/:id/qr", (req, res) => {
  const qr = getSessionQr(req.params.id);
  res.json({ qr });
});

app.post("/api/sessions/:id/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone wajib diisi" });
  try {
    const code = await requestSessionPairingCode(req.params.id, phone.replace(/\D/g, ""), logger);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Chat & Messages ─────────────────────────────────────────────────────

app.get("/api/sessions/:id/chats", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const chats = stmts.getChats.all(req.params.id, limit, offset);
  res.json(chats);
});

app.get("/api/sessions/:id/chats/:jid/messages", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const messages = stmts.getMessages.all(req.params.id, req.params.jid, limit, offset);
  res.json(messages);
});

// ─── Disconnect ──────────────────────────────────────────────────────────

app.post("/api/disconnect", async (req, res) => {
  const sessionId = req.body.sessionId || getDefaultSessionId();
  if (!sessionId) return res.status(400).json({ error: "Tidak ada session" });
  try {
    await removeSession(sessionId, logger);
    res.json({ ok: true, message: "Disconnected. Buat session baru untuk reconnect." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Quick send (single number, N messages) ─────────────────────────────

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

app.post("/api/quick-send", async (req, res) => {
  const { phone, message, count = 1, delayMin = 3, delayMax = 8, sessionId: reqSessionId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone dan message wajib" });
  if (count < 1) return res.status(400).json({ error: "count harus minimal 1" });

  const sessionId = reqSessionId || getDefaultSessionId();
  if (!sessionId) return res.status(503).json({ error: "Tidak ada session aktif" });
  const sock = getSessionSocket(sessionId);
  if (!sock) return res.status(503).json({ error: "WhatsApp belum terhubung" });

  const jid = formatPhone(phone);
  const display = displayPhone(phone);

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Transfer-Encoding": "chunked",
  });

  let sent = 0, failed = 0;

  const jobId = newJobId("quick");
  recordJobStart(logger, { id: jobId, type: "quick", sessionId, template: message, total: Number(count) });

  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const delay = i % 10 === 0 ? randInt(30, 60) : randInt(delayMin, delayMax);
      await new Promise(r => setTimeout(r, delay * 1000));
    }

    try {
      const result = await sendWithRetry(sessionId, jid, { text: message }, logger);
      sent++;
      try { stmts.insertMessage.run(sessionId, jid, "outgoing", message, result?.key?.id || null, "sent", null, null); } catch {}
      recordJobItem(logger, jobId, { index: i, phone: display, content: message, status: "sent", messageId: result?.key?.id });
      res.write(JSON.stringify({ index: i, phone: display, status: "sent", messageId: result?.key?.id }) + "\n");
      logger.info({ index: i, phone: display, jid, messageId: result?.key?.id }, `Quick send ${i + 1}/${count}`);
    } catch (err) {
      failed++;
      recordJobItem(logger, jobId, { index: i, phone: display, content: message, status: "failed", error: err.message });
      res.write(JSON.stringify({ index: i, phone: display, status: "failed", error: err.message }) + "\n");
      logger.error({ index: i, phone: display, err: err.message }, "Quick send failed");
    }
  }

  recordJobFinish(logger, jobId, "done");
  res.write(JSON.stringify({ done: true, total: count, sent, failed }) + "\n");
  res.end();
});

// ─── Upload contacts ──────────────────────────────────────────────────────

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const ext = req.file.originalname.split(".").pop().toLowerCase();
  let rows;

  try {
    if (ext === "csv") {
      rows = parse(req.file.buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } else if (["xlsx", "xls"].includes(ext)) {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    } else {
      return res.status(400).json({ error: "Format file harus CSV atau Excel (.xlsx/.xls)" });
    }
  } catch (err) {
    return res.status(400).json({ error: `Gagal parse file: ${err.message}` });
  }

  if (!rows.length) return res.status(400).json({ error: "File kosong" });

  rows = rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v === null || v === undefined ? "" : String(v);
    }
    return out;
  });

  const now = Date.now();
  for (const [id, u] of uploads) {
    if (now - u.createdAt > UPLOAD_TTL_MS) uploads.delete(id);
  }
  if (req.body?.replaces) uploads.delete(req.body.replaces);

  const uploadId = `u_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const columns = Object.keys(rows[0]);
  uploads.set(uploadId, { rows, columns, createdAt: now });
  lastUploadId = uploadId;

  logger.info({ uploadId, count: rows.length, columns }, "Contacts uploaded");
  res.json({
    uploadId,
    count: rows.length,
    columns,
    preview: rows.slice(0, 5),
  });
});

// ─── Preview message ──────────────────────────────────────────────────────

app.post("/api/preview", (req, res) => {
  const { template, uploadId } = req.body;
  const upload = getUpload(uploadId);
  if (!upload) return res.status(400).json({ error: "Upload kontak dulu" });
  if (!template) return res.status(400).json({ error: "Template kosong" });

  const previews = upload.rows.slice(0, 3).map((row) => {
    const rendered = template.replace(/\{\{([^}]+)\}\}/g, (_, rawKey) => {
      const key = rawKey.trim();
      if (key in row) return row[key];
      const lower = key.toLowerCase();
      const match = Object.keys(row).find(k => k.toLowerCase() === lower);
      return match ? row[match] : `{{${rawKey}}}`;
    });
    return { row, rendered };
  });

  res.json({ previews });
});

// ─── Send single message ─────────────────────────────────────────────────

app.post("/api/send", async (req, res) => {
  const { phone, message, sessionId: reqSessionId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone dan message wajib diisi" });

  const sessionId = reqSessionId || getDefaultSessionId();
  if (!sessionId) return res.status(503).json({ error: "Tidak ada session aktif" });

  const jid = formatPhone(phone);

  try {
    const result = await sendWithRetry(sessionId, jid, { text: message }, logger);
    try { stmts.insertMessage.run(sessionId, jid, "outgoing", message, result?.key?.id || null, "sent", null, null); } catch {}
    logger.info({ phone: displayPhone(phone), jid, messageId: result?.key?.id }, "Single message sent");
    res.json({ ok: true, phone: displayPhone(phone), jid, messageId: result?.key?.id, baileys: result });
  } catch (err) {
    logger.error({ phone: displayPhone(phone), err: err.message }, "Single message failed");
    res.status(500).json({ error: err.message });
  }
});

// ─── Start blast ──────────────────────────────────────────────────────────

app.post("/api/blast", (req, res) => {
  const { template, delayMin = 3, delayMax = 7, sessionId: reqSessionId, uploadId } = req.body;
  const upload = getUpload(uploadId);
  if (!upload) return res.status(400).json({ error: "Upload kontak dulu" });
  if (!template) return res.status(400).json({ error: "Template kosong" });

  const sessionId = reqSessionId || getDefaultSessionId();
  if (!sessionId) return res.status(503).json({ error: "Tidak ada session aktif" });

  try {
    const job = startBlast(sessionId, upload.rows, template, delayMin, delayMax, logger);
    res.json({ id: job.id, sessionId, status: job.status, total: job.total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Blast stats (delivery/read tracking) ────────────────────────────────

app.get("/api/blast/:jobId/stats", (req, res) => {
  const stats = stmts.getBlastStats.get(req.params.jobId);
  if (!stats) return res.json({ total: 0, sent: 0, delivered: 0, read_count: 0, failed: 0 });
  res.json(stats);
});

// ─── Job status (polling) ─────────────────────────────────────────────────

app.get("/api/status", (req, res) => {
  const job = getJobStatus(req.query.sessionId);
  if (!job) return res.json({ status: "idle" });
  res.json(job);
});

// ─── Cancel blast ─────────────────────────────────────────────────────────

app.post("/api/cancel", (req, res) => {
  cancelJob(req.body?.sessionId);
  res.json({ ok: true });
});

// ─── Job history ──────────────────────────────────────────────────────────

app.get("/api/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  res.json(stmts.getJobs.all(limit, offset));
});

app.get("/api/history/:id", (req, res) => {
  const job = stmts.getJob.get(req.params.id);
  if (!job) return res.status(404).json({ error: "History tidak ditemukan" });
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = parseInt(req.query.offset) || 0;
  res.json({ job, items: stmts.getJobItems.all(job.session_id, job.id, limit, offset) });
});

// ─── Connection log ───────────────────────────────────────────────────────

app.get("/api/connection-log", (req, res) => {
  const sessionId = req.query.sessionId || getDefaultSessionId();
  if (!sessionId) return res.json([]);
  res.json(getSessionConnectionLog(sessionId));
});

// ─── Clear contacts ───────────────────────────────────────────────────────

app.post("/api/clear", (req, res) => {
  const id = req.body?.uploadId || lastUploadId;
  uploads.delete(id);
  if (id === lastUploadId) lastUploadId = null;
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`WA Blast listening on :${PORT}`);
  restoreSessions(logger).catch((err) => {
    logger.error({ err }, "Failed to restore sessions");
  });
});
