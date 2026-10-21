/**
 * watchPromote.test.ts — 候选池 → 自选迁移（G4）+ 持仓 enrich 接口
 *
 * 🔴 T92：候选迁移语义已改为「**只打标记，不建关联**」
 *   （PRD S5：「MVP 迁移候选到自选**只打标记**，不会自动创建自选关联（用户需手动从候选池加入自选）」
 *    / SDD §12.3 B6 同）。
 *   本文件原先断言的是**旧行为**（「promote 后 watch 出现」）→ 已按 T92 验收点⑥改写。
 *
 * 覆盖：
 *   - POST /api/candidate/:asset/promote 首次迁移 → **watch 不出现**、候选行被标记
 *   - 幂等：重复 promote 不报错，标记保持
 *   - price_mode 必填且白名单（base / current）
 *   - 非法 symbol → 400 PARAM_INVALID
 *   - 迁移写 system_log（log_type='candidate_migrate'，**不再是 'trade'**）
 *   - GET /api/holding 返回 totalQuantity / marketValue 等 enrich 字段
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

/**
 * 🔴 2026-10-19 CI 教训：CI 环境只有 12KB 空壳行情库（无 `v_stock_qfq` 等表）。
 *   `POST /api/candidate` 需**查行情库**来固化基准价（T50 语义）→ 无库时返回 503。
 *   → 依赖真实行情库的用例在 CI 无库时跳过。
 */
import { marketDataUsableFor } from '../_marketData.js';

/** 真实行情库是否可用（顶层 await 判定一次） */
// 🔴 2026-10-21 **两层开关**：本文件用例全是**数值型**断言（价格 / 昨收 / 落库口径），
//    迷你库（真库的逐位一致子集）即可满足 → 用 `numeric` 能力守卫。
const MARKET_DATA_AVAILABLE = await marketDataUsableFor('numeric');

let bundle: TestAppBundle;
const CODE = 'sh600519';

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

