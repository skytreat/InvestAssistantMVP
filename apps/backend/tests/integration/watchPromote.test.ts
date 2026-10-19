/**
 * watchPromote.test.ts — 候选池 → 自选迁移（G4）+ 持仓 enrich 接口
 *
 * 覆盖：
 *   - POST /api/candidate/:asset/promote 首次迁移
 *   - 幂等：已在自选 → alreadyExisted=true，不报 409
 *   - 软删后迁移 → restored=true 且 is_deleted 归 0
 *   - candidate 记录仍保留（watch/candidate 三列独立共存，AGENTS.md 硬约束）
 *   - 非法 symbol → 400 INVALID_SYMBOL
 *   - GET /api/positions 返回 totalQuantity / marketValue 等 enrich 字段
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const CODE = 'sh600519';

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

beforeAll(async () => {
  bundle = await createTestApp();
  bundle.db.db.prepare('DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = ?').run(bundle.userId, CODE);
  bundle.db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?').run(bundle.userId, CODE);
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('Watch · 候选迁移到自选（G4）', () => {
  it('先加候选，再 promote → watch 出现、candidate 仍在', async () => {
    const cand = await bundle.app.inject({
      method: 'POST', url: '/api/candidate', headers: authHeaders(),
      payload: { asset_code: CODE },
    });
    expect(cand.statusCode).toBe(201);

    const promo = await bundle.app.inject({
      method: 'POST', url: `/api/candidate/${CODE}/promote`, headers: authHeaders(),
    });
    expect(promo.statusCode).toBe(200);
    const body = JSON.parse(promo.body);
    expect(body.success).toBe(true);
    expect(body.data.from).toBe('candidate');
    expect(body.data.to).toBe('watch');
    expect(body.data.alreadyExisted).toBe(false);

    const watch = await bundle.app.inject({ method: 'GET', url: '/api/watch', headers: authHeaders() });
    expect(JSON.parse(watch.body).data.some((r: any) => r.asset_code === CODE)).toBe(true);

    // 三列独立共存：candidate 记录不被删
    const cands = await bundle.app.inject({ method: 'GET', url: '/api/candidate', headers: authHeaders() });
    expect(JSON.parse(cands.body).data.some((r: any) => r.asset_code === CODE)).toBe(true);
  });

  it('重复 promote 幂等 → alreadyExisted=true 不报错', async () => {
    const again = await bundle.app.inject({
      method: 'POST', url: `/api/candidate/${CODE}/promote`, headers: authHeaders(),
    });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).data.alreadyExisted).toBe(true);
    expect(JSON.parse(again.body).data.restored).toBe(false);
  });

  it('自选被软删后再 promote → restored=true', async () => {
    await bundle.app.inject({ method: 'DELETE', url: `/api/watch/${CODE}`, headers: authHeaders() });

    const promo = await bundle.app.inject({
      method: 'POST', url: `/api/candidate/${CODE}/promote`, headers: authHeaders(),
    });
    expect(promo.statusCode).toBe(200);
    expect(JSON.parse(promo.body).data.restored).toBe(true);

    const watch = await bundle.app.inject({ method: 'GET', url: '/api/watch', headers: authHeaders() });
    expect(JSON.parse(watch.body).data.some((r: any) => r.asset_code === CODE)).toBe(true);
  });

  it('非法 symbol → 400 INVALID_SYMBOL', async () => {
    const bad = await bundle.app.inject({
      method: 'POST', url: '/api/candidate/BADCODE/promote', headers: authHeaders(),
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('INVALID_SYMBOL');
  });

  it('迁移写 system_log（Requirements §5.1 永久留痕）', () => {
    const rows = bundle.db.db.prepare(
      `SELECT * FROM system_log WHERE log_type='trade' AND message LIKE ? ORDER BY id DESC LIMIT 1`
    ).all(`%${CODE}%`) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].message).toContain('迁移到 watch');
  });
});

describe('Positions · 现价 / 市值 enrich（T33）', () => {
  it('GET /api/positions 返回 totalQuantity + summary', async () => {
    bundle.db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, 'buy', '2025-08-01', '09:30:00', 200, 1500, 5, 0)`
    ).run(bundle.userId, CODE);

    const res = await bundle.app.inject({ method: 'GET', url: '/api/positions', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    const pos = body.data.find((p: any) => p.asset_code === CODE);
    expect(pos).toBeDefined();
    expect(pos.totalQuantity).toBe(200);
    expect(pos.avgCost).toBeCloseTo((200 * 1500 + 5) / 200, 4);

    // summary 结构完整（currentPrice 取决于 DuckDB 是否有行情，无行情时为 null）
    expect(body.summary).toBeDefined();
    expect(body.summary.positionCount).toBeGreaterThanOrEqual(1);
    expect(typeof body.summary.totalCostBasis).toBe('number');

    if (pos.currentPrice !== null) {
      expect(pos.marketValue).toBeCloseTo(pos.currentPrice * 200, 2);
      expect(typeof pos.unrealizedYield).toBe('number');
      expect(typeof pos.weight).toBe('number');
    } else {
      // DuckDB 无行情时降级：现价/市值 null，权重 null，不应崩
      expect(pos.marketValue).toBeNull();
      expect(pos.weight).toBeNull();
    }
  });

  it('无持仓用户 → data=[] 空数组不报错', async () => {
    const seed = await bundle.app.inject({
      method: 'POST', url: '/api/auth/seed',
      payload: { username: `pos_empty_${Date.now()}`, password: 'x1234567', role: 'user' },
    });
    expect(seed.statusCode).toBe(201);
    const token = JSON.parse(seed.body).data.token;

    const res = await bundle.app.inject({
      method: 'GET', url: '/api/positions', headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });
});