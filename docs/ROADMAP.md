# Roadmap WA Blast

Arah yang disampaikan tim: aplikasi ini akan berkembang dari alat blast menjadi chatbot, dengan AI yang menangani percakapan pelanggan, dan semua transkrip chat diolah untuk mengetahui tingkat minat pelanggan (mau jual LM atau beli LM) beserta profilnya.

Dokumen ini memetakan apa yang sudah ada, apa yang perlu diputuskan, dan urutan pengerjaan yang disarankan. Keadaan aplikasi saat ini ada di [DOKUMENTASI.md](DOKUMENTASI.md).

## 1. Yang sudah tersedia sebagai fondasi

| Kebutuhan visi | Yang sudah ada | Status |
|---|---|---|
| Melihat obrolan pelanggan secara langsung | Percakapan merekam obrolan dengan nomor yang di-blast, tanpa batas waktu, dan memperbarui diri sendiri | Live di produksi, belum terbukti dengan blast nomor asli |
| Membalas pelanggan dari aplikasi | Kotak balas di Percakapan | Ada di kode, belum di-deploy |
| Mengambil semua transkrip | Unduh transkrip per nomor (CSV dan JSON) | Ada di kode, belum di-deploy |
| Menilai minat pelanggan | Analisis minat per percakapan dengan Claude: jual LM, beli LM, tingkat minat, ringkasan, saran tindak lanjut | Ada di kode, mati sampai API key diisi, belum diuji dengan API asli |
| Banyak orang memakai bersamaan | Blast paralel per nomor, batas jumlah nomor, login dengan Google kantor dan akun buatan admin | Login ada di kode, mati sampai diaktifkan |
| Data aman | Database di volume, backup harian, percakapan bertahan walau nomor dihapus | Live di produksi |

## 2. Keputusan yang dibutuhkan dari tim

Ini bukan pekerjaan teknis, dan sebagian menentukan pekerjaan teknis berikutnya.

1. **Persetujuan dan privasi pelanggan.** Obrolan pelanggan akan disimpan, dikirim ke layanan AI pihak ketiga, dan diolah menjadi profil. Perlu dipastikan dasar hukumnya (UU Pelindungan Data Pribadi), pemberitahuan ke pelanggan, dan berapa lama data disimpan.
2. **Cakupan chat yang direkam.** Sekarang hanya nomor yang dikirimi pesan dari aplikasi. Chatbot "yang menangani semua chat" berarti juga pelanggan yang menghubungi lebih dulu. Itu memperluas perekaman ke chat yang tidak dimulai tim, dan perlu aturan supaya chat pribadi pemilik nomor tidak ikut.
3. **Nomor khusus atau nomor pribadi.** Chatbot sebaiknya berjalan di nomor khusus usaha, bukan nomor pribadi karyawan.
4. **Jalur WhatsApp.** Baileys tidak resmi dan berisiko blokir, terutama untuk bot yang membalas otomatis dalam jumlah besar. Perlu diputuskan apakah tetap di Baileys atau pindah ke WhatsApp Business API resmi untuk chatbot.
5. **Database.** Tim sudah memakai Neon. Memindahkan data dari SQLite ke Postgres di Neon memudahkan tim data mengolah transkrip dan menghilangkan ketergantungan pada satu volume. Pekerjaannya cukup besar karena seluruh lapisan database harus ditulis ulang.
6. **Batas wewenang AI.** Apa yang boleh dijawab bot sendiri (misalnya jam buka, cara transaksi) dan apa yang wajib diteruskan ke manusia (harga, komplain, transaksi).
7. **Anggaran API.** Analisis dan balasan AI dibayar per pemakaian.

## 3. Urutan yang disarankan

### Tahap 0: membereskan dasar

- Deploy fitur yang sudah ada di kode (balas, transkrip, perbaikan hasil pemindaian, login).
- Aktifkan login: siapkan OAuth Google, akun admin pertama, lalu `AUTH_ENABLED=true`.
- Uji dengan nomor asli hal-hal yang belum terbukti: blast, balasan bernomor tersembunyi, pesan yang diketik dari HP.
- Aktifkan backup ke luar server.
- Ukur pemakaian memori per nomor asli untuk menentukan batas nomor yang realistis.

### Tahap 1: data transkrip siap diolah

- Aktifkan analisis minat dan uji hasilnya terhadap penilaian manusia pada contoh percakapan nyata, sebelum dipercaya.
- Halaman ringkasan: berapa percakapan per kategori minat dan tingkat, per pengiriman dan per nomor.
- Analisis otomatis setelah pelanggan membalas, dengan batas biaya harian.
- Kalau diputuskan pindah ke Neon: kerjakan di tahap ini, supaya tim data bisa mengolah langsung dengan SQL.
- Pemisahan nomor dan percakapan per pemilik, kalau dibutuhkan.

### Tahap 2: AI membantu, manusia yang mengirim

- Tombol "Saran balasan" di Percakapan: AI menyusun draf, orang memeriksa dan mengirim.
- Bahan jawaban resmi (harga LM, syarat, alur transaksi) yang dikelola tim dan dipakai AI sebagai rujukan.
- Catat draf mana yang dipakai, diubah, atau ditolak, sebagai ukuran mutu.

Tahap ini memberi sebagian besar manfaat chatbot dengan risiko jauh lebih kecil, dan menghasilkan data untuk menilai apakah AI layak dilepas sendiri.

### Tahap 3: chatbot otomatis terbatas

- Balasan otomatis hanya untuk topik yang sudah disetujui, pada jam tertentu, dengan jeda yang wajar.
- Serah terima ke manusia saat pelanggan meminta, saat AI tidak yakin, atau untuk topik terlarang, dengan pemberitahuan ke tim.
- Tombol henti darurat per nomor.
- Pelanggan diberi tahu bahwa ia berbicara dengan asisten otomatis.

### Tahap 4: chatbot penuh

Hanya setelah tahap 3 berjalan stabil dan keputusan nomor 2, 3, dan 4 di atas sudah diambil.

## 4. Risiko utama

- **Blokir nomor.** Semakin otomatis dan semakin banyak pesannya, semakin besar risikonya di jalur tidak resmi.
- **Jawaban AI yang salah.** Untuk usaha jual beli logam mulia, salah menyebut harga atau syarat berakibat langsung ke uang. Karena itu urutannya manusia dulu, baru otomatis.
- **Privasi.** Transkrip berisi data pribadi pelanggan. Akses, penyimpanan, dan pengiriman ke pihak ketiga harus punya dasar yang jelas.
- **Ketergantungan pada satu server.** Chatbot yang harus selalu menjawab butuh server yang tidak berhenti setiap deploy.
