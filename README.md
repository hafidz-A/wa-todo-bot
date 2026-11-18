# Bot WhatsApp: To-do, Catatan & Pengingat

Bot pribadi di WhatsApp. Kamu chat biasa, bot yang mengerti lalu mencatat, mengubah, menghapus, dan mengingatkan.
Otaknya Claude Sonnet, koneksi WhatsApp lewat Baileys, data disimpan di SQLite.

## Yang bisa dilakukan

- **Catat apa saja dengan bahasa bebas.** "besok jam 3 kirim laporan ke pak budi", teruskan pesan panjang, atau tempel daftar.
- **Daftar bertingkat.** Setiap poin (1, i, ii, a) bisa diubah, dicentang, dipindah, atau dihapus sendiri-sendiri.
  "yang i di nomor 1 hapus" hanya menghapus poin itu.
- **Pengingat otomatis** untuk tugas berdeadline: 1 hari, 3 jam, 30 menit sebelumnya, dan saat deadline.
  Bisa diatur sendiri ("ingetin jam 8 malam", "ga usah diingetin").
- **Rekap pagi** (default 07.00) berisi tugas yang lewat deadline dan yang jatuh tempo hari ini.
- **Tempat sampah dan undo.** Yang dihapus bisa dikembalikan selama 7 hari ("balikin yang tadi").
  Menghapus daftar yang ada isinya selalu minta konfirmasi dulu.
- **Ingat konteks obrolan.** "yang tadi", "itu juga", dan balasan ke pesan tertentu dipahami.
- **Ingat preferensi gaya.** Misalnya "jangan balas pakai jempol" atau "lebih singkat" berlaku seterusnya.
- Hanya melayani nomor kamu. Chat dari nomor lain dan grup diabaikan.

## Struktur

```
src/
  index.js      titik masuk: WhatsApp + AI + penjadwal
  whatsapp.js   koneksi Baileys, filter pemilik, ambil teks pesan
  agent.js      prompt sistem + loop pemanggilan Claude dan tools
  tools.js      aksi yang boleh dilakukan AI (tambah, ubah, hapus, pengingat, …)
  store.js      database SQLite
  scheduler.js  kirim pengingat, rekap pagi, bersihkan tempat sampah
  format.js     ringkasan keadaan yang dikirim ke AI setiap pesan
  time.js       zona waktu dan format tanggal
  cli.js        mode chat di terminal untuk uji coba tanpa WhatsApp
test/           tes otomatis (npm test)
```

## Menjalankan di VPS (Ubuntu/Debian)

1. **Pasang Node.js 22** dan alat build:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs build-essential
   ```
2. **Upload folder ini** ke VPS (tanpa `node_modules` dan `data`), lalu:
   ```bash
   cd wa-todo-bot
   npm install
   cp .env.example .env
   nano .env        # isi ANTHROPIC_API_KEY dan OWNER_NUMBER
   ```
3. **Coba dulu di terminal** (opsional, tanpa WhatsApp, pakai database terpisah):
   ```bash
   npm run chat
   ```
4. **Login WhatsApp nomor bot:**
   ```bash
   npm start
   ```
   Scan QR yang muncul dari HP nomor bot: WhatsApp → Perangkat tertaut → Tautkan perangkat.
   Kalau `BOT_NUMBER` diisi, yang muncul kode pairing dan kamu cukup memasukkannya di menu yang sama.
   Setelah muncul "✅ Terhubung ke WhatsApp", tekan Ctrl+C.
5. **Jalankan terus di background** dengan pm2:
   ```bash
   sudo npm install -g pm2
   pm2 start npm --name wa-bot -- start
   pm2 save
   pm2 startup      # ikuti perintah yang ditampilkan supaya bot ikut menyala setelah VPS restart
   pm2 logs wa-bot  # lihat log
   ```

## Data dan backup

Semua data ada di folder `data/`:
- `bot.db` berisi catatan, tugas, pengingat, dan riwayat chat
- `wa-auth/` berisi sesi login WhatsApp. **Jangan dibagikan ke siapa pun.**

Untuk backup cukup salin folder `data/`. Kalau WhatsApp logout, hapus `data/wa-auth/` lalu login ulang (langkah 4).

## Biaya AI

Setiap pesan mengirim prompt sistem, riwayat chat terakhir, dan seluruh daftar aktif ke Claude Sonnet.
Prompt sistem dan definisi tools di-cache supaya lebih murah. Pantau pemakaian di console.anthropic.com.
Kalau mau lebih hemat, set `CLAUDE_EFFORT=low` atau kecilkan `HISTORY_LIMIT` (default 30 pesan).

Kalau Sonnet menolak sebuah permintaan karena filter keamanan, server Anthropic otomatis mencoba model cadangan
(fitur `fallbacks`). Ini jarang terjadi untuk catatan biasa.

## Tes

```bash
npm test
```
