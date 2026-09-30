import assert from "node:assert/strict";
import { boot, api, upload, waitJob, BASE, sentLog, sleep } from "./harness.mjs";
try {
  const db = await boot();
  const enc = encodeURIComponent;
  const quick = (body) => fetch(`${BASE}/api/quick-send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // ── a failed send does not turn the number into a "recipient"
  const up = await upload("nama,phone\nGagal FAIL,081100000001\nOke,081100000002\n");
  await api("POST", "/api/blast", { sessionId: "a", uploadId: up.json.uploadId, template: "Hi {{nama}}", delayMin: 0, delayMax: 0 });
  const done = await waitJob("a");
  assert.deepEqual([done.sent, done.failed], [1, 1]);
  const FAILED = "6281100000001@s.whatsapp.net", OK = "6281100000002@s.whatsapp.net";
  const chats = (await api("GET", "/api/sessions/a/chats?limit=50")).json;
  assert.deepEqual(chats.map((c) => [c.jid, c.sent_count]), [[OK, 1]], "only the number that really got the message is a conversation");
  assert.equal((await api("POST", `/api/sessions/a/chats/${enc(FAILED)}/messages`, { message: "hai" })).status, 404);
  assert.deepEqual((await api("GET", `/api/sessions/a/chats/${enc(FAILED)}/messages`)).json, []);
  console.log("ok  a number whose send failed is not listed, readable or replyable");

  // ── quick send input is bounded and typed
  assert.equal((await quick({ sessionId: "a", phone: "0812", message: "x", count: 201 })).status, 400);
  assert.equal((await quick({ sessionId: "a", phone: "0812", message: "x", count: "abc" })).status, 400);
  assert.equal((await quick({ sessionId: "a", phone: "0812", message: "x", count: 0 })).status, 400);
  const before = sentLog.length;
  const t0 = Date.now();
  const r = await quick({ sessionId: "a", phone: "081200000009", message: "dua kali", count: "2", delayMin: "0", delayMax: "0" });
  const last = (await r.text()).trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([last.total, last.sent], [2, 2]);
  assert.equal(sentLog.length - before, 2);
  assert.ok(Date.now() - t0 < 3000, "string delays are treated as numbers, not concatenated into a long wait");
  console.log("ok  quick send rejects counts over 200 and non-numbers, and reads delays as numbers");

  // ── blast delays given as strings or reversed still work
  const up2 = await upload("nama,phone\nA,081100000011\nB,081100000012\nC,081100000013\n");
  const t1 = Date.now();
  const st = await api("POST", "/api/blast", { sessionId: "b", uploadId: up2.json.uploadId, template: "Hi {{nama}}", delayMin: "1", delayMax: "0" });
  assert.equal(st.status, 200, st.text);
  const d2 = await waitJob("b");
  assert.equal(d2.sent, 3);
  assert.ok(Date.now() - t1 < 6000);
  console.log("ok  blast delays sent as strings or in the wrong order are normalised");

  // ── status polling carries only the latest results
  const bigCsv = "nama,phone\n" + Array.from({ length: 150 }, (_, i) => `N${i},0813000${String(i).padStart(5, "0")}`).join("\n") + "\n";
  const up3 = await upload(bigCsv);
  await api("POST", "/api/blast", { sessionId: "a", uploadId: up3.json.uploadId, template: "x {{nama}}", delayMin: 0, delayMax: 0 });
  const d3 = await waitJob("a", 60000);
  assert.deepEqual([d3.total, d3.sent, d3.current, d3.results.length], [150, 150, 150, 100]);
  assert.equal((await api("GET", `/api/history/${d3.id}?limit=200`)).json.items.length, 150, "history still has every recipient");
  console.log("ok  blast status returns the last 100 results while history keeps all of them");

  // ── removing a number stops its blast
  const up4 = await upload("nama,phone\n" + Array.from({ length: 30 }, (_, i) => `R${i},0814000${String(i).padStart(5, "0")}`).join("\n") + "\n");
  await api("POST", "/api/blast", { sessionId: "b", uploadId: up4.json.uploadId, template: "y {{nama}}", delayMin: 1, delayMax: 1 });
  await sleep(1500);
  assert.equal((await api("DELETE", "/api/sessions/b")).status, 200);
  const d4 = await waitJob("b", 15000);
  assert.equal(d4.status, "cancelled");
  assert.ok(d4.sent < 30);
  console.log("ok  removing a number cancels the blast that was running on it");

  // ── the legacy /qr page escapes names
  db.stmts.insertSession.run("x", "<img src=x onerror=alert(1)>");
  const page = await (await fetch(`${BASE}/qr`)).text();
  assert.ok(!page.includes("<img src=x onerror"), "name is not injected as HTML");
  console.log("ok  /qr page does not render a number's name as HTML");

  console.log("ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
}
