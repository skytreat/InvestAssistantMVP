import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-v33pr-'));
const ORIG = process.env.SQLITE_DB_PATH;
const { ConfigStore } = await import('../../src/config/configStore.js');
const { computePortfolioReturn } = await import('../../src/services/portfolioReturn.js');

function fresh(tag: string) {
  ConfigStore.resetInstance();
  process.env.SQLITE_DB_PATH = path.join(TMP_DIR, `${tag}.db`);
  const store = ConfigStore.getInstance();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (1,'t33user','x','user')",
    )
    .run();
  return store;
}

afterAll(() => {
  if (ORIG) process.env.SQLITE_DB_PATH = ORIG;
  // Windows 下 SQLite 句柄未释放会让 rmSync 报 EPERM ⇒ 先关连接
  ConfigStore.resetInstance();
  rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('T132 三口径收益率 computePortfolioReturn', () => {
  it('空持仓 → 三口径全零、可加性成立、caliberNote 存在', async () => {
    fresh('empty');
    const r = await computePortfolioReturn(1);
    expect(r.risk.pnl).toBe(0);
    expect(r.cash.pnl).toBe(0);
    expect(r.total.pnl).toBe(0);
    expect(typeof r.caliberNote).toBe('string');
    expect(r.total.pnl).toBeCloseTo(r.risk.pnl + r.cash.pnl - r.total.fees, 2);
  });

  it('含一笔风险买入 → invested>0、rate 为数字', async () => {
    const store = fresh('one');
    store.db
      .prepare(
        `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee)
         VALUES (1,'sh600000','buy','2026-09-01','09:30:00',100,10,5)`,
      )
      .run();
    const r = await computePortfolioReturn(1);
    expect(r.risk.cost).toBe(1005);
    expect(typeof r.risk.rate).toBe('number');
    expect(r.total.invested).toBe(1005);
  });

  /**
   * 2026-11-06（J3 费用口径）—— risk.fees 不再恒为 0：
   * 它只统计「未平仓风险持仓成本内仍携带的买入手续费」，
   * 与 total.fees（全部交易费用）的关系：total.fees = risk.fees + 已随平仓结转部分。
   */
  describe('risk.fees 费用归属', () => {
    function insert(
      store: ReturnType<typeof fresh>,
      tradeType: string,
      date: string,
      quantity: number,
      price: number,
      fee: number,
    ) {
      store.db
        .prepare(
          `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee)
           VALUES (1,'sh600000',?,?, '09:30:00',?,?,?)`,
        )
        .run(tradeType, date, quantity, price, fee);
    }

    it('全部未平仓 → risk.fees = 买入手续费，total.fees 与之一致', async () => {
      const store = fresh('fee-open');
      insert(store, 'buy', '2026-09-01', 100, 10, 6);
      const r = await computePortfolioReturn(1);
      expect(r.risk.fees).toBe(6);
      expect(r.total.fees).toBe(6);
      expect(r.risk.cost).toBe(1006); // 费用仍嵌入成本基
    });

    it('部分卖出 → risk.fees 按剩余比例释放，差额为已结转部分', async () => {
      const store = fresh('fee-partial');
      insert(store, 'buy', '2026-09-01', 100, 10, 6);
      insert(store, 'reduce', '2026-09-02', 50, 12, 2);
      const r = await computePortfolioReturn(1);
      expect(r.risk.fees).toBe(3); // 6 × 50/100
      expect(r.total.fees).toBe(8); // 含卖出手续费
      // 可解释性：total.fees = risk.fees + 已随平仓结转（含卖出费用）
      expect(r.total.fees - r.risk.fees).toBe(5);
      expect(r.risk.cost).toBe(503);
    });

    it('全部平仓 → risk.fees 归零，费用全部随平仓结转', async () => {
      const store = fresh('fee-clear');
      insert(store, 'buy', '2026-09-01', 100, 10, 6);
      insert(store, 'clear', '2026-09-02', 100, 11, 2);
      const r = await computePortfolioReturn(1);
      expect(r.risk.fees).toBe(0);
      expect(r.total.fees).toBe(8);
      expect(r.risk.cost).toBe(0);
    });

    it('可加性断言不因 risk.fees 改动而破坏', async () => {
      const store = fresh('fee-additive');
      insert(store, 'buy', '2026-09-01', 100, 10, 6);
      insert(store, 'reduce', '2026-09-02', 50, 12, 2);
      const r = await computePortfolioReturn(1);
      expect(r.total.pnl).toBeCloseTo(r.risk.pnl + r.cash.pnl - r.total.fees, 2);
    });
  });
});
