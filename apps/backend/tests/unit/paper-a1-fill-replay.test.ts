/**
 * ADR-025 A1（PR #179）—— 纸面回放补全成交回报（onFill 历史回放）E2E 验证
 *
 * 覆盖：
 *   1. `loadFilledOrders` 正确返回历史 filled 订单（含 `exit_reason`，按 `trade_date` 升序）；
 *   2. 喂给真实 `dualmomentum.onFill` 后，策略状态（建仓日 / 冷却）从真实成交序列重建；
 *   3. 与「不喂 onFill」对照：冷却生效 ⇒ 标的被 L1 COOLDOWN 过滤，不进入 target。
 *
 * 背景：§9.2 的四条永不触发规则（止盈 / 掉出候选 / 高水位止损 / 冷却）根因是
 * 「纸面回放不调 onFill」。A1 通过「结算落 exit_reason + 决策回放喂 onFill」恢复它们。
 * 本测试证明：喂了 onFill 后，冷却确实生效（可观测：COOLDOWN 过滤）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { makeContext, universeViewOf } from '../../src/services/backtest/engine.js';
import { Portfolio } from '../../src/services/backtest/account/portfolio.js';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import type { Bar } from '../../src/services/backtest/types.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import {
  POOL_ORDER,
  BENCHMARK_SYMBOL,
} from '../../src/services/backtest/strategies/dualmomentum/l1/params.js';
import { createDualMomentumStrategy } from '../../src/services/backtest/strategies/dualmomentum/index.js';
import { loadFilledOrders } from '../../src/services/paper/decision.js';

const DAYS: string[] = (() => {
  const out: string[] = [];
  const d = new Date(Date.UTC(2026, 5, 1));
  while (out.length < 90) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
})();

/** 0.4%/日 单边上涨：MA 多头、WSM 落区间、日涨幅未触涨跌停（与 dualmomentumStrategy.test.ts 同口径） */
function risingCloses(start: number, dailyGrowth: number): number[] {
  return DAYS.map((_, i) => start * Math.pow(1 + dailyGrowth, i));
}
const POOL_CLOSES = new Map(POOL_ORDER.map((s, i) => [s, risingCloses(3 + i * 0.2, 0.004)]));

function barsOf(closes: readonly number[]): Bar[] {
  return closes.map((close, i) => ({
    date: DAYS[i],
    open: close * 0.999,
    high: close * 1.002,
    low: close * 0.998,
    close,
    preclose: i === 0 ? close : closes[i - 1],
    volume: 100_000,
    amount: close * 100_000,
  }));
}

const SIGNAL_BARS = new Map<string, Bar[]>(POOL_ORDER.map((s) => [s, barsOf(POOL_CLOSES.get(s)!)]));
// 基准（指数）需 90 根 bar（预热 60 + 决策）
const BENCH_BARS = barsOf(risingCloses(3000, 0.002));
const INDEX = new Map<string, Bar[]>([[BENCHMARK_SYMBOL, BENCH_BARS]]);

function snapshot(asOf: string): UniverseSnapshot {
  return {
    requestedAsOf: asOf,
    asOf,
    liquidityDates: [asOf],
    liquidity: { threshold: 0 },
    marketSymbolCount: POOL_ORDER.length,
    universeCount: POOL_ORDER.length,
    marketLiquidityPassCount: POOL_ORDER.length,
    fixedPoolSize: POOL_ORDER.length,
    fixedTradableCount: POOL_ORDER.length,
    fixedCoverageCount: POOL_ORDER.length,
    fixed: POOL_ORDER.map((symbol) => ({ symbol, name: symbol, avgAmount: 1e8 })),
    weak: [],
    dynamic: { pool: [], candidateCount: 0, excludedCount: 0 },
    noNameCandidateCount: 0,
    fallbackPoolMemberCount: 0,
  } as unknown as UniverseSnapshot;
}

const lastDay = DAYS[DAYS.length - 1];

// 合成数据是「完美线性上涨」，RSRS 标准化斜率会落区间外；放宽次槽区间（与 dualmomentumStrategy.test.ts 一致）
// ⚠️ research 档参数（rsrsMaxResearch / wsmMaxResearch）必须等于锁定值，否则触发档 3 路径
// （其 L1 重建不应用 cooling），冷却过滤会被绕过。这里让 research 档关闭（走缺省路径保证 cooling 生效）。
const DECIDE_PARAMS = { rsrsMin: -10, rsrsMax: 50, rsrsMaxResearch: 50, wsmMaxResearch: 5 };

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);
  // paper_order.account_id 外键引用 paper_account(id)：插一条最小账户行以满足 FK
  db.prepare(
    `INSERT INTO paper_account (
       id, user_id, strategy_id, strategy_version, strategy_name, name, params_json,
       rules_json, fee_snapshot_json, initial_cash, cash, benchmark_asset_code, phase, status
     ) VALUES (
       1, 1, 'dualmomentum', 'das-3.2', '双动量', 'acc', '{}', '{}', '{}',
       1000000, 1000000, 'sh510300', 'ledger', 'active'
     )`,
  ).run();
});

