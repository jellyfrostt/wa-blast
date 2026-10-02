// Runs every suite against the real server code with fake WhatsApp sockets.
// Each suite gets its own process and its own temporary folder for the database and logs.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  ["test-parallel.mjs", {}],
  ["test-history.mjs", {}],
  ["test-paging.mjs", { SEND_MS: "1" }],
  ["test-limit.mjs", { WITH_QR: "1", MAX_SESSIONS: "3" }],
  ["test-limit.mjs", { WITH_QR: "1", MAX_SESSIONS: "4" }],
  ["test-privacy.mjs", {}],
  ["test-archive-backup.mjs", {}],
  ["test-archive-backup.mjs", { BACKUP_TOKEN: "test-token" }],
  ["test-features.mjs", {}],
  ["test-features.mjs", { ANTHROPIC_API_KEY: "test-key-not-real" }],
  ["test-hardening.mjs", {}],
  ["test-auth.mjs", { AUTH_ENABLED: "true", ADMIN_EMAIL: "admin@contoh.com", ADMIN_PASSWORD: "bootstrap-pass-1", ADMIN_EMAILS: "boss@pintarnya.com", GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret" }],
];

let failed = 0;
for (const [file, env] of suites) {
  const cwd = mkdtempSync(join(tmpdir(), "wa-blast-test-"));
  const label = `${file}${Object.keys(env).length ? ` (${Object.keys(env).join(", ")})` : ""}`;
  const clean = { ...process.env };
  for (const k of ["DB_PATH", "BACKUP_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "MAX_SESSIONS", "WITH_QR", "N_SESSIONS", "AUTH_ENABLED", "ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_EMAILS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ALLOWED_DOMAIN", "PUBLIC_URL"]) delete clean[k];
  const r = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--no-warnings", join(here, file)], {
    cwd,
    env: { ...clean, LOG_LEVEL: "silent", ...env },
    encoding: "utf8",
    timeout: 180000,
  });
  // The verdict is the suite's own final line: on Windows, Node can abort inside libuv while exiting
  // (after everything passed), which makes the exit code unreliable.
  const ok = /^ALL PASS$/m.test(r.stdout) && !/^FAIL/m.test(r.stdout + r.stderr);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    failed++;
    console.log((r.stdout + r.stderr).trim().split("\n").slice(-12).join("\n"));
  }
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nAll suites passed");
process.exit(failed ? 1 : 0);
