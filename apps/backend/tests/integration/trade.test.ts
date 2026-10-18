/**
 * trade.test.ts — API 集成测试（交易 + 持仓链路）
 *
 * 覆盖 SDD §12.4 trade 类：
 *   - buy 201 + 返回 position
 *   - GET /api/trades 过滤 asset_code
 *   - sell 超持仓 → 400 HOLDING_INSUFFICIENT
 *   - sell 恰好持仓 → 201 + position.qty=0
 *   - duplicate trade (同日同标的同方向) → 409
 *   - quantity<=0 / price<0 → 400
 *   - 非法 trade_type → 400
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const TRADE_CODE = 'szTEST01';
const TRADE_DATE = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  bundle = await createTestApp();
  // 清残留（之前跑过可能留下）
  bundle.db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?').run(bundle.userId, TRADE_CODE);
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

describe('Trade · 买入 + 持仓查询', () => {
  it('买入 szTEST01 100 股 @ 10.0 → 201', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE, trade_type: 'buy',
        trade_date: TRADE_DATE, quantity: 100, price: 10.0, fee: 5,
        trade_reason: '集成测试买入',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade_id).toBeGreaterThan(0);
    expect(body.data.position.totalQuantity).toBe(100);
    expect(body.data.position.avgCost).toBeCloseTo(10.05, 4);  // (1000+5)/100
  });

  it('GET /api/trades → 列表有刚录的那条', async () => {
    const res = await bundle.app.inject({
      method: 'GET', url: `/api/trades?asset_code=${TRADE_CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const mine = rows.find((r: any) => r.asset_code === TRADE_CODE && r.trade_date === TRADE_DATE);
    expect(mine).toBeDefined();
  });

  it('GET /api/positions/:asset_code → qty=100', async () => {
    const res = await bundle.app.inject({
      method: 'GET', url: `/api/positions/${TRADE_CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalQuantity).toBe(100);
  });
});

describe('Trade · HOLDING_INSUFFICIENT', () => {
  it('卖出超过持仓 → 409 HOLDING_INSUFFICIENT', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE, trade_type: 'sell',
        trade_date: TRADE_DATE, quantity: 999, price: 11.0,
        trade_reason: '测试卖出超持仓',
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('HOLDING_INSUFFICIENT');
    expect(body.success).toBe(false);
  });

  it('卖出恰好 100 股 → 201 + position=0', async () => {
    const sellDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);  // 次日避免 UNIQUE
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: {
        asset_code: TRADE_CODE, trade_type: 'sell',
        trade_date: sellDate, quantity: 100, price: 11.0,
        trade_reason: '测试清仓卖出',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.position.totalQuantity).toBe(0);
    expect(body.data.position.realizedPnL).toBeGreaterThan(0);  // 赚了（realizedPnL 大写 L）
  });
});

describe('Trade · 参数校验', () => {
  it('quantity=0 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { asset_code: TRADE_CODE, trade_type: 'buy', trade_date: TRADE_DATE, quantity: 0, price: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('quantity<0 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { asset_code: TRADE_CODE, trade_type: 'buy', trade_date: TRADE_DATE, quantity: -1, price: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('price<0 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { asset_code: TRADE_CODE, trade_type: 'buy', trade_date: TRADE_DATE, quantity: 10, price: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('缺 asset_code → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { trade_type: 'buy', trade_date: TRADE_DATE, quantity: 10, price: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非法 trade_type → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { asset_code: TRADE_CODE, trade_type: 'fly', trade_date: TRADE_DATE, quantity: 10, price: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate（同日同标的同方向）→ 409 TRADE_DUPLICATE', async () => {
    // 先清一次（前一组测完持仓=0，这次新开）
    const TRADE2 = 'szTEST02';
    const BUY_DATE = new Date().toISOString().slice(0, 10);
    bundle.db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?').run(bundle.userId, TRADE2);

    await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { asset_code: TRADE2, trade_type: 'buy', trade_date: BUY_DATE, quantity: 10, price: 10, trade_reason: 'dup1' },
    });
    const dup = await bundle.app.inject({
      method: 'POST', url: '/api/trades',
      headers: authHeaders(),
      payload: { asset_code: TRADE2, trade_type: 'buy', trade_date: BUY_DATE, quantity: 20, price: 11, trade_reason: 'dup2' },
    });
    expect(dup.statusCode).toBe(409);
    const body = JSON.parse(dup.body);
    expect(body.error).toBe('TRADE_DUPLICATE');
  });
});