beforeAll(async () => {
  bundle = await createTestApp();
  bundle.db.db
    .prepare('DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = ?')
    .run(bundle.userId, CODE);
  bundle.db.db
    .prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?')
    .run(bundle.userId, CODE);
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('Watch · 候选迁移到自选（G4 / T92：只打标记不建关联）', () => {
  // 依赖真实行情库（POST /api/candidate 需查行情固化基准价）→ CI 无库时跳过
  const itReal = MARKET_DATA_AVAILABLE ? it : it.skip;
  const promote = (asset: string, body: Record<string, unknown> = { price_mode: 'base' }) =>
    bundle.app.inject({
      method: 'POST',
      url: `/api/candidate/${asset}/migrate`,
      headers: authHeaders(),
      payload: body,
    });

  /**
   * 每个用例用**独立标的**并自建候选 —— T81 的 `sequence.shuffle` 会打乱用例顺序，
   * 共用一个标的会导致「后置用例找不到前置用例建的候选」（实测 404）。
   */
  const seedCandidate = async (asset: string) => {
    const cand = await bundle.app.inject({
      method: 'POST',
      url: '/api/candidate',
      headers: authHeaders(),
      payload: { asset_code: asset },
    });
    expect(cand.statusCode).toBe(201);
    return asset;
  };

  itReal('先加候选，再 promote → **watch 不出现**、candidate 仍在且被标记', async () => {
    await seedCandidate(CODE);

    const promo = await promote(CODE);
    expect(promo.statusCode).toBe(200);
    const body = JSON.parse(promo.body);
    expect(body.code).toBe(0);
    expect(body.data.from).toBe('candidate');
    expect(body.data.to).toBe('watch');
    // T92 验收点⑤：响应体含 autoCreated:false 与中文提示
    expect(body.data.marked).toBe(true);
    expect(body.data.autoCreated).toBe(false);
    expect(body.data.message).toContain('不会自动加入自选');

    // 🔴 T92 验收点①（**反向断言** —— 与旧行为相反）：promote 后 watch 关联**不存在**
    const watch = await bundle.app.inject({ method: 'GET', url: '/api/watch', headers: authHeaders() });
    expect(
      JSON.parse(watch.body).data.some((r: any) => r.asset_code === CODE),
      'PRD S5：迁移只打标记，不自动创建自选关联',
    ).toBe(false);

    // 三列独立共存：candidate 记录不被删，且被标记
    const cands = await bundle.app.inject({ method: 'GET', url: '/api/candidate', headers: authHeaders() });
    const candRows = JSON.parse(cands.body).data as any[];
    expect(candRows.some((r: any) => r.asset_code === CODE)).toBe(true);
    // T92 验收点②：来源 candidate 行 migrated_from_candidate=1
    const row = candRows.find((r: any) => r.asset_code === CODE);
    expect(Number(row.migrated_from_candidate)).toBe(1);
    expect(row.migrated_price_mode).toBe('base');
  });

  itReal('重复 promote 幂等 → 不报错、标记保持、watch 仍不出现', async () => {
    const OWN = 'sh600520';
    await seedCandidate(OWN);

    const first = await promote(OWN);
    expect(first.statusCode).toBe(200);

    const again = await promote(OWN);
    expect(again.statusCode).toBe(200);
    const data = JSON.parse(again.body).data;
    expect(data.marked).toBe(true);
    expect(data.autoCreated).toBe(false);

    const watch = await bundle.app.inject({ method: 'GET', url: '/api/watch', headers: authHeaders() });
    expect(JSON.parse(watch.body).data.some((r: any) => r.asset_code === OWN)).toBe(false);
  });

  itReal('price_mode 缺失 / 非法 → 400 PARAM_INVALID', async () => {
    const OWN = 'sh600521';
    await seedCandidate(OWN);
    const missing = await promote(OWN, {});
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error).toBe('PARAM_INVALID');

    const bad = await promote(OWN, { price_mode: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('PARAM_INVALID');
  });

  itReal('非法 symbol → 400 PARAM_INVALID', async () => {
    const bad = await bundle.app.inject({
      method: 'POST',
      url: '/api/candidate/BADCODE/migrate',
      headers: authHeaders(),
      payload: { price_mode: 'base' },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('PARAM_INVALID');
  });

  itReal('迁移写 system_log（log_type=candidate_migrate，**不再是 trade**）', async () => {
    const OWN = 'sh600522';
    await seedCandidate(OWN);
    await promote(OWN);

    const rows = bundle.db.db
      .prepare(
        `SELECT * FROM system_log WHERE log_type='candidate_migrate' AND message LIKE ? ORDER BY id DESC LIMIT 1`,
      )
      .all(`%${OWN}%`) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].message).toContain('迁移到 watch');
    // 旧实现误用 log_type='trade'（这不是交易）—— 断言不再落到 trade 上
    const tradeRows = bundle.db.db
      .prepare(`SELECT count(*) AS c FROM system_log WHERE log_type='trade' AND message LIKE ?`)
      .get(`%${OWN}%`) as { c: number };
    expect(Number(tradeRows.c), '候选迁移不应记为 trade').toBe(0);
  });
});

describe('Positions · 现价 / 市值 enrich（T33）', () => {
  it('GET /api/holding 返回 totalQuantity + summary', async () => {
    bundle.db.db
      .prepare(
        `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, 'buy', '2025-08-01', '09:30:00', 200, 1500, 5, 0)`,
      )
      .run(bundle.userId, CODE);

    const res = await bundle.app.inject({ method: 'GET', url: '/api/holding', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);

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
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: `pos_empty_${Date.now()}`, password: 'x1234567', role: 'user' },
    });
    expect(seed.statusCode).toBe(201);
    const token = JSON.parse(seed.body).data.token;

    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/holding',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });
});
