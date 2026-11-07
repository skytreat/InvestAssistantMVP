/**
 * S0 阶段（PA-01/PA-02）验收测试：
 * 1. 重构后的 `runBacktest` 输出与重构前（HEAD）落下的 golden **逐位一致**；
 * 2. 纸面落账路径（`stepBacktestDay` + `targetsOverride`）能复现同一段「除权 → 成交 → 估值」；
 * 3. 单日顺序：先送转/分红 → 再成交 → 最后按 T 收盘估值。
 *
 * ⚠️ 全部用合成数据，**不读 DuckDB**（M3/M4 重跑期间禁止碰行情主库）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import {
  runBacktest,
  stepBacktestDay,
  type BacktestResult,
  type BacktestRunState,
} from '../../src/services/backtest/engine.js';
import { Portfolio } from '../../src/services/backtest/account/portfolio.js';
import { DEFAULT_TRADE_RULES } from '../../src/services/backtest/execution/simulator.js';
import { defineStrategy } from '../../src/services/backtest/strategy/types.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import type { Bar } from '../../src/services/backtest/types.js';

const DATES = [
  '2024-01-02',
  '2024-01-03',
  '2024-01-04',
  '2024-01-05',
  '2024-01-08',
  '2024-01-09',
  '2024-01-10',
  '2024-01-11',
];

/** 成交轨（bfq） */
const EXEC_A = [10.0, 10.2, 10.5, 10.4, 11.0, 11.5, 9.8, 10.1];
const EXEC_D = [100.0, 100.0, 100.1, 100.1, 100.2, 100.2, 100.3, 100.3];
/** 信号轨（qfq）—— 与成交轨不同，用来证明两轨都被使用 */
const SIG_A = [11.0, 11.2, 11.5, 11.4, 12.0, 12.5, 10.8, 11.1];
const SIG_D = [110.0, 110.0, 110.1, 110.1, 110.2, 110.2, 110.3, 110.3];

function bars(
  dates: readonly string[],
  prices: readonly number[],
  opts: { zeroVolume?: readonly string[]; skipDate?: string } = {},
): Bar[] {
  return dates
    .filter((d) => d !== opts.skipDate)
    .map((date) => {
      const i = dates.indexOf(date);
      return {
        date,
        open: prices[i],
        high: prices[i] + 0.05,
        low: prices[i] - 0.05,
        close: prices[i],
        preclose: i > 0 ? prices[i - 1] : prices[i],
        volume: opts.zeroVolume?.includes(date) ? 0 : 1_000_000,
        amount: prices[i] * 1_000_000,
      };
    });
}

function snapshot(asOf: string): UniverseSnapshot {
  const row = (symbol: string, name: string) => ({
    symbol,
    name,
    firstBar: DATES[0],
    lastBar: DATES[DATES.length - 1],
    avgAmount: 1e9,
  });
  return {
    requestedAsOf: asOf,
    asOf,
    liquidityDates: [asOf],
    liquidity: {
      dates: [asOf],
      totalByDate: [1e9],
      avgTotal: 1e9,
      threshold: 10_000_000,
      fallback: false,
    },
    marketSymbolCount: 2,
    universeCount: 2,
    marketLiquidityPassCount: 2,
    fixedPoolSize: 2,
    fixedTradableCount: 2,
    fixedCoverageCount: 2,
    fixed: [row('sh510300', '沪深300ETF'), row('sh511880', '白银基金')],
    weak: [],
    dynamic: { groups: [], pool: [], excludedCount: 0, skippedCount: 0, specialCount: 0, normalCount: 0 },
    noNameCandidateCount: 1,
    fallbackPoolMemberCount: 1,
  };
}

const scenarioStrategy = defineStrategy({
  id: 's0-probe',
  version: '0.0.9',
  name: 'S0 逐位基线探针',
  paramSchema: [],
  warmupDays: 0,
  priceMode: 'open',
  decide(ctx) {
    const a = ctx.latest('sh510300');
    const d = ctx.latest('sh511880');
    ctx.tag('seenA', a);
    ctx.tag('seenD', d);
    ctx.tag('cash', ctx.cash);
    if (a === null) return null;
    if (ctx.dayIndex % 2 === 1) {
      return {
        targets: [
          { symbol: 'sh510300', targetWeight: a >= 11 ? 0.6 : 0.35, reason: 'candidate-top' as const },
          {
            symbol: 'sh511880',
            targetWeight: d !== null && d > 100 ? 0.3 : 0.2,
            reason: 'defensive-fallback' as const,
          },
        ],
        mode: 'replace' as const,
        // 极小红线：制造 turnover-capped 跳过（覆盖换手上限分支）
        maxTurnoverRatio: a >= 11 ? 1e-9 : 0.5,
      };
    }
    return {
      targets: [{ symbol: 'sh510300', targetNotional: 30_000, reason: 'rebalance' as const }],
      mode: 'replace' as const,
      maxTurnoverRatio: 0.5,
    };
  },
});

