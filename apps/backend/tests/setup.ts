// vitest setup: 必须在任何业务模块加载之前设置 JWT_SECRET，
// 因为 auth.ts 顶层会立即读取 process.env.JWT_SECRET 并可能在缺失时 process.exit(1)
//
// ── T81（F-Q11）测试隔离守卫 ────────────────────────────────────────────────
// 本文件承担两件事：
//
// ① .env.local 的**白名单加载**（每个进程只做一次）
//    只放行「不会产生外部副作用」的键。明确不放行的键及理由：
//      TUSHARE_TOKEN     —— 真实 token 会让 C11 打真网络（每次 runAllChecks 30 次
//                           Tushare 请求）。既慢（整套单测多出 ~2 分钟）又烧用户
//                           每日 500 次配额，还让单测结果依赖外网 → 必须与外网解耦。
//      SQLITE_DB_PATH    —— 每个测试文件自己指向临时库；加载 .env.local 的开发库
//                           路径有写坏 data/business.db 的风险。
//      ENABLE_OCI_BACKUP —— 一旦为 'true' 会触发真实对象存储备份。
//      BACKUP_DIR        —— 备份目录由各测试自己指定临时目录。
//
// ② env 守卫：两级基线
//    - **文件级基线**（beforeAll 抓取）：此时测试文件顶层的临时路径已经写好，
//      故基线 = 该文件自己声明的值。每个用例跑完后还原到它 —— 既不会把本文件
//      自己的临时库路径抹掉（抹掉会让 ConfigStore 回落到 data/business.db），
//      也不会把用例体内的临时改动漏给下一个用例。
//    - **进程级基线**（进程内只抓一次，存在 globalThis）：每个文件跑完后还原到它
//      —— 这样**顶层写 env 的文件**（如 backup.test.ts 顶层改 DUCKDB_PATH）
//      不会把值漏给下一个文件。
//    两级基线的分工是必须的：只有文件级基线，顶层写入会顺着文件链一路漏下去
//    （实测 backup.test.ts 顶层改 DUCKDB_PATH → duckdbLeak / t50 / t55 三个文件
//    全部报 "Cannot open file .../invest-backup-*/quotes-test.duckdb"）。
//
//    守卫范围：TUSHARE_TOKEN / SQLITE_DB_PATH / DUCKDB_PATH / ENABLE_OCI_BACKUP /
//              BACKUP_DIR / JWT_SECRET
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll } from 'vitest';

// 允许从 .env.local 注入测试进程的键（无外部副作用）
const ENV_LOAD_ALLOWLIST = new Set<string>(['JWT_SECRET', 'DUCKDB_PATH']);

// 明确禁止从 .env.local 注入的键（会打真网络 / 写开发库 / 触发真实备份）
const ENV_LOAD_DENYLIST = new Set<string>([
  'TUSHARE_TOKEN',
  'SQLITE_DB_PATH',
  'ENABLE_OCI_BACKUP',
  'BACKUP_DIR',
]);

// 需要在每个用例 / 每个文件后还原的键（env 守卫范围）
const GUARDED_ENV_KEYS = [
  'TUSHARE_TOKEN',
  'SQLITE_DB_PATH',
  'DUCKDB_PATH',
  'ENABLE_OCI_BACKUP',
  'BACKUP_DIR',
  'JWT_SECRET',
] as const;

type GuardedEnvKey = (typeof GUARDED_ENV_KEYS)[number];
type EnvBaseline = Partial<Record<GuardedEnvKey, string>>;

const GLOBAL_KEY = '__investTestEnvProcessBaseline__';

function captureEnv(): EnvBaseline {
  const snapshot: EnvBaseline = {};
  for (const key of GUARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvBaseline): void {
  for (const key of GUARDED_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * 确保测试进程里有 JWT_SECRET。
 *
 * 🔴 **必须每个测试文件都调用**（2026-10-19 实测）：
 *   带 `--coverage` 时，vitest 给每个测试文件独立的模块上下文，`process.env` 不保证
 *   在文件之间共享；而 `globalThis` 守卫又让「只跑一次」的兜底在后续文件里失效
 *   → 后续文件里 `auth.ts` 签名抛错 → 用例红。
 *   → 故此函数**不受** `globalThis` 守卫保护，每次 setup 加载都执行。
 */
function ensureJwtSecret(): void {
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'investassistant-mvp-test-secret-for-unit-tests-only';
  }
}

/**
 * 进程级初始化 + 基线抓取（每个进程只执行一次）。
 * 必须在测试文件 import 之前跑完：auth.ts 读 JWT_SECRET 就是靠这一步。
 */
function initProcessBaseline(): EnvBaseline {
  const g = globalThis as unknown as Record<string, EnvBaseline | undefined>;
  const existing = g[GLOBAL_KEY];
  if (existing) {
    // 🔴 2026-10-19 实测（--coverage 场景）：`process.env` **不保证在测试文件之间共享**，
    //   而 `globalThis[GLOBAL_KEY]` 守卫会让**兜底只在第一个文件执行** ——
    //   后续文件的上下文里 `JWT_SECRET` 根本不存在 → `auth.ts` 签名抛错 → 用例红。
    //   → 兜底必须**每个文件都执行**（不放在早退路径之后）。
    ensureJwtSecret();
    return existing;
  }

  // 从 workspace 根目录加载 .env.local（白名单）
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
      if (ENV_LOAD_DENYLIST.has(key)) continue;
      if (!ENV_LOAD_ALLOWLIST.has(key)) continue;
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local 不存在：静默处理
  }

  // 兜底：denylist 里的键即便被外部环境（shell / CI secret）预先设置，也强制清掉，
  // 保证「单测绝不依赖外部凭证、绝不写开发库」。
  for (const key of ENV_LOAD_DENYLIST) {
    delete process.env[key];
  }

  ensureJwtSecret();

  // 兜底：SQLITE_DB_PATH 指向一个安全临时库，而不是回落到 data/business.db。
  // 没有它设 SQLITE_DB_PATH 的测试文件会写到开发库。
  if (!process.env.SQLITE_DB_PATH) {
    const safeDir = mkdtempSync(path.join(os.tmpdir(), 'invest-vitest-'));
    process.env.SQLITE_DB_PATH = path.join(safeDir, 'business.db');
  }

  const baseline = captureEnv();
  g[GLOBAL_KEY] = baseline;
  return baseline;
}

const processBaseline = initProcessBaseline();
let fileBaseline: EnvBaseline = processBaseline;

// 文件级基线在「测试文件顶层代码跑完」之后抓 —— 顶层代码里写的临时库路径
// 才是本文件自己的合法值。beforeAll 在 import 之后执行，正好满足这一点。
beforeAll(() => {
  fileBaseline = captureEnv();
});

afterEach(() => {
  restoreEnv(fileBaseline);
});

afterAll(() => {
  // 还原到进程级基线：把本文件顶层写过的 env 收干净，不漏给下一个文件
  restoreEnv(processBaseline);
});
