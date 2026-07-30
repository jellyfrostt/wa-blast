import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getSocket } from "./wa-client.js";
import { formatPhone, displayPhone } from "./phone.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (s) return s;
    logger.info({ elapsed: Date.now() - start }, "Waiting for WA reconnect...");
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

      try {
        let activeSock = getConnectedSocket();
        if (!activeSock) {
          logger.warn({ index: i, phone: display }, "Socket dead — waiting for reconnect before send");
          activeSock = await waitForReconnect(logger);
          if (!activeSock) {
            throw new Error("Connection Closed — reconnect timed out");
          }
          logger.info({ index: i }, "Reconnected, resuming blast");
        }

        const result = await activeSock.sendMessage(jid, { text: message });
        const sendMs = Date.now() - sendStart;
        currentJob.results.push({ index: i, phone: display, status: "sent", sendMs, ts: new Date().toISOString() });
        currentJob.sent++;
        consecutiveErrors = 0;
        logger.info({ index: i, phone: display, jid, sendMs, messageId: result?.key?.id, progress: `${i + 1}/${contacts.length}` }, "Sent");
      } catch (err) {
        const sendMs = Date.now() - sendStart;
        const errorType = classifyError(err);

        // On connection error, wait for reconnect and retry this message once
        if (errorType === "connection") {
          logger.warn({ index: i, phone: display }, "Connection error — waiting for reconnect to retry");
          const retrySock = await waitForReconnect(logger);
          if (retrySock) {
            try {
              const retryResult = await retrySock.sendMessage(jid, { text: message });
              const retrySendMs = Date.now() - sendStart;
              currentJob.results.push({ index: i, phone: display, status: "sent", sendMs: retrySendMs, retried: true, ts: new Date().toISOString() });
              currentJob.sent++;
              consecutiveErrors = 0;
              logger.info({ index: i, phone: display, jid, sendMs: retrySendMs, messageId: retryResult?.key?.id, retried: true }, "Sent (retry)");
              currentJob.current = i + 1;
              currentJob.durationMs = Date.now() - startTime;
              if (i < contacts.length - 1 && currentJob.status === "running") {
                const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
                totalDelay += delay;
                delayCount++;
                currentJob.avgDelayMs = Math.round((totalDelay / delayCount) * 1000);
                await sleep(delay * 1000);
              }
              continue;
            } catch (retryErr) {
              logger.error({ index: i, phone: display, err: retryErr.message }, "Retry also failed");
            }
          }
        }

        currentJob.results.push({
          index: i,
          phone: display,
          status: "failed",
          error: err.message,
          errorType,
          sendMs,
          ts: new Date().toISOString(),
        });
        currentJob.failed++;
        currentJob.errorBreakdown[errorType] = (currentJob.errorBreakdown[errorType] || 0) + 1;
        consecutiveErrors++;

        if (consecutiveErrors > currentJob.maxConsecutiveErrors) {
          currentJob.maxConsecutiveErrors = consecutiveErrors;
        }

        logger.error({
          index: i,
          phone: display,
          errorType,
          err: err.message,
          consecutiveErrors,
          progress: `${i + 1}/${contacts.length}`,
        }, "Send failed");

        if (errorType === "rate_limit") {
          currentJob.rateLimitHits++;
          const backoff = Math.min(30 + currentJob.rateLimitHits * 15, 120);
          logger.warn({ backoffSec: backoff, rateLimitHits: currentJob.rateLimitHits }, "Rate limit detected — backing off");
          currentJob.status = "rate_limited";
          await sleep(backoff * 1000);
          currentJob.status = "running";
        }

        if (errorType === "banned") {
          logger.error("BANNED detected — stopping blast immediately");
          currentJob.status = "banned";
          break;
        }

        if (consecutiveErrors >= 10) {
          logger.error({ consecutiveErrors }, "10 consecutive errors — stopping blast");
          currentJob.status = "error_stopped";
          break;
        }

        if (consecutiveErrors >= 5) {
          const cooldown = 30;
          logger.warn({ consecutiveErrors, cooldownSec: cooldown }, "5 consecutive errors — cooling down");
          await sleep(cooldown * 1000);
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
