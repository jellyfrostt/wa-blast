// The dashboard's request helper runs in the browser; this pulls it out of the page and checks that a page
// which never learned login is on (opened before it was switched on, or during a restart) still goes to the
// login page when the server asks for a sign-in, instead of reporting the server as unreachable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../src/public/index.html", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("    async function api(path, opts) {");
const end = html.indexOf("\n    }\n", start);
assert.ok(start > 0 && end > start, "request helper found in the page");

const run = async (status, body) => {
  const location = { went: null, replace(to) { this.went = to; } };
  const fetch = async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const api = new Function("fetch", "location", `let authOn = false;\n${html.slice(start, end + 6)}\nreturn api;`)(fetch, location);
  let result = null, error = null;
  try { result = await api("/api/sessions"); } catch (err) { error = err.message; }
  return { went: location.went, result, error };
};

try {
  let r = await run(401, { error: "Silakan masuk dulu." });
  assert.equal(r.went, "/login", "a sign-in request sends the page to the login page");
  console.log("ok  a page that does not know login is on still goes to the login page on 401");

  r = await run(403, { error: "Ganti password sementara dulu.", mustChangePassword: true });
  assert.equal(r.went, "/login");
  console.log("ok  an unreplaced one-time password also leads to the login page");

  r = await run(403, { error: "Hanya admin yang bisa melakukan ini." });
  assert.equal(r.went, null);
  assert.equal(r.error, "Hanya admin yang bisa melakukan ini.");
  r = await run(500, null);
  assert.equal(r.went, null);
  assert.equal(r.error, "Permintaan gagal (500)");
  r = await run(200, [{ id: "a" }]);
  assert.deepEqual(r, { went: null, result: [{ id: "a" }], error: null });
  console.log("ok  other errors and normal answers stay on the page");

  assert.ok(/fetch\("\/api\/auth\/me"\)\)\.json\(\); \} catch \{ setTimeout\(loadMe, 5000\); return; \}/.test(html), "a failed who-am-I call is tried again");
  console.log("ok  the who-am-I call is retried after a failure");

  console.log("ALL PASS");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