/** 基准缺 01-09 的 bar → 该日 benchmarkStale=true（指标层整对剔除） */
const benchmarkBars = bars(DATES, EXEC_A, { skipDate: '2024-01-09' });

const data = {
  calendar: new TradingCalendar(DATES),
  signalBars: new Map([
    ['sh510300', bars(DATES, SIG_A)],
    ['sh511880', bars(DATES, SIG_D)],
  ]),
  execBars: new Map([
    ['sh510300', bars(DATES, EXEC_A, { zeroVolume: ['2024-01-04'] })],
    ['sh511880', bars(DATES, EXEC_D, { skipDate: '2024-01-10' })],
  ]),
  benchmarkBars,
  universe: (asOf: string) => snapshot(asOf),
  corporateActions: [
    { date: '2024-01-04', symbol: 'sh511880', kind: 'bonus' as const, bonusRatio: 0.05 },
    { date: '2024-01-09', symbol: 'sh510300', kind: 'bonus' as const, bonusRatio: 0.1 },
    { date: '2024-01-09', symbol: 'sh510300', kind: 'dividend' as const, cashPerShare: 0.25 },
    { date: '2024-01-10', symbol: 'sh511880', kind: 'dividend' as const, cashPerShare: 0.5 },
  ],
};

const request = {
  strategy: scenarioStrategy,
  start: DATES[0],
  end: DATES[DATES.length - 1],
  initialCash: 100_000,
  benchmarkSymbol: 'sh510300',
  universeParams: { divisor: 1, topN: 2 },
};

const GOLDEN = fileURLToPath(new URL('../fixtures/backtest/s0-paper-step-golden.json', import.meta.url));

/** JSON 往返把 undefined 抹平，同时保留 double 的逐位精度 */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

function freshState(
  overrides: { data?: unknown; strategy?: BacktestRunState['strategy'] } = {},
): BacktestRunState {
  const source = (overrides.data ?? data) as typeof data;
  const actionsByDate = new Map<string, typeof data.corporateActions>();
  for (const a of source.corporateActions ?? []) {
    const list = actionsByDate.get(a.date) ?? [];
    list.push(a);
    actionsByDate.set(a.date, list);
  }
  return {
    data: source as never,
    strategy: overrides.strategy ?? scenarioStrategy,
    params: { ...scenarioStrategy.defaultParams },
    priceMode: 'open',
    rules: { ...DEFAULT_TRADE_RULES },
    suspension: {},
    actionsByDate,
    portfolio: new Portfolio(100_000),
    equity: [],
    trades: [],
    skippedAll: [],
    warningsAll: [],
    decisions: [],
    roundTripNotified: new Set<number>(),
    universeStats: {
      days: 0,
      noNameCandidateTotal: 0,
      noNameCandidateMax: 0,
      fallbackPoolMemberTotal: 0,
      fallbackPoolMemberMax: 0,
    },
    tradedNotional: 0,
  };
}

describe('S0 · 回测逐位不变', () => {
  it('重构后的 runBacktest 与 HEAD golden 逐位一致', () => {
    const golden = plain(JSON.parse(readFileSync(GOLDEN, 'utf8')) as BacktestResult);
    const actual = plain(runBacktest(data as never, request as never));
    expect(actual).toEqual(golden);
  });

  it('golden 覆盖除权 / 换手上限 / 停牌 / 缺 bar', () => {
    const r = runBacktest(data as never, request as never);
    expect(r.trades.length).toBeGreaterThan(3);
    expect(r.roundTrips.length).toBeGreaterThan(0);
    expect(r.dividends.length).toBeGreaterThan(0);
    expect(r.skipped.some((s) => s.reason === 'turnover-capped')).toBe(true);
    expect(r.skipped.some((s) => s.reason === 'suspended')).toBe(true);
  });
});

