/**
 * F1 —— 信号分级（PRD_v3 §4.2「强 / 中 / 弱，默认只显示强」）
 *
 * 钉死的口径（用户裁决，不可改）：
 *   ① 定档 = **纯分数分位**：强 = 当日候选前 20%；中 = 20%–50%；弱 = 后 50%
 *   ② 候选不足 10 只 → 退化为**绝对分值兜底**
 *   ③ 有效期：强 3 / 中 2 / 弱 1 **个交易日**，写入 `expires_at`
 *   ④ `GET /api/signal?grade=...`：强/中/弱 tab 排除已过期；`expired` 只看 `expires_at < 今天`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-f1-grade-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import { assignSignalGrades, gradeSignalStrengths } from '../../src/services/signalService.js';
import { getTradeDate } from '../../src/services/signalService.js';
import type { JwtPayload } from '../../src/services/auth.js';

const TEST_USER_ID = 8821;
const OTHER_USER_ID = 8822;
/** 2026-11-06 是周五 → 纯工作日兜底下：+1=11-09(一) / +2=11-10(二) / +3=11-11(三) */
const FRIDAY = '2026-11-06';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

function insertSignal(
  userId: number,
  code: string,
  strength: number | null,
  opts: { grade?: 'strong' | 'medium' | 'weak' | null; expiresAt?: string | null } = {},
): number {
  return Number(
    db.db
      .prepare(
        `INSERT INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label,
            strength, grade, expires_at, metrics_json, is_final)
         VALUES (?, ?, 'p1', 'monitor', ?, 'buy', 'L', ?, ?, ?, '{}', 1)`,
      )
      .run(userId, code, FRIDAY, strength, opts.grade ?? null, opts.expiresAt ?? null).lastInsertRowid,
  );
}

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(TEST_USER_ID, 'f1_grade_user');
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(OTHER_USER_ID, 'f1_grade_other');

  app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = { sub: TEST_USER_ID, username: 'f1_grade_user' } as JwtPayload;
  });
  await registerSignalRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (db) db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id IN (?, ?)').run(TEST_USER_ID, OTHER_USER_ID);
  try {
    fs.rmSync(tmpDbPath, { force: true });
    fs.rmSync(`${tmpDbPath}-wal`, { force: true });
    fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  } catch {
    // ignore
  }
  if (ORIGINAL_SQLITE_DB_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
});

