/**
 * M3 归因单测（**纯合成数据，不读 DuckDB**）—— 对应验收锚点 ② / ③
 *
 * 锚点 ②：归因可加性 —— 每个维度求和 == `totalPnl`，残差 ≤ 0.01 × 回合数
 * 锚点 ③：`totalPnl == riskPnl + cashPnl − fees`（浮点容差 1e-6）
 *
 * 用合成数据的原因与 M2 引擎单测一致：引擎/归因都是纯函数，CI 无行情库也能跑。
 */
import { describe, it, expect } from 'vitest';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import {
  runBacktest,
  type BacktestData,
  type BacktestRequest,
  type BacktestResult,
} from '../../src/services/backtest/engine.js';
import { defineStrategy } from '../../src/services/backtest/strategy/types.js';
import { computeAttribution, toAttributionRows } from '../../src/services/backtest/attribution/index.js';
import type {
  AttributionDimension,
  AttributionReport,
} from '../../src/services/backtest/attribution/types.js';
import type { CorporateAction } from '../../src/services/backtest/account/portfolio.js';
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
  '2024-01-12',
  '2024-01-15',
  '2024-01-16',
  '2024-01-17',
];

/** 决策留痕的走弱期分支（`branch_tag` 维度的输入） */
const REGIME_BY_DATE: Record<string, string> = {
  '2024-01-03': 'normal',
  '2024-01-08': 'weak',
  '2024-01-09': 'normal',
};

function makeBars(prices: readonly number[]): Bar[] {
  return DATES.map((date, i) => ({
    date,
    open: prices[i],
    high: prices[i],
    low: prices[i],
    close: prices[i],
    preclose: i > 0 ? prices[i - 1] : prices[i],
    volume: 1_000_000,
    amount: prices[i] * 1_000_000,
  }));
}

/** 最小 UniverseSnapshot（引擎只读 asOf / fixed / dynamic / weak / 阈值） */
function snapshot(asOf: string): UniverseSnapshot {
  return {
    requestedAsOf: asOf,
    asOf,
    liquidityDates: [asOf],
    liquidity: { dates: [asOf], totalByDate: [1e9], avgTotal: 1e9, threshold: 10_000_000, fallback: false },
    marketSymbolCount: 2,
    universeCount: 2,
    marketLiquidityPassCount: 2,
    fixedPoolSize: 2,
    fixedTradableCount: 2,
    fixedCoverageCount: 2,
    fixed: [],
    weak: [],
    dynamic: { groups: [], pool: [], excludedCount: 0, skippedCount: 0, specialCount: 0, normalCount: 0 },
  };
}

function makeData(
  series: Readonly<Record<string, readonly number[]>>,
  corporateActions: readonly CorporateAction[] = [],
): BacktestData {
  const barsBySymbol = new Map(Object.entries(series).map(([symbol, prices]) => [symbol, makeBars(prices)]));
  const benchmarkSymbol = barsBySymbol.has('sh510300') ? 'sh510300' : [...barsBySymbol.keys()][0];
  return {
    calendar: new TradingCalendar(DATES),
    signalBars: barsBySymbol,
    execBars: barsBySymbol,
    benchmarkBars: barsBySymbol.get(benchmarkSymbol) ?? [],
    universe: (asOf) => snapshot(asOf),
    corporateActions,
  };
}

function dimensionOf(
  report: AttributionReport,
  name: AttributionDimension['dimension'],
): AttributionDimension {
  const dim = report.dimensions.find((d) => d.dimension === name);
  if (!dim) throw new Error(`缺少归因维度：${name}`);
  return dim;
}

// ─────────────────────────────────────────────────────────────
// 场景 1：分红 + 止损卖出 + 期末两个未平仓（风险 1 + 现金 1）
// ─────────────────────────────────────────────────────────────
const SCENARIO_SERIES = {
  // 01-08（下标 4）跳空 −6.8%（未触发跌停）→ 止损卖出
  sh510300: [10, 10.1, 10.2, 10.3, 9.6, 9.7, 9.8, 9.9, 10.0, 10.1, 10.2, 10.3],
  // 防御 ETF：全程平价（现金桶）
  sh511880: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  // 期末未平仓的风险标的
  sz159915: [2.0, 2.02, 2.04, 2.06, 2.02, 2.05, 2.08, 2.1, 2.12, 2.15, 2.18, 2.2],
};

const SCENARIO_ACTIONS: readonly CorporateAction[] = [
  { date: '2024-01-04', symbol: 'sh510300', kind: 'dividend', cashPerShare: 0.05 },
  { date: '2024-01-16', symbol: 'sz159915', kind: 'dividend', cashPerShare: 0.02 },
];

