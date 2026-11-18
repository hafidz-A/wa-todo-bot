// Cek cepat: API key Claude valid dan model bisa dipakai (tanpa memakai token).
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';

const config = loadConfig();
try {
  const model = await new Anthropic().models.retrieve(config.model);
  console.log(`✅ API key valid, model ${model.id} tersedia`);
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error('❌ API key Claude tidak valid');
  else if (err instanceof Anthropic.NotFoundError) console.error(`❌ Model ${config.model} tidak tersedia untuk akun ini`);
  else console.error(`❌ Gagal menghubungi API Claude: ${err.message}`);
  process.exit(1);
}
