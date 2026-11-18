import { formatLocal, formatNowLong, relativeText } from './time.js';

const MAX_STATE_ITEMS = 400;

function itemLine(store, node, tz, now) {
  const indent = '  '.repeat(node.depth - 1);
  const kind = node.kind === 'task' ? 'tugas' : 'catatan';
  const parts = [`${indent}${node.label} [id=${node.id}] (${kind}${node.status === 'done' ? ', ✓ selesai' : ''}) ${node.title}`];
  if (node.due_at) {
    const due = new Date(node.due_at);
    parts.push(`— deadline ${formatLocal(due, tz)} (${relativeText(due, now)})`);
    const rem = store.remindersFor(node.id);
    if (rem.length) parts.push(`· pengingat: ${rem.map((r) => formatLocal(new Date(r.remind_at), tz)).join(', ')}`);
  } else {
    const rem = store.remindersFor(node.id);
    if (rem.length) parts.push(`— pengingat: ${rem.map((r) => formatLocal(new Date(r.remind_at), tz)).join(', ')}`);
  }
  let line = parts.join(' ');
  if (node.body) {
    const body = node.body.replace(/\s+/g, ' ').trim();
    line += `\n${indent}   isi: ${body.length > 300 ? `${body.slice(0, 300)}… (pakai get_item untuk isi lengkap)` : body}`;
  }
  return line;
}

/** Ringkasan keadaan terkini yang disisipkan ke setiap giliran percakapan. */
export function renderState(store, { tz, now }) {
  const lines = [`Waktu sekarang: ${formatNowLong(now, tz)}`, ''];

  const tree = store.tree();
  let count = 0;
  const walk = (nodes, out) => {
    for (const n of nodes) {
      if (count >= MAX_STATE_ITEMS) return;
      count += 1;
      out.push(itemLine(store, n, tz, now));
      walk(n.children, out);
    }
  };
  const itemLines = [];
  walk(tree, itemLines);
  lines.push('## Daftar milik pengguna');
  if (itemLines.length) lines.push(...itemLines);
  else lines.push('(kosong)');
  if (count >= MAX_STATE_ITEMS) lines.push(`… daftar dipotong; pakai search_items untuk mencari item lain.`);

  const trash = store.trash(5);
  if (trash.length) {
    lines.push('', '## Baru dihapus (tempat sampah, bisa dikembalikan dengan restore_items)');
    for (const t of trash) {
      const extra = t.child_count ? ` + ${t.child_count} isi` : '';
      lines.push(`- batch=${t.delete_batch} [id=${t.id}] ${t.title}${extra} — dihapus ${formatLocal(new Date(t.deleted_at), tz)}`);
    }
  }

  const pending = store.listPending();
  if (pending.length) {
    lines.push('', '## Menunggu konfirmasi pengguna');
    for (const p of pending) lines.push(`- confirm_token=${p.token}: ${p.summary}`);
  }

  const prefs = store.preferences();
  lines.push('', '## Preferensi gaya yang pernah diminta pengguna (WAJIB dipatuhi)');
  if (prefs.length) for (const p of prefs) lines.push(`- [pref_id=${p.id}] ${p.text}`);
  else lines.push('(belum ada)');

  return lines.join('\n');
}

/** Pohon item sebagai teks WhatsApp, dipakai di rekap pagi. */
export function renderTaskLine(item, tz, now) {
  const due = item.due_at ? ` — ${formatLocal(new Date(item.due_at), tz)} (${relativeText(new Date(item.due_at), now)})` : '';
  return `• ${item.title}${due}`;
}
