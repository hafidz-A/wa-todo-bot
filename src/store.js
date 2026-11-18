import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const MAX_DEPTH = 3; // 1 → i → a

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  parent_id     INTEGER REFERENCES items(id),
  kind          TEXT NOT NULL CHECK (kind IN ('task', 'note')),
  title         TEXT NOT NULL,
  body          TEXT,
  due_at        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  position      REAL NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  deleted_at    TEXT,
  delete_batch  TEXT
);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  remind_at  TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('auto', 'custom')),
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(sent_at, remind_at);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  token          TEXT PRIMARY KEY,
  action         TEXT NOT NULL,
  ids            TEXT NOT NULL,
  summary        TEXT NOT NULL,
  after_message  INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  id          INTEGER PRIMARY KEY,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

const toRoman = (n) => {
  if (n >= 40) return String(n);
  let out = '';
  let rest = n;
  for (const [v, s] of [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) {
    while (rest >= v) { out += s; rest -= v; }
  }
  return out;
};
const toLetter = (n) => (n <= 26 ? String.fromCharCode(96 + n) : String(n));

export class Store {
  constructor(dbPath, { clock = () => new Date() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.clock = clock;
  }

  nowIso() {
    return this.clock().toISOString();
  }

  tx(fn) {
    return this.db.transaction(fn)();
  }

  // ---------- items ----------

  getItem(id, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!row || (row.deleted_at && !includeDeleted)) return null;
    return row;
  }

  depthOf(id) {
    let depth = 0;
    let cur = this.getItem(id, { includeDeleted: true });
    while (cur) {
      depth += 1;
      cur = cur.parent_id ? this.getItem(cur.parent_id, { includeDeleted: true }) : null;
    }
    return depth;
  }

  /** Kedalaman subtree di bawah item (item tanpa anak = 1). */
  subtreeHeight(id) {
    const kids = this.children(id);
    return 1 + Math.max(0, ...kids.map((k) => this.subtreeHeight(k.id)));
  }

  children(parentId) {
    return parentId == null
      ? this.db.prepare('SELECT * FROM items WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY position, id').all()
      : this.db.prepare('SELECT * FROM items WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id').all(parentId);
  }

  nextPosition(parentId) {
    const row = parentId == null
      ? this.db.prepare('SELECT MAX(position) AS p FROM items WHERE parent_id IS NULL').get()
      : this.db.prepare('SELECT MAX(position) AS p FROM items WHERE parent_id = ?').get(parentId);
    return (row?.p ?? 0) + 1;
  }

  assertParentOk(parentId, movingHeight = 1) {
    if (parentId == null) return;
    const parent = this.getItem(parentId);
    if (!parent) throw new Error(`Induk id=${parentId} tidak ditemukan`);
    if (this.depthOf(parentId) + movingHeight > MAX_DEPTH) {
      throw new Error(`Maksimal ${MAX_DEPTH} tingkat (contoh: 1 → i → a)`);
    }
  }

  addItem({ title, kind = 'note', body = null, dueAt = null, parentId = null }) {
    this.assertParentOk(parentId);
    const now = this.nowIso();
    const info = this.db
      .prepare(`INSERT INTO items (parent_id, kind, title, body, due_at, position, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parentId, dueAt ? 'task' : kind, title, body, dueAt, this.nextPosition(parentId), now, now);
    return Number(info.lastInsertRowid);
  }

  updateItem(id, patch) {
    const item = this.getItem(id);
    if (!item) throw new Error(`Item id=${id} tidak ditemukan`);
    const next = { ...item };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.dueAt !== undefined) next.due_at = patch.dueAt;
    if (next.due_at) next.kind = 'task';
    if (patch.parentId !== undefined && patch.parentId !== item.parent_id) {
      if (patch.parentId != null) {
        if (patch.parentId === id || this.descendantIds(id).includes(patch.parentId)) {
          throw new Error('Tidak bisa memindahkan item ke dalam dirinya sendiri');
        }
        this.assertParentOk(patch.parentId, this.subtreeHeight(id));
      }
      next.parent_id = patch.parentId;
      next.position = this.nextPosition(patch.parentId);
    }
    if (patch.position !== undefined) {
      // posisi 1-based di antara saudara
      const siblings = this.children(next.parent_id).filter((s) => s.id !== id);
      const idx = Math.max(0, Math.min(siblings.length, patch.position - 1));
      siblings.splice(idx, 0, next);
      const upd = this.db.prepare('UPDATE items SET position = ? WHERE id = ?');
      siblings.forEach((s, i) => { if (s.id !== id) upd.run(i + 1, s.id); });
      next.position = idx + 1;
    }
    this.db
      .prepare(`UPDATE items SET parent_id = ?, kind = ?, title = ?, body = ?, due_at = ?, position = ?, updated_at = ?
                WHERE id = ?`)
      .run(next.parent_id, next.kind, next.title, next.body, next.due_at, next.position, this.nowIso(), id);
    return this.getItem(id);
  }

  setStatus(id, status) {
    const now = this.nowIso();
    this.db
      .prepare('UPDATE items SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(status, status === 'done' ? now : null, now, id);
  }

  descendantIds(id) {
    const out = [];
    const walk = (pid) => {
      for (const c of this.children(pid)) { out.push(c.id); walk(c.id); }
    };
    walk(id);
    return out;
  }

  /** Soft delete item beserta isinya. Mengembalikan id batch untuk undo. */
  softDelete(ids) {
    const batch = crypto.randomBytes(3).toString('hex');
    const now = this.nowIso();
    this.tx(() => {
      const all = new Set();
      for (const id of ids) { all.add(id); for (const d of this.descendantIds(id)) all.add(d); }
      const stmt = this.db.prepare('UPDATE items SET deleted_at = ?, delete_batch = ? WHERE id = ? AND deleted_at IS NULL');
      for (const id of all) stmt.run(now, batch, id);
    });
    return batch;
  }

  /** Kembalikan item dari tempat sampah (per batch atau per id). */
  restore({ batch, ids }) {
    let roots = [];
    if (batch) {
      const rows = this.db.prepare('SELECT * FROM items WHERE delete_batch = ? AND deleted_at IS NOT NULL').all(batch);
      const inBatch = new Set(rows.map((r) => r.id));
      roots = rows.filter((r) => !r.parent_id || !inBatch.has(r.parent_id)).map((r) => r.id);
    } else {
      roots = ids ?? [];
    }
    const restored = [];
    this.tx(() => {
      for (const id of roots) {
        const item = this.getItem(id, { includeDeleted: true });
        if (!item || !item.deleted_at) continue;
        const ids2 = [id, ...this.deletedDescendants(id, item.delete_batch)];
        const parentGone = item.parent_id && !this.getItem(item.parent_id);
        if (parentGone) {
          this.db.prepare('UPDATE items SET parent_id = NULL, position = ? WHERE id = ?').run(this.nextPosition(null), id);
        }
        const stmt = this.db.prepare('UPDATE items SET deleted_at = NULL, delete_batch = NULL WHERE id = ?');
        for (const x of ids2) stmt.run(x);
        restored.push(id);
      }
    });
    return restored;
  }

  deletedDescendants(id, batch) {
    const out = [];
    const walk = (pid) => {
      const rows = this.db.prepare('SELECT id FROM items WHERE parent_id = ? AND delete_batch = ?').all(pid, batch);
      for (const r of rows) { out.push(r.id); walk(r.id); }
    };
    walk(id);
    return out;
  }

  /** Item teratas per batch di tempat sampah, terbaru dulu. */
  trash(limit = 20) {
    const rows = this.db
      .prepare('SELECT * FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id LIMIT 500')
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const roots = rows.filter((r) => {
      const parent = r.parent_id ? byId.get(r.parent_id) : null;
      return !parent || parent.delete_batch !== r.delete_batch;
    });
    return roots.slice(0, limit).map((r) => ({
      ...r,
      child_count: rows.filter((x) => x.delete_batch === r.delete_batch && x.id !== r.id).length,
    }));
  }

  purgeTrash(olderThanIso) {
    const ids = this.db.prepare('SELECT id FROM items WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(olderThanIso).map((r) => r.id);
    if (!ids.length) return 0;
    this.tx(() => {
      // Hapus dari yang paling dalam dulu supaya foreign key aman
      const delRem = this.db.prepare('DELETE FROM reminders WHERE item_id = ?');
      const detach = this.db.prepare('UPDATE items SET parent_id = NULL WHERE parent_id = ?');
      const del = this.db.prepare('DELETE FROM items WHERE id = ?');
      for (const id of ids) { delRem.run(id); detach.run(id); }
      for (const id of ids) del.run(id);
    });
    return ids.length;
  }

  search(query, limit = 30) {
    const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(`SELECT * FROM items WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
                ORDER BY updated_at DESC LIMIT ?`)
      .all(like, like, limit);
  }

  /**
   * Pohon item aktif dengan label tampilan (1, 1.i, 1.i.a).
   * Item teratas yang sudah selesai lebih dari `hideDoneAfterDays` hari disembunyikan.
   */
  tree({ hideDoneAfterDays = 3 } = {}) {
    const cutoff = new Date(this.clock().getTime() - hideDoneAfterDays * 86400000).toISOString();
    const build = (parentId, depth, prefix) => {
      let kids = this.children(parentId);
      if (depth === 1) kids = kids.filter((k) => k.status === 'open' || (k.completed_at ?? '') >= cutoff);
      return kids.map((k, i) => {
        const n = i + 1;
        const seg = depth === 1 ? String(n) : depth === 2 ? toRoman(n) : toLetter(n);
        const label = prefix ? `${prefix}.${seg}` : seg;
        return { ...k, label, depth, children: build(k.id, depth + 1, label) };
      });
    };
    return build(null, 1, '');
  }

  countActive() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL').get().n;
  }

  // ---------- reminders ----------

  remindersFor(itemId, { unsentOnly = true } = {}) {
    const sql = unsentOnly
      ? 'SELECT * FROM reminders WHERE item_id = ? AND sent_at IS NULL ORDER BY remind_at'
      : 'SELECT * FROM reminders WHERE item_id = ? ORDER BY remind_at';
    return this.db.prepare(sql).all(itemId);
  }

  clearReminders(itemId, source = null) {
    if (source) this.db.prepare('DELETE FROM reminders WHERE item_id = ? AND sent_at IS NULL AND source = ?').run(itemId, source);
    else this.db.prepare('DELETE FROM reminders WHERE item_id = ? AND sent_at IS NULL').run(itemId);
  }

  addReminder(itemId, remindAtIso, source) {
    this.db.prepare('INSERT INTO reminders (item_id, remind_at, source) VALUES (?, ?, ?)').run(itemId, remindAtIso, source);
  }

  /** Atur ulang pengingat otomatis berdasarkan deadline item. */
  resetAutoReminders(itemId, offsetsMinutes) {
    this.clearReminders(itemId, 'auto');
    const item = this.getItem(itemId);
    if (!item?.due_at) return;
    const due = new Date(item.due_at).getTime();
    const now = this.clock().getTime();
    for (const off of offsetsMinutes) {
      const at = due - off * 60000;
      if (at > now) this.addReminder(itemId, new Date(at).toISOString(), 'auto');
    }
  }

  dueReminders(nowIso) {
    return this.db
      .prepare(`SELECT r.*, i.title, i.due_at, i.status, i.deleted_at, i.parent_id
                FROM reminders r JOIN items i ON i.id = r.item_id
                WHERE r.sent_at IS NULL AND r.remind_at <= ?
                ORDER BY r.remind_at`)
      .all(nowIso);
  }

  markRemindersSent(ids) {
    const stmt = this.db.prepare('UPDATE reminders SET sent_at = ? WHERE id = ?');
    const now = this.nowIso();
    this.tx(() => { for (const id of ids) stmt.run(now, id); });
  }

  // ---------- percakapan ----------

  addMessage(role, content) {
    const info = this.db.prepare('INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)').run(role, content, this.nowIso());
    return Number(info.lastInsertRowid);
  }

  recentMessages(limit) {
    return this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
  }

  lastUserMessageId() {
    return this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE role = 'user'").get().id ?? 0;
  }

  // ---------- konfirmasi ----------

  createPending({ action, ids, summary }) {
    const token = crypto.randomBytes(3).toString('hex');
    this.db
      .prepare('INSERT INTO pending_confirmations (token, action, ids, summary, after_message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, action, JSON.stringify(ids), summary, this.lastUserMessageId(), this.nowIso());
    return token;
  }

  getPending(token) {
    const row = this.db.prepare('SELECT * FROM pending_confirmations WHERE token = ?').get(token);
    return row ? { ...row, ids: JSON.parse(row.ids) } : null;
  }

  deletePending(token) {
    this.db.prepare('DELETE FROM pending_confirmations WHERE token = ?').run(token);
  }

  listPending(maxAgeMinutes = 30) {
    const cutoff = new Date(this.clock().getTime() - maxAgeMinutes * 60000).toISOString();
    this.db.prepare('DELETE FROM pending_confirmations WHERE created_at < ?').run(cutoff);
    return this.db.prepare('SELECT * FROM pending_confirmations ORDER BY created_at').all().map((r) => ({ ...r, ids: JSON.parse(r.ids) }));
  }

  // ---------- preferensi gaya ----------

  addPreference(text) {
    const info = this.db.prepare('INSERT INTO preferences (text, created_at) VALUES (?, ?)').run(text, this.nowIso());
    return Number(info.lastInsertRowid);
  }

  removePreference(id) {
    return this.db.prepare('DELETE FROM preferences WHERE id = ?').run(id).changes > 0;
  }

  preferences() {
    return this.db.prepare('SELECT * FROM preferences ORDER BY id').all();
  }

  // ---------- meta ----------

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
