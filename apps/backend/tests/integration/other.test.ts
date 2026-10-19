/**
 * other.test.ts — Signal 分页查询 + Watch/Candidate CRUD 集成测试
 *
 * 覆盖：
 *   src/routes/signal.ts   —— GET /api/signal 默认分页 / plugin_id 过滤 / page_size 上限 / page=0 兜底
 *   src/routes/watch.ts    —— POST 201 / 同 asset 409 / DELETE 不存在 404 / UNIQUE 三列独立共存
 *
 * 不 mock，走真实 SQLite + Fastify inject。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, makeUserToken, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

/**
 * 🔴 2026-10-19 CI 教训：CI 环境只有 12KB 空壳行情库（无 `v_stock_qfq` 等表）。
 *   `POST /api/candidate` 需**查行情库**来固化基准价（T50 语义）→ 无库时返回 503。
 *   → 依赖真实行情库的用例在 CI 无库时跳过。
 */
import { marketDataAvailable } from '../_marketData.js';

/** 真实行情库是否可用（顶层 await 判定一次） */
const MARKET_DATA_AVAILABLE = await marketDataAvailable();

const WATCH_USER = 'int_watch_user';
const WATCH_PASS = 'int_watch_user123';

let bundle: TestAppBundle;
let watchToken: string;
let watchUserId: number;

// authHeaders 模式
const adminHeaders = () => ({ authorization: `Bearer ${bundle.adminToken}` });
const watchHeaders = () => ({ authorization: `Bearer ${watchToken}` });

