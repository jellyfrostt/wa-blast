import { randomBytes, scrypt, timingSafeEqual, createHash } from "crypto";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import db from "./db.js";

// Login for the dashboard. Off unless AUTH_ENABLED=true, so an existing deployment keeps working
// until accounts are configured. Two ways in:
//   - Google sign-in, restricted to one Workspace domain (accounts are created on first sign-in)
//   - email + password accounts created by an admin, with a one-time password the user must replace
// Sessions are random tokens in an httpOnly cookie; only their SHA-256 is stored.

const scryptAsync = promisify(scrypt);
const __dirname = dirname(fileURLToPath(import.meta.url));

const SESSION_COOKIE = "wa_session";
const STATE_COOKIE = "wa_oauth_state";
const SESSION_DAYS = 7;
const MIN_PASSWORD = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const ROLES = ["admin", "member"];

export const authEnabled = () => process.env.AUTH_ENABLED === "true";
const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const allowedDomain = () => (process.env.GOOGLE_ALLOWED_DOMAIN || "pintarnya.com").trim().toLowerCase();
const adminEmails = () =>
  new Set(String(process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));

// Tests point the Google token exchange at a local fake.
export const authTestHooks = { googleTokenUrl: null };

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    password_hash TEXT,
    google_sub TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  listUsers: db.prepare("SELECT * FROM users ORDER BY is_active DESC, name COLLATE NOCASE"),
  countUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  countActiveAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1"),
  insertUser: db.prepare(
    "INSERT INTO users (email, name, role, password_hash, google_sub, must_change_password, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  setPassword: db.prepare("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?"),
  setRole: db.prepare("UPDATE users SET role = ? WHERE id = ?"),
  setActive: db.prepare("UPDATE users SET is_active = ? WHERE id = ?"),
  setGoogle: db.prepare("UPDATE users SET google_sub = ? WHERE id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  insertSession: db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))"),
  sessionUser: db.prepare(`
    SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `),
  deleteSession: db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?"),
  deleteUserSessions: db.prepare("DELETE FROM auth_sessions WHERE user_id = ?"),
  deleteOtherSessions: db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?"),
};

// ─── Passwords ────────────────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, key] = parts;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const dummyHash = hashPassword(randomBytes(16).toString("hex"));

function temporaryPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(12), (b) => alphabet[b % alphabet.length]).join("");
}

// ─── Cookies and sessions ─────────────────────────────────────────────────

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (req.secure) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

function startSession(req, res, user) {
  const token = randomBytes(32).toString("base64url");
  q.insertSession.run(hashToken(token), user.id, `+${SESSION_DAYS} days`);
  q.touchLogin.run(user.id);
  setCookie(req, res, SESSION_COOKIE, token, SESSION_DAYS * 24 * 60 * 60);
}

function currentUser(req) {
  const token = readCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const user = q.sessionUser.get(hashToken(token));
  return user ? { ...user, sessionHash: hashToken(token) } : null;
}

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  active: !!u.is_active,
  mustChangePassword: !!u.must_change_password,
  hasPassword: !!u.password_hash,
  google: !!u.google_sub,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

// ─── Login throttling ─────────────────────────────────────────────────────

const attempts = new Map();

function tooManyAttempts(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now > a.resetAt) return false;
  return a.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailure(key) {
  const now = Date.now();
  if (attempts.size > 5000) for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  const a = attempts.get(key);
  if (!a || now > a.resetAt) attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else a.count++;
}

// ─── Startup ──────────────────────────────────────────────────────────────

async function bootstrapAdmin(logger) {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (email && password) {
    const existing = q.userByEmail.get(email);
    if (!existing) {
      q.insertUser.run(email, "Admin", "admin", await hashPassword(password), null, 1, "bootstrap");
      logger.info({ email }, "First admin account created from ADMIN_EMAIL; the password must be changed at first login");
    } else if (existing.role !== "admin" || !existing.is_active) {
      q.setRole.run("admin", existing.id);
      q.setActive.run(1, existing.id);
    }
  }
  if (!q.countActiveAdmins.get().n && !adminEmails().size) {
    logger.error("AUTH_ENABLED is on but no admin exists: set ADMIN_EMAIL and ADMIN_PASSWORD, or ADMIN_EMAILS for Google sign-in");
  }
}

// ─── Google sign-in ───────────────────────────────────────────────────────

