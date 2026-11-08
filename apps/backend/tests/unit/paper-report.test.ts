/**
 * PA-09 只读报告 —— 影子期信号质量（目标数 / 稳定性 / 数据完整性）与落账期净值口径
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import type { Bar } from '../../src/services/backtest/types.js';
import { createPaperAccount } from '../../src/services/paper/accountService.js';
import {
  getPaperReport,
  listPaperEquity,
  listPaperOrders,
  listPaperPositions,
} from '../../src/services/paper/report.js';

let db: Database.Database;
let businessDb: Database.Database;

function bar(date: string, overrides: Partial<Bar> = {}): Bar {
  return {
    date,
    open: 4,
    high: 4,
    low: 4,
    close: 4,
    preclose: 4,
    volume: 10_000,
    amount: 40_000,
    ...overrides,
  };
}

function seedUser(id: number) {
  businessDb
    .prepare('INSERT OR IGNORE INTO user_account (id, username, role) VALUES (?, ?, ?)')
    .run(id, `u${id}`, 'user');
}

function newAccount(userId: number) {
  return createPaperAccount(db, businessDb, {
    userId,
    strategyId: 'ref-buy-and-hold',
    strategyVersion: '0.1.0',
    initialCash: 1_000_000,
    params: { symbol: 'sh510300', weight: 1, rebalance: false },
  });
}

function insertShadowOrder(args: {
  accountId: number;
  decisionDate: string;
  assetCode: string;
  side: 'buy' | 'sell';
  seq: number;
  intentKind?: 'target' | 'liquidate';
  status?: string;
}) {
  const signalId = `psig_${args.accountId}_${args.decisionDate}_${args.assetCode}_${args.seq}`;
  db.prepare(
    `INSERT INTO paper_order (
       account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
       rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional, status, is_replayed, is_deleted
     ) VALUES (?, ?, ?, '2026-11-09', ?, ?, ?, ?, 'replace', 0.1, 100000, 1000000, 50000, ?, 0, 0)`,
  ).run(
    args.accountId,
    signalId,
    args.decisionDate,
    args.seq,
    args.assetCode,
    args.intentKind ?? 'target',
    args.side,
    args.status ?? 'shadow',
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);
  businessDb = new Database(':memory:');
  businessDb.exec('CREATE TABLE user_account (id INTEGER PRIMARY KEY, username TEXT, role TEXT)');
  seedUser(1);
  seedUser(2);
  seedUser(3);
});

describe('影子期报告', () => {
  it('目标数 / 稳定性 / 数据完整性（缺 bar 与零量停牌分开计）', async () => {
    const account = newAccount(1);
    insertShadowOrder({
      accountId: account.id,
      decisionDate: '2026-11-05',
      assetCode: 'sh510300',
      side: 'buy',
      seq: 0,
    });
    insertShadowOrder({
      accountId: account.id,
      decisionDate: '2026-11-05',
      assetCode: 'sh510500',
      side: 'buy',
      seq: 1,
    });
    insertShadowOrder({
      accountId: account.id,
      decisionDate: '2026-11-06',
      assetCode: 'sh510300',
      side: 'buy',
      seq: 0,
    });
    insertShadowOrder({
      accountId: account.id,
      decisionDate: '2026-11-06',
      assetCode: 'sh510500',
      side: 'sell',
      seq: 1,
    });
    insertShadowOrder({
      accountId: account.id,
      decisionDate: '2026-11-06',
      assetCode: 'sh512000',
      side: 'sell',
      seq: 2,
      intentKind: 'liquidate',
    });
    // 被 superseded 的行不计入目标数
    insertShadowOrder({
      accountId: account.id,
      decisionDate: '2026-11-06',
      assetCode: 'sh513100',
      side: 'buy',
      seq: 3,
      status: 'superseded',
    });

    const report = await getPaperReport(
      db,
      1,
      account.id,
      {},
      {
        loadBars: async (symbols) => {
          const map = new Map<string, readonly Bar[]>();
          for (const s of symbols) {
            if (s === 'sh510300') map.set(s, [bar('2026-11-05'), bar('2026-11-06')]);
            if (s === 'sh510500') map.set(s, [bar('2026-11-06', { volume: 0 })]);
            // sh512000 / sh513100 完全无 bar
          }
          return map;
        },
      },
    );

    expect(report.shadow).not.toBeNull();
    const shadow = report.shadow!;
    expect(shadow.latestDecisionDate).toBe('2026-11-06');
    expect(shadow.days).toHaveLength(2);
    expect(shadow.days[0]).toMatchObject({ targetCount: 2, buyIntentCount: 2, sellIntentCount: 0 });
    expect(shadow.days[1]).toMatchObject({
      targetCount: 2,
      buyIntentCount: 1,
      sellIntentCount: 1,
      liquidateCount: 1,
    });

    // 两天目标集合一致 ⇒ identicalDays = 1
    expect(shadow.stability).toMatchObject({
      comparedDays: 1,
      identicalDays: 1,
      changedDays: 0,
      longestIdenticalRun: 1,
    });

    // 4 个有效目标 pair：1 缺 bar（sh510500 在 11-05）+ 1 零量（sh510500 在 11-06）
    // 注：sh512000 是 liquidate（不计入数据完整性 pair）
    expect(shadow.dataQuality).toMatchObject({
      checkedPairs: 4,
      missingBarPairs: 1,
      zeroVolumePairs: 1,
    });
    expect(shadow.dataQuality.byDate['2026-11-05']).toEqual({ missingBar: 1, zeroVolume: 0 });

    expect(shadow.orderCounts).toEqual({ shadow: 5, superseded: 1 });
    expect(shadow.latestTargets.map((o) => o.assetCode)).toEqual(['sh510300', 'sh510500', 'sh512000']);
    expect(report.ledger).toBeNull();
  });

  it('影子期不读持仓 / 净值（两表恒空也能出报告）', async () => {
    const account = newAccount(1);
    const report = await getPaperReport(db, 1, account.id, {}, { loadBars: async () => new Map() });
    expect(report.account.phase).toBe('shadow');
    expect(report.shadow!.latestDecisionDate).toBeNull();
    expect(report.shadow!.days).toEqual([]);
    expect(report.ledger).toBeNull();
  });
});

describe('落账期报告', () => {
  it('净值序列 / 持仓 / 订单分布 / 三项闲置现金口径', async () => {
    const account = newAccount(2);
    db.prepare(`UPDATE paper_account SET phase = 'ledger' WHERE id = ?`).run(account.id);

    db.prepare(
      `INSERT INTO paper_equity (
         account_id, trade_date, equity, cash, risk_mv, cash_mv, exposure,
         benchmark_close, benchmark_stale, drawdown_ratio, stale_symbol_count, is_deleted
       ) VALUES (?, '2026-11-06', 1000000, 500000, 450000, 50000, 0.5, 4, 0, -0.02, 0, 0)`,
    ).run(account.id);

    db.prepare(
      `INSERT INTO paper_position (
         account_id, asset_code, qty, avg_cost, cost_basis, closeable_qty, last_price, last_price_date, is_deleted
       ) VALUES (?, 'sh510300', 1000, 4, 4000, 1000, 4.5, '2026-11-06', 0)`,
    ).run(account.id);

    db.prepare(
      `INSERT INTO paper_order (
         account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
         rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional,
         status, filled_qty, filled_notional, unfilled_reason, is_replayed, is_deleted
       ) VALUES (?, 'psig_ledger_1', '2026-11-05', '2026-11-06', 0, 'sh510500', 'target', 'buy',
         'replace', 0.05, 50000, 1000000, 50000, 'unfilled', 0, 0, 'insufficient-cash', 0, 0)`,
    ).run(account.id);
    db.prepare(
      `INSERT INTO paper_order (
         account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
         rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional,
         status, filled_qty, fill_price, filled_notional, is_replayed, is_deleted
       ) VALUES (?, 'psig_ledger_2', '2026-11-05', '2026-11-06', 1, 'sh510300', 'target', 'buy',
         'replace', 1, 1000000, 1000000, 1000000, 'filled', 1000, 4, 4000, 0, 0)`,
    ).run(account.id);

    const report = await getPaperReport(db, 2, account.id);
    expect(report.shadow).toBeNull();
    const ledger = report.ledger!;
    expect(ledger.equity).toHaveLength(1);
    expect(ledger.positions).toHaveLength(1);
    expect(ledger.positions[0]).toMatchObject({ assetCode: 'sh510300', qty: 1000, closeableQty: 1000 });
    expect(ledger.orderCounts).toEqual({ unfilled: 1, filled: 1 });
    expect(ledger.unfilledReasons).toEqual({ 'insufficient-cash': 1 });
    expect(ledger.latest).toMatchObject({
      tradeDate: '2026-11-06',
      equity: 1_000_000,
      cashRatio: 0.5,
      cashLikeRatio: 0.55,
      unfilledBuyIntentRatio: 0.05,
    });
  });
});

describe('只读路由的服务层签名', () => {
  it('orders / equity / positions 都做归属校验（跨用户抛 404）', () => {
    const account = newAccount(1);
    expect(() => listPaperOrders(db, 2, account.id)).toThrowError(/不存在/);
    expect(() => listPaperPositions(db, 2, account.id)).toThrowError(/不存在/);
    expect(() => listPaperEquity(db, 2, account.id)).toThrowError(/不存在/);
  });
});
