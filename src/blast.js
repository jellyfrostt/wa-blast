import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getSocket } from "./wa-client.js";
import { formatPhone, displayPhone } from "./phone.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEND_TIMEOUT_MS = 20000;

function sendWithTimeout(sock, jid, content) {
  return Promise.race([
    sock.sendMessage(jid, content),
    sleep(SEND_TIMEOUT_MS).then(() => { throw new Error("Send timeout — socket mungkin hang"); }),
  ]);
}

let currentJob = null;
let jobHistory = [];

export function getJobStatus() {
  return currentJob;
}

export function getJobHistory() {
  return jobHistory;
}

export function cancelJob() {
  if (currentJob && currentJob.status === "running") {
    currentJob.status = "cancelled";
  }
}

function renderTemplate(template, row) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return row[key] ?? `{{${key}}}`;
  });
}

function classifyError(err) {
  const msg = (err.message || err.toString()).toLowerCase();

  if (msg.includes("rate") || msg.includes("throttl") || msg.includes("429") || msg.includes("too many"))
    return "rate_limit";
  if (msg.includes("banned") || msg.includes("blocked") || msg.includes("restricted"))
    return "banned";
  if (msg.includes("not on whatsapp") || msg.includes("not registered") || msg.includes("not a valid"))
    return "invalid_number";
  if (msg.includes("timeout") || msg.includes("timed out"))
    return "timeout";
  if (msg.includes("connection") || msg.includes("disconnect") || msg.includes("socket"))
    return "connection";
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized"))
    return "auth";

  return "unknown";
}

