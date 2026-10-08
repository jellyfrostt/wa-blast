# Gap WA Blast terhadap PRD Intools CRM

| | |
|---|---|
| Tanggal | 4 November 2026 |
| Sumber kebutuhan | Diskusi PRD Intools CRM (PRD vs Vercel, pertanyaan Ninda dan Shanti, Railway Questions, Request) |
| Kode yang dinilai | `master` 508c87e, yang juga sedang live di `whatsapp-service-production-7a29` |
| Cara menilai | Lima pemeriksa membaca kode per area. Klaim penting dicek ulang langsung ke kode. |

## Ringkasan

WA Blast saat ini adalah dashboard untuk sedikit nomor yang dipakai langsung oleh orang. Intools membutuhkan layanan backend yang dipanggil server ke server untuk sekitar 700 FL, dengan aturan kirim yang ditegakkan di server. Dari kebutuhan PRD yang menyangkut WA Blast:

- **Sudah ada:** normalisasi nomor `08`/`+62`, hasil per nomor dalam satu batch, menolak blast kedua di nomor yang sama, dan kunci API.
- **Sebagian:** status pengiriman, jeda acak, log kirim, pemutusan sesi.
- **Belum ada sama sekali:** pairing lewat API, 1 FL 1 nomor, kuota harian, jam kirim, supresi 14 hari lintas cabang, opt-out, webhook, kontrak OpenAPI, dan kapasitas 700 nomor.

Kesimpulan: Intools **belum bisa** diintegrasikan untuk produksi. Pekerjaan paling penting adalah kontrak API v1 berikut aturan kirimnya (P0). Setelah itu baru skala 700 nomor (P1).

## Pembagian tanggung jawab

| Intools (Vercel) | WA Blast (Railway) |
|---|---|
| Template, variabel personalisasi, masking nomor, filter nasabah, eksklusi loan overdue | Koneksi WhatsApp per FL: pair, unpair, status |
| Peran FL, Kanit, KaCab, AM (siapa boleh unpair) | Aturan kirim yang tidak boleh dilanggar klien: jeda, kuota, jam, supresi, opt-out |
| Pemetaan FL ke cabang | Status per pesan dan alasan gagal |
| UI pending, gagal, retry | Webhook ke Intools dan log untuk analisis visit rate |

Prinsipnya, aturan yang menyangkut risiko blokir dan privasi ditegakkan di WA Blast walaupun Intools juga menyaringnya. Alasannya, hanya WA Blast yang melihat semua permintaan dari semua FL.

## Gap per area

Prioritas: **P0** wajib ada sebelum pilot, **P1** wajib ada sebelum 700 FL, **P2** perbaikan setelahnya.

### A. Pairing dan sesi

| # | Kebutuhan | Kondisi sekarang | Yang perlu dibuat | P |
|---|---|---|---|---|
| A1 | Pairing dimulai dari BE Intools | Kunci API tidak bisa membuat sesi, mengambil QR, kode pairing, atau unpair. Semua dijawab 403 (`auth.js` `API_KEY_ROUTES`) | Scope kunci untuk pairing: buat, QR, kode pairing, unpair | P0 |
| A2 | 1 FL 1 tautan, tidak boleh double pair | Sesi tidak punya pemilik. Tabel `sessions` hanya berisi `id, name, phone, status` | Kolom `external_user_id` yang unik per sesi aktif. Pembuatan sesi idempoten per FL. Nomor yang sama tidak boleh tertaut di dua sesi | P0 |
| A3 | Scan nomor lain setelah terputus tidak boleh mengganti nomor (Railway Q1) | Terjadi: setelah logout, file login dihapus, QR baru dibuat otomatis, lalu `phone` ditimpa tanpa dicek (`sessions.js:218`, `:233-246`) | Kunci nomor pada sesi. Kalau yang di-scan berbeda, tolak dengan status `phone_mismatch`. Setelah logout, jangan buat QR baru sampai ada unpair atau pair ulang dari Intools (sekaligus menutup BUG-047) | P0 |
| A4 | Tersinkron atau Terputus, dengan nomor, nama FL, dan waktu sinkron | Status hanya `waiting_qr`, `connected`, `disconnected`. Belum ada `paired_at` atau `paired_by`, dan alasan putus hanya disimpan di memori | Status `connected`, `logged_out`, `reconnecting`, `gave_up`, `revoked`, beserta alasannya, disimpan di DB | P0 |
| A5 | Cek nomor terdaftar di WhatsApp | Belum ada endpoint. `onWhatsApp` hanya dipakai untuk mencocokkan ID tersembunyi | `POST /v1/numbers/check` | P1 |
| A6 | Unpair saat blast berjalan menghasilkan error, bukan diam | Setiap kontak menunggu tersambung lagi selama 30 detik, dan blast baru berhenti setelah 10 gagal beruntun, sekitar 18 menit. `/api/send` menunggu 30 detik lalu menjawab 500 | Kalau sesi sudah di-unpair atau logout, langsung kembalikan 409 `not_paired`, dan sisa item ditandai gagal `unpaired` | P0 |

