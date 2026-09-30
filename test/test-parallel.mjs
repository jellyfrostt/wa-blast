import assert from "node:assert/strict";
import { boot, api, upload, waitJob, sentLog } from "./harness.mjs";

const csvA = "nama,phone\n" + [1, 2, 3, 4, 5].map((i) => `A${i},08110000000${i}`).join("\n") + "\n";
const csvB = "Nama,hp\n" + [1, 2, 3, 4].map((i) => `B${i},08220000000${i}`).join("\n") + "\n";

try {
  await boot();

  const upA = await upload(csvA);
  const upB = await upload(csvB);
  assert.equal(upA.status, 200);
  assert.ok(upA.json.uploadId && upB.json.uploadId && upA.json.uploadId !== upB.json.uploadId, "distinct uploadIds");
  console.log("ok  uploads get separate ids");

  const prevA = await api("POST", "/api/preview", { template: "Hi {{nama}}", uploadId: upA.json.uploadId });
  assert.equal(prevA.json.previews[0].rendered, "Hi A1", "A's preview survives B's later upload");
  console.log("ok  preview of first upload is not overwritten by second upload");

  const startA = await api("POST", "/api/blast", { sessionId: "a", uploadId: upA.json.uploadId, template: "A says hi {{nama}}", delayMin: 0, delayMax: 0 });
  const startB = await api("POST", "/api/blast", { sessionId: "b", uploadId: upB.json.uploadId, template: "B says hi {{nama}}", delayMin: 0, delayMax: 0 });
  assert.equal(startA.status, 200, startA.text);
  assert.equal(startB.status, 200, startB.text);
  assert.equal(startA.json.total, 5);
  assert.equal(startB.json.total, 4);

  const [sa, sb] = await Promise.all([api("GET", "/api/status?sessionId=a"), api("GET", "/api/status?sessionId=b")]);
  assert.equal(sa.json.status, "running");
  assert.equal(sb.json.status, "running");
  assert.notEqual(sa.json.id, sb.json.id);
  console.log("ok  two blasts run at the same time on different sessions");

  const dup = await api("POST", "/api/blast", { sessionId: "a", uploadId: upA.json.uploadId, template: "again", delayMin: 0, delayMax: 0 });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /masih mengirim/);
  console.log("ok  second blast on a busy session is rejected with 400");

  const [doneA, doneB] = await Promise.all([waitJob("a"), waitJob("b")]);
  assert.deepEqual([doneA.status, doneA.sent, doneA.failed], ["done", 5, 0]);
  assert.deepEqual([doneB.status, doneB.sent, doneB.failed], ["done", 4, 0]);

  const byA = sentLog.filter((m) => m.sessionId === "a");
  const byB = sentLog.filter((m) => m.sessionId === "b");
  assert.equal(byA.length, 5);
  assert.equal(byB.length, 4);
  assert.ok(byA.every((m) => m.text.startsWith("A says hi A") && m.jid.startsWith("62811")), "session a sent only A's list");
  assert.ok(byB.every((m) => m.text.startsWith("B says hi B") && m.jid.startsWith("62822")), "session b sent only B's list");
  console.log("ok  each session sent only its own contacts and template");

  // cancel only touches the named session
  const startA2 = await api("POST", "/api/blast", { sessionId: "a", uploadId: upA.json.uploadId, template: "A2 {{nama}}", delayMin: 0, delayMax: 0 });
  const startB2 = await api("POST", "/api/blast", { sessionId: "b", uploadId: upB.json.uploadId, template: "B2 {{nama}}", delayMin: 0, delayMax: 0 });
  assert.equal(startA2.status, 200);
  assert.equal(startB2.status, 200);
  await api("POST", "/api/cancel", { sessionId: "a" });
  const [cA, cB] = await Promise.all([waitJob("a"), waitJob("b")]);
  assert.equal(cA.status, "cancelled");
  assert.ok(cA.sent < 5, "a stopped early");
  assert.deepEqual([cB.status, cB.sent], ["done", 4]);
  console.log("ok  cancelling one session leaves the other running");

  // unknown uploadId must not fall back to another person's upload
  const bad = await api("POST", "/api/blast", { sessionId: "a", uploadId: "u_missing", template: "x", delayMin: 0, delayMax: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Upload kontak dulu/);
  console.log("ok  unknown uploadId is rejected instead of using another upload");

  // clear removes only that upload; legacy calls without ids still work
  await api("POST", "/api/clear", { uploadId: upA.json.uploadId });
  const afterClear = await api("POST", "/api/preview", { template: "x", uploadId: upA.json.uploadId });
  assert.equal(afterClear.status, 400);
  const legacyPreview = await api("POST", "/api/preview", { template: "Hi {{nama}}" });
  assert.equal(legacyPreview.json.previews[0].rendered, "Hi B1");
  const legacyStatus = await api("GET", "/api/status");
  assert.equal(legacyStatus.json.sessionId, "b");
  console.log("ok  clear is per upload; calls without ids fall back to latest upload/job");

  console.log("ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
