import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isPnUser,
  jidDecode,
  useMultiFileAuthState,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

/** Ambil nomor telepon pengirim dari key pesan (mendukung alamat LID di Baileys v7). */
export function senderNumber(key) {
  for (const jid of [key?.remoteJid, key?.remoteJidAlt]) {
    if (jid && isPnUser(jid)) return jidDecode(jid)?.user ?? null;
  }
  return null;
}

/** Ambil teks dari berbagai jenis pesan, plus konteks balasan/terusan. */
export function extractText(message) {
  const m = message ?? {};
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m;
  const text =
    inner.conversation ??
    inner.extendedTextMessage?.text ??
    inner.imageMessage?.caption ??
    inner.videoMessage?.caption ??
    inner.documentMessage?.caption ??
    null;
  if (!text) return null;

  const ctx = inner.extendedTextMessage?.contextInfo ?? inner.imageMessage?.contextInfo ?? null;
  const prefix = [];
  if (ctx?.isForwarded) prefix.push('(pesan diteruskan)');
  const quoted = ctx?.quotedMessage;
  if (quoted) {
    const q = quoted.conversation ?? quoted.extendedTextMessage?.text ?? quoted.imageMessage?.caption;
    if (q) prefix.push(`(membalas pesan: "${q.length > 500 ? `${q.slice(0, 500)}…` : q}")`);
  }
  return prefix.length ? `${prefix.join(' ')}\n${text}` : text;
}

/**
 * Hubungkan ke WhatsApp. onMessage(text, reply) dipanggil untuk pesan dari pemilik saja.
 * Mengembalikan { sendToOwner, isConnected }.
 */
export async function startWhatsApp({ config, onMessage, onNonText, onOpen, log = console }) {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
  const ownerJid = `${config.ownerNumber}@s.whatsapp.net`;
  let sock = null;
  let connected = false;
  let pairingRequested = false;

  const connect = async () => {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    sock = makeWASocket({ auth: state, logger, version, markOnlineOnConnect: false });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        if (config.botNumber && !pairingRequested) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(config.botNumber);
            log.info(`\nKode pairing: ${code}\nWhatsApp (nomor bot) → Perangkat tertaut → Tautkan dengan nomor telepon → masukkan kode di atas.\n`);
          } catch (err) {
            log.error('Gagal meminta kode pairing, pakai QR saja:', err.message);
            qrcode.generate(qr, { small: true });
          }
        } else if (!config.botNumber) {
          log.info('Scan QR ini dari WhatsApp nomor bot (Perangkat tertaut → Tautkan perangkat):');
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === 'open') {
        connected = true;
        log.info('✅ Terhubung ke WhatsApp');
        onOpen?.();
      }
      if (connection === 'close') {
        connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          log.error(`Sesi WhatsApp logout. Hapus folder ${config.authDir} lalu jalankan ulang untuk login lagi.`);
          process.exit(2);
        }
        log.warn(`Koneksi terputus (kode ${code ?? '?'}), menyambung ulang…`);
        setTimeout(() => connect().catch((e) => log.error('Gagal menyambung ulang:', e)), code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        const key = msg.key ?? {};
        if (key.fromMe || !key.remoteJid || key.remoteJid.endsWith('@g.us') || key.remoteJid === 'status@broadcast') continue;
        if (senderNumber(key) !== config.ownerNumber) continue;

        const chatJid = key.remoteJid;
        const reply = async (text) => { await sock.sendMessage(chatJid, { text }); };
        sock.readMessages([key]).catch(() => {});

        const text = extractText(msg.message);
        if (!text) {
          if (msg.message && !msg.message.protocolMessage && !msg.message.reactionMessage) await onNonText?.(reply);
          continue;
        }
        sock.sendPresenceUpdate('composing', chatJid).catch(() => {});
        try {
          await onMessage(text, reply);
        } finally {
          sock.sendPresenceUpdate('paused', chatJid).catch(() => {});
        }
      }
    });
  };

  await connect();

  return {
    isConnected: () => connected,
    sendToOwner: async (text) => {
      if (!connected) throw new Error('WhatsApp belum terhubung');
      await sock.sendMessage(ownerJid, { text });
    },
  };
}
