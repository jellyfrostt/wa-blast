import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { boot, api, BASE, REPO, sleep } from "./harness.mjs";
try {
  const db = await boot();
  const PN = "6283879730934@s.whatsapp.net";
  const store = (session, jid, dir, text) => db.stmts.insertMessage.run(session, jid, dir, text, dir + Math.random(), dir === "outgoing" ? "sent" : "received", null, null);
  store("a", PN, "outgoing", "halo"); store("a", PN, "incoming", "balasan");

  if (!process.env.BACKUP_TOKEN) {
    // ── removing a number keeps its chats
    assert.deepEqual((await api("GET", "/api/sessions/archived")).json, []);
    db.stmts.archiveSession.run("a");
    assert.deepEqual(db.stmts.getAllSessions.all().map((s) => s.id), ["b"], "removed number is no longer restored or listed as a sender");
    db.stmts.updateSessionStatus.run("disconnected", "a");
    db.stmts.updateSessionPhone.run("6280000", "a");
    assert.equal(db.stmts.getSession.get("a").status, "removed", "late socket events cannot bring it back");
    const archived = (await api("GET", "/api/sessions/archived")).json;
    assert.deepEqual(archived.map((s) => [s.id, s.name, s.phone]), [["a", "Marketing", "6281110001"]]);
    const chats = (await api("GET", "/api/sessions/a/chats?limit=50")).json;
    assert.deepEqual(chats.map((c) => [c.jid, c.sent_count, c.received_count]), [[PN, 1, 1]]);
    assert.equal((await api("GET", `/api/sessions/a/chats/${encodeURIComponent(PN)}/messages`)).json.length, 2);
    console.log("ok  a removed number keeps its conversations and stays out of the sender list");

    // ── daily backup with retention
    const backup = await import(pathToFileURL(`${REPO}/src/backup.js`).href);
    fs.mkdirSync(backup.backupDir, { recursive: true });
    for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(backup.backupDir, `wa-blast-2020-01-0${i}.db`), "old");
    fs.writeFileSync(path.join(backup.backupDir, "notes.txt"), "not a backup");
    const file = await backup.createBackup();
    const kept = fs.readdirSync(backup.backupDir).filter((f) => f.startsWith("wa-blast-")).sort();
    assert.equal(kept.length, 7, "only the newest 7 backups are kept");
    assert.equal(kept.at(-1), path.basename(file));
    assert.equal(kept[0], "wa-blast-2020-01-04.db");
    assert.ok(fs.existsSync(path.join(backup.backupDir, "notes.txt")), "unrelated files are left alone");
    const Database = createRequire(`${REPO}/src/db.js`)("better-sqlite3");
    const copy = new Database(file, { readonly: true });
    assert.equal(copy.prepare("SELECT COUNT(*) n FROM messages").get().n, 2);
    assert.equal(copy.prepare("SELECT status FROM sessions WHERE id = 'a'").get().status, "removed");
    copy.close();
    console.log("ok  backup is a readable copy of the database; old backups are pruned to 7");

    assert.equal((await fetch(`${BASE}/api/backup`)).status, 404);
    assert.equal((await fetch(`${BASE}/api/backup`, { headers: { Authorization: "Bearer anything" } })).status, 404);
    console.log("ok  backup download is switched off when no token is configured");
  } else {
    const backup = await import(pathToFileURL(`${REPO}/src/backup.js`).href);
    assert.equal((await fetch(`${BASE}/api/backup`)).status, 401);
    assert.equal((await fetch(`${BASE}/api/backup`, { headers: { Authorization: "Bearer wrong-token" } })).status, 401);
    const r = await fetch(`${BASE}/api/backup`, { headers: { Authorization: `Bearer ${process.env.BACKUP_TOKEN}` } });
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), "SQLite format 3");
    assert.match(r.headers.get("content-disposition"), /wa-blast-\d{4}-\d{2}-\d{2}\.db/);
    await sleep(300);
    assert.deepEqual(fs.readdirSync(backup.backupDir).filter((f) => f.startsWith("download-")), [], "temporary download copy is removed");
    console.log(`ok  with a token set, the backup downloads only with the right token (${buf.length} bytes)`);
  }
  console.log("ALL PASS");
  process.exit(0);
} catch (err) { console.error("FAIL:", err.stack || err.message); process.exit(1); }
