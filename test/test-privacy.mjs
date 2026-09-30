import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { boot, api, REPO } from "./harness.mjs";
try {
  const db = await boot();
  const { recordChatMessage, reconcileHiddenIds } = await import(pathToFileURL(`${REPO}/src/contacts.js`).href);
  const log = { info() {}, warn() {} };
  const PN = "6283879730934@s.whatsapp.net", LID = "105227285979254@lid", OTHER_LID = "152100006607@lid", GROUP = "120363403400009009@g.us";
  const store = (session, jid, dir, text, name = null) => db.stmts.insertMessage.run(session, jid, dir, text, dir + Math.random(), dir === "outgoing" ? "sent" : "received", null, name);
  let seq = 0;
  const record = (session, key, text, name) => recordChatMessage(session, { key: { id: "M" + ++seq, ...key }, message: { conversation: text }, pushName: name }, { ownDelayMs: 50 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chatsOf = async (s) => (await api("GET", `/api/sessions/${s}/chats?limit=50`)).json.map((c) => [c.jid, c.sent_count, c.received_count, c.contact_name]);
  const rows = (s) => db.default.prepare("SELECT jid, COUNT(*) n FROM messages WHERE session_id = ? GROUP BY jid ORDER BY jid").all(s).map((r) => `${r.jid.split("@")[1]}:${r.n}`).join(" ");

  // ── what production holds today: 3 sent to the number, 7 replies under a hidden id, plus a group and a private chat
  for (let i = 0; i < 3; i++) store("a", PN, "outgoing", "pesan " + i);
  for (let i = 0; i < 7; i++) store("a", LID, "incoming", "balasan " + i, "observer 32");
  for (let i = 0; i < 2; i++) store("a", OTHER_LID, "incoming", "chat pribadi", "Caroline D");
  for (let i = 0; i < 5; i++) store("a", GROUP, "incoming", "obrolan grup", "slebew");

  assert.deepEqual(await chatsOf("a"), [[PN, 3, 0, null]], "only the conversation this app started is listed");
  for (const hidden of [GROUP, LID, OTHER_LID]) assert.deepEqual((await api("GET", `/api/sessions/a/chats/${encodeURIComponent(hidden)}/messages`)).json, []);
  console.log("ok  group, private and unmatched chats are neither listed nor readable");

  // ── the app asks WhatsApp for the recipient's hidden id and merges the replies into one conversation
  let lookups = [];
  const sock = { onWhatsApp: async (...jids) => { lookups.push(jids); return jids.filter((j) => j === PN).map((j) => ({ jid: j, exists: true, lid: LID })); } };
  await reconcileHiddenIds("a", sock, log);
  assert.deepEqual(lookups, [[PN]], "one lookup, only for the number we sent to");
  assert.deepEqual(await chatsOf("a"), [[PN, 3, 7, "observer 32"]]);
  const convo = (await api("GET", `/api/sessions/a/chats/${encodeURIComponent(PN)}/messages?limit=50`)).json;
  assert.equal(convo.length, 10);
  assert.equal(rows("a"), "g.us:5 s.whatsapp.net:10", "the private chat under another hidden id was deleted");
  await reconcileHiddenIds("a", sock, log);
  assert.equal(lookups.length, 1, "no repeated lookups");
  console.log("ok  replies under a hidden id are merged into the recipient's conversation; the unrelated private chat is deleted");

  // ── what gets recorded from now on
  assert.equal(record("a", { remoteJid: GROUP, participant: "999@lid" }, "grup", "flower"), null);
  assert.equal(record("a", { remoteJid: "12345@newsletter" }, "saluran"), null);
  assert.equal(record("a", { remoteJid: "628999000111@s.whatsapp.net" }, "chat pribadi", "Caroline D"), null);
  assert.equal(record("a", { remoteJid: OTHER_LID, senderPn: "628999000111@s.whatsapp.net" }, "chat pribadi"), null);
  assert.equal(record("a", { remoteJid: OTHER_LID }, "chat pribadi"), null, "unknown hidden id is dropped once all recipients are known");
  assert.equal(record("a", { remoteJid: LID }, "balasan baru", "observer 32"), PN);
  assert.equal(record("a", { remoteJid: PN }, "balasan baru 2", "observer 32"), PN);
  assert.equal(record("b", { remoteJid: PN }, "bukan penerima nomor ini"), null);
  assert.deepEqual(await chatsOf("a"), [[PN, 3, 9, "observer 32"]]);
  console.log("ok  from now on only replies from numbers this app sent to are recorded");

  // ── live chat: everything in a recipient's chat after the blast message, in order, nothing duplicated
  assert.equal(record("a", { remoteJid: PN, fromMe: true }, "diketik dari HP"), PN);
  assert.equal(record("a", { remoteJid: LID, fromMe: true, senderPn: "6285715300442@s.whatsapp.net" }, "diketik dari HP, chat beralamat tersembunyi"), PN, "our own number on the message is not mistaken for the chat");
  assert.equal(record("a", { remoteJid: PN }, "topik lain besoknya", "observer 32"), PN);
  // a message the app itself sends is reported by Baileys too, but must be stored once
  assert.equal(record("a", { id: "APP1", remoteJid: PN, fromMe: true }, "dikirim lewat aplikasi"), PN);
  db.stmts.insertMessage.run("a", PN, "outgoing", "dikirim lewat aplikasi", "APP1", "sent", "blast-x", null);
  // the same incoming message delivered twice (reconnect) is stored once
  assert.equal(record("a", { id: "DUP1", remoteJid: PN }, "sekali saja", "observer 32"), PN);
  assert.equal(record("a", { id: "DUP1", remoteJid: PN }, "sekali saja", "observer 32"), null);
  // the owner chatting privately from the phone is never recorded
  assert.equal(record("a", { remoteJid: "628999000111@s.whatsapp.net", fromMe: true }, "chat pribadi dari HP"), null);
  assert.equal(record("a", { remoteJid: OTHER_LID, fromMe: true }, "chat pribadi dari HP"), null);
  assert.equal(record("a", { remoteJid: GROUP, fromMe: true, participant: "me@lid" }, "pesan ke grup"), null);
  await sleep(200);
  const live = (await api("GET", `/api/sessions/a/chats/${encodeURIComponent(PN)}/messages?limit=100`)).json.reverse();
  assert.equal(live.filter((m) => m.message_id === "APP1").length, 1, "app-sent message stored once");
  assert.deepEqual(live.slice(-6).map((m) => [m.direction, m.content]).sort(), [
    ["incoming", "sekali saja"], ["incoming", "topik lain besoknya"],
    ["outgoing", "dikirim lewat aplikasi"], ["outgoing", "diketik dari HP"], ["outgoing", "diketik dari HP, chat beralamat tersembunyi"],
    ["incoming", "balasan baru 2"],
  ].sort());
  assert.equal(live[0].direction, "outgoing", "the conversation starts at the message this app sent");
  assert.deepEqual(await chatsOf("a"), [[PN, 6, 11, "observer 32"]]);
  console.log("ok  live chat: replies, later topics and phone-typed messages are kept in one conversation, nothing stored twice, private chats ignored");

  // ── WhatsApp gives no hidden id for a recipient: nothing is deleted or exposed, lookup failures do not crash
  const PN2 = "628777000222@s.whatsapp.net";
  store("b", PN2, "outgoing", "halo");
  assert.equal(record("b", { remoteJid: "909@lid" }, "mungkin balasan", "X"), "909@lid", "kept unlisted while a recipient is still unmatched");
  await reconcileHiddenIds("b", { onWhatsApp: async () => { throw new Error("timeout"); } }, log);
  assert.equal(rows("b"), "s.whatsapp.net:1 lid:1");
  assert.deepEqual(await chatsOf("b"), [[PN2, 1, 0, null]]);
  console.log("ok  when the hidden id cannot be looked up, the message stays unlisted instead of being lost or shown");

  // ── restart: leftovers from the old version (group chats) are deleted, conversations are kept
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const { default: db } = await import(${JSON.stringify(pathToFileURL(`${REPO}/src/db.js`).href)}); console.log(db.prepare("SELECT session_id s, jid, COUNT(*) n FROM messages GROUP BY s, jid ORDER BY s, jid").all().map(r => r.s + ":" + r.jid.split("@")[1] + ":" + r.n).join(" "));`,
  ], { env: process.env, encoding: "utf8" }).trim();
  assert.equal(out, "a:s.whatsapp.net:17 b:s.whatsapp.net:1 b:lid:1");
  console.log("ok  on restart the recorded group chat is deleted and blast conversations are kept");
  console.log("ALL PASS");
  process.exit(0);
} catch (err) { console.error("FAIL:", err.stack || err.message); process.exit(1); }
