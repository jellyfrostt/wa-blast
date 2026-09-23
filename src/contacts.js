import { stmts } from "./db.js";

// WhatsApp may address a chat by a hidden id ("...@lid") instead of the phone number.
// We keep every chat under the phone-number jid whenever the number is known.

const stripDevice = (jid) => String(jid || "").replace(/:\d+(?=@)/, "");
const isLid = (jid) => jid.endsWith("@lid");
const isPhone = (jid) => jid.endsWith("@s.whatsapp.net");

export function rememberLid(sessionId, lid, pn) {
  lid = stripDevice(lid);
  pn = stripDevice(pn);
  if (!isLid(lid) || !isPhone(pn)) return;
  stmts.upsertLid.run(sessionId, lid, pn);
  stmts.relabelMessages.run(pn, sessionId, lid);
}

export function resolveChatJid(sessionId, key) {
  const jid = stripDevice(key.remoteJid);
  if (!isLid(jid)) {
    if (isPhone(jid) && key.senderLid) rememberLid(sessionId, key.senderLid, jid);
    return jid;
  }
  if (key.senderPn) {
    rememberLid(sessionId, jid, key.senderPn);
    return stripDevice(key.senderPn);
  }
  return stmts.getLid.get(sessionId, jid)?.pn ?? jid;
}
