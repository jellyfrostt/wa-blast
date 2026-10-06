// The help search runs in the browser; this pulls its pure functions and the real FAQ out of the page
// and checks that everyday wording, abbreviations and typos lead to the right answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../src/public/index.html", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("    // Forgiving search:");
const end = html.indexOf("    let faqIndex = null;");
assert.ok(start > 0 && end > start, "search code found in the page");
const { faqTokens, faqSearch } = new Function(`${html.slice(start, end)}\nreturn { faqTokens, faqSearch };`)();

const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<");
const entries = [...html.matchAll(/<details([^>]*)><summary>([\s\S]*?)<\/summary><div class="answer">([\s\S]*?)<\/div><\/details>/g)].map((m) => ({
  name: text(m[2]),
  title: faqTokens(text(m[2]), false, true),
  keys: faqTokens((m[1].match(/data-k="([^"]*)"/) || [])[1] || "", false, true),
  body: [...new Set(faqTokens(text(m[3]), false, true))],
}));
assert.ok(entries.length >= 20, `FAQ parsed (${entries.length} answers)`);
assert.ok(entries.every((e) => e.keys.length > 0), "every answer has everyday keywords");

const top = (q) => { const r = faqSearch(q, entries); return r.strong[0] ? entries[r.strong[0].index].name : null; };
const shown = (q) => faqSearch(q, entries).strong.map((r) => entries[r.index].name);

try {
  const cases = [
    // everyday wording
    ["kok pesan saya ga kekirim", "Kenapa ada pesan yang gagal"],
    ["pesan tidak terkirim", "Kenapa ada pesan yang gagal"],
    ["gagal kirim", "Kenapa ada pesan yang gagal"],
    ["cara scan qr", "Bagaimana cara menghubungkan nomor"],
    ["gimana nyambungin wa", "Bagaimana cara menghubungkan nomor"],
    ["scan barcode nya ga bisa", "Kamera HP saya tidak bisa scan"],
    ["nomer saya logout sendiri", "Status nomor saya"],
    ["wa nya putus", "Status nomor saya"],
    ["file excel nya gimana", "File kontak seperti apa"],
    ["format no hp", "Bagaimana format nomor HP"],
    ["lama banget ngirimnya", "Kenapa pengirimannya lama"],
    ["lemot", "Kenapa pengirimannya lama"],
    ["cara stop kirim", "Bagaimana cara menghentikan pengiriman"],
    ["batalin blast", "Bagaimana cara menghentikan pengiriman"],
    ["centang biru", "Apa arti Terkirim, Diterima, dan Dibaca"],
    ["download chat", "Bagaimana cara mengambil data percakapan"],
    ["mau ambil data chat buat diolah", "Bagaimana cara mengambil data percakapan"],
    ["bales chat customer", "Bisakah membalas pelanggan"],
    ["kurung kurawal nama itu apa", "Apa maksud tulisan {{nama}}"],
    ["whatsapp web masih nyala di laptop", "Bolehkah nomornya tetap tertaut"],
    ["berapa nomor maksimal", "Bisakah menghubungkan lebih dari satu nomor"],
    ["kalau nomor dihapus chat nya ilang ga", "Kalau nomor dihapus dari aplikasi"],
    ["siapa aja yang bisa liat", "Siapa saja yang bisa melihat data"],
    ["lupa sandi", "Bagaimana cara masuk"],
    ["ga bisa login", "Bagaimana cara masuk"],
    ["chat grup saya keliatan ga", "Apakah semua chat WhatsApp"],
    ["analisa ai minat", "Apa itu \"Analisis minat pelanggan\""],
    ["boleh tutup laptop pas lagi ngirim", "Bolehkah halaman ditutup"],
    ["dua orang barengan", "Berapa orang yang bisa memakai"],
    // typos
    ["pasword lupa", "Bagaimana cara masuk"],
    ["nomr terputs", "Status nomor saya"],
    ["transkip", "Bagaimana cara mengambil data percakapan"],
    ["mengentikan pengiriman", "Bagaimana cara menghentikan pengiriman"],
    ["anlisis minat", "Apa itu \"Analisis minat pelanggan\""],
    ["tdk bs masuk akun", "Bagaimana cara masuk"],
    ["pesan ga nyampe", "Kenapa ada pesan yang gagal"],
    ["cara tmbah nomor", "Bagaimana cara menghubungkan nomor"],
    ["exel kontak", "File kontak seperti apa"],
  ];
  const wrong = [];
  for (const [q, expected] of cases) {
    const got = top(q);
    if (!got || !got.startsWith(expected)) wrong.push(`  "${q}" -> ${got ?? "(nothing)"}   expected: ${expected}`);
  }
  assert.equal(wrong.length, 0, `\n${wrong.join("\n")}`);
  console.log(`ok  ${cases.length} everyday and misspelled questions each find the right answer first`);

  for (const q of ["asdfgh qwerty", "zzzz", "12345", "?!"]) assert.deepEqual(shown(q), [], `"${q}" should not pretend to match`);
  assert.deepEqual(faqSearch("", entries).strong, []);
  assert.deepEqual(faqSearch("yang di ke dan", entries).strong, [], "filler words alone match nothing");
  console.log("ok  nonsense and filler words do not produce confident answers");

  for (const [q] of cases) assert.ok(shown(q).length <= 5, `"${q}" shows at most 5 answers`);
  assert.ok(shown("nomor").length >= 2, "a broad word offers several answers");
  console.log("ok  results are a short list, broad words offer several answers");

  console.log("ALL PASS");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
