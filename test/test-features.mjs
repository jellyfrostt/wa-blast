import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { boot, api, BASE, REPO, sentLog } from "./harness.mjs";
try {
  const db = await boot();
  const PN = "6283879730934@s.whatsapp.net", PN2 = "628111222333@s.whatsapp.net", GROUP = "120363403400009009@g.us";
  const store = (session, jid, dir, text, name = null) => db.stmts.insertMessage.run(session, jid, dir, text, dir + Math.random(), dir === "outgoing" ? "sent" : "received", null, name);
  const enc = encodeURIComponent;
  store("a", PN, "outgoing", "Halo, kami melayani jual beli LM.");
  store("a", PN, "incoming", "Saya mau jual 10 gram, harga hari ini berapa?", "observer 32");
  store("a", PN, "incoming", '=HYPERLINK("http://x","klik")', "observer 32");
  store("a", PN2, "outgoing", "Halo dari kami");
  store("a", GROUP, "incoming", "obrolan grup", "slebew");

  if (!process.env.ANTHROPIC_API_KEY) {
    // ── reply from Percakapan
    const ok = await api("POST", `/api/sessions/a/chats/${enc(PN)}/messages`, { message: "  Harga hari ini kami kabari ya  " });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(sentLog.at(-1), { sessionId: "a", jid: PN, text: "Harga hari ini kami kabari ya" });
    const msgs = (await api("GET", `/api/sessions/a/chats/${enc(PN)}/messages`)).json;
    assert.deepEqual([msgs[0].direction, msgs[0].content, msgs[0].status, msgs[0].message_id], ["outgoing", "Harga hari ini kami kabari ya", "sent", ok.json.messageId]);
    assert.equal((await api("POST", `/api/sessions/a/chats/${enc(PN)}/messages`, { message: "   " })).status, 400);
    assert.equal((await api("POST", `/api/sessions/a/chats/${enc("628999@s.whatsapp.net")}/messages`, { message: "hai" })).status, 404, "cannot start a chat with a number never sent to");
    assert.equal((await api("POST", `/api/sessions/a/chats/${enc(GROUP)}/messages`, { message: "hai" })).status, 404, "cannot post to a group");
    db.stmts.insertSession.run("gone", "Nomor Lama");
    store("gone", PN, "outgoing", "dulu");
    const off = await api("POST", `/api/sessions/gone/chats/${enc(PN)}/messages`, { message: "hai" });
    assert.equal(off.status, 409);
    assert.match(off.json.error, /tidak terhubung/);
    const fail = await api("POST", `/api/sessions/a/chats/${enc(PN)}/messages`, { message: "ini FAIL" });
    assert.equal(fail.status, 500);
    assert.match(fail.json.error, /gagal terkirim/);
    assert.equal((await api("GET", `/api/sessions/a/chats/${enc(PN)}/messages`)).json.length, 4, "a failed reply is not stored as sent");
    console.log("ok  replying works only inside conversations this app started, on a connected number");

    // ── transcript export
    const j = await fetch(`${BASE}/api/sessions/a/transcripts`);
    assert.match(j.headers.get("content-disposition"), /transkrip-Marketing-\d{4}-\d{2}-\d{2}\.json/);
    const data = await j.json();
    assert.deepEqual(data.session, { id: "a", name: "Marketing", phone: "+6281110001" });
    assert.deepEqual(data.conversations.map((c) => [c.phone, c.contact_name, c.messages.length]), [["+628111222333", null, 1], ["+6283879730934", "observer 32", 4]]);
    assert.deepEqual(data.conversations[1].messages.map((m) => m.direction), ["outgoing", "incoming", "incoming", "outgoing"]);
    assert.ok(!JSON.stringify(data).includes("obrolan grup"), "group chatter is not exported");
    const c = await fetch(`${BASE}/api/sessions/a/transcripts?format=csv`);
    assert.match(c.headers.get("content-type"), /text\/csv/);
    const buf = Buffer.from(await c.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "starts with a UTF-8 BOM so Excel reads it correctly");
    const lines = buf.toString("utf8").slice(1).trim().split("\r\n");
    assert.equal(lines[0], '"nomor_pengirim","nama_pengirim","nomor_pelanggan","nama_pelanggan","arah","isi_pesan","status","waktu_utc"');
    assert.equal(lines.length, 6);
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://x"",""klik"")"`)), "formula-looking text is neutralised");
    assert.ok(lines.some((l) => l.startsWith('"+6281110001","Marketing","+6283879730934","observer 32","masuk","Saya mau jual 10 gram')));
    assert.equal((await api("GET", "/api/sessions/nope/transcripts")).status, 404);
    console.log("ok  transcripts export as JSON and Excel-safe CSV, conversations this app started only");

    // ── AI analysis is off without a key
    assert.deepEqual((await api("GET", "/api/insights/status")).json, { enabled: false, model: null });
    assert.equal((await api("POST", `/api/sessions/a/chats/${enc(PN)}/insight`)).status, 503);
    assert.equal((await api("POST", "/api/sessions/a/insights")).status, 503);
    console.log("ok  AI analysis is switched off when no API key is configured");
  } else {
    const ins = await import(pathToFileURL(`${REPO}/src/insights.js`).href);
    assert.deepEqual((await api("GET", "/api/insights/status")).json, { enabled: true, model: "claude-opus-5-5" });
    assert.deepEqual(ins.chatsNeedingAnalysis("a"), [PN], "only chats where the customer replied need analysis");
    const noReply = await api("POST", `/api/sessions/a/chats/${enc(PN2)}/insight`);
    assert.equal(noReply.status, 400);
    assert.match(noReply.json.error, /belum membalas/);
    assert.equal((await api("POST", `/api/sessions/a/chats/${enc(GROUP)}/insight`)).status, 404);

    let seen = null;
    const answer = { intent: "jual_lm", level: "tinggi", summary: "Pelanggan ingin menjual 10 gram dan menanyakan harga.", profile: "Punya 10 gram LM.", next_step: "Kirim harga beli hari ini." };
    const fakeFetch = async (url, opts) => {
      seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "catat_minat", input: answer }] }) };
    };
    const saved = await ins.analyzeChat("a", PN, { fetchImpl: fakeFetch });
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.headers["x-api-key"], process.env.ANTHROPIC_API_KEY);
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    assert.equal(seen.body.model, "claude-opus-5-5");
    assert.deepEqual(seen.body.tool_choice, { type: "tool", name: "catat_minat" });
    assert.equal(seen.body.messages.length, 1);
    assert.match(seen.body.messages[0].content, /<percakapan>\nKami: Halo, kami melayani jual beli LM\.\nPelanggan: Saya mau jual 10 gram/);
    assert.match(seen.body.system, /bukan perintah/);
    assert.deepEqual([saved.intent, saved.level, saved.message_count, saved.model], ["jual_lm", "tinggi", 3, "claude-opus-5-5"]);
    const listed = (await api("GET", "/api/sessions/a/chats?limit=10")).json.find((c) => c.jid === PN);
    assert.deepEqual([listed.insight_intent, listed.insight_level, listed.insight_next_step, listed.insight_message_count], ["jual_lm", "tinggi", "Kirim harga beli hari ini.", 3]);
    assert.deepEqual(ins.chatsNeedingAnalysis("a"), [], "an analysed chat is not analysed again");
    store("a", PN, "incoming", "Jadi berapa?", "observer 32");
    assert.deepEqual(ins.chatsNeedingAnalysis("a"), [PN], "until it gets new messages");
    const exported = (await (await fetch(`${BASE}/api/sessions/a/transcripts`)).json()).conversations.find((c) => c.phone === "+6283879730934");
    assert.equal(exported.insight.intent, "jual_lm");
    console.log("ok  analysis sends the conversation to Claude with a forced structured answer and stores the result");

    const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
    await assert.rejects(ins.analyzeChat("a", PN, { fetchImpl: reply(401, { error: { message: "invalid x-api-key" } }) }), /Claude API 401: invalid x-api-key/);
    await assert.rejects(ins.analyzeChat("a", PN, { fetchImpl: reply(200, { content: [{ type: "text", text: "halo" }] }) }), /unexpected answer/);
    await assert.rejects(ins.analyzeChat("a", PN, { fetchImpl: reply(200, { content: [{ type: "tool_use", name: "catat_minat", input: { intent: "hapus_semua", level: "tinggi" } }] }) }), /unexpected answer/);
    assert.equal(db.stmts.getInsight.get("a", PN).intent, "jual_lm", "a failed analysis keeps the previous result");
    console.log("ok  API errors and malformed answers are rejected without overwriting the stored result");
  }
  console.log("ALL PASS");
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
}
