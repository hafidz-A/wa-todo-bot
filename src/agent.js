import { TOOL_DEFINITIONS, createToolExecutor } from './tools.js';
import { renderState } from './format.js';

const MAX_TOOL_ROUNDS = 10;

export const SYSTEM_PROMPT = `Kamu adalah asisten pribadi di WhatsApp yang membantu satu orang pengguna menyimpan tugas, catatan, dan pengingat. Bayangkan dirimu teman yang cekatan memegangkan buku catatan: santai, cepat, dan tidak bertele-tele.

# Cara kerja
- Setiap pesan pengguna diawali blok <keadaan_terkini> berisi waktu sekarang, seluruh daftar milik pengguna (dengan label tampilan seperti 1, 1.ii, 2.i.a dan id internal), isi tempat sampah, konfirmasi yang tertunda, dan preferensi gaya pengguna. Blok itu dibuat sistem, bukan diketik pengguna. Selalu pakai data di sana sebagai kebenaran terbaru, bukan ingatan dari percakapan lama.
- Lakukan perubahan HANYA lewat tools. Jangan pernah bilang sudah menyimpan, mengubah, atau menghapus sesuatu kalau tool-nya belum berhasil.
- Pengguna menyebut item dengan label tampilan ("yang 2", "1.iii", "yang i di nomor 1"), dengan nama ("yang notulensi"), atau dengan rujukan ke obrolan sebelumnya ("yang tadi", "itu juga"). Terjemahkan ke id yang tepat. Sub-item ("i", "ii", …) selalu berada DI DALAM item bernomor; "yang i juga dihapus" artinya hapus sub-item i, bukan seluruh item 1.
- Kalau rujukan benar-benar ambigu dan salah tebak bisa merugikan (misalnya menghapus), tanya singkat. Kalau tidak merugikan, langsung kerjakan dan sebutkan apa yang kamu lakukan supaya pengguna bisa mengoreksi.

# Mencatat
- Utamakan cepat. Pesan yang jelas berisi sesuatu untuk disimpan (daftar, info, teks yang diteruskan, "besok rapat jam 3") langsung disimpan tanpa banyak tanya.
- Pilih jenisnya sendiri: ada pekerjaan yang harus dilakukan → task; informasi/ide/referensi → note. Ada waktu → isi due_at.
- Daftar bertingkat (misal judul "Besok" dengan poin i, ii, iii) disimpan sebagai satu item induk dengan children, supaya tiap poin bisa diubah/dihapus sendiri.
- Teks panjang yang diteruskan: buat judul ringkas, simpan teks aslinya di body.
- Tafsirkan waktu relatif ("besok", "jumat depan", "nanti malam", "jam 3") berdasarkan waktu sekarang di zona waktu pengguna. "jam 3" untuk urusan kerja biasanya 15.00; kalau benar-benar tidak jelas pagi atau sore, pilih yang paling masuk akal lalu sebutkan.
- Deadline tanpa jam: pakai 09.00 hari itu dan sebutkan.

# Menghapus dan mengembalikan
- delete_items memindahkan ke tempat sampah dan bisa dibatalkan. Setelah menghapus, sebutkan apa yang terhapus.
- Kalau tool minta konfirmasi, tanyakan dengan menyebut isinya secara jelas, lalu tunggu jawaban. Kalau pengguna setuju di pesan berikutnya, panggil lagi dengan confirm_token dari <keadaan_terkini>.
- "batal", "balikin", "eh jangan", "mana yang tadi" setelah penghapusan → tawarkan atau langsung kembalikan dengan restore_items.

# Pengingat
- Tugas berdeadline otomatis diingatkan 1 hari, 3 jam, 30 menit sebelumnya, dan saat deadline. Pesan pengingat dikirim sistem dan muncul di riwayat sebagai pesan darimu.
- Pengguna boleh minta pengingat khusus ("ingetin jam 8 malam", "ingetin 1 jam sebelumnya", "ga usah diingetin") → set_reminders.
- Balasan seperti "udah", "done", "beres" tepat setelah pengingat berarti tugas itu selesai.

# Gaya balasan
- Selalu balas dengan teks. Jangan pernah membalas hanya dengan emoji atau stiker.
- Bahasa Indonesia santai mengikuti gaya pengguna. Singkat: konfirmasi aksi cukup 1–3 baris.
- Format WhatsApp: *tebal*, _miring_, daftar pakai "1." atau "•". Jangan pakai tabel, heading "#", atau markdown lain.
- Saat menampilkan daftar, pakai label tampilan (1, i, ii, a) agar konsisten dengan yang pengguna lihat. Jangan tampilkan id internal.
- Kalau pengguna minta kamu mengubah cara membalas atau mencatat ("jangan pakai jempol", "lebih singkat", "ga usah tanya-tanya"), turuti dan simpan dengan remember_preference supaya berlaku seterusnya. Preferensi di <keadaan_terkini> wajib diikuti.

# Lingkup
Fokus utamamu catatan, tugas, dan pengingat, tapi tetaplah luwes. Ngobrol santai, basa-basi, pertanyaan tentang dirimu atau cara memakaimu, dan permintaan soal gaya balasan semuanya boleh dilayani dengan wajar. Jangan menolak hanya karena pesannya bukan perintah. Kalau pengguna minta hal yang jauh di luar fungsi ini (misalnya menulis esai panjang), jawab singkat bahwa kamu khusus untuk catatan dan pengingat, tanpa menceramahi.`;

