import express from "express";
import pino from "pino";
import multer from "multer";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { initWhatsApp, getSocket, getQrDataUrl, requestPairingCode } from "./wa-client.js";
import { startBlast, getJobStatus, cancelJob } from "./blast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

let uploadedContacts = null;
let uploadedColumns = null;

// ─── WhatsApp connection ──────────────────────────────────────────────────

app.get("/qr", (_req, res) => {
  const qr = getQrDataUrl();
  const sock = getSocket();
  const connected = sock?.user != null;

  if (connected) return res.send("<h2>WhatsApp sudah terhubung</h2>");

  let html = `<html><body style="display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;flex-direction:column;font-family:sans-serif;gap:20px">`;
  if (qr) {
    html += `<h2>Scan QR dengan WhatsApp</h2><img src="${qr}" style="width:300px;height:300px"/><p>WhatsApp → Linked Devices → Link a Device</p>`;
  } else {
    html += `<h2>Menghubungkan ke WhatsApp...</h2><p>Tunggu sebentar lalu refresh.</p>`;
    html += `<p>Atau gunakan pairing code: <a href="/pair?phone=628xxx">/pair?phone=628xxxxxxxxxx</a></p>`;
  }
  html += `<meta http-equiv='refresh' content='5'></body></html>`;
  res.send(html);
});

app.get("/pair", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).send("<h2>Usage: /pair?phone=628xxxxxxxxxx</h2>");
  try {
    const code = await requestPairingCode(phone.replace(/\D/g, ""), logger);
    res.send(`<h2>Pairing Code: <span style="font-size:48px;letter-spacing:8px">${code}</span></h2>`);
  } catch (e) {
    res.status(500).send(`<h2>Error: ${e.message}</h2>`);
  }
});

app.get("/health", (_req, res) => {
  const sock = getSocket();
  const connected = sock?.user != null;
  res.status(connected ? 200 : 503).json({
    status: connected ? "connected" : "disconnected",
    contacts: uploadedContacts?.length ?? 0,
  });
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

  uploadedContacts = rows;
  uploadedColumns = Object.keys(rows[0]);

  logger.info({ count: rows.length, columns: uploadedColumns }, "Contacts uploaded");
  res.json({
    count: rows.length,
    columns: uploadedColumns,
    preview: rows.slice(0, 5),
  });
});

// ─── Preview message ──────────────────────────────────────────────────────

app.post("/api/preview", (req, res) => {
  if (!uploadedContacts?.length) return res.status(400).json({ error: "Upload kontak dulu" });

  const { template } = req.body;
  if (!template) return res.status(400).json({ error: "Template kosong" });

  const previews = uploadedContacts.slice(0, 3).map((row) => {
    const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key) => row[key] ?? `{{${key}}}`);
    return { row, rendered };
  });

  res.json({ previews });
});

// ─── Start blast ──────────────────────────────────────────────────────────

app.post("/api/blast", (req, res) => {
  if (!uploadedContacts?.length) return res.status(400).json({ error: "Upload kontak dulu" });

  const { template, delayMin = 3, delayMax = 7 } = req.body;
  if (!template) return res.status(400).json({ error: "Template kosong" });

  try {
    const job = startBlast(uploadedContacts, template, delayMin, delayMax, logger);
    res.json({ status: job.status, total: job.total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Job status (polling) ─────────────────────────────────────────────────

app.get("/api/status", (_req, res) => {
  const job = getJobStatus();
  if (!job) return res.json({ status: "idle" });
  res.json(job);
});

// ─── Cancel blast ─────────────────────────────────────────────────────────

app.post("/api/cancel", (_req, res) => {
  cancelJob();
  res.json({ ok: true });
});

// ─── Clear contacts ───────────────────────────────────────────────────────

app.post("/api/clear", (_req, res) => {
  uploadedContacts = null;
  uploadedColumns = null;
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`WA Blast listening on :${PORT}`);
  initWhatsApp(logger).catch((err) => {
    logger.error({ err }, "Failed to init WhatsApp");
  });
});
