import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { handleUserMessage } from './agent.js';
import { startScheduler } from './scheduler.js';
import { startWhatsApp } from './whatsapp.js';

const config = loadConfig();
if (!config.ownerNumber) {
  console.error('OWNER_NUMBER belum diisi di .env (format 628xxxxxxxxxx)');
  process.exit(1);
}

const log = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: process.env.DEBUG ? console.log : undefined,
};

const store = new Store(config.dbPath);
const client = new Anthropic();

// Pesan diproses satu per satu supaya urutan dan konfirmasi tidak kacau
let queue = Promise.resolve();
const enqueue = (job) => {
  queue = queue.then(job).catch((err) => log.error(err));
  return queue;
};

async function onMessage(text, reply) {
  await enqueue(async () => {
    let answer;
    try {
      answer = await handleUserMessage(text, { store, client, config, log });
    } catch (err) {
      log.error('[agent] gagal:', err);
      if (err instanceof Anthropic.AuthenticationError) answer = '⚠️ API key Claude tidak valid. Cek ANTHROPIC_API_KEY di server.';
      else if (err instanceof Anthropic.RateLimitError) answer = 'Lagi kebanyakan permintaan ke AI, coba lagi sebentar ya.';
      else answer = 'Maaf, lagi ada gangguan waktu memproses pesanmu. Coba kirim ulang sebentar lagi ya.';
    }
    await reply(answer);
  });
}

async function onNonText(reply) {
  await reply('Aku baru bisa baca pesan teks (termasuk caption foto). Coba ketik atau teruskan versi teksnya ya.');
}

// `node src/index.js --login`: cukup login WhatsApp (scan QR), lalu keluar
if (process.argv.includes('--login')) {
  await startWhatsApp({
    config,
    onMessage: async () => {},
    log,
    onOpen: () => setTimeout(() => { log.info('Login berhasil, sesi tersimpan.'); process.exit(0); }, 5000),
  });
} else {
  const wa = await startWhatsApp({ config, onMessage, onNonText, log });
  startScheduler({ store, send: wa.sendToOwner, config, isReady: wa.isConnected, log });
  log.info(`Bot berjalan. Model: ${config.model}, zona waktu: ${config.timezone}, pemilik: ${config.ownerNumber}`);
}
