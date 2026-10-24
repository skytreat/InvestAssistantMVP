/**
 * candidateRemove.test.ts —— T74 · 候选池「移除候选」端点 + 候选列表字段补齐
 *
 * 🔴 **为什么需要这个文件**（实测结论，2026-10-21）
 *
 * gap-list F-G3 记的是「后端 `GET /api/candidate`、`GET /api/watch`、`DELETE /:asset` 全是死路由」。
 * 实测（`app.printRoutes()` + `app.inject()`）后**该结论已过期**：
 *
 * | 端点 | 实测 | 结论 |
 * |---|---|---|
 * | `GET /api/candidate` | 200，返回 envelope | **活的**（T92 已注册）|
 * | `GET /api/watch` | 200，返回 envelope | **活的** |
 * | `DELETE /api/watch/:asset_code` | 路由存在（业务 404 = 无该行）| **活的** |
 * | `DELETE /api/candidate/:asset_code` | **404 路由不存在** | 🔴 **真的缺** —— T92 收敛路由时丢失 |
 *
 * ⇒ T74 卡片要求的「【移除】软删」需要一个**此前不存在**的端点 → 本文件锁住它。
 *
 * 覆盖：
 *   - DELETE /api/candidate/:asset → 200，**软删**（`is_deleted=1`，行还在库里）
 *   - 移除候选**不影响**同标的的 `watch` 关联（`UNIQUE(user_id, asset_code, rel_type)` 三列独立共存）
 *   - 移除不存在的候选 → 404 `NOT_FOUND`
 *   - 非法 asset_code → 400 `PARAM_INVALID`
 *   - `GET /api/candidate` 补齐 `name` / `tracked_days` / `signal`（SDD §4.4:1426 契约字段）
 *
 * ⚠️ **不依赖行情库**：候选行用**直接 INSERT** 造（而不是 `POST /api/candidate`），
 *   后者要查 DuckDB 固化基准价 → CI 无行情库时会 503（见 `watchPromote.test.ts` 的同款说明）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;

/** 用例自用的候选标的（与其它测试文件错开，避免共用标的带来的顺序依赖）*/
const CANDIDATE_CODE = 'sh600036';
const WATCH_CODE = 'sh600037';

function authHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

/** 直接造一条候选行（不查行情库）*/
function seedCandidate(assetCode: string): void {
  bundle.db.db
    .prepare(
      `INSERT OR REPLACE INTO user_asset_rel
         (user_id, asset_code, rel_type, candidate_reason, candidate_base_price, is_deleted)
       VALUES (?, ?, 'candidate', '测试用候选', 10.0, 0)`,
    )
    .run(bundle.userId, assetCode);
}

/** 直接造一条自选行（不查行情库）*/
function seedWatch(assetCode: string): void {
  bundle.db.db
    .prepare(
      `INSERT OR REPLACE INTO user_asset_rel (user_id, asset_code, rel_type, is_deleted)
       VALUES (?, ?, 'watch', 0)`,
    )
    .run(bundle.userId, assetCode);
}

function rowOf(assetCode: string, relType: string) {
  return bundle.db.db
    .prepare(
      `SELECT id, asset_code, rel_type, is_deleted FROM user_asset_rel
        WHERE user_id = ? AND asset_code = ? AND rel_type = ?`,
    )
    .get(bundle.userId, assetCode, relType) as
    { id: number; asset_code: string; rel_type: string; is_deleted: number } | undefined;
}

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

beforeEach(() => {
  bundle.db.db
    .prepare(`DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code IN (?, ?)`)
    .run(bundle.userId, CANDIDATE_CODE, WATCH_CODE);
});

describe('T74 · DELETE /api/candidate/:asset_code —— 移除候选（软删）', () => {
  it('移除候选 → 200，列表不再返回该标的，且数据库里是**软删**（行还在）', async () => {
    seedCandidate(CANDIDATE_CODE);

    const res = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/candidate/${CANDIDATE_CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);

    // 列表不再返回
    const list = await bundle.app.inject({
      method: 'GET',
      url: '/api/candidate',
      headers: authHeaders(),
    });
    const items = JSON.parse(list.body).data as Array<{ asset_code: string }>;
    expect(items.some((i) => i.asset_code === CANDIDATE_CODE)).toBe(false);

    // 🔴 **软删**（AGENTS.md：禁止物理删除）—— 行还在，只是 is_deleted=1
    const row = rowOf(CANDIDATE_CODE, 'candidate');
    expect(row).toBeDefined();
    expect(Number(row?.is_deleted)).toBe(1);
  });

  it('移除候选**不影响**同标的的 watch 关联（三列独立共存）', async () => {
    seedCandidate(CANDIDATE_CODE);
    seedWatch(CANDIDATE_CODE);

    const res = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/candidate/${CANDIDATE_CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);

    // watch 行**不受影响**（仍是未删除状态）
    const watchRow = rowOf(CANDIDATE_CODE, 'watch');
    expect(watchRow).toBeDefined();
    expect(Number(watchRow?.is_deleted)).toBe(0);

    // 自选列表里仍然能看到
    const watchList = await bundle.app.inject({
      method: 'GET',
      url: '/api/watch',
      headers: authHeaders(),
    });
    const watchItems = JSON.parse(watchList.body).data as Array<{ asset_code: string }>;
    expect(watchItems.some((i) => i.asset_code === CANDIDATE_CODE)).toBe(true);
  });

  it('移除不存在的候选 → 404 NOT_FOUND', async () => {
    const res = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/candidate/${WATCH_CODE}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND');
  });

  it('非法 asset_code → 400 PARAM_INVALID（且不误删 watch 行）', async () => {
    seedWatch(WATCH_CODE);
    const res = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/candidate/NOT_A_CODE',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('PARAM_INVALID');
    expect(Number(rowOf(WATCH_CODE, 'watch')?.is_deleted)).toBe(0);
  });

  it('未带 token → 401（鉴权钩子拦住）', async () => {
    const res = await bundle.app.inject({ method: 'DELETE', url: `/api/candidate/${CANDIDATE_CODE}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('T74 · GET /api/candidate —— 列表字段补齐（name / tracked_days / signal）', () => {
  it('每条候选都带 name / tracked_days / signal 三个字段（缺失时为 null，不得 500）', async () => {
    seedCandidate(CANDIDATE_CODE);

    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/candidate',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);

    const items = JSON.parse(res.body).data as Array<Record<string, unknown>>;
    const mine = items.filter((i) => i.asset_code === CANDIDATE_CODE);
    expect(mine.length).toBe(1);
    const row = mine[0];

    // 既有字段一个都不能少（T50 的契约）
    expect(row).toHaveProperty('candidate_base_price');
    expect(row).toHaveProperty('current_close');
    expect(row).toHaveProperty('relative_return');
    expect(row).toHaveProperty('base_price_date');

    // T74 补的三个字段
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('tracked_days');
    expect(row).toHaveProperty('signal');
    // 跟踪天数 = 加入日 → 今天（今天加入 = 0 天），且不得为负
    expect(typeof row.tracked_days).toBe('number');
    expect(row.tracked_days as number).toBeGreaterThanOrEqual(0);
    expect(row.tracked_days as number).toBeLessThanOrEqual(1);
  });

  it('没有信号的候选 → signal = null（不是缺字段）', async () => {
    seedCandidate(WATCH_CODE);
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/candidate',
      headers: authHeaders(),
    });
    const items = JSON.parse(res.body).data as Array<Record<string, unknown>>;
    const row = items.find((i) => i.asset_code === WATCH_CODE);
    expect(row).toBeDefined();
    expect(row?.signal).toBeNull();
  });
});
