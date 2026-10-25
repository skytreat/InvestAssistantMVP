/**
 * t119-cost-semantic.test.ts — T119（V3.0）送股 / 现金分红成本语义：上层回归
 *
 * core 单测见 packages/core/tests/movingWeightedCost.v3.test.ts + golden B1-B5。
 * 本文件验证**上层映射与口径统一**（SDD_v3 §8.5）：
 *   ① mapToCoreTrade 把 dividend / bonus 映射进 core（不再忽略）
 *   ② calcClosedTradePnLs 回放含 bonus 摊薄
 *   ③ exDividendSync.getHoldingBeforeDate 与 core 口径一致（除权基数含送股）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-t119-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import {
  calcPosition,
  calcClosedTradePnLs,
} from '../../src/services/positionCalculator.js';
import { getHoldingBeforeDate } from '../../src/services/exDividendSync.js';

let store: ReturnType<typeof ConfigStore.getInstance>;

function seedUser(uid: number): void {
  store.db
    .prepare(`INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`)
    .run(uid, `user_${uid}`, 'dummy-hash');
}

function seedTrade(
  uid: number,
  code: string,
  tradeType: string,
  date: string,
  time: string,
  quantity: number,
  price: number,
  fee = 0,
): void {
  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(uid, code, tradeType, date, time, quantity, price, fee);
}

beforeAll(() => {
  store = ConfigStore.getInstance();
});

afterAll(() => {
  try {
    (store.db as unknown as { close(): void }).close();
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

describe('T119 · calcPosition 上层映射（mapToCoreTrade）', () => {
  it('送股进持仓：buy 100 + bonus 60 ⇒ 160 股、均价摊薄至 6.25（T119 前为 100 股/10 均价 —— 少 60 股的缺陷）', () => {
    const uid = 2001;
    const code = 'sh600519';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-03-01', '09:30:00', 100, 10, 0);
    seedTrade(uid, code, 'bonus', '2025-06-10', '00:00:00', 60, 0, 0);

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(160);
    expect(pos.avgCost).toBeCloseTo(6.25, 6); // 1000 / 160
    expect(pos.totalCostBasis).toBeCloseTo(1000, 4);
  });

  it('分红进 cashReceived（不进价差盈亏）：dividend 100 股 × 0.5 ⇒ 50', () => {
    const uid = 2002;
    const code = 'sh600000';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-03-01', '09:30:00', 100, 10, 0);
    seedTrade(uid, code, 'dividend', '2025-06-10', '00:00:00', 100, 0.5, 0);

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(100); // 分红不增股
    expect(pos.avgCost).toBeCloseTo(10, 6); // 分红不摊成本
    expect(pos.cashReceived).toBeCloseTo(50, 6);
    expect(pos.realizedPnL).toBe(0); // 分红不产生价差盈亏
  });

  it('同日先送股后分红（DB 里 dividend 行 id 小于 bonus 行也正确）：分红基数 = 送股后股数', () => {
    const uid = 2003;
    const code = 'sz000001';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-03-01', '09:30:00', 100, 10, 0);
    // 故意先插 dividend（id 更小）：core 的同日重排规则必须让送股先结算
    seedTrade(uid, code, 'dividend', '2025-06-10', '00:00:00', 160, 0.5, 0);
    seedTrade(uid, code, 'bonus', '2025-06-10', '00:00:00', 60, 0, 0);

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(160);
    expect(pos.cashReceived).toBeCloseTo(80, 6); // 160 × 0.5（若按送股前 100 股结算 = 50，防回退）
    expect(pos.cashReceived).not.toBeCloseTo(50, 6);
  });

  it('transfer 仍被忽略（转托管不改总持仓与成本）', () => {
    const uid = 2004;
    const code = 'sh601318';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-03-01', '09:30:00', 100, 20, 0);
    seedTrade(uid, code, 'transfer', '2025-04-01', '00:00:00', 100, 0, 0);

    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(100);
    expect(pos.avgCost).toBeCloseTo(20, 6);
    expect(pos.cashReceived).toBe(0);
  });
});

describe('T119 · calcClosedTradePnLs 含送股摊薄', () => {
  it('送股后卖出的价差盈亏按摊薄均价计：700（T119 前回放不计 bonus ⇒ 会算成 200）', () => {
    const uid = 2005;
    const code = 'sh688981';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-01-05', '09:30:00', 100, 10, 0);
    seedTrade(uid, code, 'bonus', '2025-06-10', '00:00:00', 100, 0, 0);
    seedTrade(uid, code, 'reduce', '2025-09-01', '14:00:00', 100, 12, 0);

    const pnls = calcClosedTradePnLs(uid);
    expect(pnls).toHaveLength(1);
    expect(pnls[0].realized_pnl).toBeCloseTo(700, 4); // 摊薄均价 5 ⇒ 1200 − 100×5
  });

  it('bonus 行本身不出现在平仓盈亏列表（只统计 sell/reduce/clear）', () => {
    const uid = 2006;
    const code = 'sz002594';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-01-05', '09:30:00', 100, 10, 0);
    seedTrade(uid, code, 'bonus', '2025-06-10', '00:00:00', 50, 0, 0);

    const pnls = calcClosedTradePnLs(uid);
    expect(pnls).toHaveLength(0);
    expect(pnls.some((p) => p.trade_type === 'bonus')).toBe(false);
  });
});

describe('T119 · exDividendSync 除权基数与 core 口径一致', () => {
  it('除权前持仓含历史送股（getHoldingBeforeDate = core 净股数）：100 + 60 = 160', () => {
    const uid = 2007;
    const code = 'sh600036';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-01-05', '09:30:00', 100, 10, 0);
    seedTrade(uid, code, 'bonus', '2025-06-10', '00:00:00', 60, 0, 0);
    seedTrade(uid, code, 'reduce', '2025-08-01', '14:00:00', 40, 11, 0);

    // 除权日 2025-09-01 前：100 + 60 − 40 = 120
    const holding = getHoldingBeforeDate(store.db, uid, code, '2025-09-01');
    expect(holding).toBe(120);
    // 与 core 回放净股数一致（口径统一的回归锚点）
    expect(calcPosition(uid, code).totalQuantity).toBe(holding);
  });

  it('除权日当日的 bonus/dividend 行不计入基数（严格 trade_date < exDate）', () => {
    const uid = 2008;
    const code = 'sh600030';
    seedUser(uid);
    seedTrade(uid, code, 'buy', '2025-01-05', '09:30:00', 100, 10, 0);
    seedTrade(uid, code, 'bonus', '2025-09-01', '00:00:00', 60, 0, 0); // 当日（本次要生成的）送股

    expect(getHoldingBeforeDate(store.db, uid, code, '2025-09-01')).toBe(100);
  });
});
