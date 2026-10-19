/**
 * T56 候选池批量接口 `POST /api/candidates/batch`
 *
 * 契约（T56 卡片）：
 *   - `{ asset_codes: string[] }`，单次上限 100
 *   - `db.transaction()` 包裹
 *   - `INSERT OR IGNORE` 幂等，重复项进 `duplicates` 不报错
 *   - 返回 `{ added, skipped, duplicates[] }`
 *   - 写 `system_log`
 *
 * 事务回滚的验证抓手（**已实测 SQLite 语义**）：
 *   `INSERT OR IGNORE` 的冲突算法只覆盖 UNIQUE / NOT NULL / CHECK，
 *   **不覆盖外键**（SQLite 官方文档明载 FK 违例不受 ON CONFLICT 影响）。
 *   故传入不存在的 `user_id` 会抛 FK 违例 → 整批回滚，可零歧义验证「全量回滚」。
 *   用例另断言 `PRAGMA foreign_keys = 1`，防止该前提被静默关掉而测试变空转。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../src/services/auth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-t56-'));
const tmpDbPath = path.join(tmpDir, 't56.db');
const prevSqlitePath = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = tmpDbPath;

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerBatchCandidateRoutes } = await import('../../src/routes/candidates.js');
const {
  MAX_BATCH_CANDIDATES,
  batchInsertCandidates,
} = await import('../../src/services/candidateService.js');

const TEST_UID = 5601;
const TEST_USERNAME = 't56_user';
const MISSING_UID = 999_999; // user_account 中不存在 → 触发 FK 违例
const USER_PAYLOAD: JwtPayload = {
  sub: TEST_UID, username: TEST_USERNAME, role: 'user',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
};

let app: FastifyInstance;
let store: InstanceType<typeof ConfigStore>;

function candidatesOf(uid: number): Array<{ asset_code: string; candidate_reason: string | null; is_deleted: number }> {
  return store.db
    .prepare(
      `SELECT asset_code, candidate_reason, is_deleted FROM user_asset_rel
        WHERE user_id = ? AND rel_type = 'candidate' ORDER BY asset_code`,
    )
    .all(uid) as Array<{ asset_code: string; candidate_reason: string | null; is_deleted: number }>;
}

function countFor(uid: number, codes: string[]): number {
  const ph = codes.map(() => '?').join(',');
  const r = store.db
    .prepare(`SELECT COUNT(*) AS c FROM user_asset_rel WHERE user_id = ? AND asset_code IN (${ph})`)
    .get(uid, ...codes) as { c: number };
  return r.c;
}

function codesOf(n: number, prefix = 'sh60'): string[] {
  // 造 n 个互异且合法的标的代码（sh600001..）
  return Array.from({ length: n }, (_, i) => `${prefix}${String(1000 + i).padStart(4, '0')}`);
}

async function batch(payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/candidates/batch', payload: payload as object });
}

beforeAll(async () => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  store = ConfigStore.getInstance();
  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(TEST_UID, TEST_USERNAME, 'dummy-hash');

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user?: JwtPayload }).user = USER_PAYLOAD;
  });
  await registerBatchCandidateRoutes(app);
});

afterAll(async () => {
  await app.close();
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (prevSqlitePath !== undefined) process.env.SQLITE_DB_PATH = prevSqlitePath;
  else delete process.env.SQLITE_DB_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ══════════════════ 参数校验 ══════════════════

describe('T56 参数校验', () => {
  it('asset_codes 缺失 / 非数组 → 400 PARAM_INVALID', async () => {
    for (const body of [{}, { asset_codes: 'sh600001' }, { asset_codes: null }, { asset_codes: { a: 1 } }]) {
      const res = await batch(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('PARAM_INVALID');
    }
  });

  it('asset_codes 空数组 → 400', async () => {
    const res = await batch({ asset_codes: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });

  it('含非法代码格式 → 400，且**不写入任何一条**（校验在事务之前）', async () => {
    const before = candidatesOf(TEST_UID).length;
    const res = await batch({ asset_codes: ['sh600777', 'NOT_A_SYMBOL', 'sz00001'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
    expect(String(res.json().message)).toContain('NOT_A_SYMBOL');
    expect(candidatesOf(TEST_UID).length).toBe(before);
    expect(countFor(TEST_UID, ['sh600777'])).toBe(0);
  });

  it('candidate_reason 非字符串 / 超长 → 400', async () => {
    const bad1 = await batch({ asset_codes: ['sh600778'], candidate_reason: 42 });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await batch({ asset_codes: ['sh600778'], candidate_reason: 'x'.repeat(1001) });
    expect(bad2.statusCode).toBe(400);
    expect(countFor(TEST_UID, ['sh600778'])).toBe(0);
  });

  it('恰好 100 条上限 → 201；101 条 → 400', async () => {
    const ok = await batch({ asset_codes: codesOf(MAX_BATCH_CANDIDATES) });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.added).toBe(MAX_BATCH_CANDIDATES);

    const tooMany = await batch({ asset_codes: [...codesOf(100), 'sh601999'] });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error).toBe('PARAM_INVALID');
    expect(String(tooMany.json().message)).toContain('100');
  });
});

// ══════════════════ 幂等 / duplicates ══════════════════

describe('T56 幂等：INSERT OR IGNORE + duplicates', () => {
  const seedCodes = ['sh600001', 'sh600002', 'sh600003'];

  it('首次批量 → added=N, skipped=0, duplicates=[]', async () => {
    store.db.prepare(`DELETE FROM user_asset_rel WHERE user_id = ?`).run(TEST_UID);
    const res = await batch({ asset_codes: seedCodes });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.added).toBe(3);
    expect(d.skipped).toBe(0);
    expect(d.duplicates).toEqual([]);
    expect(candidatesOf(TEST_UID).map((c) => c.asset_code)).toEqual(seedCodes);
  });

  it('重复项进 duplicates，**不报错**，已有记录不被覆盖', async () => {
    // T81：自带前置（先造两条已存在的候选），不依赖上一个用例跑过
    store.db
      .prepare(`DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code IN ('sh600001', 'sh600002')`)
      .run(TEST_UID);
    batchInsertCandidates(TEST_UID, ['sh600001', 'sh600002']);

    const res = await batch({ asset_codes: ['sh600001', 'sh600004', 'sh600002', 'sh600005'] });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.added).toBe(2);
    expect(d.skipped).toBe(2);
    expect(d.duplicates.sort()).toEqual(['sh600001', 'sh600002']);
  });

  it('完全相同的请求重复调用 → 第二次 added=0，全部进 duplicates', async () => {
    const first = await batch({ asset_codes: ['sh600010', 'sh600011'] });
    expect(first.json().data.added).toBe(2);
    const second = await batch({ asset_codes: ['sh600010', 'sh600011'] });
    expect(second.statusCode).toBe(201);
    expect(second.json().data).toEqual({ added: 0, skipped: 2, duplicates: ['sh600010', 'sh600011'] });
    expect(countFor(TEST_UID, ['sh600010', 'sh600011'])).toBe(2);
  });

  it('请求内自重复 → 只入池一条，重复项进 duplicates', async () => {
    const res = await batch({ asset_codes: ['sh600020', 'sh600020', 'sh600020'] });
    const d = res.json().data;
    expect(d.added).toBe(1);
    expect(d.skipped).toBe(2);
    expect(d.duplicates).toEqual(['sh600020', 'sh600020']);
    expect(countFor(TEST_UID, ['sh600020'])).toBe(1);
  });

  it('已软删的候选仍算已存在 → 进 duplicates（软删除 + 三列 UNIQUE 的必然结果）', async () => {
    batchInsertCandidates(TEST_UID, ['sh600030']);
    store.db
      .prepare(`UPDATE user_asset_rel SET is_deleted = 1 WHERE user_id = ? AND asset_code = 'sh600030'`)
      .run(TEST_UID);
    const res = await batch({ asset_codes: ['sh600030'] });
    const d = res.json().data;
    expect(d.added).toBe(0);
    expect(d.duplicates).toEqual(['sh600030']);
    // 确认没有物理删除，底行仍在
    const row = store.db
      .prepare(`SELECT is_deleted FROM user_asset_rel WHERE user_id = ? AND asset_code = 'sh600030'`)
      .get(TEST_UID) as { is_deleted: number };
    expect(row.is_deleted).toBe(1);
  });

  it('watch 关系不与 candidate 冲突（三列 UNIQUE 独立共存）', async () => {
    // T81：自带前置（先造一条 candidate 候选），不依赖上一个用例跑过
    store.db
      .prepare(`DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = 'sh600001'`)
      .run(TEST_UID);
    batchInsertCandidates(TEST_UID, ['sh600001']);
    store.db
      .prepare(
        `INSERT OR IGNORE INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, 'sh600001', 'watch')`,
      )
      .run(TEST_UID);
    const res = await batch({ asset_codes: ['sh600001'] });
    // 已是 candidate → 仍进 duplicates；watch 行的存在不影响候选池判定
    expect(res.json().data.added).toBe(0);
    const rows = store.db
      .prepare(`SELECT rel_type FROM user_asset_rel WHERE user_id = ? AND asset_code = 'sh600001' ORDER BY rel_type`)
      .all(TEST_UID) as Array<{ rel_type: string }>;
    expect(rows.map((r) => r.rel_type)).toEqual(['candidate', 'watch']);
  });

  it('candidate_reason 整批写入', async () => {
    await batch({ asset_codes: ['sh600040'], candidate_reason: '  批量选股  ' });
    const row = store.db
      .prepare(`SELECT candidate_reason FROM user_asset_rel WHERE user_id = ? AND asset_code = 'sh600040'`)
      .get(TEST_UID) as { candidate_reason: string | null };
    expect(row.candidate_reason).toBe('批量选股');
  });
});

// ══════════════════ 事务原子性 ══════════════════

describe('T56 事务：中途失败全量回滚', () => {
  it('前置：PRAGMA foreign_keys = ON（否则回滚用例空转）', () => {
    const r = store.db.pragma('foreign_keys', { simple: true }) as number;
    expect(r).toBe(1);
  });

  it('user_id 不存在 → 抛错，且该批 0 条落库（既有数据不受影响）', () => {
    const batchCodes = ['sh605001', 'sh605002', 'sh605003', 'sh605004', 'sh605005'];
    const beforeCount = countFor(TEST_UID, batchCodes);

    expect(() => batchInsertCandidates(MISSING_UID, batchCodes)).toThrow(/FOREIGN KEY/i);

    expect(countFor(MISSING_UID, batchCodes)).toBe(0);            // 失败批全回滚
    expect(countFor(TEST_UID, batchCodes)).toBe(beforeCount);      // 其他用户数据零影响
  });

  it('回滚后再用合法 user 重试 → 整批成功（证明回滚没有留下「半截」状态）', () => {
    // T81：自带独立代码段，不依赖同文件其它用例的执行顺序（打乱顺序后仍然自洽）
    const batchCodes = ['sh605011', 'sh605012', 'sh605013'];
    const r = batchInsertCandidates(TEST_UID, batchCodes);
    expect(r).toEqual({ added: 3, skipped: 0, duplicates: [] });
    expect(countFor(TEST_UID, batchCodes)).toBe(3);
  });

  it('混合场景：已存在 + 新增 同批提交，两类计数都正确（事务内逐条判定不互相污染）', () => {
    // T81：自带前置（先造两条已存在），不依赖上一个用例跑过
    const exist = ['sh605021', 'sh605022'];
    const fresh = ['sh605023', 'sh605024'];
    batchInsertCandidates(TEST_UID, exist);
    const r = batchInsertCandidates(TEST_UID, [exist[0], fresh[0], exist[1], fresh[1]]);
    expect(r).toEqual({ added: 2, skipped: 2, duplicates: [exist[0], exist[1]] });
    expect(countFor(TEST_UID, [...exist, ...fresh])).toBe(4);
  });
});

// ══════════════════ 性能 + 日志 ══════════════════

describe('T56 性能与 system_log', () => {
  it('100 条批量 < 200ms', async () => {
    const codes = codesOf(100, 'sh62');
    const t0 = performance.now();
    const res = await batch({ asset_codes: codes });
    const elapsed = performance.now() - t0;
    expect(res.statusCode).toBe(201);
    expect(res.json().data.added).toBe(100);
    expect(elapsed, `实际耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
  });

  it('成功批次写 system_log（log_type=trigger_manual，见文件头说明）', async () => {
    // T81：自带前置 —— 自己跑一批 100 条，再查日志，不依赖上一个用例跑过
    const codes = codesOf(100, 'sh63');
    const res = await batch({ asset_codes: codes });
    expect(res.statusCode).toBe(201);

    const logs = store.db
      .prepare(
        `SELECT log_type, level, message, detail FROM system_log
          WHERE log_type = 'trigger_manual' AND message LIKE '%候选池批量入池%'
          ORDER BY id DESC LIMIT 1`,
      )
      .get() as { log_type: string; level: string; message: string; detail: string } | undefined;
    expect(logs).toBeTruthy();
    expect(logs!.level).toBe('INFO');
    expect(logs!.message).toContain('批量入池');
    const detail = JSON.parse(logs!.detail) as { added: number; skipped: number; duplicates: string[] };
    expect(detail.added).toBe(100);
    expect(Array.isArray(detail.duplicates)).toBe(true);
  });
});