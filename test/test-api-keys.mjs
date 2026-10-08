// API keys for other systems: needs AUTH_ENABLED=true, ADMIN_EMAIL, ADMIN_PASSWORD (see run.mjs).
import assert from "node:assert/strict";
import { boot, BASE, sentLog, sleep } from "./harness.mjs";

async function call(method, path, { body, cookie, key, bearer, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { "X-API-Key": key } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const set = r.headers.getSetCookie().find((c) => c.startsWith("wa_session="));
  return { status: r.status, json, text, cookie: set ? set.split(";")[0] : null };
}

try {
  const db = await boot();
  const ADMIN = process.env.ADMIN_EMAIL, PW = process.env.ADMIN_PASSWORD;

  // An admin signs in and replaces the bootstrap password.
  const login = await call("POST", "/api/auth/login", { body: { email: ADMIN, password: PW } });
  const admin = login.cookie;
  assert.equal((await call("POST", "/api/auth/password", { cookie: admin, body: { current: PW, next: "password-baru-1" } })).status, 200);

  // ── an admin creates a key; it is shown once and only its hash is stored
  assert.equal((await call("POST", "/api/api-keys", { cookie: admin, body: { name: "  " } })).status, 400);
  const made = await call("POST", "/api/api-keys", { cookie: admin, body: { name: "LMS" } });
  assert.equal(made.status, 200, made.text);
  const KEY = made.json.key;
  assert.match(KEY, /^wab_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.json.apiKey.name, "LMS");
  assert.equal(made.json.apiKey.prefix, KEY.slice(0, 10));
  const stored = db.default.prepare("SELECT * FROM api_keys").all();
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(KEY), "the key itself is never stored");
  const listed = await call("GET", "/api/api-keys", { cookie: admin });
  assert.ok(!listed.text.includes(KEY), "listing never shows the key again");
  assert.deepEqual(listed.json.map((k) => [k.name, k.lastUsedAt, k.revokedAt]), [["LMS", null, null]]);
  console.log("ok  an admin creates a key that is shown once and stored only as a hash");

  // ── the key reaches the sending and status APIs, by either header
  assert.equal((await call("GET", "/api/sessions", { key: KEY })).status, 200);
  assert.equal((await call("GET", "/api/sessions/a", { bearer: KEY })).status, 200);
  assert.equal((await call("GET", "/api/status?sessionId=a", { key: KEY })).status, 200);
  const before = sentLog.length;
  const sent = await call("POST", "/api/send", { key: KEY, body: { sessionId: "a", phone: "081200000009", message: "Halo dari LMS" } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sentLog.length, before + 1);
  assert.equal(sentLog.at(-1).text, "Halo dari LMS");
  const quick = await call("POST", "/api/quick-send", { key: KEY, body: { sessionId: "b", phone: "081200000010", message: "tes", count: 1 } });
  assert.equal(quick.status, 200);
  const hist = await call("GET", "/api/history", { key: KEY });
  assert.equal(hist.status, 200);
  assert.equal(hist.json.find((j) => j.type === "quick")?.user_email, "api:LMS", "history names the key that sent it");
  const used = (await call("GET", "/api/api-keys", { cookie: admin })).json[0];
  assert.ok(used.lastUsedAt, "last use is recorded");
  console.log("ok  the key can list numbers, send, check status and read history, and sends are traced to it");

  // ── everything else stays with signed-in people
  const refused = [
    ["GET", "/api/sessions/a/chats"],
    ["GET", "/api/sessions/a/chats/6281200000009%40s.whatsapp.net/messages"],
    ["GET", "/api/sessions/a/transcripts"],
    ["GET", "/api/sessions/archived"],
    ["POST", "/api/sessions"],
    ["DELETE", "/api/sessions/a"],
    ["POST", "/api/sessions/a/reconnect"],
    ["POST", "/api/disconnect"],
    ["GET", "/api/users"],
    ["GET", "/api/api-keys"],
    ["POST", "/api/api-keys"],
    ["DELETE", "/api/api-keys/1"],
    ["POST", "/api/auth/password"],
    ["GET", "/api/connection-log"],
    ["GET", "/"],
  ];
  for (const [method, path] of refused) {
    const r = await call(method, path, { key: KEY, body: method === "GET" ? undefined : {} });
    assert.equal(r.status, 403, `${method} ${path} must be refused for a key (got ${r.status})`);
  }
  console.log("ok  a key cannot read chats, manage numbers, users or keys, or open the dashboard");

  // ── wrong, malformed and revoked keys
  assert.equal((await call("GET", "/api/sessions", { key: "wab_salah" })).status, 401);
  assert.equal((await call("GET", "/api/sessions", { key: KEY.slice(0, -1) + (KEY.at(-1) === "A" ? "B" : "A") })).status, 401);
  assert.equal((await call("GET", "/api/sessions", { key: "bukan-kunci" })).status, 401, "not a key: treated as no login");
  const id = made.json.apiKey.id;
  const revoked = await call("DELETE", `/api/api-keys/${id}`, { cookie: admin });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.apiKey.revokedAt);
  assert.equal((await call("GET", "/api/sessions", { key: KEY })).status, 401, "a revoked key stops working at once");
  assert.equal((await call("DELETE", "/api/api-keys/999", { cookie: admin })).status, 404);
  console.log("ok  unknown and revoked keys are refused");

  // ── members cannot manage keys
  const m = await call("POST", "/api/users", { cookie: admin, body: { name: "Vero", email: "vero@contoh.com", role: "member" } });
  const mLogin = await call("POST", "/api/auth/login", { body: { email: "vero@contoh.com", password: m.json.temporaryPassword } });
  await call("POST", "/api/auth/password", { cookie: mLogin.cookie, body: { current: m.json.temporaryPassword, next: "punya-vero-123" } });
  assert.equal((await call("GET", "/api/api-keys", { cookie: mLogin.cookie })).status, 403);
  assert.equal((await call("POST", "/api/api-keys", { cookie: mLogin.cookie, body: { name: "x" } })).status, 403);
  console.log("ok  only admins can create, list or revoke keys");

  await sleep(50);
  console.log("ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
}
