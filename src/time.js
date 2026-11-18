const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Selisih (menit) zona waktu `tz` terhadap UTC pada saat `date`. */
export function tzOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/**
 * Parse waktu ISO 8601 dari AI. Tanpa offset → dianggap waktu lokal di `tz`.
 * Mengembalikan Date, atau null kalau formatnya tidak valid.
 */
export function parseDateTime(input, tz) {
  const s = String(input ?? '').trim();
  const m = ISO_RE.exec(s);
  if (!m) return null;
  if (m[7]) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (Number.isNaN(naive)) return null;
  let d = new Date(naive - tzOffsetMinutes(new Date(naive), tz) * 60000);
  // Koreksi sekali lagi untuk zona dengan DST
  d = new Date(naive - tzOffsetMinutes(d, tz) * 60000);
  return d;
}

/** Contoh: "Kam, 19 Nov 2026 15.00" */
export function formatLocal(date, tz) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Contoh: "Kamis, 19 November 2026 pukul 09.30 (WIB)" */
export function formatNowLong(date, tz) {
  const text = new Intl.DateTimeFormat('id-ID', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const off = tzOffsetMinutes(date, tz);
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${text} (${tz}, UTC${sign}${hh}:${mm})`;
}

/** "2026-11-19" dan "07:00" di zona waktu `tz`. */
export function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Teks durasi relatif: "3 jam lagi", "lewat 20 menit". */
export function relativeText(target, now) {
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  let text;
  if (min < 1) return 'sekarang';
  if (min < 60) text = `${min} menit`;
  else if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    text = m >= 5 && h < 6 ? `${h} jam ${m} menit` : `${Math.round(min / 60)} jam`;
  } else text = `${Math.round(min / 1440)} hari`;
  return diff > 0 ? `${text} lagi` : `lewat ${text}`;
}
