// Login: needs AUTH_ENABLED=true, ADMIN_EMAIL, ADMIN_PASSWORD, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (see run.mjs).
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { boot, BASE, REPO, PORT } from "./harness.mjs";

// A tiny browser: keeps cookies per "person" and never follows redirects, so they can be inspected.
function client() {
  const jar = new Map();
  return async function call(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookies = r.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (value === "" || /Max-Age=0/i.test(c)) jar.delete(name); else jar.set(name, value);
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, location: r.headers.get("location"), setCookies, jar, headers: r.headers };
  };
}

const fakeIdToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

try {
  const db = await boot();
  const auth = await import(pathToFileURL(`${REPO}/src/auth.js`).href);
  const ADMIN = process.env.ADMIN_EMAIL, ADMIN_PW = process.env.ADMIN_PASSWORD;

  // ── nothing is reachable without signing in
  const anon = client();
  assert.equal((await anon("GET", "/api/sessions")).status, 401);
  assert.equal((await anon("GET", "/api/history")).status, 401);
  assert.equal((await anon("POST", "/api/quick-send", { phone: "0812", message: "x" })).status, 401);
  assert.equal((await anon("GET", "/api/sessions/a/transcripts")).status, 401);
  assert.equal((await anon("GET", "/api/users")).status, 401);
  const home = await anon("GET", "/");
  assert.deepEqual([home.status, home.location], [302, "/login"]);
  assert.equal((await anon("GET", "/index.html")).status, 302);
  assert.equal((await anon("GET", "/qr")).status, 302);
  const loginPage = await anon("GET", "/login");
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /Masuk dengan Google/);
  const health = await anon("GET", "/health");
  assert.notEqual(health.status, 401, "health check stays open for the platform");
  assert.equal(health.json.sessions, undefined, "but it no longer lists numbers and phone numbers");
  assert.equal(typeof health.json.connectedNumbers, "number");
  assert.equal(loginPage.headers.get("x-frame-options"), "DENY");
  assert.equal((await anon("GET", "/api/sessions")).headers.get("cache-control"), "no-store");
  assert.equal((await anon("GET", "/api/sessions", null, { Cookie: "wa_session=%E0%A4%A; rusak" })).status, 401, "a malformed cookie is ignored, not a crash");
  assert.deepEqual((await anon("GET", "/api/auth/config")).json, { enabled: true, google: true, domain: "pintarnya.com" });
  assert.deepEqual((await anon("GET", "/api/auth/me")).json, { authEnabled: true, user: null });
  console.log("ok  pages redirect to /login and every API answers 401 without a session");

  // ── password login: generic error, then the first admin must replace the bootstrap password
  const admin = client();
  const wrong = await admin("POST", "/api/auth/login", { email: ADMIN, password: "salah-salah" });
  assert.deepEqual([wrong.status, wrong.json.error], [401, "Email atau password salah."]);
  const unknown = await admin("POST", "/api/auth/login", { email: "tidak.ada@contoh.com", password: "salah-salah" });
  assert.deepEqual([unknown.status, unknown.json.error], [401, "Email atau password salah."], "unknown email gets the same answer");
  const ok = await admin("POST", "/api/auth/login", { email: ADMIN.toUpperCase(), password: ADMIN_PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.mustChangePassword, true);
  const cookie = ok.setCookies.find((c) => c.startsWith("wa_session="));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=604800/);
  assert.ok(!JSON.stringify(ok.json).includes("password_hash"));
  const blocked = await admin("GET", "/api/sessions");
  assert.deepEqual([blocked.status, blocked.json.mustChangePassword], [403, true], "a temporary password opens nothing but the change-password call");
  assert.equal((await admin("POST", "/api/auth/password", { current: ADMIN_PW, next: "pendek" })).status, 400);
  assert.equal((await admin("POST", "/api/auth/password", { current: "bukan-ini", next: "password-baru-1" })).status, 400);
  assert.equal((await admin("POST", "/api/auth/password", { current: ADMIN_PW, next: "password-baru-1" })).status, 200);
  assert.equal((await admin("GET", "/api/sessions")).status, 200);
  assert.equal((await admin("GET", "/")).status, 200);
  console.log("ok  password login sets an httpOnly session cookie and forces a new password at first login");

  // ── admin creates an account (the LMS-style "registration"); the member cannot manage users
  const created = await admin("POST", "/api/users", { name: "Vero", email: "Vero@Contoh.com", role: "member" });
  assert.equal(created.status, 200, created.text);
  const temp = created.json.temporaryPassword;
  assert.ok(temp.length >= 12);
  assert.deepEqual([created.json.user.email, created.json.user.role, created.json.user.mustChangePassword], ["vero@contoh.com", "member", true]);
  assert.equal((await admin("POST", "/api/users", { name: "Vero", email: "vero@contoh.com" })).status, 409);
  assert.equal((await admin("POST", "/api/users", { name: "X", email: "bukan-email" })).status, 400);
  const member = client();
  assert.equal((await member("POST", "/api/auth/login", { email: "vero@contoh.com", password: temp })).status, 200);
  assert.equal((await member("POST", "/api/auth/password", { current: temp, next: "punya-vero-123" })).status, 200);
  assert.equal((await member("GET", "/api/sessions")).status, 200);
  assert.equal((await member("GET", "/api/users")).status, 403);
  assert.equal((await member("POST", "/api/users", { name: "Y", email: "y@contoh.com" })).status, 403);
  assert.equal((await member("PATCH", "/api/users/1", { role: "member" })).status, 403);
  console.log("ok  an admin-created account works with its one-time password; members cannot manage users");

  // ── who started a send is recorded
  const sent = await member("POST", "/api/quick-send", { sessionId: "a", phone: "081200000001", message: "halo", count: 1 });
  assert.equal(sent.status, 200);
  const hist = (await member("GET", "/api/history")).json;
  assert.equal(hist[0].user_email, "vero@contoh.com");
  console.log("ok  history records which user started a send");

  // ── cross-site requests are refused; same-site ones pass
  assert.equal((await member("POST", "/api/clear", {}, { Origin: "https://jahat.example" })).status, 403);
  assert.equal((await member("POST", "/api/clear", {}, { Origin: `http://localhost:${PORT}` })).status, 200);
  console.log("ok  a state-changing request from another site is refused");

  // ── deactivation and password reset end the member's sessions; safeguards for the last admin
  const users = (await admin("GET", "/api/users")).json;
  const vero = users.find((u) => u.email === "vero@contoh.com"), adminRow = users.find((u) => u.email === ADMIN.toLowerCase());
  assert.equal((await admin("PATCH", `/api/users/${adminRow.id}`, { active: false })).status, 400, "cannot lock yourself out");
  assert.equal((await admin("PATCH", `/api/users/${adminRow.id}`, { role: "member" })).status, 400);
  assert.equal((await admin("PATCH", `/api/users/${vero.id}`, { active: false })).status, 200);
  assert.equal((await member("GET", "/api/sessions")).status, 401, "a deactivated user is signed out at once");
  assert.equal((await client()("POST", "/api/auth/login", { email: "vero@contoh.com", password: "punya-vero-123" })).status, 401);
  assert.equal((await admin("PATCH", `/api/users/${vero.id}`, { active: true })).status, 200);
  const reset = await admin("POST", `/api/users/${vero.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await client()("POST", "/api/auth/login", { email: "vero@contoh.com", password: "punya-vero-123" })).status, 401, "old password stops working");
  assert.equal((await client()("POST", "/api/auth/login", { email: "vero@contoh.com", password: reset.json.temporaryPassword })).status, 200);
  console.log("ok  deactivating or resetting a user ends access; the last admin cannot be removed");

  // ── logout
  const out = await admin("POST", "/api/auth/logout");
  assert.equal(out.status, 200);
  assert.equal((await admin("GET", "/api/sessions")).status, 401);
  console.log("ok  logout ends the session");

  // ── Google sign-in against a fake token endpoint
  let nextClaims = null, lastExchange = null;
  const fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastExchange = Object.fromEntries(new URLSearchParams(raw));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(nextClaims ? { id_token: fakeIdToken(nextClaims) } : { error: "invalid_grant" }));
    });
  }).listen(4003);
  auth.authTestHooks.googleTokenUrl = "http://localhost:4003/token";
  const good = (over = {}) => ({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, sub: "g-123", email: "bintang@pintarnya.com", email_verified: true, hd: "pintarnya.com", name: "Bintang", ...over });
  const signIn = async (claims) => {
    const c = client();
    const start = await c("GET", "/auth/google");
    assert.equal(start.status, 302);
    const to = new URL(start.location);
    nextClaims = claims;
    const back = await c("GET", `/auth/google/callback?code=abc&state=${to.searchParams.get("state")}`);
    return { c, start, to, back };
  };

  const g = await signIn(good());
  assert.equal(g.to.origin + g.to.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual([g.to.searchParams.get("hd"), g.to.searchParams.get("scope"), g.to.searchParams.get("redirect_uri")], ["pintarnya.com", "openid email profile", `http://localhost:${PORT}/auth/google/callback`]);
  assert.match(g.start.setCookies.join(";"), /wa_oauth_state=.*HttpOnly/);
  assert.deepEqual([lastExchange.code, lastExchange.grant_type, lastExchange.client_secret], ["abc", "authorization_code", process.env.GOOGLE_CLIENT_SECRET]);
  assert.deepEqual([g.back.status, g.back.location], [302, "/"]);
  const gme = (await g.c("GET", "/api/auth/me")).json.user;
  assert.deepEqual([gme.email, gme.name, gme.role, gme.google, gme.hasPassword, gme.mustChangePassword], ["bintang@pintarnya.com", "Bintang", "member", true, false, false]);
  assert.equal((await g.c("GET", "/api/sessions")).status, 200);
  assert.equal((await g.c("POST", "/api/auth/password", { current: "x", next: "password-baru-1" })).status, 400, "a Google account has no password to change");
  console.log("ok  Google sign-in creates a member account for the company domain");

  const boss = await signIn(good({ email: "boss@pintarnya.com", sub: "g-9", name: "Boss" }));
  assert.equal((await boss.c("GET", "/api/auth/me")).json.user.role, "admin", "ADMIN_EMAILS become admins");
  assert.equal((await boss.c("GET", "/api/users")).status, 200);

  for (const [label, claims, code] of [
    ["another domain", good({ email: "orang@gmail.com", hd: undefined }), "domain"],
    ["look-alike domain", good({ email: "x@pintarnya.com.evil.com", hd: "pintarnya.com.evil.com" }), "domain"],
    ["personal Google account registered with a company address", good({ hd: undefined }), "domain"],
    ["company-looking address in another organisation's domain", good({ email: "x@pintarnya.co", hd: "pintarnya.co" }), "domain"],
    ["unverified email", good({ email_verified: false }), "unverified"],
    ["token for another app", good({ aud: "client-lain" }), "google"],
    ["wrong issuer", good({ iss: "https://evil.example" }), "google"],
    ["expired token", good({ exp: Math.floor(Date.now() / 1000) - 10 }), "google"],
    ["failed code exchange", null, "google"],
  ]) {
    const r = await signIn(claims);
    assert.deepEqual([r.back.status, r.back.location], [302, `/login?error=${code}`], label);
    assert.equal((await r.c("GET", "/api/auth/me")).json.user, null, `${label}: no session`);
  }
  const forged = client();
  await forged("GET", "/auth/google");
  nextClaims = good();
  assert.equal((await forged("GET", "/auth/google/callback?code=abc&state=bukan-state-saya")).location, "/login?error=state");
  assert.equal((await client()("GET", "/auth/google/callback?code=abc&state=apa-saja")).location, "/login?error=state", "no state cookie");
  console.log("ok  Google sign-in refuses other domains, unverified emails, foreign tokens and forged state");

  // ── edge cases around Google
  const alias = await signIn(good({ email: "alias@pintarnya.com", sub: "g-77", hd: "pandai-group.com", name: "Alias" }));
  assert.equal(alias.back.location, "/", "an organisation whose primary domain differs from the address domain is accepted");
  const cancel = client();
  const cancelState = new URL((await cancel("GET", "/auth/google")).location).searchParams.get("state");
  assert.equal((await cancel("GET", `/auth/google/callback?error=access_denied&state=${cancelState}`)).location, "/login?error=cancelled");
  console.log("ok  Google: alias-domain organisations are accepted and a cancelled sign-in is reported as cancelled");

  // ── an account that still has a one-time password (like the first admin) can use Google straight away
  const dinaMade = await boss.c("POST", "/api/users", { name: "Dina", email: "dina@pintarnya.com" });
  const dinaTemp = dinaMade.json.temporaryPassword;
  const dina = await signIn(good({ email: "dina@pintarnya.com", sub: "g-55", name: "Dina" }));
  assert.equal(dina.back.location, "/");
  assert.equal((await dina.c("GET", "/api/auth/me")).json.user.mustChangePassword, false, "a Google session is not asked for the temporary password");
  assert.equal((await dina.c("GET", "/api/sessions")).status, 200);
  const dinaPw = client();
  assert.equal((await dinaPw("POST", "/api/auth/login", { email: "dina@pintarnya.com", password: dinaTemp })).json.user.mustChangePassword, true);
  assert.equal((await dinaPw("GET", "/api/sessions")).status, 403, "but signing in with the temporary password still forces a new one");
  db.default.prepare("UPDATE users SET temp_expires_at = datetime('now', '-1 day') WHERE email = ?").run("dina@pintarnya.com");
  const stale = await client()("POST", "/api/auth/login", { email: "dina@pintarnya.com", password: dinaTemp });
  assert.equal(stale.status, 401);
  assert.match(stale.json.error, /kedaluwarsa/);
  assert.equal((await dina.c("GET", "/api/sessions")).status, 200, "the Google session is unaffected");
  const bossRow = (await boss.c("GET", "/api/users")).json.find((u) => u.email === "boss@pintarnya.com");
  assert.equal((await boss.c("POST", `/api/users/${bossRow.id}/reset-password`)).status, 400, "an admin cannot reset (and sign out) themselves by accident");
  console.log("ok  temporary passwords: not demanded from Google sessions, still enforced for password sessions, expire after a week");

  // ── a deactivated Google account stays out
  const bintang = (await boss.c("GET", "/api/users")).json.find((u) => u.email === "bintang@pintarnya.com");
  await boss.c("PATCH", `/api/users/${bintang.id}`, { active: false });
  assert.equal((await signIn(good())).back.location, "/login?error=inactive");
  console.log("ok  a deactivated account cannot come back through Google");

  // ── too many wrong passwords
  const brute = client();
  let last = null;
  for (let i = 0; i < 9; i++) last = await brute("POST", "/api/auth/login", { email: "boss@pintarnya.com", password: "tebak-" + i });
  assert.equal(last.status, 429);
  console.log("ok  repeated wrong passwords are throttled");

  fake.close();
  console.log("ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
}
