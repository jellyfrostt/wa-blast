# Log error WA Blast

Semua error, bug, dan insiden sejak WA Blast mulai dikembangkan sampai 30 Oktober 2026. Disusun dari riwayat git, transkrip sesi pengembangan, log dan file lokal, dokumentasi, serta pengecekan ulang langsung ke kode.

Tanggal di dokumen ini adalah tanggal kejadian yang sebenarnya (dari transkrip). **Tanggal commit di git sengaja dimundurkan**, jadi tidak bisa dipakai untuk menentukan kapan sesuatu terjadi.

## Ringkasan

- Sekitar 225 catatan mentah dari tujuh sumber, banyak yang tumpang tindih. Setelah digabung, lebih dari 100 kejadian berbeda.
- **Insiden produksi terbesar:**
  - selama hampir sebulan produksi menjalankan kode lama padahal dikira sudah versi baru;
  - database terhapus setiap deploy;
  - semua chat grup dan chat pribadi nomor yang tertaut terekam dan bisa dibaca siapa saja tanpa login;
  - chat nomor "vero" hilang permanen saat nomornya dihapus.
- **Yang masih terbuka dan paling mendesak:**
  - perbaikan yang sudah ada di `master` belum live karena login Railway CLI kedaluwarsa;
  - nomor tidak terdaftar dicoba kirim tiga kali berturut-turut tanpa jeda;
  - ada 10 celah keamanan di dependensi (1 kritis);
  - belum ada backup di luar server.

## 1. Masih terbuka

### Prioritas tinggi

| # | Masalah | Bukti | Kenapa penting |
|---|---|---|---|
| T1 | **`master` lebih baru dari produksi.** Produksi masih `7fe26d4`. Yang belum live: perbaikan "Server tidak bisa dihubungi" (`62a3e05`), dukungan pindah domain (`a902a18`), dan dokumen | `railway` CLI: "invalid_grant … Please run `railway login` again" sejak 26 Okt. Login Railway di Chrome juga sudah keluar | Pengguna yang membuka tab lama masih melihat server seolah mati. Semua deploy terhenti sampai ada yang menjalankan `railway login` |
| T2 | **Nomor tidak terdaftar atau error lain yang tidak bisa diulang tetap dicoba tiga kali tanpa jeda** | `src/blast.js:248-268`: hanya error koneksi, timeout, dan rate limit yang `continue`. Error lain jatuh ke putaran berikutnya. Log uji: `"Failed after 3 attempts","errorType":"invalid_number","sendMs":366`. Ditemukan saat menyusun log ini | Tiga permintaan beruntun ke nomor yang tidak ada adalah pola yang buruk di mata WhatsApp, dan pesan errornya menyesatkan |
| T3 | **Celah keamanan di dependensi:** 10 celah (1 kritis, 5 tinggi, 4 sedang) | `npm audit --omit=dev` 30 Okt: `proxy-addr` (kritis, lewat express), `axios`, `body-parser`, `follow-redirects`, `sharp`, `xlsx` (tinggi, **tidak ada versi perbaikan**), `csv-parse` (perlu naik versi mayor). `multer` masih 1.x yang sudah tidak didukung | `xlsx` membaca file yang diunggah pengguna. Sebagian besar sisanya selesai dengan `npm audit fix` |
| T4 | **Build Docker tidak memakai `package-lock.json`** | `Dockerfile` hanya menyalin `package.json` lalu `npm install` | Versi Baileys dan dependensi lain bisa berubah diam-diam di deploy berikutnya |
| T5 | **Belum ada backup di luar server, dan database produksi tidak bisa diambil** | Snapshot harian ada di volume yang sama. `BACKUP_TOKEN` belum diisi, jadi `/api/backup` mati. `railway ssh` tidak jalan karena tidak ada SSH key | Kalau volume rusak, semua riwayat, chat, dan akun hilang. Juga menghambat pindah ke Render atau Neon |
| T6 | **Semua orang di domain kantor bisa masuk dan melihat semua chat** | Login Google membuat akun Anggota otomatis untuk siapa pun `@pintarnya.com`. Belum ada pemisahan nomor per pemilik | Chat pelanggan terbuka untuk seluruh kantor |
| T7 | **Pindah domain ke pandai-group.com belum disiapkan di konfigurasi** | Kode siap (`a902a18`) tapi belum live. Belum diketahui apakah alamat baru ada di Workspace Google yang sama. Jenis layar persetujuan OAuth (Internal atau tidak) belum dicek | Kalau salah urutan, semua orang tidak bisa masuk atau admin kehilangan perannya |

