# Laporan Bug dan Root Cause Analysis: WA Blast

| Atribut | Isi |
|---|---|
| Produk | WA Blast (layanan `whatsapp-service` di Railway) |
| Repo | `jellyfrostt/wa-blast`, branch `master` |
| Periode | 3 Juli s.d. 30 Oktober 2026 |
| Versi di produksi | `7fe26d4` (deploy 13 Okt 2026). Kode terbaru di `master` lebih baru, lihat INC-10 |
| Disusun | 30 Oktober 2026, dari riwayat git, transkrip sesi pengembangan, log lokal, dokumentasi, dan pengecekan ulang ke kode |
| Format | Blameless: fokus ke sistem dan proses, bukan menyalahkan orang |
| Zona waktu | WIB (UTC+7). Tanggal commit di git sengaja dimundurkan, jadi tidak dipakai untuk timeline |

## 1. Ringkasan eksekutif

Selama pengembangan tercatat **58 bug** dan **11 insiden produksi**. Saat ini **18 bug masih terbuka**, termasuk 7 dengan severity S2. Dua di antaranya sudah diperbaiki di kode tetapi belum live.

| Severity | Total | Selesai | Terbuka |
|---|---|---|---|
| S1 Kritis | 6 | 6 | 0 |
| S2 Tinggi | 21 | 14 | 7 |
| S3 Sedang | 21 | 14 | 7 |
| S4 Rendah | 10 | 6 | 4 |
| **Total** | **58** | **40** | **18** |

**Insiden paling berat** (semuanya sudah selesai):
- **INC-01:** produksi menjalankan kode lama selama 26 hari, padahal tim mengira versi baru sudah live.
- **INC-03:** database terhapus setiap deploy.
- **INC-04:** chat grup dan chat pribadi nomor tertaut terekam dan bisa dibaca tanpa login.
- **INC-05:** riwayat chat nomor "vero" hilang permanen.

**Risiko terbuka teratas:**
1. **INC-10 / BUG-056:** deploy terblokir. Perbaikan yang sudah ada di `master` belum bisa dikirim ke produksi.
2. **BUG-041:** error yang tidak bisa diulang tetap dicoba tiga kali tanpa jeda.
3. **BUG-042:** 10 celah keamanan di dependensi, 1 kritis.
4. **BUG-044:** tidak ada backup di luar server.
5. **BUG-045:** semua orang di domain kantor bisa melihat semua chat.

**Akar masalah sistemik (bagian 6):**
- Tidak ada verifikasi setelah deploy.
- Tidak ada CI maupun review.
- Privasi dan penghapusan data tidak dirancang sejak awal.
- Pengujian hanya memakai WhatsApp tiruan.
- Tidak ada observability: pelacak error, retensi log, peringatan.

## 2. Definisi

### Severity (dampak)

| Level | Arti | Contoh |
|---|---|---|
| S1 Kritis | Data hilang, kebocoran data pribadi, atau layanan mati untuk semua pengguna | Database terhapus, server crash |
| S2 Tinggi | Fungsi utama salah atau tidak jalan, pesan ke pelanggan salah, atau risiko keamanan nyata, tanpa jalan pintas | Pesan diubah, celah XSS |
| S3 Sedang | Fungsi menurun tetapi ada jalan pintas, atau risiko operasional | Nomor perlu disambung manual |
| S4 Rendah | Kosmetik, teks, atau hanya berdampak ke pengembang | Urutan tampilan, pesan error |

### Prioritas (urgensi)

| Level | Arti |
|---|---|
| P1 | Kerjakan sekarang, sebelum pekerjaan lain |
| P2 | Kerjakan di siklus berikutnya |
| P3 | Masuk backlog |

### Status

| Status | Arti |
|---|---|
| Terbuka | Belum ada perbaikan |
| Diperbaiki, belum live | Perbaikan ada di `master` tetapi belum di produksi |
| Selesai | Perbaikan live dan sudah diverifikasi |
| Sebagian | Gejala utama teratasi, akar masalah masih ada |
| Tidak terjelaskan | Tidak terulang dan penyebabnya tidak ditemukan |

## 3. Register bug

Komponen: **Kirim** (blast, Kirim Cepat), **Koneksi** (socket WhatsApp), **Data** (database, perekaman chat), **Tampilan** (dashboard), **Login**, **Infra** (build, deploy, hosting).

### Selesai

