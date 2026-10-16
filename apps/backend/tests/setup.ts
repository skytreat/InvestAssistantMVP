// vitest setup: 必须在任何业务模块加载之前设置 JWT_SECRET，
// 因为 auth.ts 顶层会立即读取 process.env.JWT_SECRET 并可能在缺失时 process.exit(1)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 从 workspace 根目录加载 .env.local
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = path.join(rootDir, '.env.local');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local 不存在：静默处理
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'investassistant-mvp-test-secret-for-unit-tests-only';
}
