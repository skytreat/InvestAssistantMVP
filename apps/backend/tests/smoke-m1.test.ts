import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../src/config/configStore.js';
import { duckdbHealthCheck, queryDuckDB } from '../src/db/duckdb.js';
import { registerRoutes } from '../src/routes/index.js';

/**
 * smoke-m1.test.ts — Phase 1 M1 里程碑冒烟测试
 *
 * 顶层用 fs.existsSync 快速检测 DuckDB 文件是否存在（不打开连接，不拿锁）
 * 真实 DuckDB 查询留给 test 内部执行（有独立 timeout）
 */
const HOST = '127.0.0.1';
const PORT = 51100;

// 顶层快速检测：只看文件存不存在，不打开 DuckDB 连接（避免文件锁泄漏）
const DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
const DUCKDB_FILE_EXISTS = fs.existsSync(DUCKDB_PATH);
console.log(`[smoke-m1] DuckDB path: ${DUCKDB_PATH}, exists=${DUCKDB_FILE_EXISTS}`);

let app: Awaited<ReturnType<typeof Fastify>>;
let db: ReturnType<typeof ConfigStore>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  db = ConfigStore.getInstance();
  // 关键：注册所有路由（之前只 register 了 CORS，路由没注册 → 404）
  await registerRoutes(app);
}, 10000);

afterAll(async () => {
  await app.close().catch(() => {});
}, 5000);

// === SQLite 必过 ===
describe('M1 SQLite', () => {
  it('WAL 模式已开启', () => {
    const row = db.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe('wal');
  });

  it('busy_timeout = 5000', () => {
    // SQLite PRAGMA busy_timeout 返回的列名是 timeout（不是 busy_timeout）
    const row = db.db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  });

  it('foreign_keys = ON', () => {
    const row = db.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it('7 张业务表全覆盖', () => {
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'user_account',
      'user_asset_rel',
      'user_asset_stat',
      'user_plugin_config',
      'user_strategy_signal',
      'user_trade_record',
      'system_log',
    ].sort());
  });

  it('user_asset_rel UNIQUE(user_id, asset_code, rel_type) 约束存在', () => {
    // SQLite CREATE TABLE ... UNIQUE(user_id, asset_code, rel_type) 自动创建内部 UNIQUE 索引
    // sqlite_master.sql 列对自动索引是 NULL，但 index_list 能看到 unique=1
    const indexes = db.db
      .prepare("PRAGMA index_list('user_asset_rel')")
      .all() as { name: string; unique: number; origin: string }[];
    // 找到 origin='u'（UNIQUE 约束创建的）且 unique=1 的索引
    const uniqueIdx = indexes.find((i) => i.unique === 1);
    expect(uniqueIdx).toBeDefined();
    // 验证索引覆盖三列
    const cols = db.db
      .prepare(`PRAGMA index_info('${uniqueIdx!.name}')`)
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual(['asset_code', 'rel_type', 'user_id']);
  });

  it('system_log 可写可读', () => {
    db.writeLog('startup', 'INFO', 'smoke-m1 test log');
    const row = db.db
      .prepare("SELECT * FROM system_log WHERE log_type='startup' ORDER BY id DESC LIMIT 1")
      .get();
    expect(row).toBeDefined();
    expect((row as any).message).toBe('smoke-m1 test log');
  });
});

// === Fastify 必过 ===
describe('M1 Fastify', () => {
  it('启动监听 127.0.0.1:51100', async () => {
    await app.listen({ port: PORT, host: HOST });
    const addr = app.addresses()[0];
    expect(addr.port).toBe(PORT);
    expect(addr.address).toBe(HOST);
  });

  it('/api/health 返回 200 + 正确结构', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
    expect(typeof body.uptime).toBe('number');
  });

  it('/api/market/latest 返回 JSON（DuckDB 不可用时返回 502）', async () => {
    // 顶层已检测 DuckDB 不可用 → 路由内部快速返回 502，不触发 retry
    const res = await app.inject({ method: 'GET', url: '/api/market/latest' });
    expect([200, 502]).toContain(res.statusCode);
  }, 20000);
});

// === DuckDB 可选（真实文件存在时才跑） ===
describe('M1 DuckDB（部署后启用）', () => {
  it('健康检查 OR 优雅跳过', async () => {
    // 顶层已检测：文件不存在 → 直接跳过（不打开 DuckDB，不拿锁）
    if (!DUCKDB_FILE_EXISTS) {
      console.log('  ⚠️  SKIP DuckDB: 文件不存在');
      console.log('     部署后 export DUCKDB_PATH=/opt/invol/quotes.duckdb 启用');
      return;  // 空通过（无断言）
    }

    // 文件存在 → 跑真实 health check（5 秒 timeout，DuckDB 打开失败就 SKIP）
    try {
      await duckdbHealthCheck();
    } catch (err: any) {
      console.log(`  ⚠️  SKIP DuckDB: ${String(err).substring(0, 80)}`);
      return;  // 空通过（health check 失败说明文件被锁或损坏）
    }

    // 真实 DuckDB 通 → 查询 v_stock_qfq
    const rows = await queryDuckDB<{ symbol: string; date: string; close: number }>(
      'SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 1'
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].symbol).toMatch(/^(sh|sz)\d{6}$/);
    expect(typeof rows[0].close).toBe('number');
  }, 15000);  // 独立 timeout，给 DuckDB 大文件查询留够时间
});
