import assert from "node:assert/strict";
import { boot, api } from "./harness.mjs";
try {
  await boot();
  const max = Number(process.env.MAX_SESSIONS || 10);
  assert.deepEqual((await api("GET", "/api/limits")).json, { maxSessions: max });
  const count = (await api("GET", "/api/sessions")).json.length;
  const r = await api("POST", "/api/sessions", { name: "Baru" });
  if (count >= max) {
    assert.equal(r.status, 400);
    assert.match(r.json.error, new RegExp(`batas ${max} nomor`));
    console.log(`ok  ${count}/${max}: adding a number is refused with: ${r.json.error}`);
  } else {
    assert.match(r.json.error, /not available in harness/);
    console.log(`ok  ${count}/${max}: below the limit, request reaches session creation`);
  }
  console.log("ALL PASS");
  process.exit(0);
} catch (err) { console.error("FAIL:", err.message); process.exit(1); }