| ID | Judul | Sev | Komponen | Kategori akar masalah | Perbaikan |
|---|---|---|---|---|---|
| BUG-001 | Logout WhatsApp mematikan seluruh server | S1 | Koneksi | Penanganan error | `afd1870` |
| BUG-002 | Blast memakai socket mati setelah reconnect | S2 | Kirim | Manajemen state | `afd1870` |
| BUG-003 | Baris kosong di Excel membuat blast macet | S2 | Kirim | Validasi input | `7b227f1` |
| BUG-004 | Socket putus-sambung karena konflik 440 | S3 | Koneksi | Lingkungan eksternal | `88d4fd9` (sebagian) |
| BUG-005 | `sendMessage` bisa macet selamanya | S2 | Kirim | Tanpa timeout | `b7b086c` |
| BUG-006 | Nama perangkat "WA Blast" dan reconnect tanpa batas | S3 | Koneksi | Desain | `99e3884` |
| BUG-007 | Regresi: semua error tercatat "connection", rate limit tanpa jeda | S3 | Kirim | Regresi | `be1a80f` |
| BUG-008 | `{{nama}}` tidak terisi kalau nama kolom beda huruf atau berspasi | S2 | Kirim | Validasi input | `be1a80f` |
| BUG-009 | Kirim Cepat tanpa timeout dan retry | S3 | Kirim | Kode tidak seragam | `be1a80f` |
| BUG-010 | Polling tidak berhenti saat blast dihentikan otomatis | S3 | Tampilan | Logika status | `be1a80f` |
| BUG-011 | Dockerfile Node 20, padahal better-sqlite3 butuh Node 22 | S2 | Infra | Konfigurasi | `60aabd4` |
| BUG-012 | Kirim Cepat menambah salam acak dan karakter tak terlihat | S2 | Kirim | Fitur usang | `528b2b5`, `24caab6` (INC-06) |
| BUG-013 | Server gagal start: `datetime("now")` | S1 | Data | Tidak diuji jalan | `fe4ed4c` (INC-02) |
| BUG-014 | Memulai blast saat nomor terputus atau sibuk mematikan server | S1 | Kirim | Penanganan error async | `2d50529` (INC-07) |
| BUG-015 | Satu blast untuk semua nomor; unggahan saling menimpa | S2 | Kirim | State global | `380d722`, `d91d91f` (INC-08) |
| BUG-016 | Database terhapus setiap deploy | S1 | Infra | Konfigurasi penyimpanan | `DB_PATH` (INC-03) |
| BUG-017 | Balasan tercatat di id tersembunyi; id tampil sebagai nomor | S3 | Data | Perubahan protokol WhatsApp | `0bd8a46`, `fb839f8` |
| BUG-018 | Chat grup dan pribadi terekam dan terlihat | S1 | Data | Privasi tidak dirancang | `a0a5c23`, `bc164ec` (INC-04) |
| BUG-019 | Endpoint pesan melayani chat apa pun | S2 | Data | Kontrol akses | `2f71072`, `a92480b` |
| BUG-020 | Menghapus nomor menghapus semua chatnya | S1 | Data | Desain penghapusan | `ba87ff3` (INC-05) |
| BUG-021 | Kiriman gagal dihitung sebagai percakapan | S2 | Data | Logika query | `8928104` |
| BUG-022 | Folder database salah untuk path tanpa `/` | S4 | Data | Penanganan path | `8928104` |
| BUG-023 | XSS tersimpan di halaman `/qr` | S2 | Tampilan | Escaping | `5f537a3` |
| BUG-024 | Masukan kirim tidak divalidasi; `/api/status` tanpa batas | S3 | Kirim | Validasi input | `5f537a3` |
| BUG-025 | Blast nomor yang dihapus tetap berjalan | S3 | Kirim | Siklus hidup | `5f537a3` |
| BUG-026 | Nomor mati permanen setelah 8 kali gagal, tanpa tombol | S3 | Koneksi | Desain | `5f537a3`, `dff1669` (sisa: BUG-046) |
| BUG-027 | Salinan cadangan menumpuk; `data/` tidak di-ignore git | S3 | Data | Kebersihan | `84fcbaa`, `df490cd` |
| BUG-028 | Blast yang berjalan mengambil alih layar semua pengunjung | S2 | Tampilan | State global | `dff1669` |
| BUG-029 | Percakapan: centang tidak update, draf hilang, balasan dobel | S3 | Tampilan | Manajemen state | `dff1669` |
| BUG-030 | Kode pairing tanpa kode negara; FAQ salah | S3 | Tampilan | Validasi, dokumentasi | `dff1669` |
| BUG-031 | Teks error teknis, "0/1" tanpa keterangan, tanpa paging | S3 | Tampilan | UX | `dbd16a7`, `5afcf74`, `d2d1f16` |
| BUG-032 | Urutan pesan dalam detik yang sama acak | S4 | Data | Logika query | `3ecdcd9` |
| BUG-033 | Password sementara menahan sesi Google; tidak kedaluwarsa | S2 | Login | Desain | `b42291f` |
| BUG-034 | Organisasi dengan domain utama berbeda ditolak login Google | S2 | Login | Asumsi salah | `b42291f` |
| BUG-035 | Cookie rusak membuat error; tanpa header keamanan | S3 | Login | Hardening | `b42291f` |
| BUG-036 | `/health` publik menampilkan nama dan nomor HP | S2 | Data | Kebocoran data | `a174082` |
| BUG-037 | Batal login Google tampil sebagai error umum | S4 | Login | UX | `85555bc` |
| BUG-038 | Pencarian FAQ terlalu kaku untuk pengguna awam | S4 | Tampilan | UX | `5683e18` |
| BUG-058 | Deployment `1fc6fee8` tercatat CRASHED | S4 | Infra | Tidak terjelaskan | Tergantikan deploy berikutnya |
| BUG-059 | Halaman login pertama tidak sesuai permintaan | S4 | Login | Requirement | Dibuat ulang |

### Terbuka atau belum live

| ID | Judul | Sev | Pri | Komponen | Status |
|---|---|---|---|---|---|
| BUG-039 | Tab lama menampilkan "Server tidak bisa dihubungi" | S2 | P1 | Tampilan | Diperbaiki, belum live (`62a3e05`) |
| BUG-040 | Pindah domain memecah akun dan menghapus peran | S2 | P1 | Login | Diperbaiki, belum live (`a902a18`) |
| BUG-041 | Error yang tidak bisa diulang tetap dicoba 3 kali tanpa jeda | S2 | P1 | Kirim | Terbuka |
| BUG-042 | 10 celah keamanan di dependensi | S2 | P1 | Infra | Terbuka |
| BUG-043 | Build Docker tidak memakai lockfile | S3 | P1 | Infra | Terbuka |
| BUG-044 | Tidak ada backup di luar server | S2 | P1 | Infra | Terbuka |
| BUG-045 | Semua orang di domain kantor bisa melihat semua chat | S2 | P2 | Login | Terbuka |
| BUG-046 | Nomor berhenti mencoba setelah 8 kali gagal, tanpa peringatan | S3 | P2 | Koneksi | Terbuka |
| BUG-047 | Nomor ter-logout membuat QR terus-menerus | S3 | P2 | Koneksi | Terbuka |
| BUG-048 | Semua nomor menyambung bersamaan saat server menyala | S3 | P2 | Koneksi | Terbuka |
| BUG-049 | Blast yang terputus restart tidak dilanjutkan | S3 | P2 | Kirim | Terbuka |
| BUG-050 | Server macet 53-262 detik di uji beban | S3 | P2 | Infra | Tidak terjelaskan |
| BUG-051 | "Tampilkan lebih banyak" bisa memuat halaman pertama dua kali | S4 | P3 | Tampilan | Terbuka (dugaan) |
| BUG-052 | Pesan id tersembunyi yang belum cocok disimpan 3 hari | S3 | P3 | Data | Terbuka (desain) |
| BUG-053 | `/health` 503 saat 0 nomor; daftar nomor saat login mati | S4 | P3 | Infra | Terbuka |
| BUG-054 | Permintaan tanpa id jatuh ke unggahan atau blast orang lain | S4 | P3 | Kirim | Terbuka |
| BUG-055 | Kirim Cepat tidak bisa dihentikan | S4 | P3 | Kirim | Terbuka |
| BUG-056 | Deploy terblokir: login Railway CLI kedaluwarsa | S2 | P1 | Infra | Terbuka (INC-10) |

Permintaan fitur yang tidak dihitung sebagai bug: menyimpan gambar dari pelanggan (`src/contacts.js:46`) dan kapasitas 700 nomor (`docs/RENCANA-700-NOMOR.md`).

