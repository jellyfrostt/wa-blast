import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getSessionSocket } from "./sessions.js";
import { stmts } from "./db.js";
import { formatPhone, displayPhone } from "./phone.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEND_TIMEOUT_MS = 20000;

function sendWithTimeout(sock, jid, content) {
  return Promise.race([
    sock.sendMessage(jid, content),
    sleep(SEND_TIMEOUT_MS).then(() => { throw new Error("Send timeout - socket mungkin hang"); }),
  ]);
}

function getConnectedSocket(sessionId) {
  const s = getSessionSocket(sessionId);
  if (!s?.user) return null;
  return s;
}

async function waitForReconnect(sessionId, logger, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const s = getConnectedSocket(sessionId);
    if (s) {
      await sleep(2000);
      const s2 = getConnectedSocket(sessionId);
      if (s2 && s2 === s) return s2;
      logger.info("Socket died during stability check, retrying...");
    }
    await sleep(3000);
  }
  return null;
}

export async function sendWithRetry(sessionId, jid, content, logger) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let activeSock = getConnectedSocket(sessionId);
    if (!activeSock) {
      logger.warn({ sessionId, jid, attempt }, "Socket dead - waiting for reconnect");
      activeSock = await waitForReconnect(sessionId, logger);
      if (!activeSock) throw new Error("Connection lost - reconnect timed out");
    }
    try {
      return await sendWithTimeout(activeSock, jid, content);
    } catch (err) {
      const errorType = classifyError(err);
      if (attempt < MAX_RETRIES && (errorType === "connection" || errorType === "timeout")) {
        logger.info({ jid, attempt, backoffMs: (attempt + 1) * 5000 }, "Retrying after backoff");
        await sleep((attempt + 1) * 5000);
        continue;
      }
      throw err;
    }
  }
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

function resolveColumn(row, key) {
  if (key in row) return row[key];
  const lower = key.toLowerCase();
  const match = Object.keys(row).find(k => k.toLowerCase() === lower);
  return match ? row[match] : undefined;
}

function renderTemplate(template, row) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, rawKey) => {
    const key = rawKey.trim();
    const val = resolveColumn(row, key);
    return val !== undefined ? val : `{{${rawKey}}}`;
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
      sessionId: job.sessionId,
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

export async function startBlast(sessionId, contacts, template, delayMin, delayMax, logger) {
  if (currentJob?.status === "running") {
    throw new Error("Blast sedang berjalan");
  }

  if (!getConnectedSocket(sessionId)) {
    throw new Error("WhatsApp belum terhubung");
  }

  const jobId = `blast-${Date.now()}`;

  currentJob = {
    id: jobId,
    sessionId,
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
        logger.warn({ index: i, columns: Object.keys(row) }, "Skipped - no phone column found");
        continue;
      }

      const phone = row[phoneCol];
      const cleaned = String(phone).replace(/\D/g, "");
      if (!cleaned || cleaned.length < 9) {
        currentJob.results.push({ index: i, phone: phone || "?", status: "skipped", error: "Nomor tidak valid", ts: new Date().toISOString() });
        currentJob.skipped++;
        currentJob.current = i + 1;
        logger.warn({ index: i, phone, columns: Object.keys(row) }, "Skipped - invalid/empty phone");
        continue;
      }

      const message = renderTemplate(template, row);
      const jid = formatPhone(phone);
      const display = displayPhone(phone);
      const sendStart = Date.now();

      const MAX_RETRIES = 2;
      let sent = false;
      let lastErrorType = "unknown";

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          let activeSock = getConnectedSocket(sessionId);
          if (!activeSock) {
            logger.warn({ index: i, phone: display, attempt }, "Socket dead - waiting for reconnect");
            activeSock = await waitForReconnect(sessionId, logger);
            if (!activeSock) {
              throw new Error("Connection Closed - reconnect timed out");
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

          try {
            stmts.insertMessage.run(sessionId, jid, "outgoing", message, result?.key?.id, "sent", jobId, null);
          } catch (dbErr) {
            logger.warn({ err: dbErr.message }, "Failed to log sent message to DB");
          }

          break;
        } catch (err) {
          lastErrorType = classifyError(err);
          logger.warn({ index: i, phone: display, attempt, maxRetries: MAX_RETRIES, errorType: lastErrorType, err: err.message }, "Send attempt failed");

          if (lastErrorType === "banned") {
            logger.error("BANNED detected - stopping blast immediately");
            currentJob.status = "banned";
            break;
          }

          if (lastErrorType === "rate_limit") {
            currentJob.rateLimitHits++;
            const cooldown = 30000 + Math.floor(Math.random() * 15000);
            logger.warn({ index: i, cooldownMs: cooldown }, "Rate limited - cooling down");
            await sleep(cooldown);
          }

          if (attempt < MAX_RETRIES && (lastErrorType === "connection" || lastErrorType === "timeout" || lastErrorType === "rate_limit")) {
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
          errorType: lastErrorType,
          sendMs,
          ts: new Date().toISOString(),
        });
        currentJob.failed++;
        currentJob.errorBreakdown[lastErrorType] = (currentJob.errorBreakdown[lastErrorType] || 0) + 1;
        consecutiveErrors++;

        try {
          stmts.insertMessage.run(sessionId, jid, "outgoing", message, null, "failed", jobId, null);
        } catch (dbErr) {
          logger.warn({ err: dbErr.message }, "Failed to log failed message to DB");
        }

        if (consecutiveErrors > currentJob.maxConsecutiveErrors) {
          currentJob.maxConsecutiveErrors = consecutiveErrors;
        }

        logger.error({ index: i, phone: display, consecutiveErrors, progress: `${i + 1}/${contacts.length}` }, "Send failed after all retries");

        if (consecutiveErrors >= 10) {
          logger.error({ consecutiveErrors }, "10 consecutive errors - stopping blast");
          currentJob.status = "error_stopped";
          break;
        }

        if (consecutiveErrors >= 5) {
          logger.warn({ consecutiveErrors }, "5 consecutive errors - cooling down 30s");
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
      sessionId,
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
      sessionId: currentJob.sessionId,
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
  for (const k of keys) {
    const val = String(row[k]).replace(/\D/g, "");
    if (val.length >= 9 && val.length <= 15 && /^(0|62|8)\d+/.test(val)) return k;
  }
  return null;
}
