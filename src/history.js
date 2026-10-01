import { stmts } from "./db.js";

// History writes must never break a send, so every write swallows and logs its own errors.

export function newJobId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function recordJobStart(logger, { id, type, sessionId, template, total, userEmail = null }) {
  try {
    const s = stmts.getSession.get(sessionId);
    stmts.insertJob.run(id, type, sessionId, s?.name ?? null, s?.phone ?? null, template, total, new Date().toISOString(), userEmail);
  } catch (err) {
    logger.warn({ id, err: err.message }, "Failed to record send job");
  }
}

export function recordJobItem(logger, jobId, { index, phone, content, status, error, messageId }) {
  try {
    stmts.insertJobItem.run(jobId, index, phone ?? null, content ?? null, status, error ?? null, messageId ?? null, new Date().toISOString());
  } catch (err) {
    logger.warn({ jobId, err: err.message }, "Failed to record send job item");
  }
}

export function recordJobFinish(logger, jobId, status) {
  try {
    stmts.finishJob.run(status, new Date().toISOString(), jobId);
  } catch (err) {
    logger.warn({ jobId, err: err.message }, "Failed to record send job finish");
  }
}
