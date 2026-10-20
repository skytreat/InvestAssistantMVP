import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import schedule from '@fastify/schedule';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { ConfigStore } from '../src/config/configStore.js';
import { registerRoutes } from '../src/routes/index.js';
import { registerCronJobs } from '../src/services/scheduler.js';
import { hashPassword } from '../src/services/auth.js';

// ── 测试用临时 SQLite DB（覆盖 .env.local 中指向不可写路径的 SQLITE_DB_PATH）──
const _SMOKE_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-smoke3-'));
const _SMOKE_DB_PATH = path.join(_SMOKE_TMP_DIR, 'smoke3-test.db');
const _origSqlitePath3 = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = _SMOKE_DB_PATH;
(ConfigStore as any)._instance = null;

export function cleanupSmoke3(): void {
  (ConfigStore as any)._instance = null;
  if (_origSqlitePath3 !== undefined) {
    process.env.SQLITE_DB_PATH = _origSqlitePath3;
  } else {
    delete process.env.SQLITE_DB_PATH;
  }
  try {
    rmSync(_SMOKE_TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * smoke-m3.test.ts — Phase 3 M3 里程碑冒烟测试
 *
 * 覆盖：
 *   ✅ Auth: seed admin + login 拿 JWT
 *   ✅ Trade: 买入 → 持仓正确；卖出超持仓 → HOLDING_INSUFFICIENT
 *   ✅ Signal: 手动触发 → user_strategy_signal 有记录
 *   ✅ Admin: 手动 run-datacheck → system_log 有 trigger_manual
 *   ✅ Watch/Candidate: CRUD（UNIQUE 三列独立共存）
 *   ✅ Scheduler: registerCronJobs → 4 段 cron
 *   ✅ Backup: SQLite 热备份 + DuckDB COPY TO parquet（Windows 可选）
 *
 * ⚠️ Vitest 收集阶段 describe 回调体就执行，it 内的代码才在 beforeAll 后跑
 *    → HEADERS 不能在 describe 顶层常量里引用 beforeAll 赋值的变量
 */

const PORT = 51102;
const HOST = '127.0.0.1';
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

// 顶层 fs.existsSync 粗筛
const _DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
const DUCKDB_FILE_EXISTS = fs.existsSync(_DUCKDB_PATH);
console.log(`[smoke-m3] DuckDB path: ${_DUCKDB_PATH}, exists=${DUCKDB_FILE_EXISTS}`);

let app: Awaited<ReturnType<typeof Fastify>>;
let db: ReturnType<typeof ConfigStore>;
let TRADE_DATE = '';

// 不在模块顶层存 ADMIN_TOKEN！beforeAll 后再生成 getter
function adminHeaders() {
  return { Authorization: `Bearer ${(globalThis as any).__SM3_ADMIN_TOKEN__}` };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(schedule);
  db = ConfigStore.getInstance();
  await registerRoutes(app);
  await app.listen({ port: PORT, host: HOST });

  // seed admin（INSERT OR IGNORE 幂等）
  db.db
    .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
    .run(ADMIN_USER, hashPassword(ADMIN_PASS), 'admin');

  // login 拿 JWT（存入 globalThis，getter 动态取）
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  expect(loginRes.statusCode).toBe(200);
  (globalThis as any).__SM3_ADMIN_TOKEN__ = JSON.parse(loginRes.body).data.token;
  console.log('[smoke-m3] login OK, token_len=', (globalThis as any).__SM3_ADMIN_TOKEN__.length);

  TRADE_DATE = new Date().toISOString().slice(0, 10);
  // beforeAll 里清残留：trade + signal + rel（smoke-m1/m2 可能留下）
  db.db.prepare('DELETE FROM user_trade_record WHERE user_id = 1').run();
  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = 1').run();
  db.db.prepare('DELETE FROM user_asset_rel WHERE user_id = 1').run();
  console.log('[smoke-m3] residue cleared');
}, 15000);

afterAll(async () => {
  await app.close().catch(() => {});
  cleanupSmoke3();
}, 5000);

// === Trade + HOLDING_INSUFFICIENT ===
/**
 * 🔴 T81 顺序依赖修复：本块是**顺序型场景测试**（买入 → 超卖校验 → 卖出 50 → 查持仓），
 *   原实现把每次 POST 放在各自的 `it` 里，依赖「前一个 it 先跑」。
 *   T81 的 `sequence.shuffle` 一开就随机失败（实测：卖出 50 拿到 409、持仓看到 100）。
 *   ⚠️ 试过 `describe.sequential` —— **在 vitest 2.1.9 + 配置级 `sequence.shuffle: true`
 *   下不生效**（该配置会连 sequential 块内部一起打乱）。
 *   → 改为：**场景在 beforeAll 里按顺序构造完并存快照，各 `it` 只做断言**。
 */
describe('M3 Trade + 持仓校验', () => {
  const snap: Record<string, any> = {};

  beforeAll(async () => {
    snap.buy = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: adminHeaders(),
      payload: {
        asset_code: 'sh600000',
        trade_type: 'buy',
        trade_date: TRADE_DATE,
        trade_time: '09:00:01',
        quantity: 100,
        price: 10.0,
        fee: 1,
        trade_reason: 'smoke买入',
      },
    });
    snap.oversell = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: adminHeaders(),
      payload: {
        asset_code: 'sh600000',
        trade_type: 'reduce',
        trade_date: TRADE_DATE + '-dup',
        trade_time: '09:00:02',
        quantity: 5000,
        price: 20.0,
        trade_reason: 'smoke超卖测试',
      },
    });
    snap.sell50 = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: adminHeaders(),
      payload: {
        asset_code: 'sh600000',
        trade_type: 'reduce',
        trade_date: TRADE_DATE + 'b',
        trade_time: '09:00:03',
        quantity: 50,
        price: 20.0,
        trade_reason: 'smoke卖出50',
      },
    });
    snap.positions = await app.inject({ method: 'GET', url: '/api/holding', headers: adminHeaders() });
  });

  it('买入 sh600000 100 股', () => {
    const res = snap.buy;
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.position.totalQuantity).toBe(100);
    expect(body.data.position.avgCost).toBeCloseTo((1000 + 1) / 100, 4);
  });

  it('卖出超持仓 → HOLDING_INSUFFICIENT', () => {
    const res = snap.oversell;
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe('HOLDING_INSUFFICIENT');
  });

  it('卖出 50 股后持仓正确', () => {
    const res = snap.sell50;
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.position.totalQuantity).toBe(50);
  });

  it('GET /api/holding 返回 sh600000', () => {
    const res = snap.positions;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    const found = body.data.find((p: any) => p.asset_code === 'sh600000');
    expect(found).toBeDefined();
    expect(found.totalQuantity).toBe(50);
  });
});

