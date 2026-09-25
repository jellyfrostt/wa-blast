import { stmts } from "./db.js";

// WhatsApp may address a chat by a hidden id ("...@lid") instead of the phone number.
// This app records only replies from numbers it has sent to, filed under the phone number.

const stripDevice = (jid) => String(jid || "").replace(/:\d+(?=@)/, "");
const isLid = (jid) => jid.endsWith("@lid");
const isPhone = (jid) => jid.endsWith("@s.whatsapp.net");
const isRecipient = (sessionId, pn) => !!stmts.hasOutgoing.get(sessionId, pn);

// Only numbers this app has sent to are remembered; other contacts leave no trace.
export function rememberLid(sessionId, lid, pn) {
  lid = stripDevice(lid);
  pn = stripDevice(pn);
  if (!isLid(lid) || !isPhone(pn) || !isRecipient(sessionId, pn)) return;
  stmts.upsertLid.run(sessionId, lid, pn);
  stmts.relabelMessages.run(pn, sessionId, lid);
}

export function resolveChatJid(sessionId, key) {
  const jid = stripDevice(key.remoteJid);
  // On our own messages the sender attributes describe us, not the chat, so they are not used.
  if (!isLid(jid)) {
    if (!key.fromMe && isPhone(jid) && key.senderLid) rememberLid(sessionId, key.senderLid, jid);
    return jid;
  }
  if (!key.fromMe && key.senderPn) {
    rememberLid(sessionId, jid, key.senderPn);
    return stripDevice(key.senderPn);
  }
  return stmts.getLid.get(sessionId, jid)?.pn ?? jid;
}

// The jid to file a message under, or null when it must not be recorded
// (groups, channels, and anyone this app has never sent a message to).
// A hidden id we cannot match yet is kept, unlisted, only while some recipient's hidden id is
// still unknown; reconcileHiddenIds() then merges it into that recipient's chat or deletes it.
export function recordableChatJid(sessionId, key) {
  const jid = resolveChatJid(sessionId, key);
  if (isPhone(jid)) return isRecipient(sessionId, jid) ? jid : null;
  if (isLid(jid) && !key.fromMe) return stmts.hasUnmappedRecipient.get(sessionId) ? jid : null;
  return null;
}

const textOf = (m) =>
  m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || "[media]";

// Records one message of a live chat with a recipient: their replies, and what the owner types on
// the phone. Returns the jid it was filed under, or null when nothing was recorded.
export function recordChatMessage(sessionId, msg, { ownDelayMs = 3000 } = {}) {
  const key = msg.key;
  if (!msg.message || key.remoteJid === "status@broadcast") return null;
  const jid = recordableChatJid(sessionId, key);
  if (!jid) return null;
  if (key.id && stmts.hasMessageId.get(sessionId, key.id)) return null;
  const content = textOf(msg.message);

  if (!key.fromMe) {
    stmts.insertMessage.run(sessionId, jid, "incoming", content, key.id, "received", null, msg.pushName || null);
    return jid;
  }
  // Baileys also reports the messages this app sends; those are stored by the sender right after
  // the send, so wait briefly and skip them instead of storing them twice.
  const timer = setTimeout(() => {
    try {
      if (!stmts.hasMessageId.get(sessionId, key.id)) {
        stmts.insertMessage.run(sessionId, jid, "outgoing", content, key.id, "sent", null, null);
      }
    } catch {}
  }, ownDelayMs);
  timer.unref?.();
  return jid;
}

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
const LOOKUPS_PER_RUN = 50;
const running = new Set();
const lastRun = new Map();
const lookedUp = new Map();

// Ask WhatsApp for the hidden id of recent recipients (small batch, at most every 5 minutes),
// so replies stored under a hidden id join the right conversation. Once every recent recipient
// has a known hidden id, whatever is still unmatched is not a reply to this app and is deleted.
// If some recipient could not be resolved, unmatched messages are kept (unlisted) for 3 days.
export async function reconcileHiddenIds(sessionId, sock, logger) {
  if (running.has(sessionId)) return;
  running.add(sessionId);
  try {
    if (!stmts.hasHiddenRows.get(sessionId)) return;
    if (Date.now() - (lastRun.get(sessionId) ?? 0) < RECONCILE_EVERY_MS) return;
    lastRun.set(sessionId, Date.now());
    if (!lookedUp.has(sessionId)) lookedUp.set(sessionId, new Set());
    const seen = lookedUp.get(sessionId);
    const batch = stmts.unmappedRecipients.all(sessionId).map((r) => r.jid).filter((pn) => !seen.has(pn)).slice(0, LOOKUPS_PER_RUN);

    let learned = 0;
    if (batch.length) {
      const results = (await sock.onWhatsApp(...batch)) || [];
      for (const pn of batch) seen.add(pn);
      for (const r of results) {
        if (!r?.lid || !r?.jid) continue;
        rememberLid(sessionId, r.lid, r.jid);
        learned++;
      }
    }
    let removed = stmts.deleteOldHiddenRows.run(sessionId).changes;
    const allKnown = !stmts.hasUnmappedRecipient.get(sessionId);
    if (allKnown) removed += stmts.deleteHiddenRows.run(sessionId).changes;
    logger.info({ sessionId, lookedUp: batch.length, learned, removed, allKnown }, "Hidden ids reconciled");
  } catch (err) {
    logger.warn({ sessionId, err: err.message }, "Hidden id lookup failed");
  } finally {
    running.delete(sessionId);
  }
}
