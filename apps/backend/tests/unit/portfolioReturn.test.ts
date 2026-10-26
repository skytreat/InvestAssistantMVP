import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-v33pr-'));
const ORIG = process.env.SQLITE_DB_PATH;
const { ConfigStore } = await import('../../src/config/configStore.js');
const { computePortfolioReturn } = await import('../../src/services/portfolioReturn.js');

function fresh(tag: string) {
  (ConfigStore as any)._instance = null;
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
  rmSync(TMP_DIR, { recursive: true, force: true });
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
});
