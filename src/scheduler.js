import { formatLocal, localParts, relativeText } from './time.js';
import { renderTaskLine } from './format.js';

function parentTitle(store, parentId) {
  return parentId ? store.getItem(parentId)?.title ?? null : null;
}

/** Bangun teks pengingat untuk satu item. */
export function reminderText({ title, dueAt, parent }, now, tz) {
  const where = parent ? ` _(di ${parent})_` : '';
  if (!dueAt) return `⏰ Pengingat: *${title}*${where}\nBalas "udah" kalau sudah beres.`;
  const due = new Date(dueAt);
  const diffMin = (due.getTime() - now.getTime()) / 60000;
  if (diffMin <= 1 && diffMin >= -5) {
    return `🚨 Deadline sekarang: *${title}*${where}\nBalas "udah" kalau sudah beres, atau minta diundur.`;
  }
  if (diffMin < -5) {
    return `⚠️ Lewat deadline (${relativeText(due, now).replace('lewat ', '')}): *${title}*${where}\nDeadline-nya ${formatLocal(due, tz)}. Sudah beres, atau mau diundur?`;
  }
  return `⏰ Pengingat: *${title}*${where}\nDeadline ${formatLocal(due, tz)} (${relativeText(due, now)}).`;
}

/** Kirim pengingat yang sudah jatuh tempo. Mengembalikan jumlah pesan terkirim. */
export async function processReminders({ store, send, now, tz }) {
  const due = store.dueReminders(now.toISOString());
  if (!due.length) return 0;

  // Kelompokkan per item; kalau bot sempat mati dan beberapa pengingat menumpuk, kirim satu saja
  const byItem = new Map();
  for (const r of due) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id).push(r);
  }

  let sent = 0;
  for (const [, rows] of byItem) {
    const r = rows[rows.length - 1];
    const ids = rows.map((x) => x.id);
    if (r.deleted_at || r.status === 'done') {
      store.markRemindersSent(ids);
      continue;
    }
    const text = reminderText({ title: r.title, dueAt: r.due_at, parent: parentTitle(store, r.parent_id) }, now, tz);
    await send(text); // kalau gagal, lempar error → dicoba lagi di putaran berikutnya
    store.markRemindersSent(ids);
    store.addMessage('assistant', text);
    sent += 1;
  }
  return sent;
}

/** Rekap pagi: tugas yang lewat deadline dan yang jatuh tempo hari ini. */
export async function maybeSendDigest({ store, send, now, tz, digestTime }) {
  if (!digestTime) return false;
  const { date, time } = localParts(now, tz);
  if (time < digestTime || store.getMeta('last_digest') === date) return false;

  const overdue = [];
  const today = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.status === 'open' && n.due_at) {
        const d = new Date(n.due_at);
        if (d < now) overdue.push(n);
        else if (localParts(d, tz).date === date) today.push(n);
      }
      walk(n.children);
    }
  };
  walk(store.tree());
  store.setMeta('last_digest', date);
  if (!overdue.length && !today.length) return false;

  const lines = ['☀️ Pagi! Rekap tugas hari ini:'];
  if (overdue.length) lines.push('', '*Lewat deadline*', ...overdue.map((n) => renderTaskLine(n, tz, now)));
  if (today.length) lines.push('', '*Hari ini*', ...today.map((n) => renderTaskLine(n, tz, now)));
  const text = lines.join('\n');
  await send(text);
  store.addMessage('assistant', text);
  return true;
}

export function startScheduler({ store, send, config, isReady = () => true, log = console, intervalMs = 20000 }) {
  let running = false;
  const tick = async () => {
    if (running || !isReady()) return;
    running = true;
    const now = new Date();
    try {
      await processReminders({ store, send, now, tz: config.timezone });
      await maybeSendDigest({ store, send, now, tz: config.timezone, digestTime: config.digestTime });
      const cutoff = new Date(now.getTime() - config.trashDays * 86400000).toISOString();
      store.purgeTrash(cutoff);
    } catch (err) {
      log.error?.('[scheduler] gagal:', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}