### B. Aturan kirim

| # | Kebutuhan | Kondisi sekarang | Yang perlu dibuat | P |
|---|---|---|---|---|
| B1 | Jeda acak 15 sampai 45 detik | Bawaan 3 sampai 7 detik, dan klien boleh mengisi 0 sampai 600. `/api/send` tidak memakai jeda sama sekali | Jeda 15 sampai 45 detik ditentukan server dan berlaku untuk semua jalur kirim di satu nomor | P0 |
| B2 | Kuota harian 15 per cabang | Belum ada. Catatan: `RENCANA-700-NOMOR.md` menyebut batas harian "sudah ada", padahal kodenya tidak ada | Penghitung harian per sesi dan per cabang (cabang dikirim oleh Intools). Kirim yang melewati kuota ditolak dengan `quota_exceeded` | P0 |
| B3 | Kirim hanya Senin sampai Sabtu pukul 08.00 sampai 18.00 WIB. Yang masih tertunda saat 18.00 digagalkan | Tidak ada pengecekan jam maupun zona waktu | Cek waktu Asia/Jakarta saat permintaan masuk dan sebelum setiap item. Item yang masih tertunda saat jam tutup ditandai `outside_hours` | P0 |
| B4 | Tanpa antrean: ditolak dengan alasan, bisa diulang | Sudah dekat: blast kedua di nomor yang sama ditolak. Retry belum ada | Kode alasan untuk setiap penolakan, plus `POST /v1/batches/:id/retry` untuk item yang gagal | P0 |
| B5 | Status pending dan cancel per pesan | Item baru tercatat setelah dicoba. Pembatalan berlaku untuk seluruh nomor, dan sisa item tidak tercatat | Semua item dibuat `pending` sejak awal, sisa item jadi `cancelled` saat dibatalkan, dan pembatalan bisa per batch | P0 |
| B6 | Batch dalam JSON beserta ID Intools (FL, cabang, template, nasabah) | Blast hanya bisa lewat unggah CSV atau Excel. Data unggahan disimpan di memori dan hilang saat restart. Tidak ada kolom metadata | `POST /v1/batches` dengan `items[]` berisi teks final dan `externalId`. Metadata disimpan dan dikembalikan di status serta log | P0 |
| B7 | Tidak salah nomor atau salah kontak antar FL | Kalau `sessionId` atau `uploadId` kosong, server memakai nomor pertama atau unggahan terakhir milik siapa pun. Kunci API bisa mengirim dari sesi FL mana saja | `sessionId` wajib diisi. Kunci dan sesi dicocokkan dengan FL yang ada di metadata | P0 |
| B8 | Idempoten | Permintaan yang diulang akan mengirim dua kali | Header `Idempotency-Key` dan `externalBatchId` yang unik | P0 |
| B9 | Kesalahan nomor tidak dicoba ulang (BUG-041) | Terbukti: kesalahan yang bukan sementara langsung diulang 3 kali | `break` untuk jenis kesalahan yang tidak sementara | P1 |
| B10 | Format nomor `08` dan `+62` aman (Railway Q2) | Bisa dipakai. Masih ada kasus yang salah: `0062…` jadi `62062…`, `+62 0812…` jadi `620812…`, dan nomor asing berawalan 8 ikut diberi 62 | Ubah ke E.164 dengan validasi, dan tolak nomor yang tidak valid | P1 |

### C. Supresi, opt-out, dan risiko blokir