<!-- pagebreak -->

## 4. RCA insiden produksi

### INC-01: Produksi menjalankan kode lama selama 26 hari

| Atribut | Isi |
|---|---|
| Severity | S1 |
| Status | Selesai |
| Mulai | 16 Sep 2026, 13:02 WIB (deployment `021d98ed`) |
| Terdeteksi | 12 Okt 2026, 12:34 WIB |
| Selesai | 12 Okt 2026, sekitar 12:40 WIB |
| Durasi | 26 hari |
| Terdeteksi oleh | Pengecekan manual ke endpoint produksi saat menyelidiki laporan salam "Halo" |
| Terkait | INC-02, INC-06 |

**Ringkasan.** Fitur banyak nomor dan database dilaporkan sudah ter-deploy pada 16 Sep. Ternyata produksi tetap menjalankan kode satu nomor yang lama sampai 12 Okt.

**Dampak.**
- Tim mengira fitur dan perbaikan sudah aktif selama hampir sebulan, padahal belum.
- Bug yang sudah diperbaiki di branch tetap ada di produksi, misalnya BUG-014.

**Timeline (WIB).**

| Waktu | Kejadian |
|---|---|
| 16 Sep sekitar 13:00 | Empat subagent sedang menulis ulang `blast.js`, `index.js`, `index.html` |
| 16 Sep 13:02 | `railway up` dijalankan. CLI mengunggah isi folder kerja saat itu |
| 16 Sep 13:03-13:06 | Subagent selesai menulis. Perubahan ini tidak ikut terunggah |
| 16 Sep 13:17 | Build sukses. Laporan "Deploy berhasil" tanpa mengecek endpoint baru |
| 12 Okt 11:35 | Tim melaporkan salam "Halo" di pesan |
| 12 Okt 12:34 | `GET /api/sessions` di produksi menjawab 404; UI masih 2 tab; log menunjukkan pesan dari kode lama |
| 12 Okt 12:40 | Kode banyak nomor di-deploy setelah BUG-013 dan BUG-014 diperbaiki |

**Akar masalah (5 Whys).**
1. Kenapa produksi menjalankan kode lama? Karena unggahan `railway up` berisi file versi lama.
2. Kenapa versinya lama? Karena deploy dijalankan sebelum subagent selesai menulis file.
3. Kenapa itu tidak ketahuan? Karena tidak ada pengecekan endpoint live setelah deploy. Build sukses dianggap sama dengan deploy benar.
4. Kenapa build sukses dianggap cukup? Karena tidak ada daftar periksa deploy maupun penanda versi yang bisa dicek dari luar.
5. Kenapa deploy bisa dari folder yang sedang berubah? Karena deploy manual dari laptop, tidak terikat ke commit tertentu.

**Faktor pendukung.**
- Kode baru sebenarnya juga tidak bisa start (INC-02). Seandainya ikut terunggah, produksi justru akan mati.
- Tidak ada nomor tertaut di produksi selama periode itu, sehingga tidak ada yang memakai dan menyadari.

**Penyelesaian.** Deploy ulang dari branch yang benar, lalu diverifikasi lewat `/api/sessions` dan tampilan UI.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| Cek endpoint live setiap selesai deploy | Proses | Dijalankan sejak 12 Okt |
| Tampilkan commit yang sedang berjalan di `/health` agar bisa dicocokkan | Teknis | Terbuka |
| Deploy otomatis dari GitHub per commit, bukan dari folder laptop | Teknis | Terbuka |

### INC-02: Kode banyak nomor tidak bisa start

| Atribut | Isi |
|---|---|
| Severity | S1 (tidak sampai produksi karena INC-01) |
| Status | Selesai (`fe4ed4c`) |
| Mulai | 16 Sep 2026 (commit `d1e8de2`) |
| Terdeteksi | 12 Okt 2026, 12:36 WIB, dari uji jalan lokal |

**Ringkasan.** Server langsung crash saat start dengan `SqliteError: no such column: "now"`.

**Akar masalah (5 Whys).**
1. Kenapa crash? Karena SQL memakai `datetime("now")`.
2. Kenapa itu error? Karena better-sqlite3 13 dikompilasi dengan DQS=0, sehingga teks dalam tanda kutip ganda dibaca sebagai nama kolom.
3. Kenapa lolos? Karena kode hanya dicek dengan `node --check` dan pencocokan import, tanpa pernah dinyalakan.
4. Kenapa tidak dinyalakan? Karena belum ada tes otomatis yang menyalakan server.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| Tanda kutip tunggal di semua SQL | Teknis | Selesai |
| Suite tes yang menyalakan server sungguhan (`npm test`, 14 putaran) | Teknis | Selesai |
| CI menjalankan `npm test` di setiap push | Teknis | Terbuka |

### INC-03: Database terhapus setiap deploy

| Atribut | Isi |
|---|---|
| Severity | S1 |
| Status | Selesai |
| Mulai | 16 Sep 2026 (database pertama kali ditambahkan) |
| Terdeteksi | Risiko dicatat 16 Sep; dipastikan 12 Okt 12:40 WIB |
| Selesai | 12 Okt 2026, 13:10 WIB |
| Terdeteksi oleh | Pemeriksaan konfigurasi volume Railway |

**Ringkasan.** Database SQLite berada di `/app/data`, yang tidak memakai volume. Setiap deploy atau restart menghapus nomor, riwayat kirim, dan chat.

**Dampak.** Semua data aplikasi hilang di setiap deploy sampai 12 Okt. Karena saat itu belum ada pengguna aktif, data asli yang hilang tidak diketahui.

**Timeline (WIB).**

| Waktu | Kejadian |
|---|---|
| 16 Sep 13:10 | Dicatat bahwa database perlu volume. README menyarankan menambah volume yang ternyata tidak pernah dibuat |
| 12 Okt 13:07 | `DB_PATH` diisi lewat Git Bash dan berubah menjadi `C:/Program Files/Git/app/...`. Deploy `185fef91` langsung jalan dengan nilai salah |
| 12 Okt 13:08 | Nilai diperbaiki lewat PowerShell, deploy ulang `7e97a9b2` |
| 12 Okt 13:10 | Diuji: buat sesi, redeploy, sesi masih ada, sesi uji dihapus |