### Prioritas sedang

| # | Masalah | Bukti |
|---|---|---|
| S1 | Setelah 8 kali gagal menyambung, nomor berhenti selamanya tanpa peringatan sampai ada yang klik "Sambungkan ulang" | `src/sessions.js:251-256` |
| S2 | Nomor yang ter-logout membuat QR baru terus-menerus. QR yang habis waktu (408) mengulang dari percobaan 1, jadi batas 8 kali tidak pernah tercapai | `src/sessions.js:204-209, 233-247`. Log produksi Sep sampai Okt: "QR refs attempts ended" setiap 2-3 menit |
| S3 | Saat server menyala, semua nomor menyambung bersamaan dan `fetchLatestBaileysVersion()` dipanggil per nomor. Riwayat chat diunduh dan pesan grup didekripsi lalu dibuang | `src/sessions.js:129-152`. Rencana perbaikan ada di `docs/RENCANA-700-NOMOR.md` Fase 0 |
| S4 | Blast yang terputus karena deploy atau restart tidak dilanjutkan. Statusnya `interrupted`, daftar kontak hilang dari memori, dan file `logs/blast-*.json` hilang tiap deploy | `src/blast.js` (`jobs` di memori), `src/index.js` (`uploads` di memori) |
| S5 | Server sesekali berhenti merespons 53 sampai 262 detik di uji beban lokal (2 dari 15 putaran berat). Penyebabnya tidak ditemukan | Uji beban 12 Okt; tidak muncul lagi di 9 putaran dengan profiling |
| S6 | Tombol "Tampilkan lebih banyak" di Percakapan bisa bentrok dengan refresh otomatis. Refresh mengubah `offset` ke 0 sementara, sehingga klik di saat itu memuat halaman pertama dua kali. Di uji browser tombolnya sempat hilang | `src/public/index.html:1613-1624, 1706-1718`. Dugaan, belum terbukti |
| S7 | Pesan dari nomor tersembunyi (`@lid`) yang belum cocok dengan penerima disimpan sampai 3 hari, termasuk pesan pribadi yang bukan balasan blast | Desain pencocokan id tersembunyi; dicatat di DOKUMENTASI §3 |
| S8 | `/health` menjawab HTTP 503 setiap kali 0 nomor terhubung, dan masih menampilkan nama serta nomor kalau login dimatikan | `src/index.js` `/health`. Akan menggagalkan health check platform kalau nanti dipasang |
| S9 | Permintaan tanpa `uploadId` atau `sessionId` jatuh ke unggahan terakhir atau blast terakhir milik orang lain | `src/index.js:52, 546`, `src/blast.js:66`. Halaman selalu mengirim keduanya, jadi hanya berisiko untuk pemanggil API lain |
| S10 | Kirim Cepat tidak bisa dihentikan di tengah jalan | DOKUMENTASI §2 |
| S11 | Gambar dari pelanggan tidak disimpan, hanya caption atau `[media]` | `src/contacts.js:46`. Ditanyakan tim 28 Okt |
| S12 | Kapasitas nomor belum pernah diukur. Batas 10 nomor adalah tebakan | `MAX_SESSIONS`; rencana 700 nomor |
| S13 | Kalau nanti ada instance lain, salam "Halo" otomatis bisa masih aktif di sana | Laporan tim 12 Okt saat layanan ini sedang menunggu scan QR |

### Prioritas rendah

- `src/wa-client.js` adalah kode mati dari versi satu nomor.
- Dokumentasi menyebut "12 skenario" tes, padahal sekarang 14 putaran dari 11 file tes.
- Node lokal v24, produksi Node 22.
- Railway CLI lokal v5.23.0, sudah jauh tertinggal.
- Tidak ada `.gitattributes`, jadi muncul peringatan LF/CRLF di setiap commit.

