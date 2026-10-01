import express from "express";
import pino from "pino";
import multer from "multer";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { restoreSessions, getAllSessionsList, getSession, getSessionSocket, getSessionQr, getSessionConnectionLog, createSession, removeSession, requestSessionPairingCode, reconnectSession } from "./sessions.js";
import { stmts } from "./db.js";
import { startBlast, getJobStatus, cancelJob, sendWithRetry } from "./blast.js";
import { newJobId, recordJobStart, recordJobItem, recordJobFinish } from "./history.js";
import { formatPhone, displayPhone } from "./phone.js";
import { startBackups, createSnapshot } from "./backup.js";
import { insightsEnabled, insightModel, analyzeChat, chatsNeedingAnalysis } from "./insights.js";
import { mountAuth } from "./auth.js";
import { timingSafeEqual } from "crypto";
import { unlink } from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
// Login routes and, when AUTH_ENABLED=true, the gate in front of every page and API below.
mountAuth(app, logger);
app.use(express.static(join(__dirname, "public")));

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS) || 10);
const INSIGHT_BATCH = 10;
const MAX_QUICK_COUNT = 200;
const MAX_DELAY_SECONDS = 600;

const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// Delays arrive from the browser; keep them numeric, ordered and within a sane range.
function readDelays(min, max, fallbackMin, fallbackMax) {
  const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_DELAY_SECONDS) : fb;
  };
  const a = Math.round(num(min, fallbackMin));
  const b = Math.round(num(max, fallbackMax));
  return a <= b ? [a, b] : [b, a];
}
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
      if (qr) html += `<h3>${escapeHtml(s.name)}</h3><img src="${qr}" style="width:250px;height:250px"/>`;
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

// Removed numbers whose chats are kept. Declared before "/:id" so "archived" is not read as an id.
app.get("/api/sessions/archived", (_req, res) => {
  res.json(stmts.getArchivedSessions.all());
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
    cancelJob(req.params.id);
    await removeSession(req.params.id, logger);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/reconnect", async (req, res) => {
  try {
    await reconnectSession(req.params.id, logger);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
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
  // Numbers are stored as 62..., so a leading 0 typed by the user is dropped before matching.
  const digits = String(req.query.q || "").replace(/\D/g, "").replace(/^0+/, "");
  const chats = stmts.getChats.all(req.params.id, `%${digits}%`, limit, offset, req.params.id);
  res.json(chats);
});

// Only conversations this app started (a phone-number chat with at least one message sent from here).
const isOwnChat = (sessionId, jid) => jid.endsWith("@s.whatsapp.net") && !!stmts.hasOutgoing.get(sessionId, jid);

app.get("/api/sessions/:id/chats/:jid/messages", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  if (!isOwnChat(req.params.id, req.params.jid)) return res.json([]);
  const messages = stmts.getMessages.all(req.params.id, req.params.jid, limit, offset);
  res.json(messages);
});

