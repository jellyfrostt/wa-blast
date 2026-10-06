# Dokumentasi WA Blast

Dokumen ini menjelaskan apa yang dilakukan aplikasi, aturan yang berlaku di dalamnya, di mana datanya disimpan, cara mengoperasikannya, dan apa yang sudah serta belum teruji. Rujukan teknis lengkap (daftar endpoint, tabel, variable) ada di [README.md](../README.md). Rencana ke depan ada di [ROADMAP.md](ROADMAP.md).

## 1. Ringkasan

WA Blast adalah dashboard web untuk mengirim pesan WhatsApp ke banyak nomor dari beberapa nomor pengirim sekaligus, lalu mengikuti obrolan yang terjadi setelahnya.

- Dipakai oleh anggota tim yang tidak teknis, jadi semua teks di layar memakai bahasa Indonesia sederhana.
- Terhubung ke WhatsApp lewat pustaka Baileys, yaitu cara tidak resmi yang meniru WhatsApp Web. Ini bukan WhatsApp Business API.
- Berjalan di Railway sebagai satu server dengan database SQLite. Alamat produksi: `https://whatsapp-service-production-0bbd.up.railway.app`.
- Login sudah aktif di produksi (bagian 5): masuk dengan Google kantor atau akun buatan admin.

## 2. Fitur per menu

### Kirim Pesan

Alur lima langkah untuk pengiriman massal:

1. **Pilih nomor.** Hanya nomor yang terhubung dan tidak sedang mengirim yang bisa dipilih. Nomor yang sedang mengirim ditandai "Sedang mengirim" dengan tombol Lihat progres.
2. **Tulis pesan.** Penanda seperti `{{nama}}` diganti isi kolom dengan judul yang sama di file kontak. Huruf besar dan kecil tidak berpengaruh.
3. **Unggah kontak.** File CSV atau Excel, paling besar 10 MB, hanya sheet pertama yang dibaca. Harus ada kolom nomor HP.
4. **Periksa.** Contoh pesan untuk tiga kontak pertama, perkiraan waktu, dan peringatan kalau ada penanda yang tidak punya kolom.
5. **Kirim.** Ada konfirmasi sebelum mulai. Kemajuan tampil langsung, dan saat selesai muncul laporan dengan tombol ke detail per nomor.

Aturan pengiriman massal:

- Satu nomor hanya menjalankan satu pengiriman massal dalam satu waktu. Nomor berbeda bisa mengirim bersamaan.
- Jeda antar pesan 3 sampai 7 detik (bisa diubah di langkah Periksa).
- Nomor kurang dari 9 angka, atau baris tanpa kolom nomor, dilewati.
- Tiap pesan dicoba paling banyak 3 kali kalau gagal karena koneksi, waktu habis, atau pembatasan WhatsApp.
- Lima kegagalan berturut-turut membuat pengiriman berhenti sejenak 30 detik. Sepuluh kegagalan berturut-turut menghentikannya. Tanda nomor diblokir langsung menghentikannya.
- Pesan dikirim persis seperti yang ditulis. Tidak ada salam atau variasi otomatis.

### Nomor WhatsApp

- Menambah nomor dengan scan QR atau kode pairing. Paling banyak 10 nomor (bisa diubah, lihat bagian 7).
- Nomor yang putus mencoba menyambung sendiri sampai 8 kali. Setelah itu muncul tombol Sambungkan ulang.
- Menghapus nomor memutusnya dari aplikasi. Percakapan dan riwayatnya tetap tersimpan. Kalau nomor itu sedang mengirim, pengirimannya dihentikan.
- Nomor yang dihubungkan ke sini sebaiknya hanya tertaut ke aplikasi ini. Aplikasi tidak bisa memeriksa hal itu sendiri.

### Kirim Cepat

Mengirim satu pesan ke satu nomor, 1 sampai 200 kali. Jeda 3 sampai 8 detik antar pesan dan istirahat 30 sampai 60 detik setiap 10 pesan. Tidak ada tombol berhenti.

### Percakapan

