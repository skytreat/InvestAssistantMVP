/**
 * T84 持仓充足性校验（P0-13）—— backend 时点回放
 *
 * 核心 bug：validateSufficientHolding 用 calcPosition 回放「全部已写入记录」，
 * 导致**尚未发生的买入**可以支撑**更早的卖出**（日期交错时绕过校验）。
 *
 * 修复：校验必须以「卖出交易发生时点」为界，只回放 trade_date <= asOf 的记录。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDbPath = path.join(os.tmpdir(), `invest-t84-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { calcPosition, validateSufficientHolding } from '../../src/services/positionCalculator.js';

let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(() => { db = ConfigStore.getInstance(); });

afterAll(() => {
  try { (db.db as any).close(); } catch { /* ignore */ }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function seed(uid: number, code: string) {
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  ).run(uid, `user_${uid}`, 'dummy-hash');
}

function ins(uid: number, code: string, type: string, date: string, qty: number, price = 10) {
  db.db.prepare(
    `INSERT INTO user_trade_record
     (user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(uid, code, type, date, qty, price);
}

describe('T84 时点回放：日期交错不能绕过校验', () => {
  it('原始 P0-13 场景：08-01 买100、10-16 买100，08-06 想卖 105 → 必须拒绝', () => {
    const uid = 8001, code = 'sh600000';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-08-01', 100);
    ins(uid, code, 'buy', '2026-10-16', 100);

    // 关键：卖出时点是 08-06，此时只有 08-01 的 100 股
    expect(validateSufficientHolding(uid, code, 105, '2026-08-06')).toBe(false);
    // 对照：不指定时点时全量回放得 200 —— 这正是原 bug 的表现
    expect(validateSufficientHolding(uid, code, 105)).toBe(true);
  });

  it('时点之后买入不能支撑之前的卖出，但能支撑之后的卖出', () => {
    const uid = 8002, code = 'sz000002';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-08-01', 100);
    ins(uid, code, 'buy', '2026-10-16', 100);

    expect(validateSufficientHolding(uid, code, 150, '2026-08-06')).toBe(false);
    expect(validateSufficientHolding(uid, code, 150, '2026-10-20')).toBe(true);
  });

  it('同日多笔：同日第二笔卖出应看到同日第一笔的扣减', () => {
    const uid = 8003, code = 'sh600519';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-09-01', 100);
    ins(uid, code, 'sell', '2026-09-10', 60);

    // 09-10 当天第一笔已卖 60，剩 40；第二笔卖 50 必须被拒
    expect(validateSufficientHolding(uid, code, 50, '2026-09-10')).toBe(false);
    expect(validateSufficientHolding(uid, code, 40, '2026-09-10')).toBe(true);
  });

  it('精确持平：买100 卖100 → 允许', () => {
    const uid = 8004, code = 'sh601398';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-07-01', 100);
    expect(validateSufficientHolding(uid, code, 100, '2026-07-10')).toBe(true);
  });

  it('边界：持仓100 卖 99 → 允许', () => {
    const uid = 8005, code = 'sz300750';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-07-01', 100);
    expect(validateSufficientHolding(uid, code, 99, '2026-07-10')).toBe(true);
  });

  it('边界：持仓100 卖 101 → 拒绝', () => {
    const uid = 8006, code = 'sz000001';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-07-01', 100);
    expect(validateSufficientHolding(uid, code, 101, '2026-07-10')).toBe(false);
  });

  it('非正数量 → 一律拒绝', () => {
    const uid = 8007, code = 'sh600036';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-07-01', 100);
    expect(validateSufficientHolding(uid, code, 0, '2026-07-10')).toBe(false);
    expect(validateSufficientHolding(uid, code, -5, '2026-07-10')).toBe(false);
  });

  it('不传时点（向后兼容）→ 沿用全量回放口径', () => {
    const uid = 8008, code = 'sh601988';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-01-01', 100);
    expect(validateSufficientHolding(uid, code, 100)).toBe(true);
    expect(validateSufficientHolding(uid, code, 101)).toBe(false);
  });
});

describe('T84 calcPosition：asOf 时点参数', () => {
  it('asOf 只回放该时点之前的记录', () => {
    const uid = 8009, code = 'sh600028';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-01-01', 100);
    ins(uid, code, 'buy', '2026-12-01', 100);

    expect(calcPosition(uid, code).totalQuantity).toBe(200);
    expect(calcPosition(uid, code, '2026-06-01').totalQuantity).toBe(100);
  });

  it('asOf 早于全部记录 → 持仓 0', () => {
    const uid = 8010, code = 'sh601857';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-05-01', 100);
    expect(calcPosition(uid, code, '2026-01-01').totalQuantity).toBe(0);
  });

  it('存量脏数据不使持仓页 500，但脏状态必须可见', () => {
    const uid = 8011, code = 'sh600000';
    seed(uid, code);
    ins(uid, code, 'buy', '2026-08-01', 100);
    ins(uid, code, 'sell', '2026-08-06', 150);  // 超卖 50 —— 存量脏数据

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(0);
    expect(pos.totalQuantity).toBeGreaterThanOrEqual(0);  // 绝不出现负持仓
    expect(pos.hasOversell).toBe(true);
    expect(pos.oversellDetail?.date).toBe('2026-08-06');
    expect(pos.oversellDetail?.shortfall).toBe(50);
  });
});