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
// T81：顶层写 env 必须留原值并在 afterAll 还原，否则会漏给下一个测试文件
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-position-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import {
  calcPosition,
  calcAllPositions,
  validateSufficientHolding,
  calcClosedTradePnLs,
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
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
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
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');

    const insert = db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    insert.run(uid, code, 'buy', '2025-01-01', '09:01:00', 100, 10.0, 1.0);
    insert.run(uid, code, 'buy', '2025-01-05', '09:02:00', 50, 12.0, 0.5);
    insert.run(uid, code, 'buy', '2025-01-10', '09:03:00', 200, 8.0, 2.0);

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(350);

    // 手动验证：成本基 = 100*10+1 + 50*12+0.5 + 200*8+2.0
    // = 1001 + 600.5 + 1602 = 3203.5
    const expectedCost = 100 * 10.0 + 1.0 + (50 * 12.0 + 0.5) + (200 * 8.0 + 2.0);
    expect(pos.totalCostBasis).toBeCloseTo(expectedCost, 4);
    expect(pos.avgCost).toBeCloseTo(expectedCost / 350, 6);
  });
});

describe('positionCalculator — validateSufficientHolding', () => {
  it('有持仓：持仓 100 验证卖 50 → true', () => {
    const uid = 1002;
    const code = 'sh601398';
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uid, code, 'buy', '2025-02-01', '09:30:00', 100, 5.0, 0);

    expect(validateSufficientHolding(uid, code, 50)).toBe(true);
  });

  it('超持仓：持仓 100 验证卖 200 → false', () => {
    const uid = 1003;
    const code = 'sz000001';
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(uid, code, 'buy', '2025-02-02', '09:30:00', 100, 10.0, 0);

    expect(validateSufficientHolding(uid, code, 200)).toBe(false);
  });
});

describe('positionCalculator — calcAllPositions', () => {
  it('多标的：返回数组 length=2', () => {
    const uid = 1004;
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    insert.run(uid, 'sh600519', 'buy', '2025-03-01', '09:04:00', 10, 1500.0, 5.0);
    insert.run(uid, 'sz300750', 'buy', '2025-03-02', '09:05:00', 20, 200.0, 1.0);

    const positions = calcAllPositions(uid);
    expect(positions.length).toBe(2);
    const codes = positions.map((p) => p.asset_code).sort();
    expect(codes).toEqual(['sh600519', 'sz300750']);
  });
});

describe('positionCalculator — calcClosedTradePnLs（T38 胜率/盈亏比数据源）', () => {
  it('无交易 → 返回空数组', () => {
    expect(calcClosedTradePnLs(999)).toEqual([]);
  });

  it('一买一卖：卖出 realized_pnl = 净收入 - 数量×移动加权均价', () => {
    const uid = 2001;
    const code = 'sh600000';
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    // 成本基 = 100*10 + 2 = 1002 → 均价 10.02
    insert.run(uid, code, 'buy', '2025-04-01', '09:06:00', 100, 10.0, 2.0);
    // 净收入 = 50*12 - 1 = 599；成本 = 50*10.02 = 501 → realized = 98
    insert.run(uid, code, 'reduce', '2025-04-10', '09:07:00', 50, 12.0, 1.0);

    const closed = calcClosedTradePnLs(uid);
    expect(closed.length).toBe(1);
    expect(closed[0].trade_type).toBe('reduce');
    expect(closed[0].quantity).toBe(50);
    expect(closed[0].realized_pnl).toBeCloseTo(98, 6);
  });

  it('多次加仓后卖出：按卖出时点的移动加权均价计成本', () => {
    const uid = 2002;
    const code = 'sz000002';
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    // 成本基 = 100*10 + 100*12 = 2200 → 均价 11
    insert.run(uid, code, 'buy', '2025-05-01', '09:08:00', 100, 10.0, 0);
    insert.run(uid, code, 'buy', '2025-05-02', '09:09:00', 100, 12.0, 0);
    // 全清：净收入 = 200*9 - 2 = 1798；成本 = 200*11 = 2200 → realized = -402
    insert.run(uid, code, 'clear', '2025-05-20', '09:10:00', 200, 9.0, 2.0);

    const closed = calcClosedTradePnLs(uid);
    expect(closed.length).toBe(1);
    expect(closed[0].realized_pnl).toBeCloseTo(-402, 6);
  });

  it('软删除的平仓记录不计入', () => {
    const uid = 2003;
    const code = 'sz000003';
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(uid, code, 'buy', '2025-06-01', '09:11:00', 100, 10.0, 0, 0);
    insert.run(uid, code, 'reduce', '2025-06-10', '09:12:00', 100, 11.0, 0, 1); // 已软删
    expect(calcClosedTradePnLs(uid)).toEqual([]);
  });

  it('除权类交易（dividend/bonus/transfer）不参与回放', () => {
    const uid = 2004;
    const code = 'sh601398';
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    insert.run(uid, code, 'buy', '2025-07-01', '09:13:00', 100, 10.0, 0);
    insert.run(uid, code, 'dividend', '2025-07-02', '09:14:00', 100, 0.5, 0);
    insert.run(uid, code, 'bonus', '2025-07-03', '09:15:00', 10, 0, 0);

    const closed = calcClosedTradePnLs(uid);
    expect(closed.length).toBe(0); // 只有买入，无平仓
  });
});