const scenarioStrategy = defineStrategy({
  id: 'm3-attribution-scenario',
  version: '0.0.1',
  name: '归因场景（分红/止损/期末持仓）',
  paramSchema: [],
  warmupDays: 0,
  priceMode: 'open',
  decide(ctx) {
    ctx.tag('regime', REGIME_BY_DATE[ctx.execDate] ?? 'unknown');
    if (ctx.execDate === '2024-01-03') {
      return {
        targets: [{ symbol: 'sh510300', targetNotional: 30_000, reason: 'candidate-top' }],
        mode: 'incremental',
      };
    }
    if (ctx.execDate === '2024-01-08') {
      return {
        targets: [{ symbol: 'sh511880', targetNotional: 5_000, reason: 'defensive-fallback' }],
        mode: 'replace',
        exitReasons: { sh510300: 'stop-loss' },
      };
    }
    if (ctx.execDate === '2024-01-09') {
      return {
        targets: [
          { symbol: 'sh511880', targetNotional: 5_000, reason: 'defensive-fallback' },
          { symbol: 'sz159915', targetNotional: 20_000, reason: 'candidate-top' },
        ],
        mode: 'incremental',
      };
    }
    return null;
  },
});

function runScenario(): BacktestResult {
  const request: BacktestRequest = {
    strategy: scenarioStrategy,
    start: DATES[0],
    end: DATES[DATES.length - 1],
    initialCash: 100_000,
    benchmarkSymbol: 'sh510300',
  };
  return runBacktest(makeData(SCENARIO_SERIES, SCENARIO_ACTIONS), request);
}

describe('M3 归因 · 可加性（锚点 ②）', () => {
  it('每个维度求和 == totalPnl，残差 ≤ 0.01 × 回合数', () => {
    const result = runScenario();
    const report = computeAttribution(result, { initialCash: 100_000 });

    // 场景确实覆盖了三条路径：止损平仓、分红、期末未平仓
    expect(result.roundTrips.some((rt) => rt.exitReason === 'stop-loss')).toBe(true);
    expect(result.dividends.length).toBeGreaterThanOrEqual(2);

    const pseudoCount = dimensionOf(report, 'exit_reason').buckets.find(
      (b) => b.key === 'end-of-backtest',
    )?.tradeCount;
    expect(pseudoCount).toBe(2); // sh511880（现金桶）+ sz159915（风险桶）
    const unitCount = result.roundTrips.length + (pseudoCount ?? 0);

    for (const dim of report.dimensions) {
      expect(dim.residual).toBeLessThanOrEqual(0.01 * unitCount);
      expect(dim.sum).toBeCloseTo(report.totalPnl, 6);
    }
  });
});

describe('M3 归因 · 毛额恒等式（锚点 ③）', () => {
  it('totalPnl == riskPnl + cashPnl − fees，且 sh511880 落在 cash 桶', () => {
    const result = runScenario();
    const report = computeAttribution(result, { initialCash: 100_000 });

    expect(Math.abs(report.totalPnl - (report.riskPnl + report.cashPnl - report.fees))).toBeLessThanOrEqual(
      1e-6,
    );
    expect(report.identity.ok).toBe(true);

    const bucketDim = dimensionOf(report, 'bucket');
    expect(bucketDim.buckets.map((b) => b.key).sort()).toEqual(['cash', 'risk']);

    // 现金桶毛额 == 该标的自身现金流 + 期末现金类市值（证明 sh511880 未混进风险桶）
    const lastPoint = result.equity[result.equity.length - 1];
    let expectedCashPnl = lastPoint.cashMv;
    for (const t of result.trades.filter((t) => t.symbol === 'sh511880')) {
      expectedCashPnl += t.side === 'buy' ? -(t.qty * t.price) : t.qty * t.price;
    }
    for (const d of result.dividends.filter((d) => d.symbol === 'sh511880')) {
      expectedCashPnl += d.amount;
    }
    expect(report.cashPnl).toBeCloseTo(expectedCashPnl, 6);
  });
});

describe('M3 归因 · 期末未平仓伪回合', () => {
  it('伪回合同时出现在 round_trip_id 与 exit_reason=end-of-backtest 两个维度', () => {
    const result = runScenario();
    const report = computeAttribution(result, { initialCash: 100_000 });

    const rtDim = dimensionOf(report, 'round_trip_id');
    expect(rtDim.buckets.some((b) => b.key.startsWith('eob-sh511880-'))).toBe(true);
    expect(rtDim.buckets.some((b) => b.key.startsWith('eob-sz159915-'))).toBe(true);

    const exitDim = dimensionOf(report, 'exit_reason');
    expect(exitDim.buckets.some((b) => b.key === 'end-of-backtest')).toBe(true);
    expect(exitDim.buckets.some((b) => b.key === 'stop-loss')).toBe(true);
  });
});