**Akar masalah (5 Whys).**
1. Kenapa data hilang? Karena file database ada di filesystem container yang dibuat ulang setiap deploy.
2. Kenapa tidak di volume? Karena satu-satunya volume dipasang di `/app/auth_info`, sementara database ditaruh di `/app/data`.
3. Kenapa tidak disesuaikan? Karena dokumentasi menyarankan volume baru, tetapi tidak ada yang memastikan volume itu ada.
4. Kenapa tidak ketahuan lebih awal? Karena tidak ada uji "data bertahan setelah redeploy" dan produksi belum dipakai.

**Faktor pendukung.** Git Bash mengubah nilai yang diawali `/`, dan deploy dijalankan dalam satu perintah sebelum nilainya dicek.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| `DB_PATH=/app/auth_info/_data/wa-blast.db` | Teknis | Selesai |
| Variabel yang diawali `/` diisi lewat PowerShell atau `MSYS_NO_PATHCONV=1`, lalu dibaca ulang sebelum deploy | Proses | Selesai |
| Snapshot harian, disimpan 7 hari | Teknis | Selesai (di volume yang sama) |
| Backup ke luar server | Teknis | Terbuka (BUG-044) |

### INC-04: Chat grup dan chat pribadi terekam dan terlihat tanpa login

| Atribut | Isi |
|---|---|
| Severity | S1 (privasi) |
| Status | Selesai |
| Mulai | 12 Okt 2026, sekitar 15:20 WIB (nomor "vero" ditautkan) |
| Terdeteksi | 12 Okt 2026, 15:45 WIB |
| Selesai | 12 Okt 2026, 15:52 WIB (perbaikan live); data lama dibersihkan saat server menyala |
| Durasi | Sekitar 30 menit |
| Terdeteksi oleh | Pemeriksaan data produksi saat memperbaiki tampilan nomor |

**Ringkasan.** Setelah nomor asli ditautkan, aplikasi menyimpan setiap pesan masuk, termasuk chat grup (satu grup berisi 308 pesan) dan chat pribadi pemilik nomor. Semuanya tampil di halaman Percakapan, yang saat itu bisa dibuka siapa saja yang punya link.

**Dampak.** Pesan pribadi pihak ketiga, beserta nama tampilan WhatsApp mereka, tersimpan dan bisa dibaca orang yang tidak berhak.

**Timeline (WIB).**

| Waktu | Kejadian |
|---|---|
| 12 Okt 15:20 | Nomor "vero" ditautkan ke produksi |
| 12 Okt 15:37 | Pengguna melaporkan "nomor" aneh di Percakapan (id tersembunyi dan id grup) |
| 12 Okt 15:45 | Di data produksi terlihat chat grup dan chat pribadi |
| 12 Okt 15:48 | Rancangan perbaikan pertama ternyata akan menghapus 7 balasan asli yang tersimpan dengan id tersembunyi, lalu dirancang ulang |
| 12 Okt 15:52 | Perbaikan live: hanya merekam nomor yang pernah dikirimi aplikasi, dan data lain dihapus saat server menyala |
| 12 Okt 16:01 | Pengguna meminta live chat dikembalikan, mulai dari pesan blast ke bawah, dengan aturan perekaman yang sama |

**Akar masalah (5 Whys).**
1. Kenapa chat pribadi terekam? Karena handler `messages.upsert` menyimpan semua pesan masuk tanpa filter.
2. Kenapa tanpa filter? Karena fitur Percakapan dirancang untuk "melihat balasan", tetapi batas "balasan dari siapa" tidak pernah didefinisikan.
3. Kenapa bisa dibaca orang lain? Karena dashboard belum punya login.
4. Kenapa lolos sampai produksi? Karena pengujian memakai WhatsApp tiruan yang tidak punya grup dan chat pribadi.

**Faktor pendukung.** Balasan pelanggan dikirim dengan id tersembunyi (`@lid`), sehingga filter sederhana "pernah dikirimi" akan ikut membuang balasan asli.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| Rekam hanya nomor yang pernah sukses dikirimi; grup dan chat pribadi tidak pernah disimpan | Teknis | Selesai (`a0a5c23`, `bc164ec`) |
| Endpoint pesan menolak chat yang tidak dimulai aplikasi | Teknis | Selesai (`2f71072`, `a92480b`) |
| Pembersihan otomatis saat server menyala | Teknis | Selesai |
| Pencocokan id tersembunyi ke nomor penerima | Teknis | Selesai, belum diuji dengan WhatsApp asli |
| Login wajib | Teknis | Selesai (aktif 13 Okt) |
| Tes privasi (`test-privacy.mjs`) | Teknis | Selesai |
| Pemisahan akses per pemilik nomor | Teknis | Terbuka (BUG-045) |

### INC-05: Riwayat chat nomor "vero" hilang permanen

| Atribut | Isi |
|---|---|
| Severity | S1 (data hilang) |
| Status | Selesai untuk ke depannya; data tidak bisa dipulihkan |
| Terjadi | 12 Okt 2026, antara 15:52 dan 16:03 WIB |
| Terdeteksi | 12 Okt 2026, 16:03 WIB |
| Terdeteksi oleh | Pemeriksaan produksi setelah deploy |

**Ringkasan.** Tim menghapus nomor "vero" dari aplikasi. Semua chat nomor itu ikut terhapus. Riwayat kirim tetap ada.

**Akar masalah (5 Whys).**
1. Kenapa chat terhapus? Karena tabel `messages` punya `FOREIGN KEY ... ON DELETE CASCADE` ke `sessions`.
2. Kenapa cascade? Karena saat dirancang, "hapus nomor" dianggap sama dengan "hapus semua datanya".
3. Kenapa tidak ada peringatan? Karena tombol hapus tidak menjelaskan bahwa chat ikut hilang.
4. Kenapa tidak bisa dipulihkan? Karena belum ada backup saat itu.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| Nomor yang punya pesan diarsipkan, bukan dihapus | Teknis | Selesai (`ba87ff3`) |
| Halaman nomor yang diarsipkan | Teknis | Selesai |
| Backup harian | Teknis | Selesai; backup ke luar server masih terbuka (BUG-044) |

### INC-06: Kirim Cepat mengubah isi pesan

| Atribut | Isi |
|---|---|
| Severity | S2 |
| Status | Selesai (`528b2b5`, `24caab6`), live 12 Okt 12:40 WIB |
| Terdeteksi | 12 Okt 2026, 11:35 WIB, laporan tim ("halo itu dari mana") |

**Ringkasan.** Pesan Kirim Cepat ditambah salam acak ("Halo", "Assalamualaikum"), penutup acak, titik ganda, dan karakter tak terlihat. Yang tersimpan di riwayat juga versi yang sudah diubah.

