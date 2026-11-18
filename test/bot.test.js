import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createToolExecutor } from '../src/tools.js';
import { parseDateTime } from '../src/time.js';
import { renderState } from '../src/format.js';
import { processReminders, maybeSendDigest } from '../src/scheduler.js';
import { handleUserMessage, buildHistory } from '../src/agent.js';

const TZ = 'Asia/Jakarta';
const OFFSETS = [1440, 180, 30, 0];

function setup(nowIso = '2026-11-18T02:00:00Z') {
  let now = new Date(nowIso);
  const store = new Store(':memory:', { clock: () => now });
  const exec = (name, input) => {
    const run = createToolExecutor({ store, tz: TZ, now, reminderOffsets: OFFSETS });
    const { content, isError } = run(name, input);
    return isError ? { error: content } : JSON.parse(content);
  };
  return { store, exec, setNow: (iso) => { now = new Date(iso); } };
}

const BESOK = ['Notulensi', 'PKS Carbon Ethics', 'PKS AAB', 'LPD', 'SPJ Panjar', 'Pedoman KHE', 'Memo UPA'];

function addBesok(exec) {
  const res = exec('add_items', {
    items: [{ title: 'Besok', kind: 'note', children: BESOK.map((t) => ({ title: t, kind: 'task' })) }],
  });
  return res.created;
}

test('waktu tanpa offset dianggap WIB', () => {
  assert.equal(parseDateTime('2026-11-19T15:00', TZ).toISOString(), '2026-11-19T08:00:00.000Z');
  assert.equal(parseDateTime('2026-11-19T15:00:00+07:00', TZ).toISOString(), '2026-11-19T08:00:00.000Z');
  assert.equal(parseDateTime('besok jam 3', TZ), null);
});

test('daftar bertingkat mendapat label 1, 1.i, 1.ii …', () => {
  const { store, exec } = setup();
  const created = addBesok(exec);
  assert.equal(created[0].label, '1');
  assert.equal(created[1].label, '1.i');
  assert.equal(created[7].label, '1.vii');
  const state = renderState(store, { tz: TZ, now: store.clock() });
  assert.match(state, /1\.iv \[id=\d+\] \(tugas\) LPD/);
});

test('kasus screenshot: menghapus sub-item i hanya menghapus Notulensi', () => {
  const { store, exec } = setup();
  const created = addBesok(exec);
  const notulensi = created.find((c) => c.title === 'Notulensi');

  const res = exec('delete_items', { ids: [notulensi.id] });
  assert.equal(res.ok, true, 'hapus satu item tanpa isi tidak perlu konfirmasi');
  assert.deepEqual(res.deleted.map((d) => d.title), ['Notulensi']);

  const tree = store.tree();
  assert.equal(tree.length, 1);
  assert.equal(tree[0].title, 'Besok');
  assert.equal(tree[0].children.length, 6);
  assert.equal(tree[0].children[0].label, '1.i');
  assert.equal(tree[0].children[0].title, 'PKS Carbon Ethics');

  // dan bisa dibatalkan
  exec('restore_items', { batch: res.batch });
  assert.equal(store.tree()[0].children.length, 7);
});

test('hapus daftar yang ada isinya wajib konfirmasi di pesan berikutnya', () => {
  const { store, exec } = setup();
  store.addMessage('user', 'hapus yang besok');
  const [besok] = addBesok(exec);

  const ask = exec('delete_items', { ids: [besok.id] });
  assert.equal(ask.needs_confirmation, true);
  assert.equal(ask.items_affected.length, 8);
  assert.match(ask.summary, /Besok.*berisi 7 item/);

  // AI tidak boleh langsung mengonfirmasi sendiri di giliran yang sama
  const early = exec('delete_items', { ids: [besok.id], confirm_token: ask.confirm_token });
  assert.match(early.error, /belum menjawab/);
  assert.equal(store.tree().length, 1);

  // Token tampil di keadaan terkini supaya AI bisa memakainya di giliran berikutnya
  assert.match(renderState(store, { tz: TZ, now: store.clock() }), new RegExp(`confirm_token=${ask.confirm_token}`));

  store.addMessage('user', 'ya');
  const done = exec('delete_items', { ids: [besok.id], confirm_token: ask.confirm_token });
  assert.equal(done.ok, true);
  assert.equal(store.tree().length, 0);

  // "mana full nya" → isi tempat sampah tampil di keadaan terkini dan bisa dipulihkan utuh
  const state = renderState(store, { tz: TZ, now: store.clock() });
  assert.match(state, /Besok \+ 7 isi/);
  exec('restore_items', { batch: done.batch });
  assert.equal(store.tree()[0].children.length, 7);
});

test('tugas berdeadline otomatis dapat pengingat; yang selesai tidak dikirim', async () => {
  const { store, exec, setNow } = setup('2026-11-18T02:00:00Z'); // 09.00 WIB
  const { created } = exec('add_items', {
    items: [
      { title: 'Kirim laporan ke Pak Budi', kind: 'task', due_at: '2026-11-19T15:00:00+07:00' },
      { title: 'Bayar listrik', kind: 'task', due_at: '2026-11-19T15:00:00+07:00' },
    ],
  });
  assert.equal(created[0].reminders.length, 4);
  exec('set_status', { ids: [created[1].id], status: 'done' });

  const sent = [];
  setNow('2026-11-19T05:00:00Z'); // 12.00 WIB, 3 jam sebelum deadline (pengingat H-1 juga menumpuk)
  const n = await processReminders({ store, send: async (t) => sent.push(t), now: store.clock(), tz: TZ });
  assert.equal(n, 1, 'pengingat yang menumpuk digabung jadi satu pesan');
  assert.match(sent[0], /Kirim laporan ke Pak Budi/);
  assert.match(sent[0], /3 jam lagi/);
  assert.equal(store.recentMessages(5).at(-1).role, 'assistant', 'pengingat masuk riwayat');

  const again = await processReminders({ store, send: async (t) => sent.push(t), now: store.clock(), tz: TZ });
  assert.equal(again, 0);
});