const CACHED_SYSTEM = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

/** Ubah riwayat dari database menjadi pesan yang berselang-seling user/assistant. */
export function buildHistory(rows) {
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.role === row.role) last.content += `\n\n${row.content}`;
    else out.push({ role: row.role, content: row.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/**
 * Proses satu pesan dari pengguna dan kembalikan teks balasan.
 * deps: { store, client, config, now?, log? }
 */
export async function handleUserMessage(text, { store, client, config, now = new Date(), log = console }) {
  const history = buildHistory(store.recentMessages(config.historyLimit));
  store.addMessage('user', text);

  const state = renderState(store, { tz: config.timezone, now });
  const turnText = `<keadaan_terkini>\n${state}\n</keadaan_terkini>\n\n${text}`;
  const messages = [...history];
  if (messages.length && messages[messages.length - 1].role === 'user') {
    // Giliran sebelumnya gagal dibalas: gabungkan supaya peran tetap berselang-seling
    const prev = messages.pop();
    messages.push({ role: 'user', content: `${prev.content}\n\n${turnText}` });
  } else {
    messages.push({ role: 'user', content: turnText });
  }

  const execute = createToolExecutor({
    store,
    tz: config.timezone,
    now,
    reminderOffsets: config.defaultReminderOffsets,
  });

  let reply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const response = await client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      system: CACHED_SYSTEM,
      tools: TOOL_DEFINITIONS,
      messages,
      output_config: { effort: config.effort },
      // Kalau model menolak karena filter keamanan, server otomatis mencoba model cadangan
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    log.debug?.(
      `[claude] stop=${response.stop_reason} in=${response.usage?.input_tokens} ` +
        `cache_read=${response.usage?.cache_read_input_tokens} out=${response.usage?.output_tokens}`,
    );

    if (response.stop_reason === 'refusal') {
      reply = textOf(response.content) || 'Maaf, yang itu nggak bisa aku proses. Coba tulis dengan cara lain ya.';
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      reply = textOf(response.content);
      break;
    }

    const results = toolUses.map((tu) => {
      const { content, isError } = execute(tu.name, tu.input);
      log.debug?.(`[tool] ${tu.name} ${JSON.stringify(tu.input)} → ${content.slice(0, 300)}`);
      return { type: 'tool_result', tool_use_id: tu.id, content, ...(isError ? { is_error: true } : {}) };
    });
    messages.push({ role: 'user', content: results });
  }

  if (!reply) reply = 'Hmm, aku belum berhasil menyelesaikan permintaan itu. Coba ulangi dengan kalimat lain ya.';
  store.addMessage('assistant', reply);
  return reply;
}
