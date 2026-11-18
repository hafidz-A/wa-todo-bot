# Handoff: Bot WhatsApp To-do (hafidz-A/wa-todo-bot)

## Tujuan
Bot WhatsApp pribadi untuk mencatat tugas, catatan, dan pengingat lewat chat bebas. Hanya melayani satu nomor
pemilik. Bot memakai nomor WhatsApp terpisah dan berjalan terus di VPS.

## Kenapa ditulis ulang
Bot lama (sudah jalan di VPS, kodenya tidak pernah dilihat) bermasalah:
- Daftar disimpan sebagai satu teks. "yang i juga dihapus" malah menghapus seluruh daftar #1 beserta 7 isinya.
- Tidak ingat konteks obrolan ("mana full nya" setelah menghapus).
- Terlalu kaku. Bot menolak permintaan "jangan balas pakai jempol" karena dianggap di luar scope, lalu tetap membalas 👍.

Keinginan pemilik: fleksibel, ngobrol bebas, mencatat cepat tanpa banyak tanya, catatan biasa juga bisa disimpan,
dan memakai Claude **Sonnet** (bukan Haiku).

## Yang sudah dibuat (repo ini, branch main)
- Node.js 22, ESM. Baileys 7 (rc), `@anthropic-ai/sdk`, better-sqlite3, pm2 di VPS.
- Model `claude-sonnet-5-5`, effort `medium`, adaptive thinking, loop tool use manual, prompt sistem di-cache,
  server-side refusal fallback (`fallbacks: "default"`).
- Data bertingkat (1 → i → a). Setiap item berdiri sendiri, jenisnya task atau note, deadline opsional.
- Setiap pesan mengirim ke AI: riwayat 30 pesan terakhir + `<keadaan_terkini>` (waktu, seluruh daftar dengan label
  dan id, tempat sampah, konfirmasi tertunda, preferensi gaya).
- Tools AI: add_items, update_item, set_status, delete_items, restore_items, get_item, search_items,
  set_reminders, remember_preference, forget_preference.
- Hapus = tempat sampah 7 hari, bisa di-undo. Menghapus item yang punya isi atau lebih dari 3 item wajib konfirmasi,
  dan konfirmasi hanya sah kalau datang dari pesan pengguna berikutnya.
- Pengingat otomatis H-1, 3 jam, 30 menit, dan saat deadline. Rekap pagi jam 07.00. Pengingat masuk riwayat,
  jadi balasan "udah" langsung dipahami.
- Mode uji tanpa WhatsApp: `npm run chat`. Tes: `npm test` (12 tes lulus, termasuk kasus "yang i dihapus").
- `src/check.js` untuk mengecek API key dan model. `node src/index.js --login` hanya untuk login WhatsApp.

## Pemasangan di VPS
`dist/install.sh` adalah skrip mandiri (kode dibungkus base64). Buat ulang dengan `scripts/build-installer.sh`
setiap kali kode berubah, lalu commit. Perintah untuk VPS:

    bash <(curl -fsSL https://raw.githubusercontent.com/hafidz-A/wa-todo-bot/main/dist/install.sh)

Yang dilakukan skrip:
1. Memasang Node 22, alat build, dan pm2.
2. Menaruh kode di `/opt/wa-todo-bot`.
3. Mendeteksi bot lama (pm2, systemd, atau proses node/python) dan mematikan yang dipilih pengguna.
4. Mengambil API key dan nomor pemilik dari `.env` bot lama.
5. Menyalin folder sesi Baileys lama (yang berisi `creds.json`). Kalau sesinya tidak valid, menampilkan QR.
6. Menjalankan tes dan cek API key, lalu `pm2 start` + `pm2 save` + `pm2 startup`.

Folder bot lama tidak diubah. Langkah 1–5 sudah diuji di container dengan bot lama palsu.
**Login WhatsApp dan pemanggilan Claude yang sungguhan belum pernah diuji**: container tidak bisa menjangkau
WhatsApp dan tidak punya API key.

## Status saat ini / langkah berikutnya
- VPS: Biznet Gio NEO Lite "newVPS", 1 vCPU, 1 GB RAM, Ubuntu 20.04, West Java.
- Pemilik sudah punya API key Claude. Nomor bot sudah login di bot lama.
- **Macet di sini:** pemilik tidak bisa membuka "Open Console" di portal Biznet. Kemungkinan pop-up diblokir
  AdBlock Plus. Alternatif yang sudah disarankan: SSH dari PowerShell Windows (`ssh root@<IP publik>`,
  IP ada di tab Network and Security), lalu tempel perintah pemasangan.
- Setelah terpasang: uji di WhatsApp, cek `pm2 logs wa-todo-bot`, dan perbaiki prompt kalau ada balasan yang aneh.
- Catatan di bot lama belum dipindahkan. Kalau dibutuhkan, lihat format penyimpanan bot lama di VPS lalu buat
  skrip migrasi.
- Pemilik bukan programmer. Pakai bahasa Indonesia santai, langkah sesingkat mungkin, dan minta screenshot.
