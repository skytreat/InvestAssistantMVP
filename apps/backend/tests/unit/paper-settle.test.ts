/**
 * PA-10 / PA-11 / PA-12 落账结算 —— 合成行情，验证：
 *   A2 净值恒等式 / A3 成交价与佣金 / A4 T+1 / A5 涨停作废不顺延 / A6 停牌沿用最近价 /
 *   A7 同日重跑幂等 / A8 事务回滚保留 pending / A12 全市场未更新不落停牌 / A17 busy 重试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import type { Bar } from '../../src/services/backtest/types.js';
import { changePaperPhase, createPaperAccount } from '../../src/services/paper/accountService.js';
import { runPaperDecision } from '../../src/services/paper/decision.js';
import type { PaperMarketData } from '../../src/services/paper/marketData.js';
import { settleAccountPending, runPaperDailyStage, type PaperSettleDeps } from '../../src/services/paper/settle.js';
import { withBusyRetry } from '../../src/services/paper/retry.js';

const DAYS = ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'];
const LEDGER_START = '2026-11-09';

function flatBars(price = 4): Bar[] {
  return DAYS.map((d) => ({
    date: d,
    open: price,
    high: price,
    low: price,
    close: price,
    preclose: price,
    volume: 10_000,
    amount: 40_000,
  }));
}

const BARS = flatBars();

function snapshot(asOf: string): UniverseSnapshot {
  return {
    requestedAsOf: asOf,
    asOf,
    liquidityDates: [asOf],
    liquidity: { threshold: 0 },
    marketSymbolCount: 1,
    universeCount: 1,
    marketLiquidityPassCount: 1,
    fixedPoolSize: 1,
    fixedTradableCount: 1,
    fixedCoverageCount: 1,
    fixed: [{ symbol: 'sh510300', name: '沪深300ETF', avgAmount: 40_000 }],
    weak: [],
    dynamic: { pool: [], candidateCount: 0, excludedCount: 0 },
    noNameCandidateCount: 0,
    fallbackPoolMemberCount: 0,
  } as unknown as UniverseSnapshot;
}

function makeData(overrides: Partial<PaperMarketData> = {}): PaperMarketData {
  return {
    calendar: new TradingCalendar(DAYS),
    signalBars: new Map([['sh510300', BARS]]),
    execBars: new Map([['sh510300', BARS]]),
    indexBars: new Map(),
    benchmarkBars: BARS,
    universe: (asOf: string) => snapshot(asOf),
    loadStart: DAYS[0],
    loadEnd: LEDGER_START,
    ...overrides,
  };
}

function makeDeps(
  data: PaperMarketData,
  today: string,
  overrides: Partial<PaperSettleDeps> = {},
): PaperSettleDeps {
  return {
    today,
    resolveCalendarDate: async () => today,
    resolveQuoteDate: async () => today,
    buildData: async () => data,
    loadActions: async () => [],
    loadCalendar: async () => new TradingCalendar(DAYS),
    ...overrides,
  };
}

let db: Database.Database;
let businessDb: Database.Database;

/** 影子 → 落账（冷启动：ledger_start_date = 11-09，写种子净值点） */
async function ledgerAccount(): Promise<number> {
  const account = createPaperAccount(db, businessDb, {
    userId: 1,
    strategyId: 'ref-buy-and-hold',
    strategyVersion: '0.1.0',
    initialCash: 1_000_000,
    params: { symbol: 'sh510300', weight: 1, rebalance: false },
  });
  await changePaperPhase(db, 1, account.id, {
    to: 'ledger',
    confirm: true,
    today: '2026-11-06',
    loadHolidays: async () => [],
  });
  return account.id;
}

/** 切换后跑一次决策（asOf 11-06 → 挂到 11-09） */
async function decideAt(accountId: number, data: PaperMarketData, today: string) {
  return runPaperDecision(db, accountId, {
    today,
    resolveCalendarDate: async () => today,
    resolveQuoteDate: async () => today,
    buildData: async () => data,
  });
}

/** 手工塞一条 pending 卖单（决策侧 buy-and-hold 不会再出单） */
function insertSell(accountId: number, tradeDate: string, qty: number, price: number) {
  db.prepare(
    `INSERT INTO paper_order (
       account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
       rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional, status
     ) VALUES (?, ?, ?, ?, 2, 'sh510300', 'liquidate', 'sell', 'replace', NULL, 0, ?, ?, 'pending')`,
  ).run(
    accountId,
    `psig_${accountId}_${tradeDate}_sell_sh510300`,
    DAYS[DAYS.indexOf(tradeDate) - 1]!,
    tradeDate,
    1_000_000,
    qty * price,
  );
}

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);

  businessDb = new Database(':memory:');
  businessDb.exec('CREATE TABLE user_account (id INTEGER PRIMARY KEY, username TEXT, role TEXT)');
  businessDb.prepare('INSERT INTO user_account (id, username, role) VALUES (1, ?, ?)').run('u1', 'user');
});