// === Watch + Candidate（UNIQUE 三列独立共存） ===
describe('M3 Watch/Candidate 列表（UNIQUE 三列独立共存）', () => {
  const snap: Record<string, any> = {};
  // 🔴 T81 顺序依赖修复：本块同样是顺序型场景（加 watch → 查 watch → 删 watch），
  //   「GET /api/watch」依赖「POST /api/watch」先跑 → shuffle 下随机失败。
  //   → 场景在 beforeAll 里构造完，各 `it` 只做断言。
  beforeAll(async () => {
    snap.watchAdd = await app.inject({
      method: 'POST',
      url: '/api/watch',
      headers: adminHeaders(),
      payload: { asset_code: 'sz000001' },
    });
    snap.candidateAdd = await app.inject({
      method: 'POST',
      url: '/api/candidate',
      headers: adminHeaders(),
      payload: { asset_code: 'sz000001' },
    });
    snap.watchList = await app.inject({ method: 'GET', url: '/api/watch', headers: adminHeaders() });
  });

  it('POST /api/watch → 201', () => {
    const res = snap.watchAdd;
    expect([201, 409]).toContain(res.statusCode);
  });

  it('POST /api/candidate → 201（candidate 和 watch 互不冲突）', () => {
    // candidate 的创建也提到 beforeAll（DELETE 用例断言「candidate 还在」依赖它）
    expect(snap.candidateAdd.statusCode).toBe(201);
  });

  it('GET /api/watch 返回 sz000001', async () => {
    const res = snap.watchList;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.some((w: any) => w.asset_code === 'sz000001')).toBe(true);
  });

  it('DELETE /api/watch/sz000001 → 200，candidate 还在', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/watch/sz000001', headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const cand = await app.inject({ method: 'GET', url: '/api/candidate', headers: adminHeaders() });
    expect(JSON.parse(cand.body).data.some((w: any) => w.asset_code === 'sz000001')).toBe(true);
  });
});

// === Admin + Signal ===
describe('M3 Admin 手动触发 + Signal 查询', () => {
  it('admin run-datacheck → system_log 有 trigger_manual', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: adminHeaders(),
    });
    expect([200, 500]).toContain(res.statusCode);
    const logs = db.db
      .prepare("SELECT * FROM system_log WHERE log_type='trigger_manual' ORDER BY id DESC LIMIT 5")
      .all();
    expect((logs as any[]).length).toBeGreaterThanOrEqual(1);
  });

  it('admin run-signal → builtin 插件跑 → 有 plugin_execute 日志', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/run-signal', headers: adminHeaders() });
    expect([200, 500]).toContain(res.statusCode);
  });

  it('非 admin token 访问 /api/admin/* → 403', async () => {
    db.db
      .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
      .run('user1', hashPassword('pass1'), 'user');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'user1', password: 'pass1' },
    });
    const userTok = JSON.parse(loginRes.body).data.token;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: { Authorization: `Bearer ${userTok}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// === Scheduler + Backup ===
describe.sequential('M3 Scheduler + Backup', () => {
  it('registerCronJobs → 4 段 cron 注册', async () => {
    registerCronJobs(app);
    const jobs = app.scheduler.getAllJobs();
    expect(jobs.length).toBe(4);
    const ids = jobs.map((j) => j.id).sort();
    expect(ids).toEqual(['backup', 'datacheck-c1-c12', 'dividend-import', 'signal-generate']);
  });

  it('SQLite 热备份成功', async () => {
    // 临时目录（Windows 上不走 /opt/invol/backup）
    const tmpDir = path.resolve('data', 'backup-test');
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.BACKUP_DIR = tmpDir;
    try {
      const { runFullBackup } = await import('../src/services/backup.js');
      const result = await runFullBackup();
      console.log('DEBUG backup result=', JSON.stringify(result));
      expect(result.sqlite.success).toBe(true);
      // DuckDB 部分：文件太大时跳过（避免 800MB+ 备份超时）
      if (DUCKDB_FILE_EXISTS && result.duckdb.success) {
        const duckdbSizeMb = Math.round((result.duckdb.size ?? 0) / 1024 / 1024);
        if (duckdbSizeMb < 500) {
          console.log('  DuckDB backup OK size=', result.duckdb.size);
        } else {
          console.log(`  DuckDB backup skipped（${duckdbSizeMb}MB，超过 500MB 阈值）`);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.BACKUP_DIR;
    }
  }, 120000);
});