test('ubah deadline mengatur ulang pengingat otomatis', () => {
  const { exec } = setup();
  const { created } = exec('add_items', { items: [{ title: 'Rapat', kind: 'task', due_at: '2026-11-18T10:00:00+07:00' }] });
  assert.equal(created[0].reminders.length, 2, 'H-1 dan 3 jam sudah lewat, tinggal 30 menit dan saat deadline');
  const res = exec('update_item', { id: created[0].id, due_at: '2026-11-20T10:00:00+07:00' });
  assert.equal(res.item.reminders.length, 4);
  const cleared = exec('set_reminders', { item_id: created[0].id, mode: 'clear' });
  assert.equal(cleared.reminders.length, 0);
});

test('memindahkan item dan batas kedalaman', () => {
  const { store, exec } = setup();
  const created = addBesok(exec);
  const { created: [lain] } = exec('add_items', { items: [{ title: 'Lusa', kind: 'note' }] });
  const lpd = created.find((c) => c.title === 'LPD');
  const moved = exec('update_item', { id: lpd.id, parent_id: lain.id });
  assert.equal(moved.item.label, '2.i');
  const tooDeep = exec('add_items', { items: [{ title: 'x', kind: 'note', parent_id: lpd.id, children: [{ title: 'y', kind: 'note' }] }] });
  assert.match(tooDeep.error, /Maksimal 3 tingkat/);
  assert.equal(store.search('x').length, 0, 'gagal di tengah tidak meninggalkan data setengah jadi');
});

test('preferensi gaya tersimpan dan tampil di keadaan terkini', () => {
  const { store, exec } = setup();
  exec('remember_preference', { text: 'Jangan balas pakai emoji jempol' });
  assert.match(renderState(store, { tz: TZ, now: store.clock() }), /Jangan balas pakai emoji jempol/);
});

test('input tidak valid dikembalikan sebagai error, bukan crash', () => {
  const { exec } = setup();
  assert.match(exec('add_items', { items: [{ title: 'x', kind: 'task', due_at: 'besok' }] }).error, /tidak valid/);
  assert.match(exec('delete_items', { ids: [999] }).error, /tidak ditemukan/);
  assert.match(exec('nope', {}).error, /tidak dikenal/);
});

test('rekap pagi berisi tugas lewat deadline dan hari ini, sekali per hari', async () => {
  const { store, exec, setNow } = setup('2026-11-17T02:00:00Z');
  exec('add_items', {
    items: [
      { title: 'Lama', kind: 'task', due_at: '2026-11-17T17:00:00+07:00' },
      { title: 'Hari ini', kind: 'task', due_at: '2026-11-18T16:00:00+07:00' },
      { title: 'Minggu depan', kind: 'task', due_at: '2026-11-25T16:00:00+07:00' },
    ],
  });
  setNow('2026-11-18T00:30:00Z'); // 07.30 WIB
  const sent = [];
  const send = async (t) => sent.push(t);
  assert.equal(await maybeSendDigest({ store, send, now: store.clock(), tz: TZ, digestTime: '07:00' }), true);
  assert.match(sent[0], /Lewat deadline[\s\S]*Lama[\s\S]*Hari ini/);
  assert.doesNotMatch(sent[0], /Minggu depan/);
  assert.equal(await maybeSendDigest({ store, send, now: store.clock(), tz: TZ, digestTime: '07:00' }), false);
});

test('riwayat digabung agar peran berselang-seling dan diawali user', () => {
  const h = buildHistory([
    { role: 'assistant', content: 'pengingat' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'assistant', content: 'd' },
  ]);
  assert.deepEqual(h, [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'c\n\nd' }]);
});

test('agent menjalankan tool lalu membalas, dan menyimpan riwayat', async () => {
  const { store } = setup();
  const calls = [];
  const responses = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'tool_use', id: 't1', name: 'add_items', input: { items: [{ title: 'Beli telur', kind: 'task' }] } },
      ],
      usage: {},
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sip, "Beli telur" sudah dicatat.' }], usage: {} },
  ];
  const client = { beta: { messages: { create: async (req) => { calls.push(structuredClone(req)); return responses.shift(); } } } };
  const config = { model: 'claude-sonnet-5-5', effort: 'medium', timezone: TZ, historyLimit: 30, defaultReminderOffsets: OFFSETS };

  const reply = await handleUserMessage('catat beli telur', { store, client, config, now: store.clock(), log: {} });
  assert.equal(reply, 'Sip, "Beli telur" sudah dicatat.');
  assert.equal(store.tree()[0].title, 'Beli telur');

  const [first, second] = calls;
  assert.equal(first.model, 'claude-sonnet-5-5');
  assert.equal(first.system[0].cache_control.type, 'ephemeral');
  assert.match(first.messages.at(-1).content, /<keadaan_terkini>[\s\S]*catat beli telur$/);
  // giliran kedua membawa blok asisten utuh (termasuk thinking) dan hasil tool
  assert.equal(second.messages.at(-2).content[0].type, 'thinking');
  assert.equal(second.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(second.messages.at(-1).content[0].is_error, undefined);

  assert.deepEqual(store.recentMessages(10).map((m) => [m.role, m.content]), [
    ['user', 'catat beli telur'],
    ['assistant', 'Sip, "Beli telur" sudah dicatat.'],
  ]);
});