describe('结算落账', () => {
  it('买入：次日开盘价成交、佣金 max(5, notional×0.0001)、净值恒等（A2/A3）', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');

    const outcomes = await settleAccountPending(db, id, makeDeps(data, LEDGER_START));
    expect(outcomes[0]).toMatchObject({ status: 'done', tradeDate: LEDGER_START, filled: 1 });

    const order = db.prepare('SELECT * FROM paper_order WHERE account_id = ?').get(id) as any;
    expect(order.status).toBe('filled');
    expect(order.fill_price).toBeCloseTo(4 * 1.0001, 6);
    expect(order.filled_qty).toBe(249_900);
    expect(order.filled_notional).toBeCloseTo(249_900 * 4.0004, 2);
    expect(order.fee).toBeCloseTo(Math.max(5, 249_900 * 4.0004 * 0.0001), 2);

    const pos = db.prepare('SELECT * FROM paper_position WHERE account_id = ? AND is_deleted = 0').get(id) as any;
    expect(pos.qty).toBe(249_900);
    // 成交均价含佣金（costBasis = notional + fee）
    expect(pos.avg_cost).toBeCloseTo((order.filled_notional + order.fee) / order.filled_qty, 6);
    // A4：当日买入 → 当日收盘检查点 `closeable_qty = 0`
    expect(pos.closeable_qty).toBe(0);

    const account = db.prepare('SELECT * FROM paper_account WHERE id = ?').get(id) as any;
    expect(account.last_settled_date).toBe(LEDGER_START);

    const eq = db.prepare('SELECT * FROM paper_equity WHERE account_id = ?').get(id) as any;
    expect(eq.trade_date).toBe(LEDGER_START);
    expect(eq.equity).toBeCloseTo(eq.cash + eq.risk_mv + eq.cash_mv, 6);
    expect(eq.cash).toBeCloseTo(account.cash, 6);
    // 种子净值点被首日结算覆盖（不是 1,000,000）
    expect(eq.equity).toBeLessThan(1_000_000);
    expect(eq.cash).toBeGreaterThanOrEqual(-0.01);
  });

  it('T+1：次日可卖；无挂单日也落估值点（A4 + 逐日对账前提）', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');
    await settleAccountPending(db, id, makeDeps(data, LEDGER_START));

    insertSell(id, '2026-11-10', 249_900, 4);
    const outcomes = await settleAccountPending(db, id, makeDeps(data, '2026-11-10'));
    // 11-09 已结算过 ⇒ 只补 11-10 一天
    expect(outcomes.map((o) => o.status)).toEqual(['done']);

    const openPositions = db
      .prepare('SELECT * FROM paper_position WHERE account_id = ? AND is_deleted = 0')
      .all(id) as any[];
    expect(openPositions).toHaveLength(0);
    const sell = db
      .prepare(`SELECT * FROM paper_order WHERE account_id = ? AND side = 'sell'`)
      .get(id) as any;
    expect(sell.status).toBe('filled');

    const rows = db.prepare('SELECT trade_date FROM paper_equity WHERE account_id = ? ORDER BY trade_date').all(id) as { trade_date: string }[];
    expect(rows.map((r) => r.trade_date)).toEqual([LEDGER_START, '2026-11-10']);
  });

  it('涨停买入 → unfilled(limit-up)，不产生跨日订单（A5）', async () => {
    const id = await ledgerAccount();
    const limitUp = flatBars().map((bar) =>
      bar.date === LEDGER_START ? { ...bar, open: 4.5, preclose: 4 } : bar,
    );
    const data = makeData({ execBars: new Map([['sh510300', limitUp]]), benchmarkBars: limitUp });
    await decideAt(id, data, '2026-11-06');

    const outcomes = await settleAccountPending(db, id, makeDeps(data, LEDGER_START));
    expect(outcomes[0]).toMatchObject({ status: 'done', unfilled: 1 });

    const order = db.prepare('SELECT * FROM paper_order WHERE account_id = ?').get(id) as any;
    expect(order.status).toBe('unfilled');
    expect(order.unfilled_reason).toBe('limit-up');
    const pendingLeft = db
      .prepare(`SELECT COUNT(*) AS n FROM paper_order WHERE account_id = ? AND status = 'pending'`)
      .get(id) as { n: number };
    expect(pendingLeft.n).toBe(0);
    expect(count('paper_position')).toBe(0);
  });

  it('停牌：持仓不变、无成交、净值沿用最近收盘、stale_symbol_count+1（A6）', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');
    await settleAccountPending(db, id, makeDeps(data, LEDGER_START));
    insertSell(id, '2026-11-10', 249_900, 4);

    // 11-10 无 bar（基准仍有 bar ⇒ 不是「全市场未更新」）
    const halted = flatBars().filter((bar) => bar.date !== '2026-11-10');
    const haltedData = makeData({ execBars: new Map([['sh510300', halted]]) });
    const outcomes = await settleAccountPending(db, id, makeDeps(haltedData, '2026-11-10'));
    expect(outcomes[0]).toMatchObject({ status: 'done', unfilled: 1 });

    const sell = db
      .prepare(`SELECT * FROM paper_order WHERE account_id = ? AND side = 'sell'`)
      .get(id) as any;
    expect(sell.status).toBe('unfilled');
    expect(sell.unfilled_reason).toBe('suspended');

    const pos = db
      .prepare('SELECT * FROM paper_position WHERE account_id = ? AND is_deleted = 0')
      .get(id) as any;
    expect(pos.qty).toBe(249_900);
    expect(pos.last_price).toBeCloseTo(4, 6);

    const eq = db
      .prepare(`SELECT * FROM paper_equity WHERE account_id = ? AND trade_date = '2026-11-10'`)
      .get(id) as any;
    expect(eq.stale_symbol_count).toBe(1);
    expect(eq.equity).toBeCloseTo(eq.cash + eq.risk_mv + eq.cash_mv, 6);
  });

  it('全市场未更新（基准当日缺 bar）→ blocked，pending 保留，不落停牌（A12）', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');

    const stale = flatBars().filter((bar) => bar.date !== LEDGER_START);
    const outcomes = await settleAccountPending(
      db,
      id,
      makeDeps(makeData({ benchmarkBars: stale }), LEDGER_START),
    );
    expect(outcomes[0]).toMatchObject({ status: 'blocked', reason: 'benchmark-missing' });

    const order = db.prepare('SELECT * FROM paper_order WHERE account_id = ?').get(id) as any;
    expect(order.status).toBe('pending');
    expect(count('paper_position')).toBe(0);
    // 只有种子净值点
    expect(count('paper_equity')).toBe(1);
  });

  it('同日重跑幂等：第二次不再推进（A7）', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');
    await settleAccountPending(db, id, makeDeps(data, LEDGER_START));

    const before = db.prepare('SELECT * FROM paper_equity WHERE account_id = ?').get(id) as any;
    const outcomes = await settleAccountPending(db, id, makeDeps(data, LEDGER_START));
    expect(outcomes[0]).toMatchObject({ status: 'skipped', reason: 'no-due-day' });

    const after = db.prepare('SELECT * FROM paper_equity WHERE account_id = ?').get(id) as any;
    expect(after.cash).toBeCloseTo(before.cash, 6);
    expect(count('paper_position')).toBe(1);
  });

  it('事务回滚：写库中途失败 ⇒ pending 保留、现金/净值不变，下次可补算（A8）', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');

    db.exec(`CREATE TRIGGER trg_paper_boom BEFORE INSERT ON paper_position
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await expect(settleAccountPending(db, id, makeDeps(data, LEDGER_START))).rejects.toThrow(/boom/);

    const order = db.prepare('SELECT * FROM paper_order WHERE account_id = ?').get(id) as any;
    expect(order.status).toBe('pending');
    const account = db.prepare('SELECT * FROM paper_account WHERE id = ?').get(id) as any;
    expect(account.cash).toBe(1_000_000);
    expect(account.last_settled_date).toBeNull();
    expect(count('paper_equity')).toBe(1);

    db.exec('DROP TRIGGER trg_paper_boom');
    const outcomes = await settleAccountPending(db, id, makeDeps(data, LEDGER_START));
    expect(outcomes[0]).toMatchObject({ status: 'done', filled: 1 });
  });

  it('busy 重试：前两次 SQLITE_BUSY，第三次成功（A17）', async () => {
    let calls = 0;
    const result = await withBusyRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
        return 'ok';
      },
      { delays: [0, 0, 0] },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('日更段：落账账户先结算 T、再决策 T→T+1', async () => {
    const id = await ledgerAccount();
    const data = makeData();
    await decideAt(id, data, '2026-11-06');

    const summary = await runPaperDailyStage({
      db,
      deps: makeDeps(data, LEDGER_START),
      silent: true,
    });
    expect(summary.accounts).toBe(1);
    expect(summary.settled).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0]!.status).toBe('done');

    const account = db.prepare('SELECT * FROM paper_account WHERE id = ?').get(id) as any;
    expect(account.last_settled_date).toBe(LEDGER_START);

    // 结算在决策之前发生：决策时账户已有持仓与已扣现金（否则决策会按空仓重建）
    const pos = db
      .prepare('SELECT * FROM paper_position WHERE account_id = ? AND is_deleted = 0')
      .get(id) as any;
    expect(pos.qty).toBe(249_900);
    expect(account.cash).toBeLessThan(1_000_000);
  });
});
