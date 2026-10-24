/**
 * positionPerf.test.ts — T60④ N+1 回归测试
 *
 * 验证 calcAllPositions 始终只做 1 次 DB 查询（不随持仓数线性增长）。
 * 旧实现：1 次 DISTINCT + N 次单标的查询 = N+1 次。
 * 新实现：1 次全量查询 + 内存分组 = 恒 1 次。
 *
 * 断言方式：spy on ConfigStore.db.prepare，统计调用次数。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-posperf-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { calcAllPositions } from '../../src/services/positionCalculator.js';

let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(() => {
  db = ConfigStore.getInstance();
});

afterAll(() => {
  try {
    (db.db as any).close();
  } catch {
    /* ignore */
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

/** 造 N 个持仓标的的交易记录（每个 1 笔买入）*/
function seedPositions(userId: number, assetCount: number): void {
  const ins = db.db.prepare(
    `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, quantity, price, fee, trade_date, trade_time)
     VALUES (?, ?, 'buy', 100, 10, 1, '2026-09-01', '09:30:00')`,
  );
  for (let i = 0; i < assetCount; i++) {
    ins.run(userId, `sh${String(600000 + i)}`);
  }
}

describe('positionPerf — calcAllPositions N+1 回归', () => {
  it('10 个持仓标的 → DB prepare 次数 ≤ 2（不随标的数增长）', () => {
    db.db
      .prepare(
        "INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES ('perf_user', 'x', 'user')",
      )
      .run();
    const uid = Number(db.db.prepare("SELECT id FROM user_account WHERE username = 'perf_user'").get()?.id);
    seedPositions(uid, 10);

    const prepareSpy = vi.spyOn(db.db, 'prepare');
    const result = calcAllPositions(uid);
    const prepareCalls = prepareSpy.mock.calls.length;
    prepareSpy.mockRestore();

    expect(result.length).toBe(10);
    // 旧实现：1（DISTINCT）+ 10（单标的）= 11 次 prepare
    // 新实现：1 次 prepare（全量查询）
    // 允许 ≤2 次（ConfigStore 内部可能有额外 prepare）
    expect(prepareCalls).toBeLessThanOrEqual(2);
  });

  it('50 个持仓标的 → DB prepare 次数仍 ≤ 2（不随标的数增长）', () => {
    db.db
      .prepare(
        "INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES ('perf_user2', 'x', 'user')",
      )
      .run();
    const uid = Number(db.db.prepare("SELECT id FROM user_account WHERE username = 'perf_user2'").get()?.id);
    seedPositions(uid, 50);

    const prepareSpy = vi.spyOn(db.db, 'prepare');
    const result = calcAllPositions(uid);
    const prepareCalls = prepareSpy.mock.calls.length;
    prepareSpy.mockRestore();

    expect(result.length).toBe(50);
    // 关键断言：50 个标的的查询次数与 10 个标的相同（恒 1 次）
    expect(prepareCalls).toBeLessThanOrEqual(2);
  });

  it('0 个持仓 → 返回空数组，不抛错', () => {
    db.db
      .prepare(
        "INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES ('perf_user3', 'x', 'user')",
      )
      .run();
    const uid = Number(db.db.prepare("SELECT id FROM user_account WHERE username = 'perf_user3'").get()?.id);

    const result = calcAllPositions(uid);
    expect(result).toEqual([]);
  });
});
