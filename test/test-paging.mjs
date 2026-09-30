import assert from "node:assert/strict";
import { boot, api, upload, waitJob, BASE } from "./harness.mjs";
const quick = (i) => fetch(`${BASE}/api/quick-send`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: "a", phone: `08119990${String(i).padStart(3, "0")}`, message: `q${i}`, count: 1 }) }).then((r) => r.text());
try {
  await boot();
  const csv = "nama,phone\n" + Array.from({ length: 130 }, (_, i) => `U${i},0822100${String(i).padStart(4, "0")}`).join("\n") + "\n";
  const up = await upload(csv);
  await api("POST", "/api/blast", { sessionId: "b", uploadId: up.json.uploadId, template: "Hi {{nama}}", delayMin: 0, delayMax: 0 });
  await waitJob("b", 60000);

  const pages = [];
  for (const off of [0, 50, 100, 150]) pages.push((await api("GET", `/api/sessions/b/chats?limit=50&offset=${off}`)).json);
  assert.deepEqual(pages.map((p) => p.length), [50, 50, 30, 0]);
  assert.equal(new Set(pages.flat().map((c) => c.jid)).size, 130, "no duplicates or gaps across pages");
  console.log("ok  130 chats page as 50/50/30 with no duplicates even though they share a timestamp");

  const one = (await api("GET", "/api/sessions/b/chats?limit=50&q=" + encodeURIComponent("0822 1000-123"))).json;
  assert.deepEqual(one.map((c) => c.jid), ["628221000123@s.whatsapp.net"]);
  const many = (await api("GET", "/api/sessions/b/chats?limit=50&q=62822100012")).json;
  assert.equal(many.length, 10);
  assert.deepEqual((await api("GET", "/api/sessions/b/chats?limit=50&q=999999")).json, []);
  assert.equal((await api("GET", "/api/sessions/b/chats?limit=50&q=" + encodeURIComponent("abc"))).json.length, 50, "non-digit query means no filter");
  assert.deepEqual((await api("GET", "/api/sessions/a/chats?limit=50&q=0822")).json, [], "search stays within the selected number");
  console.log("ok  search finds numbers typed as 08xx or 62xx, beyond the first page, only within the chosen number");

  for (let i = 0; i < 25; i++) await quick(i);
  const h1 = (await api("GET", "/api/history?limit=20")).json;
  const h2 = (await api("GET", "/api/history?limit=20&offset=20")).json;
  assert.deepEqual([h1.length, h2.length], [20, 6]);
  assert.equal(new Set([...h1, ...h2].map((j) => j.id)).size, 26);
  assert.ok([...h1, ...h2].every((j, i, arr) => i === 0 || arr[i - 1].started_at >= j.started_at), "newest first across pages");
  console.log("ok  26 history jobs page as 20/6, newest first, no duplicates");
  console.log("ALL PASS");
  process.exit(0);
} catch (err) { console.error("FAIL:", err.message); process.exit(1); }