- Menampilkan obrolan dengan nomor yang berhasil dikirimi pesan dari aplikasi ini, mulai dari pesan pertama sampai yang terbaru, termasuk balasan, topik lain sesudahnya, dan pesan yang diketik langsung dari HP.
- Obrolan yang sedang dibuka diperbarui tiap 5 detik, daftarnya tiap 15 detik.
- Bisa membalas dari kotak di bawah obrolan, selama nomornya sedang terhubung.
- Bisa mencari nomor, dan mengunduh transkrip semua percakapan satu nomor sebagai file Excel (CSV) atau JSON.
- Kalau fitur AI aktif, ada tombol Analisis minat pelanggan (bagian 4).
- Nomor yang sudah dihapus tetap bisa dipilih dengan keterangan "sudah dihapus".

### Riwayat

Semua pengiriman lewat Kirim Pesan dan Kirim Cepat: nomor pengirim, waktu mulai dan selesai, isi pesan, jumlah terkirim, diterima, dibaca, gagal, dan dilewati. Kalau login aktif, tercatat juga siapa yang memulainya. Tiap kartu bisa dibuka untuk melihat daftar penerima. Balasan yang dikirim dari menu Percakapan tidak masuk Riwayat.

### Pengguna (hanya admin, hanya saat login aktif)

Membuat akun untuk orang yang emailnya di luar domain kantor, mengatur ulang password, mengubah peran, dan menonaktifkan akun.

### Bantuan

Panduan mulai empat langkah dan daftar tanya jawab yang bisa dicari. Isinya harus ikut diperbarui setiap kali perilaku aplikasi berubah.

Pencariannya sengaja longgar karena pemakainya bukan orang teknis: bahasa sehari-hari dan singkatan ("ga kekirim", "nyambungin wa", "tdk bs masuk") dan salah ketik ringan tetap menemukan jawaban yang tepat, jawaban teratas langsung dibuka, dan ada tombol topik untuk yang tidak mau mengetik. Setiap jawaban punya kata kunci sehari-hari di atribut `data-k`; saat menambah jawaban baru, isi juga kata kuncinya dan tambahkan contoh pertanyaan ke `test/test-faq-search.mjs`.

## 3. Apa yang direkam

Ini aturan terpenting di aplikasi, karena menyangkut privasi pemilik nomor dan pelanggan.

| Jenis chat | Direkam? |
|---|---|
| Pesan yang dikirim dari aplikasi | Ya |
| Balasan dan obrolan lanjutan dengan nomor yang dikirimi pesan | Ya, tanpa batas waktu |
| Pesan yang diketik pemilik nomor dari HP ke nomor tersebut | Ya |
| Grup, saluran, status | Tidak |
| Chat dengan nomor yang tidak pernah dikirimi pesan dari aplikasi | Tidak |
| Nomor yang pengirimannya gagal | Tidak dianggap percakapan |
| Foto, video, dokumen | Hanya tulisan `[media]` atau teks keterangannya |

Catatan soal nomor tersembunyi: WhatsApp kadang mengirim pesan dengan ID tersembunyi, bukan nomor HP. Aplikasi mencocokkannya ke nomor tujuan, antara lain dengan menanyakan ID itu ke WhatsApp untuk nomor yang dikirimi pesan dalam 14 hari terakhir (paling banyak 50 nomor tiap 5 menit). Selama belum cocok, pesannya disimpan tanpa ditampilkan. Yang tidak cocok dihapus paling lama setelah 3 hari. Artinya pesan pribadi dari nomor tersembunyi bisa tersimpan sementara di database walaupun tidak pernah tampil.

## 4. Analisis minat pelanggan (AI)

- Mati secara bawaan. Aktif kalau variable `ANTHROPIC_API_KEY` diisi di Railway.
- Untuk satu percakapan, 80 pesan terakhir dikirim ke layanan Claude (Anthropic). Hasilnya: mau jual LM, mau beli LM, keduanya, tidak tertarik, atau belum jelas; tingkat minat tinggi, sedang, atau rendah; ringkasan; kebutuhan yang disebut pelanggan; dan saran tindak lanjut.
- Hanya percakapan yang sudah dibalas pelanggan yang dianalisis. Hasil disimpan dan ditandai kalau ada pesan baru sesudahnya.
- Hasilnya perkiraan. Model diminta menilai hanya dari isi percakapan dan tidak menebak hal pribadi.
- Tiap analisis memakai kuota API berbayar. Selama login mati, siapa pun yang punya alamat dashboard bisa menjalankannya.
- "LM" diartikan sebagai logam mulia (emas batangan). Kalau konteks usahanya berbeda, ubah lewat variable `INSIGHT_CONTEXT`.