describe('F1 · 纯分数分位定档', () => {
  it('10 只候选 → 前 2 强 / 3 中 / 5 弱（20% / 20-50% / 后 50%）', () => {
    const grades = gradeSignalStrengths([1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
    expect(grades.filter((g) => g === 'strong')).toHaveLength(2);
    expect(grades.filter((g) => g === 'medium')).toHaveLength(3);
    expect(grades.filter((g) => g === 'weak')).toHaveLength(5);
    // 分位是「按排名」，不是按分值本身
    expect(grades.slice(0, 2)).toEqual(['strong', 'strong']);
    expect(grades.slice(2, 5)).toEqual(['medium', 'medium', 'medium']);
    expect(grades.slice(5)).toEqual(['weak', 'weak', 'weak', 'weak', 'weak']);
  });

  it('20 只候选 → 前 4 强 / 6 中 / 10 弱', () => {
    const grades = gradeSignalStrengths(Array.from({ length: 20 }, (_, i) => 1 - i / 20));
    expect(grades.filter((g) => g === 'strong')).toHaveLength(4);
    expect(grades.filter((g) => g === 'medium')).toHaveLength(6);
    expect(grades.filter((g) => g === 'weak')).toHaveLength(10);
  });

  it('不足 10 只 → 绝对分值兜底（≥0.6 强 / ≥0.3 中 / 其余弱）', () => {
    expect(gradeSignalStrengths([0.95, 0.6, 0.59, 0.3, 0.29])).toEqual([
      'strong',
      'strong',
      'medium',
      'medium',
      'weak',
    ]);
  });

  it('空集合 → 空数组', () => {
    expect(gradeSignalStrengths([])).toEqual([]);
  });
});

describe('F1 · assignSignalGrades 回填 grade / expires_at', () => {
  it('10 只信号按分位定档，并按 强3 / 中2 / 弱1 个交易日写 expires_at', async () => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
    const ids = Array.from({ length: 10 }, (_, i) =>
      insertSignal(TEST_USER_ID, `sh60${(1000 + i).toString()}`, 1 - i / 10),
    );

    const result = await assignSignalGrades(FRIDAY, TEST_USER_ID);
    expect(result).toMatchObject({ graded: 10, strong: 2, medium: 3, weak: 5 });

    const rows = db.db
      .prepare(
        'SELECT id, strength, grade, expires_at FROM user_strategy_signal WHERE user_id = ? ORDER BY strength DESC, id ASC',
      )
      .all(TEST_USER_ID) as Array<{ id: number; strength: number; grade: string; expires_at: string }>;

    expect(rows[0].grade).toBe('strong');
    expect(rows[1].grade).toBe('strong');
    expect(rows[2].grade).toBe('medium');
    expect(rows[9].grade).toBe('weak');

    // 有效期口径：强 +3 交易日 / 中 +2 / 弱 +1（均为 2026-11 的正常工作日）
    expect(rows[0].expires_at).toBe('2026-11-11');
    expect(rows[1].expires_at).toBe('2026-11-11');
    expect(rows[2].expires_at).toBe('2026-11-10');
    expect(rows[9].expires_at).toBe('2026-11-09');

    // 幂等：重复调用结果不变
    await assignSignalGrades(FRIDAY, TEST_USER_ID);
    const again = db.db
      .prepare('SELECT id, grade, expires_at FROM user_strategy_signal WHERE user_id = ? ORDER BY id ASC')
      .all(TEST_USER_ID);
    expect(again).toEqual(
      rows.map((r) => ({ id: r.id, grade: r.grade, expires_at: r.expires_at })).sort((a, b) => a.id - b.id),
    );
    expect(ids).toHaveLength(10);
  });

  it('无 strength 的行保持 grade = NULL（未分级）', async () => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
    insertSignal(TEST_USER_ID, 'sh600001', null);
    insertSignal(TEST_USER_ID, 'sh600002', 0.5);
    await assignSignalGrades(FRIDAY, TEST_USER_ID);
    const rows = db.db
      .prepare('SELECT asset_code, grade FROM user_strategy_signal WHERE user_id = ? ORDER BY asset_code')
      .all(TEST_USER_ID) as Array<{ asset_code: string; grade: string | null }>;
    expect(rows).toEqual([
      { asset_code: 'sh600001', grade: null },
      { asset_code: 'sh600002', grade: 'medium' }, // 不足 10 只 → 绝对兜底：0.5 ∈ [0.3, 0.6)
    ]);
  });
});

describe('F1 · GET /api/signal?grade=...', () => {
  const today = getTradeDate();

  beforeAll(() => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
    insertSignal(TEST_USER_ID, 'sh600100', 0.9, { grade: 'strong', expiresAt: today });
    insertSignal(TEST_USER_ID, 'sh600101', 0.8, { grade: 'strong', expiresAt: '2020-01-01' }); // 已过期
    insertSignal(TEST_USER_ID, 'sh600102', 0.5, { grade: 'medium', expiresAt: today });
    insertSignal(TEST_USER_ID, 'sh600103', 0.2, { grade: 'weak', expiresAt: today });
  });

  const codesOf = async (grade: string): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url: `/api/signal?grade=${grade}&trade_date=${FRIDAY}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ asset_code: string }> };
    return body.data.map((r) => r.asset_code);
  };

  it('强档只返回未过期的强信号', async () => {
    expect(await codesOf('strong')).toEqual(['sh600100']);
  });

  it('中 / 弱档各自返回', async () => {
    expect(await codesOf('medium')).toEqual(['sh600102']);
    expect(await codesOf('weak')).toEqual(['sh600103']);
  });

  it('expired 只返回 expires_at < 今天 的行', async () => {
    expect(await codesOf('expired')).toEqual(['sh600101']);
  });

  it('非法 grade → 400 PARAM_INVALID', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signal?grade=foo' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('PARAM_INVALID');
  });
});