### Belum pernah dicoba dengan layanan asli

Semua fitur ini hanya lolos tes dengan tiruan:
- blast massal dengan nomor asli dan beberapa nomor sekaligus;
- pencocokan balasan bernomor tersembunyi (cari baris log "Hidden ids reconciled");
- perekaman pesan yang diketik dari HP;
- tombol "Sambungkan ulang";
- analisis minat pelanggan ke Claude API asli;
- login Google asli;
- tampilan di HP sungguhan (baru dicek di lebar 390 px di komputer).

## 2. Insiden produksi (urut waktu)

| Tanggal | Insiden | Dampak | Penyebab | Penyelesaian |
|---|---|---|---|---|
| s.d. 16 Sep | Logout WhatsApp mematikan seluruh server; blast memakai socket mati setelah reconnect; baris kosong di Excel membuat blast macet; `sendMessage` bisa macet selamanya | Blast berhenti, container restart | `process.exit(1)` saat logout, socket diambil sekali di awal, JID kosong, tanpa timeout | `afd1870`, `7b227f1`, `88d4fd9`, `b7b086c`, `99e3884` |
| 16 Sep | `{{nama}}` terkirim apa adanya kalau nama kolom beda huruf besar-kecil atau berspasi | Penerima menerima teks template mentah | Regex `\w+` dan pencarian kolom peka huruf | `be1a80f` |
| 16 Sep s.d. 12 Okt | **Produksi menjalankan kode lama.** Fitur banyak nomor dikira sudah live: `/api/sessions` 404, UI masih 2 tab | Tim mengira fitur dan perbaikan sudah aktif selama hampir sebulan | `railway up` mengunggah folder kerja saat subagent masih menulis ulang file, dan hasil deploy tidak dicek ke endpoint live | Di-deploy ulang 12 Okt (`169f1f4`) |
| 16 Sep s.d. 12 Okt | Kode banyak nomor tidak bisa menyala sama sekali | Akan langsung mati kalau ter-deploy (tertutup oleh insiden di atas) | `datetime("now")` ditolak SQLite yang dikompilasi dengan DQS=0 | `fe4ed4c` |
| 16 Sep s.d. 12 Okt | Tidak ada nomor tertaut; QR berulang terus | Tidak bisa mengirim | Tidak ada yang scan setelah redeploy | Nomor "vero" ditautkan 12 Okt |
| s.d. 12 Okt | **Database terhapus setiap deploy** | Nomor, riwayat, dan chat hilang tiap deploy | Database di `/app/data` yang tidak punya volume | `DB_PATH=/app/auth_info/_data/wa-blast.db`, diuji dengan redeploy |
| 12 Okt | Deploy dengan `DB_PATH` salah (`C:/Program Files/Git/app/...`) | Beberapa menit database tidak di volume | Git Bash mengubah path yang diawali `/`, lalu deploy dijalankan sebelum nilainya dicek | Diisi ulang lewat PowerShell, deploy ulang |
| 12 Okt | Deployment `1fc6fee8` tercatat CRASHED | Tidak jelas | Tidak diselidiki | Tergantikan deploy berikutnya |
| 12 Okt | Kirim Cepat menambah salam acak ("Halo", "Assalamualaikum"), penutup, dan karakter tak terlihat | Penerima menerima pesan yang diubah | Fitur lama anti-deteksi `varyMessage` | `528b2b5`, `24caab6` |
| 12 Okt | Memulai blast saat nomor terputus atau sedang sibuk mematikan server | Server mati | `startBlast` async tidak di-await | `2d50529` |
| 12 Okt | Hanya satu blast bisa berjalan untuk semua nomor; unggahan satu orang menimpa unggahan orang lain | Bisa terkirim ke daftar kontak orang lain | `currentJob` dan `uploadedContacts` global | `380d722`, `d91d91f`, `70897ee` |
| 12 Okt | **Semua chat grup dan chat pribadi nomor tertaut terekam dan terlihat di Percakapan, tanpa login** | Pesan pribadi pihak ketiga tersimpan dan bisa dibaca siapa saja yang punya link | Semua pesan masuk disimpan dan tidak ada kontrol akses | `a0a5c23`, `bc164ec`, `2f71072`, `a92480b`, pembersihan saat menyala |
| 12 Okt | Balasan pelanggan muncul sebagai chat terpisah dengan "nomor" aneh (id tersembunyi dan id grup) | Percakapan terpecah; data lama tidak tergabung | `remoteJid` `@lid` disimpan apa adanya | `41e226c`, `0bd8a46`, `fb839f8`, pencocokan lewat `onWhatsApp` |
| 12 Okt | **Chat nomor "vero" hilang permanen saat nomornya dihapus** | Data chat asli hilang, tidak bisa dipulihkan | `ON DELETE CASCADE` di tabel messages | `ba87ff3` (nomor diarsipkan, bukan dihapus) |
| 12 Okt | Blast yang sedang jalan mengambil alih layar semua pengunjung | Orang lain tidak bisa mengirim dari nomor lain | `resumeRunning` menempel ke blast pertama | `dff1669` |
| 12 Okt | Kiriman gagal dihitung sebagai percakapan | Chat orang yang tidak pernah menerima pesan ikut terekam | Query menghitung baris `failed` | `8928104` |
| 12 Okt | XSS tersimpan di halaman `/qr` lewat nama nomor | Skrip bisa jalan di browser pembuka `/qr` | Nama tidak di-escape | `5f537a3` |
| 12 Okt | Pengecekan "tidak ada blast berjalan" sebelum deploy gagal diam-diam, deploy tetap jalan; pengecekan berikutnya melewatkan Kirim Cepat | Untungnya tidak ada yang sedang mengirim | Respons kosong dianggap "idle", dan `/api/status` hanya untuk blast | Pengecekan sekarang gagal tertutup dan memeriksa riwayat juga |
| 12 Okt | Dashboard terbuka untuk siapa saja yang punya link, termasuk analisis AI berbayar | Risiko privasi dan biaya | Belum ada login | Login dibuat (`798eea3`), diaktifkan 13 Okt |
| 13 Okt | Akun dengan password sementara tertahan di "Buat password baru" walau masuk lewat Google; password sementara tidak pernah kedaluwarsa; organisasi dengan domain utama berbeda ditolak | Login pertama sekitar 5 menit memakai kode lama | Aturan berlaku untuk semua jenis sesi, tidak ada kolom kedaluwarsa, `hd` dibandingkan persis | `b42291f` |
| 13 Okt | `/health` yang publik menampilkan nama dan nomor HP | Kebocoran data (saat itu 0 nomor) | Payload memuat daftar sesi | `a174082` |
| 13 Okt | **"Server tidak bisa dihubungi"** di tab yang dibuka sebelum login aktif | Tampak seperti server mati | Respons 401 hanya diarahkan ke login kalau `authOn`, dan `loadMe` tidak mencoba ulang | `62a3e05`, **belum live** (T1) |
| 21 Okt | Insiden platform Railway (dari banner dashboard) | Tidak diketahui; tidak ada log yang bisa dibaca | Di luar aplikasi | Tidak ada |

