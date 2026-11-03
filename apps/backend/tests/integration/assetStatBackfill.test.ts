/**
 * assetStatBackfill.test.ts — POST /api/asset-stat/backfill 路由集成测试
 *
 * 覆盖：
 *   - 成功回补 → envelope code=0 + filled / marketDays 字段 + 快照口径正确
 *   - 幂等：重复调用不覆盖已有快照（第二次 filled=0）
 *   - 行情库不可用（品种查询抛错）→ 503 MARKET_DATA_UNAVAILABLE
 *
 * ⚠️ 套件 `sequence.shuffle=true`：用例之间**不得依赖顺序** ——
 *   每个用例自带「清表 + 造数 + 断言」的完整闭环。
 *
 * DuckDB 全部 mock（fetchAssetClasses 走 queryDuckDB，K 线区间查询走
 * batchGetDailyRangeByView 的 queryDuckDBColumnar —— 都打不到真库）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const { queryDuckDBMock, queryDuckDBColumnarMock } = vi.hoisted(() => ({
  queryDuckDBMock: vi.fn(),
  queryDuckDBColumnarMock: vi.fn(),
}));

vi.mock('../../src/db/duckdb.js', () => ({
  queryDuckDB: queryDuckDBMock,
  queryDuckDBColumnar: queryDuckDBColumnarMock,
}));

import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

/** 相对「今天」往前 N 天的 ISO 日期（保证落在 365 天回补窗口内） */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

let bundle: TestAppBundle;

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

function cleanUser(): void {
  bundle.db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ?').run(bundle.userId);
  bundle.db.db.prepare('DELETE FROM user_asset_stat WHERE user_id = ?').run(bundle.userId);
}

function seedTrades(): void {
  bundle.db.db
    .prepare(
      `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, quantity, price, fee, trade_date, trade_time)
       VALUES (?, 'sh600000', 'buy', 100, 10, 0, ?, '09:30:00')`,
    )
    .run(bundle.userId, isoDaysAgo(2));
}

beforeAll(async () => {
  // 品种表：mock 返回空（查不到 → 归 stock 组，与 kline 路由同口径）
  queryDuckDBMock.mockResolvedValue([]);
  // K 线区间查询（batchGetDailyRangeByView 的列主序结果）：
  // 参数形状 = [fromDate, toDate, ...symbols]，返回 sh600000 两天行情
  queryDuckDBColumnarMock.mockImplementation(async (_sql: string, params: unknown[]) => {
    const symbols = (params ?? []).slice(2).filter((s) => typeof s === 'string');
    const cols: Record<string, unknown[]> = { symbol: [], date: [], close: [] };
    for (const sym of symbols) {
      // 每「标的 × 日期」一行：列长度必须一致（与真实列主序结果同形）
      cols.symbol.push(sym, sym);
      cols.date.push(isoDaysAgo(1), isoDaysAgo(0));
      cols.close.push(10.5, 11);
    }
    return {
      names: ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume', 'amount'],
      column: (name: string) => cols[name] ?? [],
      columnAt: (_index: number) => [] as unknown[],
    };
  });

  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('POST /api/asset-stat/backfill', () => {
  it('成功回补：envelope code=0，filled=2，快照落库且口径正确', async () => {
    cleanUser();
    seedTrades();

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/asset-stat/backfill',
      headers: authHeaders(),
      payload: { days: 365 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.data.filled).toBe(2);
    expect(body.data.marketDays).toBe(2);
    expect(body.data.skippedExisting).toBe(0);

    // 快照口径：d1 → 100×10.5 − (100×10 + 0 fee) = 50
    const snap = bundle.db.db
      .prepare(
        `SELECT total_profit_price, total_assets_price_yield FROM user_asset_stat
         WHERE user_id = ? AND trade_date = ?`,
      )
      .get(bundle.userId, isoDaysAgo(1)) as { total_profit_price: number; total_assets_price_yield: number };
    expect(snap.total_profit_price).toBeCloseTo(50, 6);
    expect(snap.total_assets_price_yield).toBeCloseTo(50 / 1000, 6);
  });

  it('幂等：重复调用不覆盖已有快照（第二次 filled=0 / skippedExisting=2）', async () => {
    cleanUser();
    seedTrades();

    const first = await bundle.app.inject({
      method: 'POST',
      url: '/api/asset-stat/backfill',
      headers: authHeaders(),
      payload: { days: 365 },
    });
    expect(JSON.parse(first.body).data.filled).toBe(2);

    const second = await bundle.app.inject({
      method: 'POST',
      url: '/api/asset-stat/backfill',
      headers: authHeaders(),
      payload: { days: 365 },
    });
    const secondBody = JSON.parse(second.body);
    expect(secondBody.code).toBe(0);
    expect(secondBody.data.filled).toBe(0);
    expect(secondBody.data.skippedExisting).toBe(2);
  });

  it('行情库不可用 → 503 MARKET_DATA_UNAVAILABLE', async () => {
    cleanUser();
    seedTrades();
    // 品种查询（fetchAssetClasses 的第一次 queryDuckDB）拒绝
    queryDuckDBMock.mockRejectedValueOnce(new Error('duckdb down'));

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/asset-stat/backfill',
      headers: authHeaders(),
      payload: { days: 30 },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('MARKET_DATA_UNAVAILABLE');
    // 没落任何快照
    const count = bundle.db.db
      .prepare('SELECT COUNT(*) c FROM user_asset_stat WHERE user_id = ?')
      .get(bundle.userId) as { c: number };
    expect(count.c).toBe(0);
  });
});
