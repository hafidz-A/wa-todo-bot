import path from 'node:path';

const digits = (value) => String(value ?? '').replace(/\D/g, '');

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return {
    // Nomor WhatsApp pemilik (satu-satunya yang dilayani), format 628xxxxxxxxxx
    ownerNumber: digits(env.OWNER_NUMBER),
    // Opsional: nomor bot untuk login via pairing code (tanpa scan QR)
    botNumber: digits(env.BOT_NUMBER),
    timezone: env.TIMEZONE || 'Asia/Jakarta',
    model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    effort: env.CLAUDE_EFFORT || 'medium',
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'bot.db'),
    authDir: env.AUTH_DIR || path.join(dataDir, 'wa-auth'),
    historyLimit: Number(env.HISTORY_LIMIT || 30),
    trashDays: Number(env.TRASH_DAYS || 7),
    // Jam rekap pagi (HH:MM, zona waktu di atas). Kosongkan untuk mematikan.
    digestTime: env.DIGEST_TIME ?? '07:00',
    // Pengingat otomatis untuk tugas berdeadline, dalam menit sebelum deadline
    defaultReminderOffsets: (env.DEFAULT_REMINDERS || '1440,180,30,0')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0),
  };
}