**Akar masalah.** Fitur lama anti-deteksi `varyMessage` masih aktif. Tim memutuskan fitur itu tidak diperlukan, karena risiko blokir datang dari kecepatan kirim dan percobaan sambung ulang, bukan dari isi pesan yang sama.

**Tindakan.** Fitur dihapus, pesan dikirim persis seperti diketik, dan teks di UI diperbarui. Selesai.

### INC-07: Memulai blast bisa mematikan server

| Atribut | Isi |
|---|---|
| Severity | S1 |
| Status | Selesai (`2d50529`), live 12 Okt 12:40 WIB |
| Ada sejak | Commit pertama (`45860f2`) |
| Terdeteksi | 12 Okt 2026, 12:31 WIB, dari scan kode lalu dibuktikan di uji lokal |

**Ringkasan.** Menekan "Kirim" saat nomor terputus atau sedang mengirim mengembalikan `{}`, lalu proses Node mati karena unhandled rejection. Server mati untuk semua pengguna.

**Akar masalah.** `startBlast` adalah fungsi async yang dipanggil tanpa `await` di dalam `try/catch`, sehingga error-nya tidak tertangkap. Tidak ditemukan bukti kejadian ini pernah terjadi di produksi.

**Tindakan.** `startBlast` dijadikan sinkron, sehingga error kembali sebagai HTTP 400. Tes `test-hardening.mjs` menutup kasus ini. Selesai.

### INC-08: Data antar pengguna tertukar

| Atribut | Isi |
|---|---|
| Severity | S2 |
| Status | Selesai (`380d722`, `d91d91f`, `70897ee`) |
| Terdeteksi | 12 Okt 2026, 12:45 WIB, saat menjawab pertanyaan "bisa dipakai banyak orang bersamaan?" |

**Ringkasan.**
- Hanya satu blast bisa berjalan untuk semua nomor.
- Daftar kontak yang diunggah satu orang menimpa unggahan orang lain, sehingga blast bisa terkirim ke daftar kontak milik orang lain.

**Akar masalah.** State global (`currentJob`, `uploadedContacts`) dari masa aplikasi masih satu pengguna dan satu nomor. Tidak ditemukan bukti kejadian ini pernah terjadi di produksi.

**Tindakan.**
- Satu job per nomor, dan kontak disimpan per unggahan dengan `uploadId`. Tes paralel ditambahkan. Selesai.
- Sisa risiko kecil untuk pemanggil API tanpa id: BUG-054.

### INC-09: Dashboard menampilkan "Server tidak bisa dihubungi"

| Atribut | Isi |
|---|---|
| Severity | S2 |
| Status | Diperbaiki, belum live (`62a3e05`) |
| Mulai | 13 Okt 2026, saat login diaktifkan |
| Terdeteksi | 13 Okt 2026, 11:32 WIB, screenshot dari pengguna ("ga konek") |
| Jalan pintas | Tekan F5, halaman pindah ke login |

**Ringkasan.** Tab yang dibuka sebelum login diaktifkan, atau saat server sedang restart, menampilkan titik merah "Server tidak bisa dihubungi". Padahal server sehat dan hanya meminta login.

**Akar masalah (5 Whys).**
1. Kenapa muncul "Server tidak bisa dihubungi"? Karena permintaan `/api/sessions` gagal.
2. Kenapa gagal? Karena server menjawab 401 (harus login).
3. Kenapa 401 tidak diarahkan ke halaman login? Karena pengalihan hanya jalan kalau `authOn` bernilai true.
4. Kenapa `authOn` false? Karena nilainya diambil sekali dari `/api/auth/me` saat halaman dibuka, dan tidak dicoba lagi kalau gagal.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| Setiap 401 diarahkan ke login; `loadMe` dicoba ulang tiap 5 detik | Teknis | Di `master`, belum live |
| Tes `test-page-login.mjs` | Teknis | Selesai |
| Deploy | Proses | Terblokir oleh INC-10 |

### INC-10: Deploy terblokir, `master` lebih baru dari produksi

| Atribut | Isi |
|---|---|
| Severity | S2 |
| Status | Terbuka |
| Mulai | Paling lambat 26 Okt 2026, 10:04 WIB |
| Terdeteksi oleh | Perintah `railway` gagal dengan `invalid_grant ... Please run railway login again` |

**Ringkasan.** Login Railway CLI di laptop pengembang kedaluwarsa, dan login dashboard Railway di Chrome juga sudah keluar. Tidak ada jalur deploy lain.

**Yang belum live:**
- BUG-039 (INC-09);
- BUG-040 (pindah domain);
- dokumentasi.

**Akar masalah.**
1. Deploy hanya bisa lewat `railway up` dari satu laptop.
2. Repo tidak terhubung ke deploy otomatis.
3. Tidak ada orang kedua yang memegang akses deploy.

**Tindakan korektif dan pencegahan.**

| Tindakan | Jenis | Status |
|---|---|---|
| Jalankan `railway login`, lalu deploy `master` | Operasional | Terbuka (menunggu pemilik akun) |
| Sambungkan repo GitHub ke Railway atau Render untuk deploy otomatis dari `master` | Teknis | Terbuka |
| Minimal dua orang punya akses deploy | Proses | Terbuka |

### Insiden kecil dan near-miss

| ID | Kejadian | Dampak | Tindakan |
|---|---|---|---|
| INC-11 | Login pertama kali aktif (13 Okt 06:58 WIB) memakai kode yang belum menangani sesi Google dengan password sementara; `/health` menampilkan daftar nomor | Sekitar 5 menit; 0 nomor tertaut | `b42291f`, `a174082`, live 07:05 WIB |
| NM-01 | Pengecekan "tidak ada blast berjalan" sebelum deploy menerima respons kosong sebagai "idle", dan deploy tetap jalan (12 Okt 14:48 WIB) | Tidak ada, kebetulan tidak ada yang mengirim | Pengecekan dibuat gagal tertutup; riwayat juga diperiksa supaya Kirim Cepat ikut terdeteksi |
| NM-02 | Rancangan pertama perbaikan INC-04 akan menghapus balasan asli pelanggan | Tidak ada, tertangkap sebelum deploy | Dirancang ulang dengan pencocokan id tersembunyi |
| NM-03 | Uji beban dijalankan ke produksi saat ada pengguna asli sedang menautkan nomor | Beban kecil | Uji dihentikan; aturan: jangan uji beban produksi |
| EXT-01 | Insiden platform Railway 21 Okt (dari banner dashboard) | Tidak diketahui; log tidak bisa dibaca | Tidak ada |