function saveLog(job, logger) {
  try {
    if (!existsSync("./logs")) mkdirSync("./logs", { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `./logs/blast-${ts}.json`;

    const log = {
      id: job.id,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      status: job.status,
      total: job.total,
      sent: job.sent,
      failed: job.failed,
      skipped: job.skipped,
      durationMs: job.durationMs,
      avgDelayMs: job.avgDelayMs,
      errorBreakdown: job.errorBreakdown,
      rateLimitHits: job.rateLimitHits,
      consecutiveErrors: job.maxConsecutiveErrors,
      results: job.results,
    };

    writeFileSync(filename, JSON.stringify(log, null, 2));
    logger.info({ filename }, "Blast log saved");
  } catch (err) {
    logger.error({ err: err.message }, "Failed to save blast log");
  }
}

function getConnectedSocket() {
  const s = getSocket();
  if (!s?.user) return null;
  return s;
}

async function waitForReconnect(logger, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const s = getConnectedSocket();
    if (s) {
      // Wait a bit to confirm socket is stable (survives the 440 cycle)
      await sleep(2000);
      const s2 = getConnectedSocket();
      if (s2 && s2 === s) return s2;
      logger.info("Socket died during stability check, retrying...");
    }
    await sleep(3000);
  }
  return null;
}

export async function startBlast(contacts, template, delayMin, delayMax, logger) {
  if (currentJob?.status === "running") {
    throw new Error("Blast sedang berjalan");
  }

  if (!getConnectedSocket()) {
    throw new Error("WhatsApp belum terhubung");
  }

  const jobId = `blast-${Date.now()}`;

  currentJob = {
    id: jobId,
    status: "running",
    total: contacts.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    current: 0,
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
    avgDelayMs: 0,
    errorBreakdown: {},
    rateLimitHits: 0,
    maxConsecutiveErrors: 0,
    delayConfig: { min: delayMin, max: delayMax },
  };

  const startTime = Date.now();

  (async () => {
    let consecutiveErrors = 0;
    let totalDelay = 0;
    let delayCount = 0;

    for (let i = 0; i < contacts.length; i++) {
      if (currentJob.status === "cancelled") {
        logger.info({ at: i, total: contacts.length, sent: currentJob.sent, failed: currentJob.failed }, "Blast cancelled by user");
        break;
      }

      const row = contacts[i];
      const phoneCol = findPhoneColumn(row);
      if (!phoneCol) {
        currentJob.results.push({ index: i, phone: "?", status: "skipped", error: "No phone column", ts: new Date().toISOString() });
        currentJob.skipped++;
        currentJob.current = i + 1;
        logger.warn({ index: i, columns: Object.keys(row) }, "Skipped — no phone column found");
        continue;
      }

      const phone = row[phoneCol];
      const cleaned = String(phone).replace(/\D/g, "");
      if (!cleaned || cleaned.length < 9) {
        currentJob.results.push({ index: i, phone: phone || "?", status: "skipped", error: "Nomor tidak valid", ts: new Date().toISOString() });
        currentJob.skipped++;
        currentJob.current = i + 1;
        logger.warn({ index: i, phone, columns: Object.keys(row) }, "Skipped — invalid/empty phone");
        continue;
      }

      const message = renderTemplate(template, row);
      const jid = formatPhone(phone);
      const display = displayPhone(phone);
      const sendStart = Date.now();

      const MAX_RETRIES = 2;
      let sent = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          let activeSock = getConnectedSocket();
          if (!activeSock) {
            logger.warn({ index: i, phone: display, attempt }, "Socket dead — waiting for reconnect");
            activeSock = await waitForReconnect(logger);
            if (!activeSock) {
              throw new Error("Connection Closed — reconnect timed out");
            }
            logger.info({ index: i, attempt }, "Reconnected, resuming");
          }

          const result = await sendWithTimeout(activeSock, jid, { text: message });
          const sendMs = Date.now() - sendStart;
          currentJob.results.push({ index: i, phone: display, status: "sent", sendMs, retries: attempt, ts: new Date().toISOString() });
          currentJob.sent++;
          consecutiveErrors = 0;
          logger.info({ index: i, phone: display, jid, sendMs, retries: attempt, messageId: result?.key?.id, progress: `${i + 1}/${contacts.length}` }, "Sent");
          sent = true;
          break;
        } catch (err) {
          const errorType = classifyError(err);
          logger.warn({ index: i, phone: display, attempt, maxRetries: MAX_RETRIES, errorType, err: err.message }, "Send attempt failed");

          if (errorType === "banned") {
            logger.error("BANNED detected — stopping blast immediately");
            currentJob.status = "banned";
            break;
          }

          if (attempt < MAX_RETRIES && (errorType === "connection" || errorType === "timeout")) {
            const backoff = (attempt + 1) * 5000;
            logger.info({ index: i, backoffMs: backoff }, "Retrying after backoff");
            await sleep(backoff);
            continue;
          }
        }
      }

      if (currentJob.status === "banned") break;

      if (!sent) {
        const sendMs = Date.now() - sendStart;
        currentJob.results.push({
          index: i,
          phone: display,
          status: "failed",
          error: `Failed after ${MAX_RETRIES + 1} attempts`,
          errorType: "connection",
          sendMs,
          ts: new Date().toISOString(),
        });
        currentJob.failed++;
        currentJob.errorBreakdown["connection"] = (currentJob.errorBreakdown["connection"] || 0) + 1;
        consecutiveErrors++;

        if (consecutiveErrors > currentJob.maxConsecutiveErrors) {
          currentJob.maxConsecutiveErrors = consecutiveErrors;
        }

        logger.error({ index: i, phone: display, consecutiveErrors, progress: `${i + 1}/${contacts.length}` }, "Send failed after all retries");

        if (consecutiveErrors >= 10) {
          logger.error({ consecutiveErrors }, "10 consecutive errors — stopping blast");
          currentJob.status = "error_stopped";
          break;
        }

        if (consecutiveErrors >= 5) {
          logger.warn({ consecutiveErrors }, "5 consecutive errors — cooling down 30s");
          await sleep(30000);
        }
      }

      currentJob.current = i + 1;
      currentJob.durationMs = Date.now() - startTime;

      if (i < contacts.length - 1 && currentJob.status === "running") {
        const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
        totalDelay += delay;
        delayCount++;
        currentJob.avgDelayMs = Math.round((totalDelay / delayCount) * 1000);
        await sleep(delay * 1000);
      }
    }

    if (currentJob.status === "running") {
      currentJob.status = "done";
    }
    currentJob.finishedAt = new Date().toISOString();
    currentJob.durationMs = Date.now() - startTime;

    logger.info({
      id: jobId,
      status: currentJob.status,
      total: currentJob.total,
      sent: currentJob.sent,
      failed: currentJob.failed,
      skipped: currentJob.skipped,
      durationMs: currentJob.durationMs,
      errorBreakdown: currentJob.errorBreakdown,
      rateLimitHits: currentJob.rateLimitHits,
      maxConsecutiveErrors: currentJob.maxConsecutiveErrors,
    }, "Blast finished");

    saveLog(currentJob, logger);
    jobHistory.unshift({
      id: currentJob.id,
      status: currentJob.status,
      total: currentJob.total,
      sent: currentJob.sent,
      failed: currentJob.failed,
      startedAt: currentJob.startedAt,
      finishedAt: currentJob.finishedAt,
      errorBreakdown: currentJob.errorBreakdown,
      rateLimitHits: currentJob.rateLimitHits,
    });
    if (jobHistory.length > 50) jobHistory.pop();
  })();

  return currentJob;
}

function findPhoneColumn(row) {
  const keys = Object.keys(row);
  const phoneAliases = ["phone", "phone number", "phone_number", "hp", "no_hp", "nohp", "no_telp", "notelp", "nomor", "wa", "whatsapp", "telepon", "telp", "mobile", "handphone", "no hp", "no. hp", "no.hp", "number", "contact", "kontak", "no_wa", "nowa", "no wa", "no. wa", "nomor hp", "nomor telepon", "nomor wa", "cell", "cellular"];
  for (const k of keys) {
    const norm = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (phoneAliases.some(a => a.replace(/[^a-z0-9]/g, "") === norm)) return k;
  }
  // fallback: first column whose value looks like a phone number
  for (const k of keys) {
    const val = String(row[k]).replace(/\D/g, "");
    if (val.length >= 9 && val.length <= 15 && /^(0|62|8)\d+/.test(val)) return k;
  }
  return null;
}