| # | Kebutuhan | Kondisi sekarang | Yang perlu dibuat | P |
|---|---|---|---|---|
| C1 | Supresi 14 hari lintas cabang dan lintas FL, hanya untuk yang berhasil terkirim | Belum ada. Semua query kirim dibatasi per sesi | Tabel `suppression(phone PK, sent_at, batch_id, session_id, actor)` dengan kunci E.164 global | P0 |
| C2 | Bentrok: dua cabang mengirim ke nomor yang sama di waktu yang sama. Yang belakangan gagal per nomor dengan pesan PRD | Dua blast di sesi berbeda bisa sama-sama mengirim ke satu nomor | Reservasi nomor secara atomik saat permintaan masuk (satu transaksi, unik per nomor). Yang kalah gagal dengan `suppressed` dan pesan "nomor telah dihubungi oleh pengguna lain" | P0 |
| C3 | Pesan yang gagal dilepas dari supresi | Belum ada supresi. Nomor yang tidak terdaftar di WhatsApp kemungkinan tetap tercatat "terkirim" | Hapus reservasi saat gagal. Cek `onWhatsApp` sebelum kirim, supaya nomor yang tidak ada tidak dihitung terkirim | P0 |
| C4 | Opt-out dari balasan pelanggan | Balasan hanya disimpan, tidak dicek kata kuncinya | Tabel `optout` yang diisi otomatis dari kata kunci (berhenti, stop, jangan kirim, dan seterusnya; daftarnya diputuskan tim). Dicek sebelum kirim, dan dikirim ke Intools lewat webhook | P0 |
| C5 | Risiko blokir | Tidak ada kuota, jeda bisa 0, kirim cepat bisa 200 kali ke satu nomor, dan nomor baru tidak dipanaskan bertahap | B1 sampai B3, ditambah batas per menit secara global, pemanasan untuk nomor baru, dan pemantauan tingkat blokir. Kirim cepat ditutup untuk kunci API | P0 |
| C6 | Duplikat dalam satu batch | Nomor yang muncul dua kali dikirimi dua kali | Hapus duplikat per nomor dalam satu batch | P1 |

### D. Status, log, dan kontrak API

| # | Kebutuhan | Kondisi sekarang | Yang perlu dibuat | P |
|---|---|---|---|---|
| D1 | Semua status: pending, sent, delivered, read, failed, beserta detailnya (seperti 8x8) | Pemetaan hanya `2,3,4,5`. Status 0 (error) dan 1 (pending) dibuang (`sessions.js:184`). Status bisa mundur. Alasan gagal berupa teks bebas | `status` dan `status_detail` dengan kode tetap, waktu per status, dan status tidak boleh mundur | P0 |
| D2 | Intools tahu perubahan status dan sesi yang terputus | Tidak ada webhook. Satu-satunya cara adalah polling | Webhook bertanda tangan HMAC dengan retry untuk `message.status`, `session.status`, dan `optout` | P0 |
| D3 | Kontrak API, sebaiknya `openapi.yaml` | Tidak ada. API hanya dijelaskan lewat tabel di README | `openapi.yaml` untuk `/v1`, dengan bentuk error `{error:{code,message}}` | P0 |
| D4 | Log per user, dan log terkirim untuk analisis visit rate | Pengirim hanya tercatat sebagai `api:<nama kunci>`. `/api/send` tidak mencatat riwayat, dan kirim yang gagal tidak tercatat. Riwayat tidak punya filter tanggal | Simpan `actor` (FL, cabang) di setiap pesan. Sediakan ekspor `GET /v1/messages?from=&to=` dalam CSV | P0 |
| D5 | Kunci API dibatasi | Satu kunci bisa membaca riwayat semua FL dan mengirim dari sesi mana pun | Batasi per kunci dan per FL, plus rate limit per kunci | P1 |
| D6 | Versi API | Semua masih di `/api/...` milik dashboard | `/api/v1` khusus integrasi. Endpoint dashboard tetap seperti sekarang | P0 |

### E. Skala 700 nomor dan operasional

Desainnya sudah ada di [RENCANA-700-NOMOR.md](RENCANA-700-NOMOR.md), tapi belum ada satu pun bagiannya yang dibangun.

| # | Gap | Kondisi sekarang | Yang perlu dibuat | P |
|---|---|---|---|---|
| E1 | Kapasitas | `MAX_SESSIONS` 10, satu proses, satu volume | Satu layanan API ditambah worker yang dipecah per kelompok nomor (shard), dan Neon Postgres | P1 |
| E2 | Memori per nomor asli | Belum pernah diukur. Angka 190 MB berasal dari tes dengan socket palsu | Ukur 3 sampai 5 nomor asli di Railway (Fase 0) | P0 |
| E3 | Semua nomor menyambung bersamaan saat start | Nomor dipulihkan satu per satu tanpa jeda, dan versi Baileys diambil ulang untuk setiap nomor | Ambil versi sekali saja, dan sambungkan ulang bertahap | P1 |
| E4 | Status blast di memori | Unggahan, job, dan sesi tersimpan di `Map`. Restart membuat blast `interrupted` tanpa bisa dilanjutkan (BUG-049) | Simpan status batch di DB, dan lanjutkan dari `next_index` | P1 |
| E5 | Shutdown dan deploy | Tidak ada penanganan SIGTERM. Setiap deploy memutus semua nomor | Shutdown yang rapi, dan deploy worker bergelombang | P1 |
| E6 | Healthcheck | `/health` menjawab 503 kalau belum ada nomor tersambung, sehingga platform bisa me-restart terus-menerus | Pisahkan `/healthz` (server hidup) dari status nomor | P1 |
| E7 | Pemantauan | Tidak ada metrik, pelacak error, maupun peringatan. Log blast ditulis ke `./logs` di luar volume | Sentry, metrik (RSS, event loop lag, jumlah tersambung), peringatan ke Slack, dan log drain | P1 |
| E8 | Backup | 7 snapshot disimpan di volume yang sama. `BACKUP_TOKEN` belum diisi. Folder login WhatsApp tidak ikut di-backup | Backup harian ke luar server (S3/R2) dan uji pemulihan | P1 |
| E9 | Rantai pasok dan CI | Dockerfile memakai `npm install` tanpa lockfile. Ada 10 celah keamanan, 1 kritis. Tidak ada CI | `npm ci`, `npm audit fix`, ganti `xlsx`, dan GitHub Actions | P1 |
| E10 | Uji dengan nomor asli | Semua tes memakai socket palsu | Pilot 10 sampai 50 FL sebelum 200 dan 700 | P0 |