## 3. Bug lain yang sudah diperbaiki

| Area | Bug | Commit |
|---|---|---|
| Kirim | Error selalu tercatat "connection" dan rate limit tanpa jeda (regresi dari `b7b086c`) | `be1a80f` |
| Kirim | Kirim Cepat tanpa timeout dan retry | `be1a80f` |
| Kirim | Masukan kirim tidak divalidasi (jumlah, jeda), dan `/api/status` mengirim semua hasil setiap detik | `5f537a3` |
| Kirim | Blast nomor yang dihapus tetap berjalan | `5f537a3` |
| Kirim | CSV transkrip menambah `'` di depan nomor `+62` | `d5da262` (sebelum rilis) |
| Kirim | Kode cadangan unduhan tidak menerima token yang benar (`\s` hilang) | `5aee42c` (sebelum rilis) |
| Tampilan | Polling tidak berhenti saat blast dihentikan otomatis atau nomor diblokir | `be1a80f` |
| Tampilan | Teks error teknis tampil ke pengguna, "0/1" tanpa keterangan, tidak ada paging di Riwayat dan Percakapan, laporan kirim tidak membuka detail | `dbd16a7`, `5afcf74`, `d2d1f16`, `8b05638` |
| Tampilan | Balasan bisa terkirim dua kali, status centang tidak diperbarui, draf hilang saat pindah halaman, balasan tidak muncul di tab tersembunyi | `dff1669` |
| Tampilan | Kode pairing tanpa kode negara, FAQ salah, pencarian FAQ terlalu kaku | `dff1669`, `5683e18` |
| Tampilan | Batal masuk Google tampil sebagai error umum, `/#pengguna` tidak terbuka | `85555bc` |
| Data | Salinan cadangan unduhan menumpuk, folder `data/` tidak di-ignore git | `84fcbaa`, `df490cd` |
| Data | Urutan pesan dalam detik yang sama acak | `3ecdcd9` |
| Data | `mkdir` folder database salah untuk path tanpa `/` | `8928104` |
| Login | Aturan "minimal satu admin" memblokir menonaktifkan anggota biasa | sebelum rilis login |
| Login | Cookie rusak membuat error, halaman bisa dibingkai situs lain, admin bisa mereset password sendiri | `b42291f` |
| Login | Pindah domain akan memecah akun dan menghapus peran admin | `a902a18` (belum live) |
| Deploy | Dockerfile Node 20, padahal better-sqlite3 butuh Node 22 | `60aabd4` |