beforeAll(async () => {
  bundle = await createTestApp();

  // seed 专属测试用户（绕开 auth/seed 路由可能的 409）
  bundle.db.db.prepare(
    `INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, 'user')`
  ).run(WATCH_USER, 'hash_placeholder');
  const row = bundle.db.db.prepare(
    'SELECT id, password_hash FROM user_account WHERE username = ?'
  ).get(WATCH_USER) as { id: number; password_hash: string };
  watchUserId = row.id;
  watchToken = makeUserToken(watchUserId, WATCH_USER);

  // 清残留（beforeAll 里先清，避免上次跑挂的脏数据干扰）
  bundle.db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(watchUserId);
  bundle.db.db.prepare('DELETE FROM user_asset_rel WHERE user_id = ?').run(watchUserId);
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

// ────────────────────────────────────────────────────────────
// Signal 路由覆盖 src/routes/signal.ts (10-46 行)
// ────────────────────────────────────────────────────────────
describe('GET /api/signal · 分页查询', () => {
  beforeAll(() => {
    const db = bundle.db.db;
    // 先清干净，避免计数不准
    db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(watchUserId);

    // 构造 5 条不同 plugin_id / asset_code 的信号
    const insert = db.prepare(`
      INSERT INTO user_strategy_signal
        (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const trades = db.transaction((rows: any[]) => {
      for (const r of rows) insert.run(...r);
    });

    trades([
      [watchUserId, '600001', 'rsi_oversold',   'monitor', '2026-10-15', 'buy',  'RSI<30', 0.85, '{}'],
      [watchUserId, '600002', 'rsi_oversold',   'monitor', '2026-10-14', 'buy',  'RSI<25', 0.90, '{}'],
      [watchUserId, '600003', 'macd_cross',     'monitor', '2026-10-15', 'buy',  '金叉',   0.70, '{}'],
      [watchUserId, '600004', 'rsi_oversold',   'monitor', '2026-10-13', 'buy',  'RSI<28', 0.80, '{}'],
      [watchUserId, '600005', 'volume_spike',   'filter',  '2026-10-15', 'hold', '放量',   0.60, '{}'],
    ]);
  });

  it('默认分页 → 返回 data + pagination 结构，totalPages ≥ 1', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/signal',
      headers: watchHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.pageSize).toBe(20);
    expect(body.pagination.total).toBeGreaterThanOrEqual(5);
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
    // 每条都属于当前用户
    for (const row of body.data) expect(row.user_id).toBe(watchUserId);
  });

  it('plugin_id 过滤 → 每行 plugin_id 匹配', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/signal?plugin_id=rsi_oversold',
      headers: watchHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row.plugin_id).toBe('rsi_oversold');
    }
    expect(body.pagination.total).toBe(3); // 之前 seed 了 3 条 rsi_oversold
  });

  it('page_size=999 → 截断到 200（Math.min(200, ...)）', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/signal?page_size=999',
      headers: watchHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pagination.pageSize).toBe(200);
    expect(body.data.length).toBeLessThanOrEqual(200);
  });

  it('page=0 → Math.max(1, ...) 兜底 page=1', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/signal?page=0',
      headers: watchHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pagination.page).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// Watch / Candidate CRUD 覆盖 src/routes/watch.ts (38-42 行)
// ────────────────────────────────────────────────────────────
describe('Watch CRUD · 38-42', () => {
  // 每次 case 之间清掉，避免互相干扰
  beforeEach(() => {
    bundle.db.db.prepare(
      'DELETE FROM user_asset_rel WHERE user_id = ? AND rel_type = ?'
    ).run(watchUserId, 'watch');
  });

  it('POST /api/watch → 201 + id', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/watch',
      headers: watchHeaders(),
      payload: { asset_code: '000001' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.id).toBe('number');
  });

  it('相同 asset_code 再 POST 一次 → 409 DUPLICATE', async () => {
    // 先造一条
    bundle.db.db.prepare(
      'INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, ?)'
    ).run(watchUserId, '000002', 'watch');

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/watch',
      headers: watchHeaders(),
      payload: { asset_code: '000002' },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe('DUPLICATE');
  });

  it('DELETE /api/watch/:asset_code 不存在的 asset → 404 NOT_FOUND', async () => {
    const res = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/watch/999999',
      headers: watchHeaders(),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe('NOT_FOUND');
  });
});

describe('Candidate CRUD · UNIQUE 三列独立共存', () => {
  // 依赖真实行情库（POST /api/candidate 需查行情固化基准价）→ CI 无库时跳过
  const itReal = MARKET_DATA_AVAILABLE ? it : it.skip;
  // 🔴 T92：候选池路由归属收敛到 `routes/candidate.ts`（T50 实现）后，
  //   `POST /api/candidate` 的入参校验**变严**了 —— 要求 `sh600000 / sz000001` 格式
  //   （旧 `watch.ts` 只要求非空）。本用例原用裸码 '000001' → 400 PARAM_INVALID。
  //   改用全系统统一的带前缀格式，语义（UNIQUE 三列独立）不变。
  const CODE = 'sz000001';

  beforeAll(() => {
    // 确保 watch 表里有一条同 asset_code（独立的 rel_type）
    bundle.db.db.prepare(
      'INSERT OR IGNORE INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, ?)'
    ).run(watchUserId, CODE, 'watch');
  });

  itReal('POST /api/candidate 对同一 asset_code → 201（验证 UNIQUE 三列独立）', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/candidate',
      headers: watchHeaders(),
      payload: { asset_code: CODE },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.id).toBe('number');

    // 验证数据库里 watch + candidate 共存
    const rows = bundle.db.db.prepare(
      'SELECT asset_code, rel_type FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND is_deleted = 0 ORDER BY rel_type'
    ).all(watchUserId, CODE) as { asset_code: string; rel_type: string }[];
    expect(rows.length).toBe(2);
    const types = new Set(rows.map(r => r.rel_type));
    expect(types.has('watch')).toBe(true);
    expect(types.has('candidate')).toBe(true);
  });

  itReal('POST /api/candidate 非法 asset_code 格式 → 400 PARAM_INVALID（T92 收敛后更严）', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/candidate',
      headers: watchHeaders(),
      payload: { asset_code: '000001' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('PARAM_INVALID');
  });
});
