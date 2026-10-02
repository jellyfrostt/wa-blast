import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { boot, api, upload, waitJob, BASE, REPO } from "./harness.mjs";

const csv = "nama,phone\nA1,081100000001\nA2,081100000002\nFAILX,081100000003\nBad,123\nA5,081100000005\n";
const isIso = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) && !isNaN(new Date(s));

try {
  const db = await boot();

  assert.deepEqual((await api("GET", "/api/history")).json, []);
  console.log("ok  history starts empty");

  const up = await upload(csv);
  const start = await api("POST", "/api/blast", { sessionId: "a", uploadId: up.json.uploadId, template: "Hi {{nama}}", delayMin: 0, delayMax: 0 });
  assert.equal(start.status, 200, start.text);
  const running = (await api("GET", "/api/history")).json;
  assert.equal(running[0].status, "running");
  const done = await waitJob("a");
  assert.deepEqual([done.sent, done.failed, done.skipped], [3, 1, 1]);

  const qs = await fetch(`${BASE}/api/quick-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "b", phone: "082200000009", message: "testing 1 tex2 text3", count: 2, delayMin: 0, delayMax: 0 }),
  });
  const qsLines = (await qs.text()).trim().split("\n").map((l) => JSON.parse(l));
  const qsDone = qsLines.at(-1);
  assert.deepEqual({ done: qsDone.done, total: qsDone.total, sent: qsDone.sent, failed: qsDone.failed }, { done: true, total: 2, sent: 2, failed: 0 });
  assert.match(qsDone.jobId, /^quick-/);

  const list = (await api("GET", "/api/history")).json;
  assert.equal(list.length, 2);
  const [quick, blast] = list;
  assert.equal(quick.type, "quick", "newest first");
  assert.equal(quick.id, qsDone.jobId, "quick send reports the id of its history entry");
  assert.deepEqual(
    { type: blast.type, session_id: blast.session_id, session_name: blast.session_name, session_phone: blast.session_phone, template: blast.template, status: blast.status, total: blast.total, sent: blast.sent, failed: blast.failed, skipped: blast.skipped },
    { type: "blast", session_id: "a", session_name: "Marketing", session_phone: "6281110001", template: "Hi {{nama}}", status: "done", total: 5, sent: 3, failed: 1, skipped: 1 }
  );
  assert.deepEqual(
    { session_name: quick.session_name, template: quick.template, status: quick.status, total: quick.total, sent: quick.sent, failed: quick.failed },
    { session_name: "Sales", template: "testing 1 tex2 text3", status: "done", total: 2, sent: 2, failed: 0 }
  );
  assert.ok(isIso(blast.started_at) && isIso(blast.finished_at) && blast.finished_at >= blast.started_at, "timestamps");
  assert.equal(blast.id, start.json.id);
  console.log("ok  blast and quick send both recorded with sender, timestamps and counts");

  const detail = (await api("GET", `/api/history/${blast.id}`)).json;
  assert.equal(detail.items.length, 5);
  assert.deepEqual(detail.items.map((i) => [i.idx, i.phone, i.status]), [
    [0, "+6281100000001", "sent"],
    [1, "+6281100000002", "sent"],
    [2, "+6281100000003", "failed"],
    [3, "123", "skipped"],
    [4, "+6281100000005", "sent"],
  ]);
  assert.equal(detail.items[0].content, "Hi A1");
  assert.match(detail.items[2].error, /invalid_number/);
  assert.equal(detail.items[3].error, "Nomor tidak valid");
  assert.ok(detail.items.every((i) => isIso(i.created_at)));
  assert.equal(detail.items[0].delivery_status, "sent");
  console.log("ok  detail lists every recipient with status, error, message and time");

  const msgs = db.stmts.getBlastMessages.all(blast.id).filter((m) => m.status === "sent");
  db.stmts.updateMessageStatus.run("read", msgs[0].message_id, "a");
  db.stmts.updateMessageStatus.run("delivered", msgs[1].message_id, "a");
  const afterReceipts = (await api("GET", "/api/history")).json.find((j) => j.id === blast.id);
  assert.deepEqual([afterReceipts.sent, afterReceipts.delivered, afterReceipts.read_count], [3, 1, 1]);
  const detail2 = (await api("GET", `/api/history/${blast.id}`)).json;
  assert.deepEqual(detail2.items.filter((i) => i.status === "sent").map((i) => i.delivery_status), ["read", "delivered", "sent"]);
  console.log("ok  delivered/read receipts show up in history counts and details");

  const page = (await api("GET", `/api/history/${blast.id}?limit=2&offset=2`)).json;
  assert.deepEqual(page.items.map((i) => i.idx), [2, 3]);
  assert.equal((await api("GET", "/api/history/nope")).status, 404);
  console.log("ok  detail pagination and 404 for unknown job");

  db.stmts.deleteSession.run("a");
  const afterRemove = (await api("GET", "/api/history")).json.find((j) => j.id === blast.id);
  assert.deepEqual([afterRemove.session_name, afterRemove.sent, afterRemove.failed, afterRemove.skipped], ["Marketing", 3, 1, 1]);
  assert.equal((await api("GET", `/api/history/${blast.id}`)).json.items.length, 5);
  console.log("ok  history survives removing the session");

  db.stmts.insertJob.run("blast-stale", "blast", "b", "Sales", "6282220002", "x", 10, new Date().toISOString(), null);
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const { stmts } = await import(${JSON.stringify(pathToFileURL(`${REPO}/src/db.js`).href)}); const j = stmts.getJob.get("blast-stale"); console.log(j.status + "|" + j.finished_at);`,
  ], { env: process.env, encoding: "utf8" }).trim();
  const [st, fin] = out.split("|");
  assert.equal(st, "interrupted");
  assert.ok(isIso(fin), `finished_at is ISO: ${fin}`);
  console.log("ok  a job left running by a restart is marked interrupted on next start");

  console.log("ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