<!-- pagebreak -->

## 5. Bug report untuk bug yang terbuka

### BUG-041: Error yang tidak bisa diulang tetap dicoba tiga kali tanpa jeda

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S2 / P1 |
| Komponen | Kirim (`src/blast.js`) |
| Lingkungan | Semua lingkungan; dibuktikan di uji lokal (Windows 11, Node 24) dan di kode `master` |
| Ditemukan | 30 Okt 2026, saat menyusun laporan ini |

**Langkah reproduksi.**
1. Hubungkan satu nomor.
2. Unggah file kontak yang berisi nomor yang ditolak WhatsApp, atau picu error lain yang bukan koneksi, timeout, atau rate limit.
3. Mulai blast, lalu lihat log server.

**Yang diharapkan.** Satu percobaan, status gagal dengan alasan yang benar (misalnya "Nomor tidak terdaftar di WhatsApp"), lalu lanjut ke kontak berikutnya.

**Yang terjadi.** Tiga percobaan berturut-turut dalam waktu kurang dari 1 detik. Hasilnya "Failed after 3 attempts".

**Bukti.**
- `logs/blast-2026-10-13T05-06-27-921Z.json`: `"error":"Failed after 3 attempts","errorType":"invalid_number","sendMs":366`.
- Kode di `src/blast.js:248-268`.

**Akar masalah.** Di blok `catch`, hanya error `connection`, `timeout`, dan `rate_limit` yang `continue` dengan jeda. Error `invalid_number`, `auth`, dan `unknown` tidak `break` maupun `continue`, sehingga perulangan langsung masuk ke percobaan berikutnya. `sendWithRetry` (Kirim Cepat) tidak punya masalah ini.

**Usulan perbaikan.** `break` untuk error yang tidak bisa diulang, dan simpan alasan aslinya di hasil.

**Kriteria selesai.**
- Tes: error `invalid_number` menghasilkan tepat 1 percobaan dan pesan error yang sesuai.
- Error koneksi tetap dicoba ulang dengan jeda.

### BUG-042: 10 celah keamanan di dependensi

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S2 / P1 |
| Komponen | Infra (`package.json`) |
| Ditemukan | 16 Sep 2026 (peringatan npm); dicek ulang 30 Okt 2026 |

**Langkah reproduksi.** Jalankan `npm audit --omit=dev`.

**Yang terjadi.** "10 vulnerabilities (4 moderate, 5 high, 1 critical)":
- `proxy-addr` (kritis, lewat express);
- `axios`, `body-parser`, `follow-redirects`, `sharp` (tinggi; ada perbaikan);
- `xlsx` (tinggi; prototype pollution dan ReDoS, **tidak ada versi perbaikan**);
- `csv-parse` (perlu naik versi mayor);
- `multer` 1.x sudah tidak didukung.

**Dampak.** `xlsx` dan `multer` memproses file yang diunggah pengguna yang sudah login.

**Usulan perbaikan.**
1. Jalankan `npm audit fix`.
2. Naikkan `multer` ke 2.x dan `csv-parse` ke versi terbaru.
3. Ganti `xlsx` dari npm dengan rilis resmi SheetJS dari CDN mereka, atau dengan `exceljs`.
4. Pasang Dependabot.

**Kriteria selesai.** `npm audit --omit=dev` tanpa celah tinggi atau kritis, dan semua tes lolos.

### BUG-043: Build Docker tidak memakai lockfile

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S3 / P1 |
| Komponen | Infra (`Dockerfile`) |

**Langkah reproduksi.** Baca `Dockerfile`: hanya `COPY package.json ./` lalu `RUN npm install --omit=dev`.

**Yang diharapkan.** Build memakai versi yang sama persis dengan yang dites (`package-lock.json`).

**Yang terjadi.** Setiap build bisa mendapat versi dependensi yang berbeda, termasuk Baileys yang sering berubah perilaku.

**Usulan perbaikan.** `COPY package.json package-lock.json ./` lalu `RUN npm ci --omit=dev`.

**Kriteria selesai.** Build Railway memakai `npm ci`, dan versi Baileys di container sama dengan lockfile.

### BUG-044: Tidak ada backup di luar server

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S2 / P1 |
| Komponen | Infra |

**Yang terjadi.**
- Snapshot harian disimpan di volume yang sama dengan database.
- `BACKUP_TOKEN` belum diisi, sehingga `/api/backup` mati.
- `railway ssh` tidak bisa dipakai karena tidak ada SSH key.

**Dampak.** Kalau volume rusak atau terhapus, semua riwayat, chat, dan akun hilang. Database produksi juga tidak bisa diambil untuk pindah ke Render atau Neon.

**Usulan perbaikan.** Isi `BACKUP_TOKEN`, lalu jadwalkan unduhan harian ke penyimpanan lain, atau kirim snapshot ke bucket S3/R2.

**Kriteria selesai.** Backup terbaru ada di luar Railway, dan pemulihannya sudah pernah diuji.

### BUG-045: Semua orang di domain kantor bisa melihat semua chat

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S2 / P2 |
| Komponen | Login |

**Langkah reproduksi.** Masuk dengan akun Google `@pintarnya.com` mana pun yang belum pernah didaftarkan. Akun Anggota langsung dibuat, dan semua nomor serta percakapan terlihat.

**Yang diharapkan.** Akses dibatasi ke orang yang memang bertugas.

**Akar masalah.** Keputusan desain awal: siapa pun di domain kantor otomatis boleh masuk, dan semua pengguna berbagi data yang sama.

**Usulan perbaikan.**
- Pilihan "akun Google baru menunggu persetujuan admin".
- Pemisahan nomor per pemilik atau per tim.

**Kriteria selesai.** Akun baru tidak bisa melihat chat sebelum disetujui admin. Keputusan ini perlu dari tim.

### BUG-046: Nomor berhenti mencoba setelah 8 kali gagal, tanpa peringatan

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S3 / P2 |
| Komponen | Koneksi (`src/sessions.js:251-256`) |

**Langkah reproduksi.** Putuskan jaringan server lebih lama dari total jeda 8 percobaan (sekitar 3-4 menit), lalu sambungkan lagi.

**Yang diharapkan.** Nomor tersambung sendiri setelah jaringan pulih, atau minimal ada peringatan.

**Yang terjadi.** Nomor tetap terputus sampai ada yang menekan "Sambungkan ulang". Tidak ada peringatan.