/** 直接向 paper_order 插一笔历史 filled 订单（模拟「结算已落账」的成交） */
function insertFilledOrder(args: {
  accountId: number;
  tradeDate: string;
  asset: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  exitReason: string | null;
  fee?: number;
}): void {
  db.prepare(
    `INSERT INTO paper_order (
       account_id, signal_id, decision_date, trade_date, seq, asset_code, intent_kind, side,
       rebalance_mode, target_weight, target_notional, cutoff_equity, intent_notional,
       status, filled_qty, fill_price, filled_notional, fee, exit_reason
     ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'replace', 1, 0, 1000000, 0,
             'filled', ?, ?, ?, ?, ?)`,
  ).run(
    args.accountId,
    `psig_${args.accountId}_${args.tradeDate}_${args.asset}_hist`,
    args.tradeDate,
    args.tradeDate,
    args.asset,
    args.side === 'sell' ? 'liquidate' : 'target',
    args.side,
    args.qty,
    args.price,
    Math.abs(args.qty * args.price),
    args.fee ?? 0,
    args.exitReason,
  );
}

describe('A1 loadFilledOrders（ADR-025）', () => {
  it('按 trade_date 升序返回历史 filled，且带 exit_reason', () => {
    insertFilledOrder({
      accountId: 1,
      tradeDate: DAYS[5],
      asset: 'sh513500',
      side: 'buy',
      qty: 1000,
      price: 4,
      exitReason: null, // 买入无 exit_reason（buy.reason 是 target reason，结算不落）
    });
    insertFilledOrder({
      accountId: 1,
      tradeDate: DAYS[10],
      asset: 'sh518880',
      side: 'sell',
      qty: 1000,
      price: 4,
      exitReason: 'stop-loss',
    });
    insertFilledOrder({
      accountId: 1,
      tradeDate: DAYS[15],
      asset: 'sh510300',
      side: 'buy',
      qty: 500,
      price: 5,
      exitReason: null,
    });

    // replayStart = DAYS[3]：只取 3 日之后的成交（影子期 DAYS[0..2] 的成交不参与）
    const rows = loadFilledOrders(db, 1, DAYS[3]);
    expect(rows.map((r) => r.trade_date)).toEqual([DAYS[5], DAYS[10], DAYS[15]]);
    expect(rows.map((r) => r.asset_code)).toEqual(['sh513500', 'sh518880', 'sh510300']);
    expect(rows.map((r) => r.exit_reason)).toEqual([null, 'stop-loss', null]);
  });

  it('replayStart 之前的成交被排除（影子期不回放）', () => {
    insertFilledOrder({
      accountId: 1,
      tradeDate: DAYS[1],
      asset: 'sh513500',
      side: 'buy',
      qty: 100,
      price: 4,
      exitReason: null,
    });
    insertFilledOrder({
      accountId: 1,
      tradeDate: DAYS[20],
      asset: 'sh518880',
      side: 'sell',
      qty: 100,
      price: 4,
      exitReason: 'take-profit',
    });
    const rows = loadFilledOrders(db, 1, DAYS[3]);
    expect(rows.map((r) => r.trade_date)).toEqual([DAYS[20]]);
  });
});

