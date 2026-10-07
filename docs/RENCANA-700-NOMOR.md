# Rencana: 700 nomor WhatsApp terhubung bersamaan

Status: usulan, belum dikerjakan. Ditulis 30 Oktober 2026.

## Ringkasan

Hari ini satu proses Node memegang semua nomor dan semua data (SQLite di satu disk), dengan batas 10 nomor. Untuk 700 nomor, aplikasi dipecah menjadi:

- **satu layanan dashboard/API** tanpa koneksi WhatsApp, yang bisa di-deploy kapan saja tanpa memutus nomor;
- **10 sampai 14 layanan pekerja (shard)**, masing-masing memegang 50 sampai 70 nomor dengan disknya sendiri;
- **database bersama di Neon (Postgres)** untuk semua data aplikasi.

Perkiraan kerja 5 sampai 7 minggu, dalam empat fase dengan titik keputusan di antaranya. Angka kapasitas dan biaya di dokumen ini masih tebakan sampai Fase 0 mengukur memori per nomor asli.

Sebelum fase mana pun, tim perlu menjawab satu pertanyaan (lihat [Titik keputusan 0](#titik-keputusan-0-perlukah-700-nomor)): kalau tujuannya hanya mengirim ke banyak orang, WhatsApp Business Platform resmi (Cloud API) bisa melakukannya dengan beberapa nomor saja, tanpa pekerjaan di bawah ini.

## Kondisi sekarang dan kenapa tidak bisa diperbesar begitu saja

| Bagian | Sekarang | Masalah di 700 nomor |
|---|---|---|
| Koneksi WhatsApp | Semua socket di satu proses (`src/sessions.js`, Map `sessions`) | RAM puluhan GB di satu proses, CPU dibatasi satu thread Node, dan satu crash atau deploy memutus 700 nomor sekaligus |
| Data | SQLite (better-sqlite3, sinkron) di volume `/app/auth_info` | Volume Railway hanya bisa dipasang ke satu instance, jadi layanan tidak bisa diperbanyak |
| Sesi WhatsApp | File per nomor (`useMultiFileAuthState`, `./auth_info/<id>`) | Terikat ke satu disk |
| Status blast | Di memori (`jobs` di `src/blast.js`) | Hilang saat restart, blast tercatat `interrupted` dan tidak dilanjutkan |
| File kontak yang diunggah | Di memori (`uploads` di `src/index.js`) | Tidak terbagi kalau API lebih dari satu instance |
| Saat server menyala | Semua nomor langsung menyambung, `fetchLatestBaileysVersion()` dipanggil per nomor | 700 sambungan dan 700 permintaan versi dalam beberapa detik |
| Nomor yang ter-logout | Langsung membuat QR baru terus-menerus | 700 putaran QR yang tidak ada yang scan |
| Gagal menyambung 8 kali | Berhenti selamanya sampai ada yang klik "Sambungkan ulang" | Di 700 nomor, nomor yang mati diam-diam tidak akan ketahuan |
| Deploy | Memutus semua nomor | Tiap perbaikan kecil mengganggu 700 nomor |

## Arsitektur tujuan

```
                     Pengguna (browser)
                            |
                 +----------v-----------+
                 |  api  (1-2 instance) |   dashboard, login, upload,
                 |  tanpa disk          |   riwayat, percakapan
                 +----+------------+----+
         perintah     |            |  baca/tulis
    (HTTP internal)   |            v
                      |     +-------------+
                      |     | Neon        |   sessions, shard, messages,
                      |     | (Postgres)  |   send_jobs, send_job_items,
                      |     +------^------+   uploads, users, auth_sessions
                      v            |
   +-----------+ +-----------+     |   tulis status, pesan, progres
   | worker-01 | | worker-02 | ... | worker-12 |
   | 50-70 no. | | 50-70 no. |     |           |
   | disk      | | disk      |     | disk      |   file sesi WhatsApp
   +-----------+ +-----------+     +-----------+   nomor-nomornya
```

### Peran tiap bagian

**api.** Kode yang sama dengan `ROLE=api`. Tidak membuka socket WhatsApp. Menyajikan halaman dan semua `/api/*`. Membaca data dari Neon. Untuk aksi yang menyentuh WhatsApp (buat nomor, QR, kode pairing, kirim, blast, hentikan, balas, hapus), api mencari shard pemilik nomor di tabel `sessions` lalu meneruskan perintahnya lewat jaringan internal Railway (`http://worker-03.railway.internal:3002`) dengan token rahasia bersama. Karena tidak punya disk, Railway bisa men-deploy api tanpa jeda dan tanpa memutus nomor.

**worker-NN.** Kode yang sama dengan `ROLE=worker SHARD=NN`. Satu service Railway per shard, masing-masing dengan volume sendiri untuk file sesi nomor-nomornya. Worker:
- saat menyala mengambil daftar nomornya dari `sessions WHERE shard = NN`, lalu menyambung bertahap (misalnya 2 nomor per detik);
- menjalankan loop blast nomor-nomornya dan menulis progres ke Neon setelah tiap pesan, sehingga blast bisa dilanjutkan setelah restart;
- menulis pesan masuk, status kirim/diterima/dibaca, dan detak jantung (`last_seen_at`, jumlah tersambung, RSS, event loop lag) ke Neon secara berkelompok (batch per 1 detik), bukan satu query per kejadian.

Karena volume Railway tidak bisa dipasang dua kali, satu shard tidak pernah berjalan dua salinan bersamaan. Itu memang diperlukan: dua proses dengan kredensial WhatsApp yang sama akan saling menendang (`conflict: replaced`).

**Neon.** Semua tabel yang sekarang ada di SQLite pindah ke Postgres, ditambah:
- `sessions.shard`: shard pemilik nomor;
- `send_jobs.next_index`: posisi blast, untuk melanjutkan setelah restart;
- `uploads(id, rows jsonb, expires_at)`: pengganti Map `uploads`;
- `workers(shard, last_seen_at, connected, rss_mb, loop_lag_ms)`: kesehatan shard untuk dashboard dan peringatan.

Compute Neon disetel selalu menyala (tanpa auto-suspend) dan di region Singapura, sama dengan Railway.

### Penempatan nomor

Nomor baru ditaruh di shard tersibuk yang masih di bawah kapasitas. Isi shard dulu sampai penuh sebelum membuka shard baru, supaya jumlah service tetap kecil. Kapasitas per shard (`SHARD_CAPACITY`) ditentukan dari pengukuran Fase 0, dengan cadangan 30%. Memindahkan nomor ke shard lain adalah operasi manual yang jarang: hentikan nomor, salin foldernya, ubah `sessions.shard`. Penyeimbangan otomatis baru dibutuhkan kalau sesi WhatsApp disimpan di database (lihat [Fase lanjutan](#fase-lanjutan-kalau-dibutuhkan)).

### Kapasitas dan biaya (tebakan sampai Fase 0)

Rumus per shard: `kapasitas = (RAM shard x 0,7) / RSS per nomor`, lalu dicek bahwa event loop lag tetap di bawah 100 ms saat semua nomor di shard itu blast bersamaan. Satu thread Node kira-kira setara satu core, jadi CPU yang biasanya membatasi, bukan RAM.

| RSS per nomor | Nomor per shard | Shard untuk 700 | RAM total | Perkiraan biaya Railway per bulan |
|---|---|---|---|---|
| ~30 MB | 70 | 10 + 2 cadangan | ~25 GB | $300 sampai $450 |
| ~80 MB | 40 | 18 + 2 cadangan | ~65 GB | $750 sampai $900 |

Biaya dihitung dari harga Railway ($10/GB RAM dan $20/vCPU per bulan, ditambah Pro $20/bulan). Neon belum termasuk; dengan compute kecil yang selalu menyala, kira-kira puluhan dolar per bulan.

## Fase pengerjaan

### Fase 0: ukur dan perbaikan murah (3 sampai 5 hari)

Tujuan: mendapat angka nyata dan memperbaiki hal yang juga berguna di skala kecil.

1. Opsi Baileys yang mengurangi beban, karena aplikasi memang tidak memakai riwayat chat maupun grup:
   - `syncFullHistory: false` dan `shouldSyncHistoryMessage: () => false`, supaya riwayat chat lama tidak diunduh saat menyambung;
   - `shouldIgnoreJid` untuk grup, siaran, dan newsletter. Pesan grup tidak didekripsi lagi, padahal sekarang didekripsi lalu dibuang;
   - `markOnlineOnConnect: false`.
2. `fetchLatestBaileysVersion()` dipanggil sekali per proses dan disimpan, bukan per nomor.
3. Menyambung bertahap saat server menyala (antrean, misalnya 2 nomor per detik).
4. Nomor yang ter-logout ditandai "perlu scan ulang" dan berhenti membuat QR sampai ada yang membuka halaman QR-nya.
5. Setelah 8 kali gagal, nomor tidak berhenti selamanya. Ia mencoba lagi tiap 10 menit dan tampil sebagai "bermasalah" di dashboard.
6. Endpoint metrik internal per proses: jumlah tersambung, RSS, heap, event loop lag, pesan per menit.
7. **Uji coba 3 sampai 5 nomor asli** di produksi selama beberapa hari. Catat RSS per nomor saat diam dan saat blast, CPU per pesan, dan apakah ada nomor yang dibatasi WhatsApp.

Hasil: angka RSS per nomor dan CPU per pesan untuk mengisi tabel kapasitas. Langkah 1 sampai 5 langsung dipakai di produksi.

### Fase 1: data pindah ke Neon (1,5 sampai 2 minggu)

Ini pekerjaan terbesar. Sekitar 240 pemanggilan database di `src/` memakai better-sqlite3 yang sinkron, dan semuanya harus menjadi `await` ke Postgres.

1. Lapisan data baru (`src/db/`) dengan fungsi bernama, misalnya `getChats()` dan `insertJob()`, menggantikan `stmts.*.run/get/all`. Fungsi yang sama dipakai api dan worker.
2. Skema Postgres dan migrasi (mengikuti pola migrasi di `lms-ojt`), termasuk kolom baru di atas.
3. `uploads` dan status blast pindah dari memori ke tabel.
4. Skrip satu kali untuk memindahkan isi SQLite produksi ke Neon (riwayat, chat, pengguna).
5. Seluruh tes di `test/` dijalankan terhadap Postgres lokal (docker) di CI.

Selama fase ini aplikasi masih satu proses, hanya databasenya pindah. Risikonya bisa dicek sebelum arsitektur ikut berubah.

### Fase 2: pisahkan api dan worker (1,5 sampai 2 minggu)

1. `ROLE=api` / `ROLE=worker` di `src/index.js`. Kode WhatsApp (`sessions.js`, `blast.js`, `contacts.js`) hanya dimuat di worker.
2. API internal worker: `POST /internal/sessions`, `DELETE /internal/sessions/:id`, `GET /internal/sessions/:id/qr`, `POST /internal/sessions/:id/pairing-code`, `/reconnect`, `/blast`, `/cancel`, `/send` (kirim cepat dan balasan, dengan stream NDJSON yang diteruskan api apa adanya). Semuanya dilindungi token bersama dan hanya terbuka di jaringan internal.
3. Penempatan nomor ke shard (lihat di atas) dan batas total = jumlah shard x `SHARD_CAPACITY`, menggantikan `MAX_SESSIONS`.
4. Mematikan worker dengan rapi: saat menerima SIGTERM, worker berhenti menerima blast baru, menyimpan posisi blast, lalu menutup socket tanpa logout. Saat menyala lagi, blast yang tertunda dilanjutkan dari `next_index`.
5. Deploy bergelombang: api lebih dulu, lalu worker satu per satu. Auto-deploy dari GitHub dimatikan untuk worker, supaya satu push tidak me-restart 12 shard sekaligus.
6. Harness tes (`test/harness.mjs`) diperluas menjadi topologi api + 3 worker dengan socket tiruan. Skenarionya: 700 nomor tiruan, satu worker dimatikan di tengah blast, dan deploy bergelombang.

### Fase 3: siap dipakai 700 nomor (1 sampai 2 minggu, ditambah waktu onboarding)

1. Dashboard untuk ratusan nomor: ringkasan per status (tersambung, perlu scan, bermasalah, dibatasi), filter, pencarian, dan halaman Nomor yang tidak memuat 700 kartu dan 700 QR sekaligus. `/api/sessions` diganti versi berhalaman plus endpoint ringkasan.
2. Kesehatan shard di dashboard (dari tabel `workers`), dan peringatan ke Slack kalau shard tidak berdetak lebih dari 2 menit atau jumlah nomor tersambung turun tajam.
3. Batas pengiriman harian per nomor dan jeda yang sudah ada tetap berlaku per nomor, ditambah batas total per menit supaya Neon dan WhatsApp tidak dibanjiri.
4. Peluncuran bertahap: 50 nomor, lalu 200, lalu 700. Tiap tahap berjalan minimal satu minggu, dan tahap berikutnya baru dimulai kalau angka blokir dan kesehatan shard aman.

Onboarding 700 nomor butuh waktu orang, bukan hanya waktu server. Tiap nomor perlu HP dan SIM aktif dan scan QR satu kali, dan harus discan ulang kalau tautannya putus atau HP-nya lama mati.

### Fase lanjutan (kalau dibutuhkan)

Sesi WhatsApp disimpan di Postgres, bukan di disk worker. Dengan begitu worker menjadi tanpa disk: nomor bisa dipindah otomatis antar worker, worker yang mati diambil alih yang lain lewat sistem sewa (lease), dan jumlah worker bisa diatur dengan replika Railway, bukan service terpisah. Ini baru perlu kalau operasi manual di Fase 2 terasa berat. Penyimpanan sesi Baileys menulis sangat sering (kunci enkripsi berubah di hampir tiap pesan), jadi perlu cache di memori dan penulisan berkelompok supaya Neon tidak terbebani.

## Titik keputusan

### Titik keputusan 0: perlukah 700 nomor?

Sebelum Fase 0. Kalau tujuannya mengirim ke banyak penerima, Cloud API resmi Meta bisa mencapai tanpa batas penerima per hari dengan satu atau beberapa nomor (kuota naik bertahap mengikuti kualitas pesan). Bayarnya per pesan, template harus disetujui, dan penerima harus pernah setuju dihubungi. Dashboard yang ada (riwayat, percakapan, laporan, analisis minat) bisa disambungkan ke sana, dan pekerjaannya jauh lebih kecil dari rencana ini. Kalau memang harus 700 nomor berbeda (misalnya tiap agen atau mitra punya nomor sendiri), lanjut ke Fase 0.

### Titik keputusan 1: setelah Fase 0

Dengan angka RSS dan CPU nyata, hitung ulang jumlah shard dan biaya. Kalau biaya per bulan atau angka pembatasan dari WhatsApp selama uji coba tidak bisa diterima, berhenti di sini. Perbaikan Fase 0 tetap berguna.

### Titik keputusan 2: setelah 200 nomor berjalan satu minggu

Lihat berapa nomor yang dibatasi atau diblokir dan apakah shard stabil, baru naik ke 700.

## Risiko

| Risiko | Dampak | Penanganan |
|---|---|---|
| **WhatsApp memblokir nomor.** Aplikasi memakai jalur WhatsApp Web tidak resmi, dan mengirim massal lewat ratusan nomor dari server yang sama adalah pola yang dicari sistem anti-spam WhatsApp | Banyak nomor hilang sekaligus. Ini tidak bisa diselesaikan dengan teknik | Kirim hanya ke orang yang memang berhubungan dengan perusahaan, jaga batas harian per nomor, naik bertahap, pantau angka blokir di tiap titik keputusan, dan pertimbangkan Cloud API |
| Memori per nomor jauh di atas perkiraan | Biaya naik dan shard bertambah | Fase 0 mengukur sebelum ada yang dibangun |
| Satu thread Node per shard kewalahan saat semua nomor blast bersamaan | Pesan tertunda dan socket putus karena keepalive terlambat | Kapasitas shard ditentukan oleh event loop lag, bukan hanya RAM |
| Banyak nomor menyambung ulang bersamaan setelah gangguan jaringan | WhatsApp menolak sementara dan antrean menumpuk | Menyambung bertahap dengan jitter, per shard |
| Neon lambat atau putus | Dashboard dan pencatatan terganggu | Worker menampung tulisan di memori sebentar dan mencoba lagi. Koneksi WhatsApp tetap berjalan |
| Migrasi data ke Neon salah | Riwayat atau chat hilang | Cadangan SQLite terakhir disimpan, skrip migrasi diuji di salinan, dan jumlah baris dibandingkan sebelum pindah |
| Operasional 700 HP | Banyak nomor perlu scan ulang | Filter "perlu scan" di dashboard dan peringatan, ditambah penanggung jawab per kelompok nomor |

## Yang perlu disiapkan tim

1. Jawaban Titik keputusan 0: untuk apa 700 nomor.
2. Akun Railway Pro (atau Render) milik pandai-group, dan project Neon milik pandai-group di region Singapura.
3. 3 sampai 5 nomor asli untuk uji coba Fase 0.
4. Penanggung jawab onboarding nomor (HP, SIM, scan QR).
5. Webhook Slack untuk peringatan.