## 5. Login

Di kode, login mati secara bawaan dan aktif kalau `AUTH_ENABLED=true`. Di produksi sudah aktif.

Dua cara masuk, dipilih lewat dua tombol di halaman masuk:

- **Akun kantor.** Masuk dengan Google, khusus email `@pintarnya.com`. Akun dibuat otomatis saat pertama masuk, dengan peran Anggota.
- **Email dan password.** Untuk email di luar domain kantor. Akunnya dibuatkan admin di menu Pengguna. Admin menerima password sementara untuk diberikan ke orangnya, dan password itu wajib diganti saat pertama masuk. Tidak ada pendaftaran mandiri.

Aturan:

- Dua peran: Admin (mengelola pengguna) dan Anggota. Selain mengelola pengguna, semua orang yang sudah masuk bisa memakai semua fitur dan melihat semua nomor serta percakapan. Pemisahan nomor per pemilik belum ada.
- Sesi berlaku 7 hari. Menonaktifkan akun atau mengatur ulang password langsung mengeluarkan orangnya.
- Password sementara berlaku 7 hari. Kalau tidak dipakai sampai lewat, admin perlu mengatur ulang.
- Orang yang punya password sementara tetapi masuk lewat Google tidak diminta mengganti password. Kewajiban ganti hanya berlaku kalau ia masuk memakai password sementara itu.
- Masuk dengan Google hanya menerima akun Google organisasi (Workspace) dengan email `@pintarnya.com`. Akun Google pribadi yang didaftarkan memakai alamat kantor ditolak.
- Salah password 8 kali dalam 15 menit membuat percobaan berikutnya ditolak sementara.
- Lupa password: admin mengatur ulang dari menu Pengguna.

Yang perlu disiapkan untuk mengaktifkan:

1. Akun admin pertama: isi `ADMIN_EMAIL` dan `ADMIN_PASSWORD` (password ini wajib diganti saat pertama masuk), atau isi `ADMIN_EMAILS` dengan email Google kantor yang dijadikan admin. Selama admin itu belum membuat password sendiri, tiap server menyala password dari `ADMIN_PASSWORD` diberlakukan lagi; itulah jalan masuk kalau password sementaranya kedaluwarsa.
2. Untuk tombol Google: buat OAuth client di Google Cloud dengan redirect URI `https://whatsapp-service-production-0bbd.up.railway.app/auth/google/callback`, lalu isi `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, dan `PUBLIC_URL`.
3. Isi `AUTH_ENABLED=true`, lalu deploy.

Tanpa langkah 2, tombol Google tidak muncul dan hanya email dan password yang bisa dipakai.

## 6. Data

### Lokasi

| Data | Lokasi di produksi | Bertahan saat deploy? |
|---|---|---|
| Database (nomor, pesan, riwayat, hasil analisis, pengguna) | `/app/auth_info/_data/wa-blast.db` di volume Railway | Ya |
| Login WhatsApp tiap nomor | `/app/auth_info/<id>/` di volume | Ya |
| Backup harian database | `/app/auth_info/_data/backups/`, 7 terbaru | Ya, tapi di volume yang sama |
| File kontak yang diunggah | Memori server, 24 jam | Tidak |
| Kemajuan pengiriman yang sedang berjalan | Memori server | Tidak, pengiriman ditandai "Terputus" |
| Log JSON tiap blast | `./logs/` di dalam container | Tidak |

### Backup

- Sekali sehari server menyalin database ke folder `backups/` dan menyimpan 7 salinan terbaru.
- Salinan itu ada di volume yang sama dengan database. Ia berguna kalau file rusak atau salah hapus, tidak berguna kalau volumenya hilang.
- Untuk salinan di luar server: isi `BACKUP_TOKEN` di Railway, lalu unduh `GET /api/backup` dengan header `Authorization: Bearer <token>` secara berkala. Tanpa token, alamat itu mati.

## 7. Operasional

### Deploy

1. Jalankan `npm test`.
2. Pastikan tidak ada pengiriman yang sedang berjalan: masuk ke dashboard, buka Riwayat, tidak boleh ada yang berstatus "Sedang berjalan". Deploy me-restart server dan memutus pengiriman yang sedang jalan.
3. Dari folder project, pada commit yang mau di-deploy: `railway up`.
4. Setelah selesai, buka dashboard dan cek nomor tersambung lagi. Nomor tersambung sendiri dalam beberapa detik.

Railway tidak terhubung ke branch git mana pun. Yang ter-deploy adalah isi folder saat `railway up` dijalankan.

### Variable di Railway

| Variable | Kegunaan | Keadaan saat dokumen ini ditulis |
|---|---|---|
| `DB_PATH` | Lokasi database | `/app/auth_info/_data/wa-blast.db` |
| `MAX_SESSIONS` | Batas jumlah nomor | Tidak diisi, jadi 10 |
| `BACKUP_KEEP` | Jumlah backup harian | Tidak diisi, jadi 7 |
| `BACKUP_TOKEN` | Mengaktifkan unduhan backup | Tidak diisi, jadi mati |
| `ANTHROPIC_API_KEY` | Mengaktifkan analisis AI | Tidak diisi, jadi mati |
| `AUTH_ENABLED` dan variable login lain | Mengaktifkan login | Sudah diisi, login aktif |

Catatan: saat mengisi variable yang nilainya diawali `/` lewat Git Bash di Windows, nilainya bisa berubah menjadi path Windows. Pakai PowerShell.

## 8. Status pengujian

Sudah teruji otomatis dengan WhatsApp palsu (`npm test`, 12 skenario):

- Blast paralel dari beberapa nomor, pembatalan, dan pemisahan daftar kontak antar pengguna.
- Riwayat, paging, pencarian nomor, batas jumlah nomor.
- Aturan perekaman chat, penggabungan balasan bernomor tersembunyi, penghapusan chat grup dan pribadi.
- Arsip nomor yang dihapus, backup dan unduhannya.
- Balas dari Percakapan, unduh transkrip, analisis AI dengan layanan Claude tiruan.
- Login: halaman dan API tertutup tanpa sesi, password sementara, kelola pengguna, Google dengan layanan Google tiruan.

Sudah terbukti di produksi dengan nomor asli:

- Menghubungkan nomor, Kirim Cepat, pencatatan Riwayat.
- Nomor tersambung lagi sendiri setelah deploy, dan data bertahan.

Belum terbukti dengan WhatsApp atau layanan asli:

- Pengiriman massal (Kirim Pesan) dengan nomor asli.
- Pencocokan nomor tersembunyi lewat pertanyaan ke WhatsApp.
- Perekaman pesan yang diketik dari HP.
- Analisis AI dengan API Claude yang sebenarnya.
- Masuk dengan Google yang sebenarnya.
- Tombol Sambungkan ulang.
- Tampilan di HP sungguhan. Yang diperiksa hanya lebar layar 390 px di komputer.

Uji beban lokal (WhatsApp palsu, laptop Windows): 500 nomor mengirim bersamaan dan 1.000 pengguna dashboard berjalan tanpa error dengan memori sekitar 190 MB. Dua dari 15 percobaan beban tinggi sempat macet 53 sampai 262 detik lalu lanjut sendiri. Penyebabnya belum ditemukan dan tidak terulang saat dilacak.

## 9. Risiko dan batasan yang diketahui

- **Belum ada pemisahan per pemilik.** Setelah login aktif pun, semua pengguna melihat semua nomor dan percakapan.
- **Risiko blokir WhatsApp.** Baileys bukan jalur resmi. Pengiriman massal dari nomor biasa bisa membuat nomor diblokir. Jeda dan batas kegagalan mengurangi risikonya, tidak menghilangkannya.
- **Kapasitas belum terukur.** Memori per koneksi WhatsApp asli dan kemampuan server Railway belum pernah diukur. Batas 10 nomor adalah titik awal yang aman, bukan hasil pengukuran.
- **Satu server, satu file database.** Tidak ada cadangan di luar server sampai `BACKUP_TOKEN` dipakai.
- **Build tidak terkunci.** Dockerfile menjalankan `npm install` tanpa `package-lock.json`, jadi versi pustaka bisa berubah antar deploy.
- **Kode lama.** `src/wa-client.js` sudah tidak dipakai.