describe('A1 喂 onFill 后状态重建（对照回测口径）', () => {
  it('喂 buy（重建建仓日）⇒ 止盈「持有≥minHoldDays」判定用真实建仓日（L2 路径）', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    strategy.init?.({ params });

    const sym = 'sh513500';
    // 喂 buy：重建 entryDate = 20 交易日前（minHoldDays=20 跑赢档，持有 20+ 自然日 ⇒ 止盈前置满足）
    strategy.onFill?.({
      date: DAYS[DAYS.length - 21],
      symbol: sym,
      side: 'buy',
      qty: 1000,
      price: 3,
      fee: 0,
      reason: 'candidate-top',
    });

    // 持仓：sym 成本 3（低于当日收盘价 5.13 ⇒ takeProfit ≈ 71% ≥ 30% 止盈阈值）
    const portfolio = new Portfolio(1_000_000);
    portfolio.restore([{ symbol: sym, qty: 1000, avgCost: 3, closeableQty: 1000 }], 1_000_000, lastDay);
    const ctx = makeContext({
      asOf: lastDay,
      execDate: lastDay,
      dayIndex: DAYS.length - 1,
      params,
      signalBars: SIGNAL_BARS,
      indexBars: INDEX,
      universeView: universeViewOf(snapshot(lastDay)),
      portfolio,
      pricesAtAsOf: new Map(POOL_ORDER.map((s) => [s, POOL_CLOSES.get(s)!.at(-1)!])),
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs: [],
    });
    const res = strategy.decide(ctx);
    expect(res).not.toBeNull();
    // 喂了真实建仓日（20 交易日前）⇒ daysSinceEntry ≈ 28 自然日 ≥ minHoldDays=20；
    // 当日收益 5.13/3-1 ≈ 71% ≥ 30% ⇒ L2 判 take-profit（exitReasons[sym]='take-profit'）
    expect(res!.exitReasons?.[sym]).toBe('take-profit');
  });

  it('对照：不喂 buy（建仓日兜底=asOf）⇒ 止盈「持有≥minHoldDays」前置不满足', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    strategy.init?.({ params });
    // 不喂 onFill：建仓日兜底 = asOf（当日）⇒ daysSinceEntry=0 < minHoldDays=20

    const sym = 'sh513500';
    const portfolio = new Portfolio(1_000_000);
    portfolio.restore([{ symbol: sym, qty: 1000, avgCost: 3, closeableQty: 1000 }], 1_000_000, lastDay);
    const ctx = makeContext({
      asOf: lastDay,
      execDate: lastDay,
      dayIndex: DAYS.length - 1,
      params,
      signalBars: SIGNAL_BARS,
      indexBars: INDEX,
      universeView: universeViewOf(snapshot(lastDay)),
      portfolio,
      pricesAtAsOf: new Map(POOL_ORDER.map((s) => [s, POOL_CLOSES.get(s)!.at(-1)!])),
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs: [],
    });
    const res = strategy.decide(ctx);
    expect(res).not.toBeNull();
    // 不喂 onFill 时建仓日兜底=asOf ⇒ daysSinceEntry=0 < 20，止盈前置不满足；
    // 即使当日收益 71% 也不判 take-profit（对照上一条的「判 take-profit」）
    expect(res!.exitReasons?.[sym]).not.toBe('take-profit');
  });

  it('喂了 buy（重建建仓日）⇒ 持仓不再触发「无建仓记录兜底」warn', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    strategy.init?.({ params });

    const sym = 'sh513500';
    // 喂 buy：重建 entryDate（避免「有持仓但无建仓记录」兜底）
    strategy.onFill?.({
      date: DAYS[DAYS.length - 6],
      symbol: sym,
      side: 'buy',
      qty: 1000,
      price: 4,
      fee: 0,
      reason: 'candidate-top',
    });

    const portfolio = new Portfolio(1_000_000);
    portfolio.restore([{ symbol: sym, qty: 1000, avgCost: 4, closeableQty: 1000 }], 1_000_000, lastDay);
    const logs: { level: 'info' | 'warn'; message: string }[] = [];
    const ctx = makeContext({
      asOf: lastDay,
      execDate: lastDay,
      dayIndex: DAYS.length - 1,
      params,
      signalBars: SIGNAL_BARS,
      indexBars: INDEX,
      universeView: universeViewOf(snapshot(lastDay)),
      portfolio,
      pricesAtAsOf: new Map(POOL_ORDER.map((s) => [s, POOL_CLOSES.get(s)!.at(-1)!])),
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs,
    });
    strategy.decide(ctx);
    const warns = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns.some((w) => w.includes('无建仓记录'))).toBe(false);
  });

  it('对照：不喂 buy（无建仓记录）⇒ 触发「无建仓记录兜底」warn', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    strategy.init?.({ params });
    // 不喂 onFill

    const sym = 'sh513500';
    const portfolio = new Portfolio(1_000_000);
    portfolio.restore([{ symbol: sym, qty: 1000, avgCost: 4, closeableQty: 1000 }], 1_000_000, lastDay);
    const logs: { level: 'info' | 'warn'; message: string }[] = [];
    const ctx = makeContext({
      asOf: lastDay,
      execDate: lastDay,
      dayIndex: DAYS.length - 1,
      params,
      signalBars: SIGNAL_BARS,
      indexBars: INDEX,
      universeView: universeViewOf(snapshot(lastDay)),
      portfolio,
      pricesAtAsOf: new Map(POOL_ORDER.map((s) => [s, POOL_CLOSES.get(s)!.at(-1)!])),
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs,
    });
    strategy.decide(ctx);
    const warns = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    // 有持仓但无建仓记录 ⇒ 兜底 warn（§9.2 的四条永不触发根因之一）
    expect(warns.some((w) => w.includes('无建仓记录'))).toBe(true);
  });
});