### F. Data dan kepatuhan

| # | Gap | Yang perlu dibuat | P |
|---|---|---|---|
| F1 | Retensi chat tanpa batas, tidak ada penghapusan per pelanggan | Tentukan masa simpan dan sediakan hapus per nomor (UU PDP) | P1 |
| F2 | Tidak ada catatan dasar hukum dan persetujuan kontak | Keputusan Legal, lalu catat sumber persetujuan di Intools | P1 |
| F3 | Nomor lengkap tercatat di log aplikasi | Masking nomor di log | P1 |
| F4 | Semua anggota bisa melihat semua chat (BUG-045) | Pisahkan per pemilik sesi | P1 |

## Bentuk API v1 yang diusulkan

Ini ringkasan untuk disepakati bersama tim Intools sebelum `openapi.yaml` ditulis.

```
POST   /api/v1/sessions                {externalUserId, branchId}       idempoten per FL
GET    /api/v1/sessions/:id            status, phone, pairedAt, pairedBy, reason
GET    /api/v1/sessions/:id/qr         {qr, expiresAt}
POST   /api/v1/sessions/:id/pairing-code {phone}
DELETE /api/v1/sessions/:id            {revokedBy}                      unpair
POST   /api/v1/numbers/check           {sessionId, phones[]}
POST   /api/v1/batches                 {sessionId, externalBatchId, actor{flId,branchId}, templateId?,
                                        items[{externalId, phone, text}]}
                                        → per item: accepted | rejected{code}
GET    /api/v1/batches/:id             status per item
POST   /api/v1/batches/:id/cancel
POST   /api/v1/batches/:id/retry       hanya item failed
GET    /api/v1/messages?from=&to=&format=csv   untuk analisis visit rate
Webhook → Intools: message.status, session.status, optout   (HMAC, retry)
```

Kode penolakan atau kegagalan: `not_paired`, `outside_hours`, `quota_exceeded`, `suppressed`, `opted_out`, `invalid_number`, `not_on_whatsapp`, `duplicate`, `banned`, `timeout`.

## Keputusan yang dibutuhkan

1. **Kuota 15:** per cabang, per FL, atau keduanya? Dihitung per pesan atau per nasabah?
2. **Hari libur nasional:** ikut ditutup atau tidak? Jam kirim juga masih menunggu konfirmasi Legal (OQ-08).
3. **Opt-out:** daftar kata kunci, dan siapa pemilik datanya, Intools atau WA Blast?
4. **Masa simpan log dan chat** untuk analisis visit rate dan untuk UU PDP.
5. **Jalur WhatsApp:** 700 nomor pribadi lewat Baileys yang tidak resmi berisiko blokir. Perlu keputusan tertulis untuk tetap di Baileys, atau pindah ke WhatsApp Cloud API resmi (Keputusan 0 di RENCANA-700-NOMOR).
6. **Hosting:** layanan sekarang berjalan di workspace Railway pribadi. Untuk 700 FL, sebaiknya dipindah ke akun perusahaan.

## Urutan pengerjaan

| Tahap | Isi | Hasil |
|---|---|---|
| 1. Kontrak | Sepakati API v1 di atas bersama Intools, lalu tulis `openapi.yaml` | Intools bisa mulai membangun dengan mock |
| 2. P0 inti | A1 sampai A4, A6, B1 sampai B8, C1 sampai C5, D1 sampai D4, D6 | Pilot 10 sampai 50 FL di satu server |
| 3. Ukur | E2 dan E10 dengan nomor asli | Data untuk ukuran shard dan biaya |
| 4. P1 skala | E1, E3 sampai E9, D5, F1 sampai F4 | Peluncuran bertahap 200 lalu 700 FL |

Tahap 2 bisa berjalan di arsitektur sekarang. Tahap 4 adalah rencana yang ada di RENCANA-700-NOMOR.md.
