// Mode uji coba di terminal: ngobrol dengan bot tanpa WhatsApp.
// Pakai database terpisah (data/cli.db) kecuali DB_PATH diisi.
import readline from 'node:readline/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { handleUserMessage } from './agent.js';
import { startScheduler } from './scheduler.js';

const config = loadConfig();
if (!process.env.DB_PATH) config.dbPath = path.join(config.dataDir, 'cli.db');

const store = new Store(config.dbPath);
const client = new Anthropic();
const log = { info: console.log, warn: console.warn, error: console.error, debug: process.env.DEBUG ? console.log : undefined };

const print = (text) => console.log(`\n🤖 ${text.replace(/\n/g, '\n   ')}\n`);
startScheduler({ store, send: async (t) => print(t), config, log });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Mode chat terminal (database: ${config.dbPath}). Ketik pesan, Ctrl+C untuk keluar.\n`);
for (;;) {
  const text = (await rl.question('kamu> ')).trim();
  if (!text) continue;
  try {
    print(await handleUserMessage(text, { store, client, config, log }));
  } catch (err) {
    console.error('Gagal:', err.message);
  }
}