## 4. Error saat pengembangan

Tidak berdampak ke produksi, tapi berulang dan memakan waktu.

| Kelompok | Yang terjadi | Pelajaran |
|---|---|---|
| Patch lewat `node -e`, heredoc, dan sed | Backslash hilang di regex (`/^Bearers+/`, regex harness), karakter BOM asli masuk ke `index.js`, teks acuan tidak ditemukan, heredoc pecah karena tanda kutip, file setengah teredit sehingga `varyMessage` tidak terdefinisi | Ubah file lewat tool Edit atau file skrip, jangan one-liner |
| Git Bash di Windows | Path diawali `/` diubah jadi `C:/Program Files/Git/...` (`DB_PATH`, uji beban, output curl); `kill` mengenai PID yang salah | Pakai PowerShell atau `MSYS_NO_PATHCONV=1`, dan matikan proses dengan `Stop-Process` |
| Server uji tertinggal | `EADDRINUSE :::3999`, file SQLite terkunci, hasil tes ternyata dari proses lama | Matikan listener port sebelum tiap suite |
| Tes | Node di Windows abort di libuv saat keluar sehingga exit code tidak bisa dipercaya; asersi tes sendiri salah; fixture rusak setelah kolom baru; `test-hardening` sekali gagal "fetch failed" setelah lebih dari 400 detik lalu tidak terulang; tes uji membuang data ke `logs/` dan `data/` proyek kalau dijalankan langsung | Runner menilai dari baris `ALL PASS` |
| Akun dan akses | Push 403 karena akun GitHub `jellybeannss` yang aktif; deploy produksi ditolak pengaman otomatis (16 Sep); membaca `.env` proyek lain ditolak; `railway ssh` tanpa SSH key; login Railway CLI kedaluwarsa | `gh auth switch -u jellyfrostt`, `railway login` |
| Browser otomatis | Screenshot timeout (CDP), ukuran jendela tidak berubah sehingga cek mobile pertama tidak sah, klik lewat ref tidak berfungsi, aksi di tab `chrome://newtab` | Cek ulang lebar viewport dari halaman |
| Jaringan ke produksi | Koneksi TLS dari laptop lambat sehingga uji beban produksi tidak sah; respons kosong atau HTML saat server baru restart | Jangan uji beban produksi dari laptop; skrip cek harus mencoba ulang |
| Sesi | Respons API terputus dua kali, sesi berhenti di tengah perintah (jeda 13 hari), satu commit melewati batas waktu 120 detik | Cek ulang keadaan git sebelum melanjutkan |

### Kesalahan proses dari asisten

