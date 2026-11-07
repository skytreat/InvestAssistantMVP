/**
 * PA-08 影子决策 —— 用合成行情（不依赖 DuckDB），验证：
 *   1. 只写 `paper_order(status='shadow')`；影子期 `paper_position` / `paper_equity` 恒为 0 行（S2 Gate）；
 *   2. 同日重跑幂等（UPSERT，行数不增）；消失的目标行标 `superseded`；
 *   3. 阻塞路径：行情未更新 / 日历不可用 / 无基准 bar / 日历缺 T；
 *   4. 已结算行存在 → `PAPER_ALREADY_SETTLED`；
 *   5. 落账期账户在 S2 阶段跳过（结算属 PA-10）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import type { Bar } from '../../src/services/backtest/types.js';
import { createPaperAccount } from '../../src/services/paper/accountService.js';
import {
  paperSignalId,
  runPaperDecision,
  runPaperDecisionStage,
  type PaperDecisionDeps,
} from '../../src/services/paper/decision.js';
import type { PaperMarketData } from '../../src/services/paper/marketData.js';
import { PaperError } from '../../src/services/paper/errors.js';

const DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];

const BARS: Bar[] = DAYS.map((d) => ({
  date: d,
  open: 4,
  high: 4,
  low: 4,
  close: 4,
  preclose: 4,
  volume: 10_000,
  amount: 40_000,
}));

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
    loadEnd: '2026-11-06',
    ...overrides,
  };
}

function makeDeps(data: PaperMarketData, overrides: PaperDecisionDeps = {}): PaperDecisionDeps {
  return {
    today: '2026-11-06',
    resolveCalendarDate: async () => '2026-11-06',
    resolveQuoteDate: async () => '2026-11-06',
    loadHolidays: async () => [],
    buildData: async () => data,
    ...overrides,
  };
}

let db: Database.Database;
let businessDb: Database.Database;

function seedUser(id: number, username: string) {
  businessDb
    .prepare('INSERT OR IGNORE INTO user_account (id, username, role) VALUES (?, ?, ?)')
    .run(id, username, 'user');
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

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);

  businessDb = new Database(':memory:');
  businessDb.exec('CREATE TABLE user_account (id INTEGER PRIMARY KEY, username TEXT, role TEXT)');
  seedUser(1, 'u1');
  seedUser(2, 'u2');
});

describe('影子决策', () => {
  it('写 shadow 行、不写持仓/净值、账户水位推进', async () => {
    const account = newAccount(1);
    const outcome = await runPaperDecision(db, account.id, makeDeps(makeData()));

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.decisionDate).toBe('2026-11-06');
    expect(outcome.tradeDate).toBe('2026-11-09');
    expect(outcome.targetCount).toBe(1);
    expect(outcome.orderCount).toBe(1);

    const row = db.prepare('SELECT * FROM paper_order WHERE account_id = ?').get(account.id) as any;
    expect(row.status).toBe('shadow');
    expect(row.intent_kind).toBe('target');
    expect(row.side).toBe('buy');
    expect(row.asset_code).toBe('sh510300');
    expect(row.target_weight).toBe(1);
    expect(row.trade_date).toBe('2026-11-09');
    expect(row.settled_at).toBeNull();
    expect(row.cutoff_equity).toBeCloseTo(1_000_000, 6);
    expect(row.intent_notional).toBeCloseTo(1_000_000, 6);

    // S2 Gate：影子期不写持仓 / 净值
    expect(count('paper_position')).toBe(0);
    expect(count('paper_equity')).toBe(0);

    const acc = db
      .prepare('SELECT start_date, last_decision_date FROM paper_account WHERE id = ?')
      .get(account.id) as any;
    expect(acc.start_date).toBe('2026-11-06');
    expect(acc.last_decision_date).toBe('2026-11-06');
  });

  it('同日重跑幂等：行数不增、水位不变', async () => {
    const account = newAccount(1);
    const deps = makeDeps(makeData());
    await runPaperDecision(db, account.id, deps);
    const before = count('paper_order');
    const again = await runPaperDecision(db, account.id, deps);

    expect(again.status).toBe('done');
    expect(count('paper_order')).toBe(before);
    expect(count('paper_position')).toBe(0);
    expect(count('paper_equity')).toBe(0);
  });

  it('消失的目标行标 superseded', async () => {
    const account = newAccount(1);
    await runPaperDecision(db, account.id, makeDeps(makeData()));

    const stale = paperSignalId(account.id, '2026-11-06', 'sh510500');
    db.prepare(
      `INSERT INTO paper_order (
         account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
         rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional, status, is_replayed, is_deleted
       ) VALUES (?, ?, '2026-11-06', '2026-11-09', 99, 'sh510500', 'target', 'buy',
         'replace', 0.2, 200000, 1000000, 200000, 'shadow', 0, 0)`,
    ).run(account.id, stale);

    const again = await runPaperDecision(db, account.id, makeDeps(makeData()));
    expect(again.status).toBe('done');
    if (again.status !== 'done') return;
    expect(again.superseded).toBe(1);
    const superseded = db.prepare('SELECT status FROM paper_order WHERE signal_id = ?').get(stale) as any;
    expect(superseded.status).toBe('superseded');
  });

  it('多日回放（start_date 已存在）仍只落最终日一行', async () => {
    const account = newAccount(1);
    db.prepare(`UPDATE paper_account SET start_date = '2026-11-02' WHERE id = ?`).run(account.id);
    const outcome = await runPaperDecision(db, account.id, makeDeps(makeData()));

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.decisionDate).toBe('2026-11-06');
    expect(outcome.orderCount).toBe(1);
    expect(count('paper_position')).toBe(0);
  });
});

describe('阻塞路径', () => {
  it('行情未更新（quoteDate < calendarDate）→ blocked，不写行', async () => {
    const account = newAccount(1);
    const outcome = await runPaperDecision(
      db,
      account.id,
      makeDeps(makeData(), { resolveQuoteDate: async () => '2026-11-05' }),
    );
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.reason).toBe('quotes-not-updated');
    expect(count('paper_order')).toBe(0);
  });

  it('日历不可用 → blocked', async () => {
    const account = newAccount(1);
    const outcome = await runPaperDecision(
      db,
      account.id,
      makeDeps(makeData(), { resolveCalendarDate: async () => null }),
    );
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.reason).toBe('calendar-unavailable');
  });

  it('基准当日无 bar → blocked（不肯用前一日价格顶替）', async () => {
    const account = newAccount(1);
    const outcome = await runPaperDecision(
      db,
      account.id,
      makeDeps(makeData({ benchmarkBars: BARS.filter((b) => b.date !== '2026-11-06') })),
    );
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.reason).toBe('benchmark-missing');
  });

  it('日历缺决策日 → blocked calendar-mismatch', async () => {
    const account = newAccount(1);
    const outcome = await runPaperDecision(
      db,
      account.id,
      makeDeps(makeData({ calendar: new TradingCalendar(DAYS.filter((d) => d !== '2026-11-06')) })),
    );
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.reason).toBe('calendar-mismatch');
  });

  it('已有已结算订单 → PAPER_ALREADY_SETTLED（禁止重写信号）', async () => {
    const account = newAccount(1);
    db.prepare(
      `INSERT INTO paper_order (
         account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
         rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional, status, settled_at, is_replayed, is_deleted
       ) VALUES (?, ?, '2026-11-06', '2026-11-09', 1, 'sh510300', 'target', 'buy',
         'replace', 1, 1000000, 1000000, 1000000, 'filled', '2026-11-09 17:04:00', 0, 0)`,
    ).run(account.id, paperSignalId(account.id, '2026-11-06', 'sh510300'));

    await expect(runPaperDecision(db, account.id, makeDeps(makeData()))).rejects.toMatchObject({
      code: 'PAPER_ALREADY_SETTLED',
    });
    expect(count('paper_position')).toBe(0);
  });
});

describe('阶段跳过', () => {
  it('落账期账户 → 产出 pending（S3 起不再跳过）', async () => {
    const account = newAccount(1);
    db.prepare(`UPDATE paper_account SET phase = 'ledger' WHERE id = ?`).run(account.id);
    const outcome = await runPaperDecision(db, account.id, makeDeps(makeData()));
    expect(outcome.status).toBe('done');
    const row = db
      .prepare(`SELECT status, trade_date FROM paper_order WHERE account_id = ? ORDER BY id DESC`)
      .get(account.id) as { status: string; trade_date: string };
    // 切换即冷启动：`ledger_start_date` 由 accountService 写入；此处未写 ⇒ 回放起点回退到决策日
    expect(row.status).toBe('pending');
    expect(row.trade_date).toBe('2026-11-09');
  });

  it('paused 账户 → skipped', async () => {
    const account = newAccount(1);
    db.prepare(`UPDATE paper_account SET status = 'paused' WHERE id = ?`).run(account.id);
    const outcome = await runPaperDecision(db, account.id, makeDeps(makeData()));
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') return;
    expect(outcome.reason).toBe('account-not-active');
  });
});

describe('日更段编排', () => {
  it('多账户：影子与落账都产出订单，落账行为 pending；都不写持仓/净值', async () => {
    const a1 = newAccount(1);
    const a2 = newAccount(2);
    db.prepare(`UPDATE paper_account SET phase = 'ledger' WHERE id = ?`).run(a2.id);

    const summary = await runPaperDecisionStage({ db, deps: makeDeps(makeData()), silent: true });
    expect(summary.accounts).toBe(2);
    expect(summary.done).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.decisionDate).toBe('2026-11-06');

    expect(count('paper_order')).toBe(2);
    expect(count('paper_position')).toBe(0);
    expect(count('paper_equity')).toBe(0);

    const ledger = db
      .prepare(`SELECT status FROM paper_order WHERE account_id = ?`)
      .get(a2.id) as { status: string };
    expect(ledger.status).toBe('pending');

    const shadow = db.prepare('SELECT start_date FROM paper_account WHERE id = ?').get(a1.id) as any;
    expect(shadow.start_date).toBe('2026-11-06');
  });

  it('策略版本失效 → 账户 paused + ERROR（不回退最新版本）', async () => {
    const account = newAccount(1);
    db.prepare(`UPDATE paper_account SET strategy_version = '9.9.9' WHERE id = ?`).run(account.id);

    const summary = await runPaperDecisionStage({ db, deps: makeDeps(makeData()), silent: true });
    expect(summary.failed).toBe(1);
    const row = db.prepare('SELECT status FROM paper_account WHERE id = ?').get(account.id) as any;
    expect(row.status).toBe('paused');
  });
});

describe('PaperError 契约', () => {
  it('账户不存在 → PAPER_ACCOUNT_NOT_FOUND', async () => {
    await expect(runPaperDecision(db, 999, makeDeps(makeData()))).rejects.toBeInstanceOf(PaperError);
  });
});