const redirectUri = (req) =>
  `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "")}/auth/google/callback`;

async function googleIdentity(req, code) {
  const res = await fetch(authTestHooks.googleTokenUrl || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.id_token) throw new Error("google");
  // The ID token comes straight from Google over TLS in exchange for our client secret, so its
  // claims are trusted without a separate signature check; audience and issuer are still verified.
  const claims = JSON.parse(Buffer.from(String(body.id_token).split(".")[1] || "", "base64url").toString("utf8"));
  const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID || !issuerOk || !(claims.exp * 1000 > Date.now())) throw new Error("google");
  const email = String(claims.email || "").toLowerCase();
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("unverified");
  if (!email.endsWith(`@${allowedDomain()}`) || String(claims.hd || "").toLowerCase() !== allowedDomain()) throw new Error("domain");
  return { email, name: String(claims.name || email.split("@")[0]), sub: String(claims.sub || "") };
}

// ─── Routes ───────────────────────────────────────────────────────────────

export function mountAuth(app, logger) {
  app.set("trust proxy", 1);

  app.get("/api/auth/config", (_req, res) => {
    res.json({ enabled: authEnabled(), google: authEnabled() && googleEnabled(), domain: allowedDomain() });
  });

  if (!authEnabled()) {
    app.get("/api/auth/me", (_req, res) => res.json({ authEnabled: false, user: null }));
    app.get("/login", (_req, res) => res.redirect("/"));
    return;
  }

  bootstrapAdmin(logger).catch((err) => logger.error({ err: err.message }, "Failed to prepare the admin account"));

  // The session cookie is SameSite=Lax; this also refuses state-changing requests from another origin.
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let host = null;
    try { host = new URL(origin).host; } catch {}
    if (host !== req.get("host")) return res.status(403).json({ error: "Permintaan dari situs lain ditolak" });
    next();
  });

  app.get("/login", (_req, res) => res.sendFile(join(__dirname, "public", "login.html")));

  app.get("/api/auth/me", (req, res) => {
    const user = currentUser(req);
    res.json({ authEnabled: true, user: user ? publicUser(user) : null });
  });

  app.post("/api/auth/login", async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const key = `${req.ip}|${email}`;
    if (!email || !password) return res.status(400).json({ error: "Isi email dan password." });
    if (tooManyAttempts(key)) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi 15 menit lagi." });
    try {
      const user = q.userByEmail.get(email);
      const ok = await verifyPassword(password, user?.password_hash || (await dummyHash));
      if (!user || !user.password_hash || !ok || !user.is_active) {
        recordFailure(key);
        logger.warn({ email }, "Login failed");
        return res.status(401).json({ error: "Email atau password salah." });
      }
      attempts.delete(key);
      startSession(req, res, user);
      logger.info({ email }, "Login");
      res.json({ user: publicUser(user) });
    } catch (err) {
      logger.error({ err: err.message }, "Login error");
      res.status(500).json({ error: "Gagal masuk. Coba lagi." });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = readCookies(req)[SESSION_COOKIE];
    if (token) q.deleteSession.run(hashToken(token));
    setCookie(req, res, SESSION_COOKIE, "", 0);
    res.json({ ok: true });
  });

  app.get("/auth/google", (req, res) => {
    if (!googleEnabled()) return res.redirect("/login?error=google_off");
    const state = randomBytes(16).toString("hex");
    setCookie(req, res, STATE_COOKIE, state, 600);
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(req),
      response_type: "code",
      scope: "openid email profile",
      state,
      hd: allowedDomain(),
      prompt: "select_account",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get("/auth/google/callback", async (req, res) => {
    const fail = (code) => res.redirect(`/login?error=${code}`);
    if (!googleEnabled()) return fail("google_off");
    const expected = Buffer.from(readCookies(req)[STATE_COOKIE] || "");
    const given = Buffer.from(String(req.query.state || ""));
    setCookie(req, res, STATE_COOKIE, "", 0);
    if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) return fail("state");
    if (!req.query.code) return fail("google");
    try {
      const id = await googleIdentity(req, String(req.query.code));
      let user = q.userByEmail.get(id.email);
      const shouldBeAdmin = adminEmails().has(id.email);
      if (!user) {
        q.insertUser.run(id.email, id.name, shouldBeAdmin ? "admin" : "member", null, id.sub, 0, "google");
        user = q.userByEmail.get(id.email);
      } else {
        if (!user.is_active) return fail("inactive");
        if (!user.google_sub) q.setGoogle.run(id.sub, user.id);
        if (shouldBeAdmin && user.role !== "admin") q.setRole.run("admin", user.id);
      }
      startSession(req, res, user);
      logger.info({ email: id.email }, "Login with Google");
      res.redirect("/");
    } catch (err) {
      const code = ["domain", "unverified"].includes(err.message) ? err.message : "google";
      logger.warn({ reason: code }, "Google login refused");
      fail(code);
    }
  });

  // ── Everything below needs a signed-in user ──
  app.use((req, res, next) => {
    // These two carry their own protection or expose nothing private.
    if (req.path === "/health" || req.path === "/api/backup") return next();
    const user = currentUser(req);
    const isApi = req.path.startsWith("/api/");
    if (!user) return isApi ? res.status(401).json({ error: "Silakan masuk dulu." }) : res.redirect("/login");
    if (user.must_change_password && req.path !== "/api/auth/password") {
      return isApi
        ? res.status(403).json({ error: "Ganti password sementara dulu.", mustChangePassword: true })
        : res.redirect("/login");
    }
    req.user = user;
    next();
  });

  app.post("/api/auth/password", async (req, res) => {
    const current = String(req.body?.current || "");
    const next = String(req.body?.next || "");
    if (!req.user.password_hash) return res.status(400).json({ error: "Akun ini masuk lewat Google, jadi tidak punya password." });
    if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `Password baru minimal ${MIN_PASSWORD} karakter.` });
    if (next === current) return res.status(400).json({ error: "Password baru harus berbeda dari yang lama." });
    if (!(await verifyPassword(current, req.user.password_hash))) return res.status(400).json({ error: "Password lama salah." });
    q.setPassword.run(await hashPassword(next), 0, req.user.id);
    q.deleteOtherSessions.run(req.user.id, req.user.sessionHash);
    res.json({ ok: true });
  });

  // ── User management (admin) ──
  const adminOnly = (req, res, next) =>
    req.user?.role === "admin" ? next() : res.status(403).json({ error: "Hanya admin yang bisa melakukan ini." });

  app.get("/api/users", adminOnly, (_req, res) => {
    res.json(q.listUsers.all().map(publicUser));
  });

  app.post("/api/users", adminOnly, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim();
    const role = ROLES.includes(req.body?.role) ? req.body.role : "member";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email tidak valid." });
    if (!name) return res.status(400).json({ error: "Isi nama orangnya." });
    if (q.userByEmail.get(email)) return res.status(409).json({ error: "Email itu sudah terdaftar." });
    const password = temporaryPassword();
    q.insertUser.run(email, name.slice(0, 120), role, await hashPassword(password), null, 1, req.user.email);
    logger.info({ email, role, by: req.user.email }, "User created");
    res.json({ user: publicUser(q.userByEmail.get(email)), temporaryPassword: password });
  });

  app.patch("/api/users/:id", adminOnly, (req, res) => {
    const target = q.userById.get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
    const { role, active } = req.body || {};
    const demoting = role !== undefined && role !== "admin" && target.role === "admin";
    const disabling = active === false && target.is_active;
    if ((demoting || disabling) && target.id === req.user.id) return res.status(400).json({ error: "Tidak bisa mengubah akun sendiri seperti itu." });
    const losesAnAdmin = target.role === "admin" && target.is_active && (demoting || disabling);
    if (losesAnAdmin && q.countActiveAdmins.get().n <= 1) return res.status(400).json({ error: "Harus ada minimal satu admin aktif." });
    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: "Peran tidak dikenal." });
      q.setRole.run(role, target.id);
    }
    if (active !== undefined) {
      q.setActive.run(active ? 1 : 0, target.id);
      if (!active) q.deleteUserSessions.run(target.id);
    }
    logger.info({ email: target.email, role, active, by: req.user.email }, "User updated");
    res.json({ user: publicUser(q.userById.get(target.id)) });
  });

  app.post("/api/users/:id/reset-password", adminOnly, async (req, res) => {
    const target = q.userById.get(Number(req.params.id));
    if (!target) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
    const password = temporaryPassword();
    q.setPassword.run(await hashPassword(password), 1, target.id);
    q.deleteUserSessions.run(target.id);
    logger.info({ email: target.email, by: req.user.email }, "Password reset");
    res.json({ temporaryPassword: password });
  });
}