**Usulan perbaikan.** Setelah 8 kali gagal, coba lagi tiap 10 menit, tampilkan status "bermasalah", dan kirim peringatan.

### BUG-047: Nomor ter-logout membuat QR terus-menerus

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S3 / P2 |
| Komponen | Koneksi (`src/sessions.js:204-209, 233-247`) |

**Langkah reproduksi.** Logout perangkat "WA Blast" dari HP, atau biarkan QR tidak discan.

**Yang terjadi.**
- Server terus membuat QR baru.
- QR yang habis waktu (kode 408) mengatur ulang hitungan percobaan ke 0, sehingga batas 8 kali tidak pernah tercapai.
- Log produksi 16 Sep s.d. 12 Okt berisi "QR refs attempts ended" setiap 2-3 menit.

**Usulan perbaikan.** Tandai nomor "perlu scan ulang", lalu berhenti membuat QR sampai halaman QR-nya dibuka.

### BUG-049: Blast yang terputus restart tidak dilanjutkan

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S3 / P2 |
| Komponen | Kirim (`src/blast.js`, `src/index.js`) |

**Langkah reproduksi.** Mulai blast ke 100 kontak, lalu deploy di tengah jalan.

**Yang terjadi.**
- Blast berstatus `interrupted`.
- Sisa kontak tidak dikirim, dan daftar kontak hilang karena disimpan di memori.
- File `logs/blast-*.json` juga hilang karena tidak berada di volume.

**Usulan perbaikan.** Simpan posisi blast (`next_index`) dan daftar kontak di database. Lanjutkan blast setelah server menyala. Lihat RENCANA-700-NOMOR Fase 2.

### BUG-050: Server macet 53-262 detik di uji beban

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S3 / P2 |
| Komponen | Infra |
| Status | Tidak terjelaskan |

**Langkah reproduksi.** Uji beban lokal dengan 200-500 nomor tiruan blast bersamaan, ditambah ratusan pengguna dashboard. Terjadi di 2 dari 15 putaran.

**Yang terjadi.** Event loop berhenti 53 detik dan 262 detik (`loopMaxMs` 52613 dan 261993), muncul `ECONNRESET` dan `ECONNREFUSED`, lalu pulih sendiri. Semua pesan akhirnya terkirim.

**Yang sudah dicoba.** Profil CPU dan pengukuran setiap operasi disk selama lebih dari 9 putaran. Masalahnya tidak muncul lagi.

**Langkah berikutnya.** Ukur ulang di server Railway sungguhan dengan nomor asli (Fase 0 rencana 700 nomor).

### BUG-051: "Tampilkan lebih banyak" bisa memuat halaman pertama dua kali

| Atribut | Isi |
|---|---|
| Severity / Prioritas | S4 / P3 |
| Komponen | Tampilan (`src/public/index.html:1613-1624, 1706-1718`) |
| Status | Dugaan dari pembacaan kode; di uji browser 12 Okt tombolnya sempat hilang |

**Langkah reproduksi (dugaan).**
1. Buka Percakapan untuk nomor dengan lebih dari 50 chat.
2. Tekan "Tampilkan lebih banyak" tepat saat refresh otomatis (tiap 5-15 detik) sedang berjalan.

**Yang terjadi (dugaan).** `reloadChatList` mengubah `chatState.offset` ke 0 selama permintaannya berjalan. Klik di saat itu mengambil halaman pertama lagi dan menambahkannya ke daftar.

**Usulan perbaikan.** `loadMoreChats` memakai offset yang disimpan sendiri, atau menunggu refresh selesai.

### Bug terbuka lainnya

| ID | Ringkasan | Usulan |
|---|---|---|
| BUG-048 | Semua nomor menyambung bersamaan saat start; `fetchLatestBaileysVersion()` dipanggil per nomor; riwayat chat diunduh dan pesan grup didekripsi lalu dibuang | Sambung bertahap; ambil versi sekali; `syncFullHistory: false`, `shouldIgnoreJid` untuk grup |
| BUG-052 | Pesan dari id tersembunyi yang belum cocok disimpan sampai 3 hari | Keputusan desain; dokumentasikan ke pelanggan atau perpendek |
| BUG-053 | `/health` menjawab 503 saat 0 nomor terhubung (akan menggagalkan health check platform), dan menampilkan nomor kalau login mati | Pisahkan "server hidup" dari "ada nomor terhubung" |
| BUG-054 | Permintaan tanpa `uploadId` atau `sessionId` jatuh ke unggahan atau blast terakhir milik orang lain | Wajibkan id; halaman sudah selalu mengirimnya |
| BUG-055 | Kirim Cepat tidak bisa dihentikan | Tambah tombol berhenti |

<!-- pagebreak -->

## 6. RCA sistemik

Kesamaan akar masalah dari semua insiden di atas, dikelompokkan seperti diagram tulang ikan.

| Kategori | Akar masalah | Insiden terkait |
|---|---|---|
| Proses rilis | Deploy manual dari laptop, tidak terikat ke commit, tanpa verifikasi live, tanpa orang kedua | INC-01, INC-03, INC-10, NM-01 |
| Pengujian | Hanya WhatsApp tiruan; tidak ada uji jalan otomatis di CI; fitur disebut selesai sebelum dicoba dengan layanan asli | INC-02, INC-04, BUG-041 |
| Desain | Privasi, kontrol akses, dan penghapusan data tidak dirancang sejak awal; state global dari masa satu pengguna | INC-04, INC-05, INC-08, BUG-045 |
| Observability | Tidak ada pelacak error, peringatan, maupun penanda versi; log Railway hanya 7-30 hari | INC-01 (26 hari tak terdeteksi), BUG-046, EXT-01 |
| Review | Tidak ada PR maupun review; banyak perbaikan digabung dalam satu commit | Semua |
| Alat | Git Bash di Windows mengubah path; patch lewat one-liner merusak file; satu akun GitHub dan Railway bergantung ke satu laptop | INC-03, INC-10 |
| Dependensi | Lockfile tidak dipakai saat build; tidak ada audit rutin | BUG-042, BUG-043 |

### Rencana tindakan (CAPA)

