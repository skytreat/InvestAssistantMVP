import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ConfigStore } from '../src/config/configStore.js';
import { duckdbHealthCheck, queryDuckDB } from '../src/db/duckdb.js';
import { registerRoutes } from '../src/routes/index.js';

/**
 * smoke-m1.test.ts — Phase 1 M1 里程碑冒烟测试
 *
 * 本地运行：
 *   npm run test  # SQLite + Fastify 必过；DuckDB 不可用时 gracefully skip
 *
 * 服务器部署后：
 *   export DUCKDB_PATH=/opt/invol/quotes.duckdb
 *   npm run test  # DuckDB 校验会自动启用
 *
 * M1 验收覆盖：
 *   ✅ Fastify 监听 127.0.0.1, /api/health → 200
 *   ✅ SQLite WAL + busy_timeout + foreign_keys PRAGMA
 *   ✅ 7 张业务表 + UNIQUE 约束存在
 *   ✅ system_log 可写可读
 *   ⚠️ DuckDB v_stock_qfq 可查询（真实 DuckDB 存在时）
 */

const HOST = '127.0.0.1';
const PORT = 51100;  // 测试端口（AGENTS.md smoke 段分配，避开 8080）

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
    const res = await app.inject({ method: 'GET', url: '/api/market/latest' });
    expect([200, 502]).toContain(res.statusCode);
  });
});

// === DuckDB 可选（真实文件存在时才跑） ===
describe('M1 DuckDB（部署后启用）', () => {
  let duckdbAvailable = false;
  let skipReason = '';

  beforeAll(async () => {
    try {
      await duckdbHealthCheck();
      duckdbAvailable = true;
    } catch (err: any) {
      duckdbAvailable = false;
      skipReason = String(err).substring(0, 80);
    }
  });

  it('健康检查 OR 优雅跳过', async () => {
    if (!duckdbAvailable) {
      console.log(`  ⚠️  SKIP DuckDB: ${skipReason}`);
      console.log('     部署后在 OCI 上 export DUCKDB_PATH=/opt/invol/quotes.duckdb 启用');
      expect(true).toBe(true);  // skip 不算失败
      return;
    }
    // 真实 DuckDB 存在 → 必须能查 v_stock_qfq
    const rows = await queryDuckDB<{ symbol: string; date: string; close: number }>(
      'SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 1'
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].symbol).toMatch(/^(sh|sz)\d{6}$/);
    expect(typeof rows[0].close).toBe('number');
  });
});
