import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-v33-'));
const ORIG = process.env.SQLITE_DB_PATH;
const { ConfigStore } = await import('../../src/config/configStore.js');
const { buildReviewPairs } = await import('../../src/services/reviewPairs.js');

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

describe('T130 交易对视图 buildReviewPairs', () => {
  it('开仓→平仓配对 + 部分平仓保留剩余 + 未平仓单独成组', () => {
    const store = fresh('pairs');
    const db = store.db;
    const ins = db.prepare(
      `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, buy_reason, sell_reason)
       VALUES (1, 'sh000001', ?, ?, '09:30:00', ?, ?, 0, ?, ?)`,
    );
    ins.run('buy', '2026-09-01', 100, 10, 'RSI低位', null);
    ins.run('add', '2026-09-02', 100, 12, null, null); // 加仓合并
    ins.run('reduce', '2026-09-05', 150, 13, null, '止盈'); // 部分平仓
    ins.run('clear', '2026-09-10', 50, 11, null, '清仓'); // 剩余清仓

    const pairs = buildReviewPairs(1);
    // 两笔平仓 → 两个 closed pair；无未平仓
    expect(pairs.filter((p) => p.status === 'closed').length).toBe(2);
    expect(pairs.filter((p) => p.status === 'open').length).toBe(0);
    const first = pairs.find((p) => p.closed_quantity === 150)!;
    expect(first.asset_code).toBe('sh000001');
    expect(first.buy_reason).toBe('RSI低位');
    expect(first.sell_reason).toBe('止盈');
    expect(first.realized_pnl).not.toBeNull();
    expect(first.holding_days).toBe(4);
  });

  it('未平仓单独成组（open）', () => {
    const store = fresh('open');
    const db = store.db;
    db.prepare(
      `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee)
       VALUES (1, 'sz000002', 'buy', '2026-09-01', '09:30:00', 200, 8, 0)`,
    ).run();
    const pairs = buildReviewPairs(1);
    expect(pairs.length).toBe(1);
    expect(pairs[0].status).toBe('open');
    expect(pairs[0].close_date).toBeNull();
    expect(pairs[0].remaining_quantity).toBe(200);
  });

  it('bonus 摊薄不生成 pair', () => {
    const store = fresh('bonus');
    const db = store.db;
    const ins = db.prepare(
      `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee)
       VALUES (1, 'sh000003', ?, ?, '09:30:00', ?, ?, 0)`,
    );
    ins.run('buy', '2026-09-01', 100, 10);
    ins.run('bonus', '2026-09-02', 10, 0);
    const pairs = buildReviewPairs(1);
    // 只有未平仓 open pair 一个
    expect(pairs.length).toBe(1);
    expect(pairs[0].status).toBe('open');
    expect(pairs[0].remaining_quantity).toBe(110);
  });
});
