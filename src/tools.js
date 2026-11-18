import { parseDateTime, formatLocal } from './time.js';

const itemFields = {
  title: { type: 'string', description: 'Judul singkat item' },
  kind: {
    type: 'string',
    enum: ['task', 'note'],
    description: 'task = tugas yang perlu dikerjakan (boleh punya deadline); note = catatan/informasi biasa',
  },
  body: { type: 'string', description: 'Isi/detail tambahan (opsional), misal teks panjang yang diteruskan' },
  due_at: {
    type: 'string',
    description: 'Deadline dalam ISO 8601 dengan offset zona waktu, misal 2026-11-19T15:00:00+07:00. Hanya untuk tugas.',
  },
};

export const TOOL_DEFINITIONS = [
  {
    name: 'add_items',
    description:
      'Tambah satu atau beberapa item (tugas/catatan). Pakai parent_id untuk menaruh item di dalam item lain ' +
      '(misal menambah sub-item ke daftar "Besok"). Pakai children untuk sekaligus membuat isi bertingkat. ' +
      'Tugas dengan deadline otomatis mendapat pengingat default.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              ...itemFields,
              parent_id: { type: 'integer', description: 'id item induk (opsional)' },
              children: {
                type: 'array',
                description: 'Sub-item yang langsung dibuat di dalam item ini',
                items: { type: 'object', properties: itemFields, required: ['title', 'kind'] },
              },
            },
            required: ['title', 'kind'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'update_item',
    description:
      'Ubah satu item: ganti judul/isi/jenis, ganti atau hapus deadline (due_at: null), ' +
      'pindahkan ke induk lain (parent_id, null = ke tingkat teratas), atau ubah urutan (position, mulai 1).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        body: { type: ['string', 'null'] },
        kind: { type: 'string', enum: ['task', 'note'] },
        due_at: { type: ['string', 'null'], description: 'ISO 8601 dengan offset, atau null untuk menghapus deadline' },
        parent_id: { type: ['integer', 'null'] },
        position: { type: 'integer', minimum: 1 },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_status',
    description: 'Tandai item selesai (done) atau buka lagi (open). Bisa beberapa sekaligus.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
        status: { type: 'string', enum: ['done', 'open'] },
      },
      required: ['ids', 'status'],
    },
  },
  {
    name: 'delete_items',
    description:
      'Pindahkan item (beserta seluruh isinya) ke tempat sampah. Bisa dikembalikan lewat restore_items. ' +
      'Hapus item tunggal tanpa isi langsung jalan. Kalau yang terhapus punya isi atau lebih dari 3 item, ' +
      'tool ini mengembalikan needs_confirmation + confirm_token: tanyakan dulu ke pengguna, lalu panggil lagi ' +
      'dengan confirm_token yang sama SETELAH pengguna menjawab setuju di pesan berikutnya.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
        confirm_token: { type: 'string' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'restore_items',
    description: 'Kembalikan item dari tempat sampah, per batch (satu aksi hapus) atau per id.',
    input_schema: {
      type: 'object',
      properties: {
        batch: { type: 'string' },
        ids: { type: 'array', items: { type: 'integer' } },
      },
    },
  },
  {
    name: 'get_item',
    description: 'Lihat detail lengkap satu item: isi penuh, semua sub-item, dan pengingatnya.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
  },
  {
    name: 'search_items',
    description: 'Cari item berdasarkan kata di judul atau isi, termasuk yang sudah selesai lama dan tidak tampil di daftar.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'set_reminders',
    description:
      'Atur pengingat untuk satu item. mode: "default" = pakai pengingat bawaan berdasarkan deadline; ' +
      '"replace" = ganti semua pengingat yang belum terkirim dengan yang diberikan; "add" = tambahkan; ' +
      '"clear" = hapus semua pengingat yang belum terkirim. Waktu bisa lewat times (ISO 8601 dengan offset) ' +
      'atau minutes_before (menit sebelum deadline).',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'integer' },
        mode: { type: 'string', enum: ['default', 'replace', 'add', 'clear'] },
        times: { type: 'array', items: { type: 'string' } },
        minutes_before: { type: 'array', items: { type: 'integer', minimum: 0 } },
      },
      required: ['item_id', 'mode'],
    },
  },
  {
    name: 'remember_preference',
    description:
      'Simpan permanen preferensi pengguna soal cara kamu membalas atau mencatat ' +
      '(misal "jangan balas pakai emoji jempol", "pakai bahasa santai", "jangan tanya konfirmasi untuk catatan"). ' +
      'Preferensi ini selalu ditampilkan di keadaan terkini dan wajib dipatuhi.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'forget_preference',
    description: 'Hapus preferensi yang sudah tidak berlaku.',
    input_schema: {
      type: 'object',
      properties: { pref_id: { type: 'integer' } },
      required: ['pref_id'],
    },
  },
];

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const isInt = (v) => Number.isInteger(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

function labelIndex(store, { includeHidden = true } = {}) {
  const map = new Map();
  const walk = (nodes) => { for (const n of nodes) { map.set(n.id, n.label); walk(n.children); } };
  walk(includeHidden ? store.tree({ hideDoneAfterDays: 36500 }) : store.tree());
  return map;
}

function describe(store, id, labels = labelIndex(store)) {
  const item = store.getItem(id, { includeDeleted: true });
  if (!item) return { id };
  return { id, label: labels.get(id) ?? null, title: item.title, kind: item.kind, status: item.status, due_at: item.due_at };
}

/** Konteks: { store, tz, now, reminderOffsets } */
export function createToolExecutor(ctx) {
  const { store, tz } = ctx;

  const parseDue = (value, field = 'due_at') => {
    if (value === null || value === undefined || value === '') return null;
    const d = parseDateTime(value, tz);
    need(d, `${field} "${value}" tidak valid. Pakai ISO 8601, misal 2026-11-19T15:00:00+07:00`);
    return d.toISOString();
  };

  const validItem = (it) => {
    need(it && typeof it === 'object', 'item harus berupa object');
    need(nonEmpty(it.title), 'title wajib diisi');
    need(it.kind === 'task' || it.kind === 'note', 'kind harus "task" atau "note"');
  };

  const handlers = {
    add_items({ items }) {
      need(Array.isArray(items) && items.length > 0, 'items wajib berisi minimal satu item');
      items.forEach((it) => { validItem(it); (it.children ?? []).forEach(validItem); });
      const created = store.tx(() => {
        const ids = [];
        const make = (it, parentId) => {
          const id = store.addItem({
            title: it.title.trim(),
            kind: it.kind,
            body: it.body?.trim() || null,
            dueAt: parseDue(it.due_at),
            parentId: parentId ?? null,
          });
          store.resetAutoReminders(id, ctx.reminderOffsets);
          ids.push(id);
          return id;
        };
        for (const it of items) {
          need(it.parent_id == null || isInt(it.parent_id), 'parent_id harus integer');
          const id = make(it, it.parent_id);
          for (const c of it.children ?? []) make(c, id);
        }
        return ids;
      });
      const labels = labelIndex(store);
      return { ok: true, created: created.map((id) => ({ ...describe(store, id, labels), reminders: reminderTimes(id) })) };
    },

    update_item(input) {
      need(isInt(input.id), 'id wajib integer');
      const patch = {};
      if (input.title !== undefined) { need(nonEmpty(input.title), 'title tidak boleh kosong'); patch.title = input.title.trim(); }
      if (input.body !== undefined) patch.body = input.body ? input.body.trim() : null;
      if (input.kind !== undefined) { need(['task', 'note'].includes(input.kind), 'kind tidak valid'); patch.kind = input.kind; }
      if (input.due_at !== undefined) patch.dueAt = parseDue(input.due_at);
      if (input.parent_id !== undefined) { need(input.parent_id === null || isInt(input.parent_id), 'parent_id harus integer atau null'); patch.parentId = input.parent_id; }
      if (input.position !== undefined) { need(isInt(input.position) && input.position >= 1, 'position mulai dari 1'); patch.position = input.position; }
      const before = store.getItem(input.id);
      need(before, `Item id=${input.id} tidak ditemukan`);
      store.tx(() => {
        store.updateItem(input.id, patch);
        if (patch.dueAt !== undefined && patch.dueAt !== before.due_at) store.resetAutoReminders(input.id, ctx.reminderOffsets);
      });
      return { ok: true, item: { ...describe(store, input.id), reminders: reminderTimes(input.id) } };
    },

    set_status({ ids, status }) {
      need(Array.isArray(ids) && ids.length && ids.every(isInt), 'ids wajib array integer');
      need(status === 'done' || status === 'open', 'status harus done atau open');
      const missing = ids.filter((id) => !store.getItem(id));
      need(!missing.length, `Item tidak ditemukan: ${missing.join(', ')}`);
      store.tx(() => ids.forEach((id) => store.setStatus(id, status)));
      const labels = labelIndex(store);
      return { ok: true, items: ids.map((id) => describe(store, id, labels)) };
    },

    delete_items({ ids, confirm_token: token }) {
      need(Array.isArray(ids) && ids.length && ids.every(isInt), 'ids wajib array integer');
      const missing = ids.filter((id) => !store.getItem(id));
      need(!missing.length, `Item tidak ditemukan (mungkin sudah terhapus): ${missing.join(', ')}`);
      const unique = [...new Set(ids)];
      const affected = new Set(unique);
      for (const id of unique) for (const d of store.descendantIds(id)) affected.add(d);
      const hasChildren = unique.some((id) => store.descendantIds(id).length > 0);
      const labels = labelIndex(store);

      if (hasChildren || affected.size > 3) {
        const sameIds = (p) => JSON.stringify([...p.ids].sort()) === JSON.stringify([...unique].sort());
        const pending = token ? store.getPending(token) : null;
        if (!pending) {
          const names = unique.map((id) => {
            const it = store.getItem(id);
            const kids = store.descendantIds(id).length;
            return `${labels.get(id) ?? ''} "${it.title}"${kids ? ` (berisi ${kids} item)` : ''}`.trim();
          });
          const summary = `hapus ${names.join(', ')} — total ${affected.size} item`;
          const newToken = store.createPending({ action: 'delete', ids: unique, summary });
          return {
            ok: false,
            needs_confirmation: true,
            confirm_token: newToken,
            summary,
            items_affected: [...affected].map((id) => describe(store, id, labels)),
            instruction: 'Tanyakan konfirmasi ke pengguna dengan menyebut apa saja yang akan terhapus. Jangan panggil lagi sebelum pengguna menjawab.',
          };
        }
        need(sameIds(pending), 'confirm_token ini untuk item yang berbeda. Minta konfirmasi baru.');
        need(
          store.lastUserMessageId() > pending.after_message,
          'Pengguna belum menjawab konfirmasi. Tunggu jawaban pengguna di pesan berikutnya.',
        );
        store.deletePending(token);
      }

      const deleted = [...affected].map((id) => describe(store, id, labels));
      const batch = store.softDelete(unique);
      return { ok: true, batch, deleted, note: `Bisa dikembalikan dengan restore_items batch="${batch}"` };
    },

    restore_items({ batch, ids }) {
      need(nonEmpty(batch) || (Array.isArray(ids) && ids.length), 'isi batch atau ids');
      const restored = store.restore({ batch, ids });
      need(restored.length, 'Tidak ada item yang bisa dikembalikan (cek batch/id di tempat sampah)');
      const labels = labelIndex(store);
      return {
        ok: true,
        restored: restored.map((id) => ({ ...describe(store, id, labels), children: store.descendantIds(id).length })),
      };
    },

    get_item({ id }) {
      need(isInt(id), 'id wajib integer');
      const item = store.getItem(id);
      need(item, `Item id=${id} tidak ditemukan`);
      const labels = labelIndex(store);
      const tree = (pid) => store.children(pid).map((c) => ({
        ...describe(store, c.id, labels),
        body: c.body,
        children: tree(c.id),
      }));
      return {
        ...describe(store, id, labels),
        body: item.body,
        created_at: item.created_at,
        completed_at: item.completed_at,
        reminders: reminderTimes(id),
        children: tree(id),
      };
    },

    search_items({ query }) {
      need(nonEmpty(query), 'query wajib diisi');
      const labels = labelIndex(store);
      const visible = labelIndex(store, { includeHidden: false });
      const rows = store.search(query.trim());
      return {
        results: rows.map((r) => ({
          ...describe(store, r.id, labels),
          body: r.body && r.body.length > 300 ? `${r.body.slice(0, 300)}…` : r.body,
          completed_at: r.completed_at,
          shown_in_list: visible.has(r.id),
        })),
      };
    },

    set_reminders({ item_id: itemId, mode, times = [], minutes_before: minutesBefore = [] }) {
      need(isInt(itemId), 'item_id wajib integer');
      const item = store.getItem(itemId);
      need(item, `Item id=${itemId} tidak ditemukan`);
      need(['default', 'replace', 'add', 'clear'].includes(mode), 'mode tidak valid');
      const now = ctx.now.getTime();
      const toAdd = [];
      if (mode === 'replace' || mode === 'add') {
        for (const t of times) {
          const d = parseDateTime(t, tz);
          need(d, `Waktu "${t}" tidak valid`);
          need(d.getTime() > now, `Waktu ${formatLocal(d, tz)} sudah lewat`);
          toAdd.push(d.toISOString());
        }
        if (minutesBefore.length) {
          need(item.due_at, 'minutes_before butuh deadline. Set due_at dulu atau pakai times.');
          for (const m of minutesBefore) {
            const at = new Date(item.due_at).getTime() - m * 60000;
            need(at > now, `Pengingat ${m} menit sebelum deadline sudah lewat`);
            toAdd.push(new Date(at).toISOString());
          }
        }
        need(toAdd.length, 'Isi times atau minutes_before');
      }
      store.tx(() => {
        if (mode === 'default') {
          need(item.due_at, 'Item belum punya deadline');
          store.clearReminders(itemId, 'custom');
          store.resetAutoReminders(itemId, ctx.reminderOffsets);
        }
        if (mode === 'replace' || mode === 'clear') store.clearReminders(itemId);
        for (const at of toAdd) store.addReminder(itemId, at, 'custom');
      });
      return { ok: true, item: describe(store, itemId), reminders: reminderTimes(itemId) };
    },

    remember_preference({ text }) {
      need(nonEmpty(text), 'text wajib diisi');
      const id = store.addPreference(text.trim());
      return { ok: true, pref_id: id };
    },

    forget_preference({ pref_id: id }) {
      need(isInt(id), 'pref_id wajib integer');
      need(store.removePreference(id), `Preferensi ${id} tidak ditemukan`);
      return { ok: true };
    },
  };

  function reminderTimes(id) {
    return store.remindersFor(id).map((r) => formatLocal(new Date(r.remind_at), tz));
  }

  /** Jalankan tool; mengembalikan { content: string, isError: boolean }. */
  return function execute(name, input) {
    const handler = handlers[name];
    if (!handler) return { content: `Tool tidak dikenal: ${name}`, isError: true };
    try {
      return { content: JSON.stringify(handler(input ?? {})), isError: false };
    } catch (err) {
      // Kesalahan input atau aturan data dikembalikan ke AI supaya ia bisa memperbaiki panggilannya
      return { content: `Error: ${err.message}`, isError: true };
    }
  };
}