| # | Tindakan | Mengatasi | Prioritas | Status |
|---|---|---|---|---|
| 1 | `railway login`, lalu deploy `master` | INC-09, INC-10, BUG-040 | P1 | Terbuka |
| 2 | Deploy otomatis dari GitHub `master` (Railway atau Render) | INC-01, INC-10 | P1 | Terbuka |
| 3 | GitHub Actions: `npm test` dan `npm audit` di setiap push | INC-02, BUG-042 | P1 | Terbuka |
| 4 | Commit yang berjalan ditampilkan di `/health`, dan dicek otomatis setelah deploy | INC-01 | P1 | Terbuka |
| 5 | Perbaiki BUG-041, BUG-042, BUG-043 | Bug terbuka S2/S3 | P1 | Terbuka |
| 6 | Backup harian ke luar server, dan uji pemulihan | INC-03, INC-05, BUG-044 | P1 | Terbuka |
| 7 | Pelacak error (misalnya Sentry) dan peringatan ke Slack untuk nomor putus | BUG-046, observability | P2 | Terbuka |
| 8 | Daftar uji dengan layanan asli sebelum fitur disebut selesai: nomor asli, login Google asli, HP asli | INC-04 | P2 | Terbuka |
| 9 | Perubahan lewat PR dengan review, walau hanya satu reviewer | Review | P2 | Terbuka |
| 10 | Persetujuan admin untuk akun baru, dan pemisahan akses per pemilik nomor | BUG-045 | P2 | Terbuka (perlu keputusan tim) |
| 11 | Pengecekan sebelum deploy yang gagal tertutup | NM-01 | P1 | Selesai |
| 12 | Aturan perekaman chat dan tes privasi | INC-04 | P1 | Selesai |
| 13 | Arsipkan nomor, jangan cascade delete | INC-05 | P1 | Selesai |
| 14 | Variabel diawali `/` diisi lewat PowerShell dan dibaca ulang | INC-03 | P2 | Selesai |
| 15 | Ubah file lewat Edit atau file skrip, bukan one-liner shell | Alat | P3 | Selesai |

<!-- pagebreak -->

## Lampiran A. Error saat pengembangan

Tidak berdampak ke produksi, tetapi berulang dan memakan waktu.

| Kelompok | Yang terjadi | Pencegahan |
|---|---|---|
| Patch lewat `node -e`, heredoc, sed | Backslash hilang di regex (`/^Bearers+/`), karakter BOM asli masuk ke `index.js`, teks acuan tidak ditemukan, heredoc pecah karena tanda kutip, file setengah teredit sehingga `varyMessage` tidak terdefinisi | Tool Edit atau file skrip |
| Git Bash di Windows | Path diawali `/` diubah jadi `C:/Program Files/Git/...`; `kill` mengenai PID yang salah | PowerShell atau `MSYS_NO_PATHCONV=1`; `Stop-Process` |
| Server uji tertinggal | `EADDRINUSE :::3999`, file SQLite terkunci, hasil tes ternyata dari proses lama | Matikan listener port sebelum tiap suite |
| Tes | Node di Windows abort di libuv saat keluar sehingga exit code tidak bisa dipercaya; asersi tes sendiri salah; fixture rusak setelah kolom baru; `test-hardening` sekali gagal "fetch failed" lalu tidak terulang; tes membuang data ke `logs/` dan `data/` proyek kalau dijalankan langsung | Runner menilai dari baris `ALL PASS`; jalankan lewat `npm test` |
| Akun dan akses | Push 403 karena akun GitHub yang aktif salah; deploy produksi ditolak pengaman otomatis (16 Sep); membaca `.env` proyek lain ditolak; `railway ssh` tanpa SSH key | `gh auth switch -u jellyfrostt` |
| Browser otomatis | Screenshot timeout (CDP), ukuran jendela tidak berubah sehingga cek mobile pertama tidak sah, klik lewat ref tidak berfungsi | Cek ulang lebar viewport dari halaman |
| Jaringan ke produksi | Koneksi TLS dari laptop lambat sehingga uji beban produksi tidak sah; respons kosong atau HTML tepat setelah restart | Skrip cek dengan retry; jangan uji beban produksi dari laptop |
| Sesi | Respons API terputus dua kali; sesi berhenti di tengah perintah (jeda 13 hari); satu commit melewati batas waktu 120 detik | Cek ulang keadaan git sebelum melanjutkan |

## Lampiran B. Kesalahan proses dari asisten pengembang

| Tanggal | Kesalahan | Akibat |
|---|---|---|
| 16 Sep | Menyatakan deploy berhasil tanpa mengecek endpoint live | INC-01 |
| 16 Sep | Menyebut kode banyak nomor selesai berdasarkan `node --check`, tanpa pernah dinyalakan | INC-02 |
| 12 Okt | Mulai mengedit sebelum memetakan semua pemakai fungsi; pengguna menolak dan minta scan dulu | File sempat setengah teredit |
| 12 Okt | Merombak UI tanpa skill yang diminta | Pengguna minta dipasang dulu |
| 12 Okt | Menyarankan Supabase tanpa menanyakan stack tim | Dikoreksi ke Neon |
| 12 Okt | Rancangan pertama perbaikan privasi akan menghapus balasan asli | NM-02 |
| 12 Okt | Menyatakan masalah macet di uji beban "tidak terulang" setelah satu putaran bersih | Muncul lagi; diralat |
| 12 Okt | Mengatakan balasan lama akan tergabung otomatis | Data lama tetap terpisah |
| 12 Okt | Uji beban ke produksi saat ada pengguna asli | NM-03 |
| 12 Okt | Membuat sesi uji dan redeploy produksi untuk membuktikan database bertahan, tanpa konfirmasi terpisah | Tidak ada kerusakan |

## Lampiran C. Sumber dan celah data

- **Riwayat git:** 92 commit, 18 branch. Semua branch sudah masuk `master`. Tidak ada issue, PR, revert, atau rahasia yang ter-commit.
- **Transkrip sesi pengembangan:** 16 Sep s.d. 30 Okt, dibaca dalam lima bagian oleh agen terpisah.
- **File lokal:** `logs/` (6 file uji: 308 terkirim, 2 gagal `invalid_number`), `data/` (database uji), keluaran tugas latar, catatan memori, dan dokumen.
- **Hasil `npm test` 30 Okt:** 14 dari 14 lolos.
- **Pengecekan langsung ke kode:** BUG-041, BUG-042, BUG-051, BUG-054.
- **Celah:**
  - **Log produksi Railway tidak bisa dibaca:** login CLI dan dashboard sudah keluar. Retensi log Railway 7-30 hari, jadi error produksi yang lebih lama memang sudah hilang.
  - Tidak ada pelacak error.
  - Diskusi Slack hanya terlihat dari potongan yang ditempel ke sesi.
- **Di luar cakupan:** laporan email LMS yang tidak sampai (sistem Pandai Blast).
