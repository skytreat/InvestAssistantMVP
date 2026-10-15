/**
 * positionCalculator.test.ts — Phase 3 SDD §12.3 单元测试
 *
 * 覆盖 src/services/positionCalculator.ts：
 *   calcPosition / validateSufficientHolding / calcAllPositions
 *
 * 依赖 ConfigStore 单例，测试前用临时 SQLite 文件，测试后删除
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- 关键：在 import src 之前设置 SQLITE_DB_PATH，确保 ConfigStore 构造时用临时库 ---
const tmpDbPath = path.join(os.tmpdir(), `invest-position-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import {
  calcPosition,
  calcAllPositions,
  validateSufficientHolding,
} from '../../src/services/positionCalculator.js';

let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(() => {
  db = ConfigStore.getInstance();
});

afterAll(() => {
  // 关闭连接并删除临时文件
  // ConfigStore 没暴露 close()，但 better-sqlite3 的 Database 实例有 close
  try {
    (db.db as any).close();
  } catch {
    // ignore
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

describe('positionCalculator — calcPosition', () => {
  it('空表：user_id=999 无交易记录 → totalQuantity=0, avgCost=0', () => {
    const pos = calcPosition(999, 'sh600000');
    expect(pos.totalQuantity).toBe(0);
    expect(pos.avgCost).toBe(0);
    expect(pos.totalCostBasis).toBe(0);
  });

  it('有交易：3 条 buy 记录返回正确 avgCost', () => {
    const uid = 1001;
    const code = 'sh600000';
    // 按 trade_date ASC 插入
    db.db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
    ).run(uid, `user_${uid}`, 'dummy-hash');

    const insert = db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    );
    insert.run(uid, code, 'buy', '2025-01-01', 100, 10.0, 1.0);
    insert.run(uid, code, 'buy', '2025-01-05', 50, 12.0, 0.5);
    insert.run(uid, code, 'buy', '2025-01-10', 200, 8.0, 2.0);

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(350);

    // 手动验证：成本基 = 100*10+1 + 50*12+0.5 + 200*8+2.0
    // = 1001 + 600.5 + 1602 = 3203.5
    const expectedCost = (100 * 10.0 + 1.0) + (50 * 12.0 + 0.5) + (200 * 8.0 + 2.0);
    expect(pos.totalCostBasis).toBeCloseTo(expectedCost, 4);
    expect(pos.avgCost).toBeCloseTo(expectedCost / 350, 6);
  });
});

describe('positionCalculator — validateSufficientHolding', () => {
  it('有持仓：持仓 100 验证卖 50 → true', () => {
    const uid = 1002;
    const code = 'sh601398';
    db.db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
    ).run(uid, `user_${uid}`, 'dummy-hash');
    db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(uid, code, 'buy', '2025-02-01', 100, 5.0, 0);

    expect(validateSufficientHolding(uid, code, 50)).toBe(true);
  });

  it('超持仓：持仓 100 验证卖 200 → false', () => {
    const uid = 1003;
    const code = 'sz000001';
    db.db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
    ).run(uid, `user_${uid}`, 'dummy-hash');
    db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(uid, code, 'buy', '2025-02-02', 100, 10.0, 0);

    expect(validateSufficientHolding(uid, code, 200)).toBe(false);
  });
});

describe('positionCalculator — calcAllPositions', () => {
  it('多标的：返回数组 length=2', () => {
    const uid = 1004;
    db.db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
    ).run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    );
    insert.run(uid, 'sh600519', 'buy', '2025-03-01', 10, 1500.0, 5.0);
    insert.run(uid, 'sz300750', 'buy', '2025-03-02', 20, 200.0, 1.0);

    const positions = calcAllPositions(uid);
    expect(positions.length).toBe(2);
    const codes = positions.map(p => p.asset_code).sort();
    expect(codes).toEqual(['sh600519', 'sz300750']);
  });
});