// Reply inside an existing conversation.
app.post("/api/sessions/:id/chats/:jid/messages", async (req, res) => {
  const { id, jid } = req.params;
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Pesan masih kosong" });
  if (!isOwnChat(id, jid)) return res.status(404).json({ error: "Percakapan tidak ditemukan" });
  if (!getSessionSocket(id)) return res.status(409).json({ error: "Nomor ini sedang tidak terhubung, jadi belum bisa membalas." });
  try {
    const result = await sendWithRetry(id, jid, { text: message }, logger);
    stmts.insertMessage.run(id, jid, "outgoing", message, result?.key?.id || null, "sent", null, null);
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (err) {
    logger.error({ sessionId: id, err: err.message }, "Reply failed");
    res.status(500).json({ error: "Pesan gagal terkirim. Coba lagi sebentar lagi." });
  }
});

// ─── Transcripts (export for analysis) ───────────────────────────────────

const EXCEL_BOM = String.fromCharCode(0xfeff); // lets Excel read the file as UTF-8
const csvCell = (v) => {
  let s = String(v ?? "");
  // Keep spreadsheet apps from running customer text as a formula; plain phone numbers are left as they are.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

app.get("/api/sessions/:id/transcripts", (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Nomor tidak ditemukan" });
  const rows = stmts.transcriptRows.all(session.id, session.id);
  const phoneOf = (jid) => `+${jid.split("@")[0]}`;
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `transkrip-${String(session.name).replace(/[^\w-]+/g, "_")}-${stamp}`;

  if (req.query.format === "csv") {
    const lines = [["nomor_pengirim", "nama_pengirim", "nomor_pelanggan", "nama_pelanggan", "arah", "isi_pesan", "status", "waktu_utc"]];
    const names = new Map();
    for (const r of rows) if (r.sender_name && !names.has(r.jid)) names.set(r.jid, r.sender_name);
    for (const r of rows) {
      lines.push([
        session.phone ? `+${session.phone}` : "", session.name, phoneOf(r.jid), names.get(r.jid) || "",
        r.direction === "outgoing" ? "keluar" : "masuk", r.content, r.status, r.created_at,
      ]);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    return res.send(EXCEL_BOM + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n");
  }

  const conversations = [];
  let current = null;
  for (const r of rows) {
    if (!current || current.jid !== r.jid) {
      current = { jid: r.jid, phone: phoneOf(r.jid), contact_name: null, insight: null, messages: [] };
      conversations.push(current);
    }
    if (r.sender_name && !current.contact_name) current.contact_name = r.sender_name;
    current.messages.push({ direction: r.direction, content: r.content, status: r.status, at: r.created_at });
  }
  for (const c of conversations) {
    const i = stmts.getInsight.get(session.id, c.jid);
    if (i) c.insight = { intent: i.intent, level: i.level, summary: i.summary, profile: i.profile, next_step: i.next_step, analyzed_at: i.analyzed_at };
    delete c.jid;
  }
  res.setHeader("Content-Disposition", `attachment; filename="${base}.json"`);
  res.json({
    session: { id: session.id, name: session.name, phone: session.phone ? `+${session.phone}` : null },
    exported_at: new Date().toISOString(),
    conversations,
  });
});

// ─── Customer-intent analysis (Claude) ───────────────────────────────────

app.get("/api/insights/status", (_req, res) => {
  res.json({ enabled: insightsEnabled(), model: insightsEnabled() ? insightModel() : null });
});

app.post("/api/sessions/:id/chats/:jid/insight", async (req, res) => {
  const { id, jid } = req.params;
  if (!insightsEnabled()) return res.status(503).json({ error: "Analisis AI belum diaktifkan oleh admin." });
  if (!isOwnChat(id, jid)) return res.status(404).json({ error: "Percakapan tidak ditemukan" });
  try {
    res.json(await analyzeChat(id, jid));
  } catch (err) {
    logger.warn({ sessionId: id, err: err.message }, "Chat analysis failed");
    const known = /belum membalas|belum diaktifkan/.test(err.message);
    res.status(known ? 400 : 502).json({ error: known ? err.message : "Analisis gagal. Coba lagi sebentar lagi." });
  }
});

// Analyze conversations that have a customer reply and no up-to-date analysis, a few per call.
app.post("/api/sessions/:id/insights", async (req, res) => {
  if (!insightsEnabled()) return res.status(503).json({ error: "Analisis AI belum diaktifkan oleh admin." });
  const pending = chatsNeedingAnalysis(req.params.id);
  const batch = pending.slice(0, INSIGHT_BATCH);
  let analyzed = 0, failed = 0;
  for (const jid of batch) {
    try {
      await analyzeChat(req.params.id, jid);
      analyzed++;
    } catch (err) {
      failed++;
      logger.warn({ sessionId: req.params.id, err: err.message }, "Chat analysis failed");
    }
  }
  res.json({ analyzed, failed, remaining: pending.length - batch.length });
});

// ─── Disconnect ──────────────────────────────────────────────────────────

app.post("/api/disconnect", async (req, res) => {
  const sessionId = req.body.sessionId || getDefaultSessionId();
  if (!sessionId) return res.status(400).json({ error: "Tidak ada session" });
  try {
    cancelJob(sessionId);
    await removeSession(sessionId, logger);
    res.json({ ok: true, message: "Disconnected. Buat session baru untuk reconnect." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Quick send (single number, N messages) ─────────────────────────────

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

app.post("/api/quick-send", async (req, res) => {
  const { phone, message, sessionId: reqSessionId } = req.body;
  const count = Math.floor(Number(req.body.count ?? 1));
  const [delayMin, delayMax] = readDelays(req.body.delayMin, req.body.delayMax, 3, 8);
  if (!phone || !message) return res.status(400).json({ error: "phone dan message wajib" });
  if (!Number.isFinite(count) || count < 1) return res.status(400).json({ error: "count harus minimal 1" });
  if (count > MAX_QUICK_COUNT) return res.status(400).json({ error: `Paling banyak ${MAX_QUICK_COUNT} kali kirim sekaligus.` });

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
  recordJobStart(logger, { id: jobId, type: "quick", sessionId, template: message, total: Number(count), userEmail: req.user?.email ?? null });

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
  res.write(JSON.stringify({ done: true, total: count, sent, failed, jobId }) + "\n");
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
  const { template, sessionId: reqSessionId, uploadId } = req.body;
  const [delayMin, delayMax] = readDelays(req.body.delayMin, req.body.delayMax, 3, 7);
  const upload = getUpload(uploadId);
  if (!upload) return res.status(400).json({ error: "Upload kontak dulu" });
  if (!template) return res.status(400).json({ error: "Template kosong" });

  const sessionId = reqSessionId || getDefaultSessionId();
  if (!sessionId) return res.status(503).json({ error: "Tidak ada session aktif" });

  try {
    const job = startBlast(sessionId, upload.rows, template, delayMin, delayMax, logger, req.user?.email ?? null);
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
  res.json({ ...job, results: job.results.slice(-100) });
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

// ─── Database backup download (off-site copies) ───────────────────────────
// Disabled unless BACKUP_TOKEN is set: the file contains every chat.

app.get("/api/backup", async (req, res) => {
  const token = process.env.BACKUP_TOKEN;
  if (!token) return res.status(404).json({ error: "Not found" });
  const given = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const file = await createSnapshot();
    res.download(file, `wa-blast-${new Date().toISOString().slice(0, 10)}.db`, () => unlink(file).catch(() => {}));
  } catch (err) {
    logger.error({ err: err.message }, "Backup download failed");
    res.status(500).json({ error: "Backup gagal dibuat" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`WA Blast listening on :${PORT}`);
  restoreSessions(logger).catch((err) => {
    logger.error({ err }, "Failed to restore sessions");
  });
  startBackups(logger);
});