| Tanggal | Kesalahan | Akibat |
|---|---|---|
| 16 Sep | Menyatakan deploy berhasil tanpa mengecek endpoint live | Produksi menjalankan kode lama hampir sebulan |
| 16 Sep | Menyebut kode banyak nomor selesai hanya berdasarkan `node --check`, tanpa pernah dinyalakan | Bug `datetime("now")` lolos |
| 12 Okt | Mulai mengedit sebelum memetakan semua pemakai fungsi; pengguna menolak dan minta scan dulu | File sempat setengah teredit |
| 12 Okt | Merombak UI tanpa skill yang diminta, lalu bilang skill-nya tidak terpasang | Pengguna minta dipasang dulu |
| 12 Okt | Menyarankan Supabase tanpa menanyakan stack tim | Dikoreksi ke Neon |
| 12 Okt | Halaman login pertama tidak sesuai permintaan (dua tombol dengan animasi geser) | Dibuat ulang |
| 12 Okt | Rancangan pertama perbaikan privasi akan menghapus 7 balasan asli yang tersimpan dengan id tersembunyi | Tertangkap sebelum deploy |
| 12 Okt | Menyatakan masalah macet di uji beban "tidak terulang" setelah satu putaran bersih, lalu muncul lagi | Diralat di laporan akhir |
| 12 Okt | Mengatakan balasan lama akan tergabung otomatis, padahal tidak untuk data yang sudah ada | Data lama tetap terpisah |
| 12 Okt | Menjalankan uji beban ke produksi saat ada pengguna asli sedang menautkan nomor | Beban kecil; uji dihentikan |
| 12 Okt | Membuat sesi uji dan redeploy produksi untuk membuktikan database bertahan, tanpa konfirmasi terpisah | Tidak ada kerusakan |

## 5. Sumber dan celah

- **Riwayat git:** 92 commit di `master`, 18 branch. Semua branch sudah masuk `master`. Tidak ada issue, PR, maupun revert di GitHub, dan tidak ada rahasia yang pernah ter-commit.
- **Transkrip sesi pengembangan:** 16 Sep s.d. 30 Okt, dibaca dalam lima bagian.
- **File lokal:** `logs/` (6 file, semuanya uji dengan WhatsApp tiruan: 308 terkirim, 2 gagal `invalid_number`), `data/` (database uji), keluaran tugas latar, catatan memori, dan dokumen. Hasil `npm test` 30 Okt: 14 dari 14 lolos.
- **Pengecekan langsung ke kode** untuk T2, T3, S6, dan S9.
- **Celah:**
  - **Log produksi Railway tidak bisa dibaca.** Login CLI kedaluwarsa dan login dashboard di Chrome juga sudah keluar. Retensi log Railway hanya 7 hari (Hobby) atau 30 hari (Pro), jadi error produksi sebelum itu memang sudah hilang.
  - Tidak ada pelacak error seperti Sentry.
  - Diskusi Slack hanya terlihat dari potongan yang ditempel ke sesi.
- **Di luar cakupan:** laporan email LMS yang tidak sampai (sistem Pandai Blast, bukan WA Blast).

## 6. Pelajaran

1. **Cek endpoint live setiap selesai deploy.** Dua insiden terbesar terjadi karena deploy tidak dicek: kode lama di produksi, dan `DB_PATH` yang salah.
2. **Nyalakan server sungguhan sebelum menyebut fitur selesai.** `node --check` tidak menangkap error SQL saat start.
3. **Pengecekan sebelum deploy harus gagal tertutup.** Respons kosong berarti jangan deploy.
4. **Rancang privasi dan penghapusan data sejak awal.** Perekaman semua chat dan cascade delete sama-sama baru ketahuan setelah ada data asli.
5. **Ubah file lewat Edit atau file skrip**, bukan one-liner di Git Bash.
6. **Fitur yang hanya lolos dengan tiruan harus ditulis sebagai "belum terbukti"**, sampai dicoba dengan nomor asli.
7. **Deploy yang bergantung pada satu laptop adalah titik rawan.** Deploy otomatis dari GitHub, di Railway atau Render, menghilangkan masalah login CLI kedaluwarsa.
