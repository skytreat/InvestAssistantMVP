/**
 * review.test.ts — 复盘闭环集成测试（T38 + T39，G6a）
 *
 * 覆盖：
 *   - DDL：user_trade_record 含 strategy_match 列（三态 0/1/NULL）
 *   - PATCH /api/trade/:id 写 strategy_match 不再 500（历史 gap：DDL 缺列）
 *   - GET /api/trade?strategy_match=1 筛选生效
 *   - GET /api/review/trades 返回 strategy_match 字段
 *   - GET /api/review/yield 胜率/盈亏比按移动加权成本算（PRD §5.5）
 *   - 软删除后统计口径同步排除
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// 存在性判定源 = DuckDB raw_symbol_class：mock 返回空（本文件专注复盘闭环，不做存在性判定）
const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const CODE = 'szREVIEW1';
const D1 = '2025-01-01';
const D2 = '2025-02-01';
const D3 = '2025-03-01';

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

async function postTrade(payload: Record<string, unknown>) {
  return bundle.app.inject({
    method: 'POST',
    url: '/api/trade',
    headers: authHeaders(),
    payload,
  });
}

beforeAll(async () => {
  // 默认放行：mock raw_symbol_class 返回空（本文件专注复盘闭环，不做存在性判定）
  queryDuckDBMock.mockImplementation(async () => []);
  bundle = await createTestApp();
  bundle.db.db
    .prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?')
    .run(bundle.userId, CODE);

  // 买入 100 @ 10（fee=0）→ 均价 10
  // 卖出 40 @ 12 → 盈亏 +80（盈利）
  // 卖出 60 @ 8  → 盈亏 -120（亏损）
  // 胜率 50%，平均盈利 80，平均亏损 120 → 盈亏比 0.67
  await postTrade({
    asset_code: CODE,
    trade_type: 'buy',
    trade_date: D1,
    trade_time: '09:00:01',
    quantity: 100,
    price: 10.0,
    fee: 0,
    trade_reason: '复盘测试买入',
  });
  await postTrade({
    asset_code: CODE,
    trade_type: 'reduce',
    trade_date: D2,
    trade_time: '09:00:02',
    quantity: 40,
    price: 12.0,
    fee: 0,
    trade_reason: '复盘测试止盈',
  });
  await postTrade({
    asset_code: CODE,
    trade_type: 'clear',
    trade_date: D3,
    trade_time: '09:00:03',
    quantity: 60,
    price: 8.0,
    fee: 0,
    trade_reason: '复盘测试止损',
  });
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('Review · DDL strategy_match 列存在（G6a）', () => {
  it('user_trade_record 表含 strategy_match 列', () => {
    const cols = (
      bundle.db.db.prepare('PRAGMA table_info(user_trade_record)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('strategy_match');
    // 复盘 4 字段齐全（Requirements §5.2）
    expect(cols).toContain('review_summary');
    expect(cols).toContain('strategy_match');
    expect(cols).toContain('is_stop_loss');
    expect(cols).toContain('remark');
  });
});

describe('Review · PATCH 复盘 4 字段', () => {
  it('PATCH strategy_match=1 → 200 且可读回', async () => {
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=buy`,
      headers: authHeaders(),
    });
    const tradeId = JSON.parse(list.body).data[0].id;

    const patch = await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: { strategy_match: 1, review_summary: '按计划加仓', is_stop_loss: 0, remark: '纪律执行到位' },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).code).toBe(0);

    const after = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=buy`,
      headers: authHeaders(),
    });
    const row = JSON.parse(after.body).data[0];
    expect(row.strategy_match).toBe(1);
    expect(row.review_summary).toBe('按计划加仓');
    expect(row.is_stop_loss).toBe(0);
    expect(row.remark).toBe('纪律执行到位');
  });

  it('PATCH strategy_match=0 → 0（三态"否"，非 NULL）', async () => {
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=reduce`,
      headers: authHeaders(),
    });
    const tradeId = JSON.parse(list.body).data[0].id;

    await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: { strategy_match: 0 },
    });

    const after = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=reduce`,
      headers: authHeaders(),
    });
    expect(JSON.parse(after.body).data[0].strategy_match).toBe(0);
  });

  it('PATCH 非法字段（trade_type）→ 被忽略，不改数量/价格', async () => {
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=buy`,
      headers: authHeaders(),
    });
    const before = JSON.parse(list.body).data[0];

    const patch = await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${before.id}`,
      headers: authHeaders(),
      payload: { trade_type: 'reduce', price: 999, quantity: 1, remark: '只改备注' },
    });
    expect(patch.statusCode).toBe(200);

    const after = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=buy`,
      headers: authHeaders(),
    });
    const row = JSON.parse(after.body).data[0];
    expect(row.trade_type).toBe('buy');
    expect(row.price).toBe(before.price);
    expect(row.quantity).toBe(before.quantity);
    expect(row.remark).toBe('只改备注');
  });
});

describe('Review · PATCH 复盘字段对齐（T131 / 缺陷 C7）', () => {
  const seedBuy = async (assetCode: string) => {
    await postTrade({
      asset_code: assetCode,
      trade_type: 'buy',
      trade_date: '2025-05-01',
      trade_time: '09:00:01',
      quantity: 10,
      price: 10.0,
      fee: 0,
      trade_reason: 'T131 字段测试',
    });
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${assetCode}&trade_type=buy`,
      headers: authHeaders(),
    });
    return JSON.parse(list.body).data[0].id as number;
  };

  const readBack = async (assetCode: string) => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${assetCode}&trade_type=buy`,
      headers: authHeaders(),
    });
    return JSON.parse(res.body).data[0];
  };

  it('emotion_status / buy_reason / sell_reason / system_followed 写入后可原样读回', async () => {
    const CODE_T131 = 'szREVIEWT131A';
    const tradeId = await seedBuy(CODE_T131);

    const patch = await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: {
        emotion_status: '焦虑',
        buy_reason: '突破买入',
        sell_reason: '止损离场',
        system_followed: 1,
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).code).toBe(0);

    const row = await readBack(CODE_T131);
    expect(row.emotion_status).toBe('焦虑');
    expect(row.buy_reason).toBe('突破买入');
    expect(row.sell_reason).toBe('止损离场');
    expect(row.system_followed).toBe(1);
  });

  it('部分字段更新不影响其他字段（未传字段保持原值，不被覆写为 NULL）', async () => {
    const CODE_T131 = 'szREVIEWT131B';
    const tradeId = await seedBuy(CODE_T131);

    // 先写满 4 个字段
    await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: {
        emotion_status: '平静',
        buy_reason: '回踩买入',
        sell_reason: '计划止盈',
        system_followed: 0,
      },
    });

    // 只改 remark → 其余字段必须保持
    const patch = await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: { remark: '只改备注' },
    });
    expect(patch.statusCode).toBe(200);

    const row = await readBack(CODE_T131);
    expect(row.remark).toBe('只改备注');
    expect(row.emotion_status).toBe('平静');
    expect(row.buy_reason).toBe('回踩买入');
    expect(row.sell_reason).toBe('计划止盈');
    expect(row.system_followed).toBe(0);
  });

  it('PATCH 不存在的 id → 404（确实未写入时不返回 200）', async () => {
    const patch = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/trade/999999999',
      headers: authHeaders(),
      payload: { remark: '不应落库' },
    });
    expect(patch.statusCode).toBe(404);
    expect(JSON.parse(patch.body).code).not.toBe(0);
  });

  it('emotion_status 非法枚举 → 400 PARAM_INVALID（不伪装成功）', async () => {
    const CODE_T131 = 'szREVIEWT131C';
    const tradeId = await seedBuy(CODE_T131);

    const patch = await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: { emotion_status: '非常开心' },
    });
    expect(patch.statusCode).toBe(400);

    const row = await readBack(CODE_T131);
    expect(row.emotion_status).toBeNull();
  });
});

describe('Review · strategy_match 筛选', () => {
  // 🔴 T81 顺序依赖修复：原实现依赖**兄弟用例**（上面的 PATCH 用例）先跑并留下
  //   strategy_match 标记 —— T81 的 `sequence.shuffle` 一开就随机失败
  //   （实测：shuffle 关 → 10/10 绿；shuffle 开 → 2 个筛选用例红）。
  //   改为每个用例**自己**准备带标记的数据，与兄弟用例解耦。
  const seedMarked = async (assetCode: string, tradeType: string, marked: 0 | 1) => {
    await postTrade({
      asset_code: assetCode,
      trade_type: tradeType,
      trade_date: '2025-04-01',
      trade_time: '09:00:09',
      quantity: 10,
      price: 10.0,
      fee: 0,
      trade_reason: '筛选测试',
    });
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${assetCode}&trade_type=${tradeType}`,
      headers: authHeaders(),
    });
    const tradeId = JSON.parse(list.body).data[0].id;
    await bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${tradeId}`,
      headers: authHeaders(),
      payload: { strategy_match: marked },
    });
  };

  it('GET /api/trade?strategy_match=1 → 只返回符合策略的', async () => {
    const MARKED = 'szREVIEWM1';
    await seedMarked(MARKED, 'buy', 1);
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?strategy_match=1`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.strategy_match === 1)).toBe(true);
  });

  it('GET /api/trade?strategy_match=0 → 只返回不符合策略的', async () => {
    const MARKED = 'szREVIEWM0';
    await seedMarked(MARKED, 'buy', 0);
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?strategy_match=0`,
      headers: authHeaders(),
    });
    const rows = JSON.parse(res.body).data as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.strategy_match === 0)).toBe(true);
  });

  it('GET /api/review/trades 返回 strategy_match 字段', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/review/trades',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data as any[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toHaveProperty('strategy_match');
  });
});

describe('Review · 胜率 / 盈亏比统计（PRD §5.5）', () => {
  it('stats 返回 closedCount=2 / winRate=50 / 盈亏比≈0.67', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/review/yield', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const stats = JSON.parse(res.body).data;

    expect(stats.closedCount).toBe(2);
    expect(stats.winCount).toBe(1);
    expect(stats.lossCount).toBe(1);
    expect(stats.winRate).toBe(50);
    expect(stats.avgWin).toBeCloseTo(80, 2);
    expect(stats.avgLoss).toBeCloseTo(120, 2);
    expect(stats.profitLossRatio).toBeCloseTo(0.67, 2);
    expect(stats.totalRealizedPnl).toBeCloseTo(-40, 2);
  });

  it('软删除一笔平仓后 closedCount 减 1，胜率重算', async () => {
    // 删掉亏损那笔（clear）→ 只剩盈利那笔 → 胜率 100%
    const list = await bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${CODE}&trade_type=clear`,
      headers: authHeaders(),
    });
    const clearId = JSON.parse(list.body).data[0].id;
    await bundle.app.inject({
      method: 'POST',
      url: `/api/trade/${clearId}/soft-delete`,
      headers: authHeaders(),
    });

    const res = await bundle.app.inject({ method: 'GET', url: '/api/review/yield', headers: authHeaders() });
    const stats = JSON.parse(res.body).data;
    expect(stats.closedCount).toBe(1);
    expect(stats.winRate).toBe(100);

    // 恢复回来，保证后续断言不受影响
    await bundle.app.inject({ method: 'POST', url: `/api/trade/${clearId}/restore`, headers: authHeaders() });
    const after = await bundle.app.inject({
      method: 'GET',
      url: '/api/review/yield',
      headers: authHeaders(),
    });
    expect(JSON.parse(after.body).data.closedCount).toBe(2);
  });

  it('空仓用户：winRate / profitLossRatio 为 null（前端显示 --）', async () => {
    const empty = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: `rev_empty_${Date.now()}`, password: 'x1234567', role: 'user' },
    });
    expect(empty.statusCode).toBe(201);
    const token = JSON.parse(empty.body).data.token;

    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/review/yield',
      headers: { authorization: `Bearer ${token}` },
    });
    const stats = JSON.parse(res.body).data;
    expect(stats.closedCount).toBe(0);
    expect(stats.winRate).toBeNull();
    expect(stats.profitLossRatio).toBeNull();
  });
});

describe('Review · 交易对标的中文名（asset_name）', () => {
  it('GET /api/review/pairs 从 raw_symbol_name 补齐名称；缺失时为 null', async () => {
    queryDuckDBMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('raw_symbol_name')) {
        const symbols = Array.isArray(params) ? params.map(String) : [];
        return symbols.filter((s) => s === CODE).map((s) => ({ symbol: s, name: '复盘测试标的' }));
      }
      return [];
    });
    try {
      const res = await bundle.app.inject({
        method: 'GET',
        url: '/api/review/pairs',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const pairs = JSON.parse(res.body).data as Array<{
        asset_code: string;
        asset_name: string | null;
      }>;
      const mine = pairs.find((p) => p.asset_code === CODE);
      expect(mine).toBeTruthy();
      expect(mine?.asset_name).toBe('复盘测试标的');
      // 行情层未覆盖的标的 → null（前端回退显示代码，不留空）
      const others = pairs.filter((p) => p.asset_code !== CODE);
      expect(others.every((p) => p.asset_name === null)).toBe(true);
    } finally {
      queryDuckDBMock.mockImplementation(async () => []);
    }
  });
});