describe('M3 归因 · 分红归属', () => {
  it('每笔分红只归属一次：Σ归属 == Σresult.dividends', () => {
    const result = runScenario();
    const report = computeAttribution(result, { initialCash: 100_000 });
    const symDim = dimensionOf(report, 'symbol');

    // sh510300 只有一笔平仓回合，派现日（01-04）在其后 → 全部分红进该回合
    const rts510300 = result.roundTrips.filter((rt) => rt.symbol === 'sh510300');
    const divs510300 = result.dividends.filter((d) => d.symbol === 'sh510300');
    expect(rts510300).toHaveLength(1);
    expect(divs510300.length).toBeGreaterThan(0);

    const bucket = symDim.buckets.find((b) => b.key === 'sh510300');
    expect(bucket).toBeDefined();
    const expected =
      rts510300.reduce((s, rt) => s + rt.pnl, 0) + divs510300.reduce((s, d) => s + d.amount, 0);
    expect(bucket!.pnl).toBeCloseTo(expected, 6);

    // 总量校验：symbol 维求和 == totalPnl ⇒ 分红既没漏、也没重复计入
    expect(symDim.sum).toBeCloseTo(report.totalPnl, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// 场景 2/3：>10 个标的 → `其它` 合并 + 20% 告警阈值
// ─────────────────────────────────────────────────────────────
const MANY_SYMBOLS = [
  'sh510300',
  'sh510500',
  'sh510880',
  'sh512000',
  'sh512100',
  'sh512480',
  'sh512880',
  'sh515000',
  'sh515790',
  'sz159915',
  'sz159919',
  'sz159949',
  'sz159995',
];
/** 13 只标的同一条价格路径：10 → 10.5（期末前全部清仓） */
const MANY_PRICES = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10.5, 10.6, 10.7];

function runManySymbols(weights: Readonly<Record<string, number>>): BacktestResult {
  const symbols = Object.keys(weights);
  const series: Record<string, readonly number[]> = {};
  for (const symbol of symbols) series[symbol] = MANY_PRICES;

  const strategy = defineStrategy({
    id: 'm3-attribution-many',
    version: '0.0.1',
    name: '多标的归因（其它桶）',
    paramSchema: [],
    warmupDays: 0,
    priceMode: 'open',
    decide(ctx) {
      if (ctx.execDate === DATES[1]) {
        return {
          targets: symbols.map((symbol) => ({
            symbol,
            targetNotional: weights[symbol],
            reason: 'candidate-top' as const,
          })),
          mode: 'incremental',
        };
      }
      if (ctx.execDate === DATES[9]) {
        return { targets: [], mode: 'replace' };
      }
      return null;
    },
  });

  return runBacktest(makeData(series), {
    strategy,
    start: DATES[0],
    end: DATES[DATES.length - 1],
    initialCash: 100_000,
    benchmarkSymbol: symbols[0],
  });
}

describe('M3 归因 · 输出纪律（其它桶 + 20% 告警）', () => {
  it('13 只等权标的：第 11 名以后合并为其它，占比 > 20% → 告警', () => {
    const weights: Record<string, number> = {};
    for (const symbol of MANY_SYMBOLS) weights[symbol] = 4_000;

    const report = computeAttribution(runManySymbols(weights), { initialCash: 100_000 });
    const symDim = dimensionOf(report, 'symbol');

    expect(symDim.buckets).toHaveLength(11); // 10 + 其它
    const other = symDim.buckets.find((b) => b.key === '其它');
    expect(other).toBeDefined();
    expect(other!.mergedCount).toBe(3);
    // 等权 ⇒ 其它 占 Σ|pnl| ≈ 3/13 ≈ 23%
    expect(report.warnings.some((w) => w.startsWith('symbol:') && w.includes('> 20%'))).toBe(true);
    // 合并后仍可加
    expect(symDim.sum).toBeCloseTo(report.totalPnl, 6);
  });

  it('一只标的占绝对多数：其它 桶存在但占比 < 20% → 不告警', () => {
    const weights: Record<string, number> = {};
    MANY_SYMBOLS.forEach((symbol, i) => (weights[symbol] = i === 0 ? 60_000 : 1_000));

    const report = computeAttribution(runManySymbols(weights), { initialCash: 100_000 });
    const symDim = dimensionOf(report, 'symbol');

    expect(symDim.buckets).toHaveLength(11);
    expect(symDim.buckets.some((b) => b.key === '其它')).toBe(true);
    expect(report.warnings.some((w) => w.startsWith('symbol:'))).toBe(false);
    expect(symDim.sum).toBeCloseTo(report.totalPnl, 6);
  });
});

describe('M3 归因 · 落库扁平行', () => {
  it('行数 == 各维桶数之和，bucketType 覆盖全部 7 个维度', () => {
    const result = runScenario();
    const report = computeAttribution(result, { initialCash: 100_000 });
    const rows = toAttributionRows(report);

    const expected = report.dimensions.reduce((s, d) => s + d.buckets.length, 0);
    expect(rows).toHaveLength(expected);

    const types = [...new Set(rows.map((r) => r.bucketType))].sort();
    expect(types).toEqual(
      ['branch_tag', 'bucket', 'exit_reason', 'month', 'round_trip_id', 'symbol', 'year'].sort(),
    );

    for (const row of rows) {
      expect(typeof row.detail?.contributionPct).toBe('number');
    }
    expect(rows.some((r) => r.bucketType === 'exit_reason' && r.detail?.exitReason === 'stop-loss')).toBe(
      true,
    );
  });
});