describe('S0 · 纸面落账复用回测路径', () => {
  it('targetsOverride 与策略路径产生相同的成交 / 跳过 / 净值', () => {
    const golden = runBacktest(data as never, request as never);
    const state = freshState();
    const dates = data.calendar.slice(request.start, request.end);

    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      const execDate = dates[dayIndex];
      if (dayIndex === 0) {
        // 区间首日没有 T-1：override 路径也必须原样返回 null（不推进、不估值）
        expect(stepBacktestDay(state, { dayIndex, execDate, targetsOverride: null })).toBeNull();
        continue;
      }
      const decision = golden.decisions.find((d) => d.execDate === execDate);
      expect(decision).toBeTruthy();
      // 决策时点权益 = 上一交易日收盘净值；区间首日（无前一日）即初始现金
      const equityAtCutoff =
        state.equity.length > 0 ? state.equity[state.equity.length - 1].equity : request.initialCash;
      stepBacktestDay(state, {
        dayIndex,
        execDate,
        targetsOverride: decision!.targets,
        equityAtCutoffOverride: equityAtCutoff,
      });
    }

    // drawdownRatio 由 runBacktest 末尾统一回填（不是逐日推进产物），故不参与逐位比对
    const noDd = (equity: readonly { drawdownRatio: number }[]) =>
      equity.map(({ drawdownRatio: _dd, ...rest }) => rest);
    expect(plain(noDd(state.equity))).toEqual(plain(noDd(golden.equity)));
    expect(plain(state.trades)).toEqual(plain(golden.trades));
    expect(plain(state.portfolio.roundTrips)).toEqual(plain(golden.roundTrips));
    expect(plain(state.portfolio.dividends)).toEqual(plain(golden.dividends));
    // 换手截断在 override 模式下由调用方负责（纸面落账自己截断并留痕），故只比对执行侧跳过
    const execSide = (d: {
      execDate: string;
      fills: unknown[];
      skipped: { reason: string }[];
      warnings: unknown[];
    }) => ({
      execDate: d.execDate,
      fills: d.fills,
      skipped: d.skipped.filter((s) => s.reason !== 'turnover-capped'),
      warnings: d.warnings,
    });
    expect(plain(state.decisions.map(execSide))).toEqual(plain(golden.decisions.map(execSide)));
  });

  it('override 路径不调用时点池与策略', () => {
    const state = freshState({
      data: {
        ...(data as never),
        universe: () => {
          throw new Error('override 路径不得调用时点池');
        },
      },
      strategy: defineStrategy({
        id: 'must-not-run',
        version: '0.0.1',
        name: 'must-not-run',
        paramSchema: [],
        warmupDays: 0,
        priceMode: 'open',
        decide() {
          throw new Error('override 路径不得调用策略');
        },
      }),
    });
    expect(stepBacktestDay(state, { dayIndex: 1, execDate: DATES[1], targetsOverride: null })).not.toBeNull();
  });
});

describe('S0 · 单日顺序：除权 → 成交 → 收盘估值', () => {
  it('同日的送转与分红先生效，卖出数量按送转后股数', () => {
    const dates = ['2024-01-02', '2024-01-03', '2024-01-04'];
    const prices = [10.0, 10.0, 10.6];
    const execBars = new Map([['sh510300', bars(dates, prices)]]);
    const dayData = {
      calendar: new TradingCalendar(dates),
      signalBars: execBars,
      execBars,
      benchmarkBars: [] as Bar[],
      universe: () => {
        throw new Error('override 路径不得调用时点池');
      },
      corporateActions: [
        { date: '2024-01-04', symbol: 'sh510300', kind: 'bonus' as const, bonusRatio: 0.1 },
        { date: '2024-01-04', symbol: 'sh510300', kind: 'dividend' as const, cashPerShare: 0.25 },
      ],
    };
    const state = freshState({ data: dayData });

    // D1：按决策时点权益满仓买入
    stepBacktestDay(state, {
      dayIndex: 1,
      execDate: dates[1],
      targetsOverride: { targets: [{ symbol: 'sh510300', targetWeight: 1 }], mode: 'replace' },
      equityAtCutoffOverride: 100_000,
    });
    const qty1 = state.portfolio.position('sh510300').qty;
    expect(qty1).toBeGreaterThan(0);

    // D2：先除权（送转 10% + 分红），再清仓
    stepBacktestDay(state, {
      dayIndex: 2,
      execDate: dates[2],
      targetsOverride: { targets: [], mode: 'replace' },
      equityAtCutoffOverride: state.equity[state.equity.length - 1].equity,
    });

    const bonusQty = qty1 * 1.1;
    const day = state.decisions[state.decisions.length - 1];
    expect(day.fills).toHaveLength(1);
    // 卖出量按送转后股数（先成交的话最多只能卖 qty1）
    expect(day.fills[0].qty).toBe(Math.floor(bonusQty));
    expect(day.fills[0].qty).toBeGreaterThan(qty1);
    // 分红基数也是送转后股数
    expect(state.portfolio.dividends).toHaveLength(1);
    expect(state.portfolio.dividends[0].amount).toBeCloseTo(bonusQty * 0.25, 6);

    // 收盘估值恒等式：清仓后净值 = 现金
    const last = state.equity[state.equity.length - 1];
    expect(last.riskMv).toBe(0);
    expect(last.cashMv).toBe(0);
    expect(last.equity).toBe(last.cash);
  });
});
