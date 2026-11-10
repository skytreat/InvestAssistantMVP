/**
 * DualMomentum 纯诊断脚本（**独立进程，不改策略主路径 / 不改 L1 口径**）
 *
 * 诊断 1：逐层拆过滤（leave-one-out），回答「41.6% 空仓主要是哪一层造成的」。
 * 诊断 2：池子相关性与动量横截面信息量（Spearman IC）。
 *
 * 约束与自证：
 * 1. 面板装载逐字复刻 `dmSweep.ts`（后者已与 `cli.ts` 基线逐位对齐）；
 * 2. 过滤链判定在本文件内复刻，**全开模式必须与 `evaluateL1Filters` 逐日逐标的完全一致**，
 *    不一致立即抛错退出（防止复刻漂移污染结论）；
 * 3. 回测只通过**现有参数**表达「关掉某层」（`wsmMin/wsmMax`、`rsrsMin/rsrsMax`、
 *    `dailyChangeMin/Max`），MA 层与基准过滤层无参数可关，只给 L1 统计、不伪造回测指标；
 * 4. 只读 DuckDB，产物写 `data/dm-diagnose/`（已被 .gitignore 覆盖）。
 *
 * 用法：npx tsx apps/backend/src/services/backtest/optimize/dmDiagnose.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTradingCalendar } from '../calendar.js';
import { getBars } from '../marketPanel.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL, GLOBAL_ETF_POOL } from '../universe/fixedPool.js';
import { WEAK_PERIOD_INDEXES } from '../universe/pointInTime.js';
import { loadUniverseProvider } from '../universe/provider.js';
import { loadIndexBars } from '../universe/dynamicPanel.js';
import { loadCorporateActions } from '../corporateActions.js';
import { runBacktest, type BacktestData, type BacktestResult } from '../engine.js';
import type { Bar } from '../types.js';
import { createDualMomentumStrategy } from '../strategies/dualmomentum/index.js';
import {
  BENCHMARK_SYMBOL,
  DAILY_CHANGE_EPSILON,
  DAILY_CHANGE_MAX,
  DAILY_CHANGE_MIN,
  DEFAULT_LIMIT_RATIO,
  POOL_ORDER,
} from '../strategies/dualmomentum/l1/params.js';
import {
  evaluateL1Filters,
  computeBenchmarkPrimary,
  type L1FilterInput,
  type L1FilterResult,
} from '../strategies/dualmomentum/l1/decisions.js';
import {
  calcMa,
  calcNdayReturnMomentum,
  calcRsrsZ,
  calcWeightedSlopeMomentum,
} from '../strategies/dualmomentum/l1/indicators.js';
import type { PriceBar, RejectReason } from '../strategies/dualmomentum/l1/types.js';
import {
  dualMomentumLookback,
  resolveDualMomentumParams,
  type DualMomentumParams,
} from '../strategies/dualmomentum/params.js';

const START = '2019-01-02';
const END = '2026-11-06';
const INITIAL_CASH = 1_000_000;
const SEG_A_START = '2019-01-02';
const SEG_A_END = '2023-12-29';
const SEG_B_START = '2024-01-02';
const SEG_B_END = '2026-11-06';
const WARMUP = 61;
const OUT_DIR = path.resolve('data/dm-diagnose');

/** 基线自证（与 `dmSweep --check-baseline` 同源） */
const BASELINE = { finalEquity: 1_189_224.15, trades: 1780 };

type Layer = 'dailyChange' | 'ma' | 'wsmRange' | 'rsrsRange' | 'benchmark';
type Disabled = ReadonlySet<Layer>;

// ────────────────────────────── 面板装载（复刻 dmSweep.ts） ──────────────────────────────

async function loadPanel(): Promise<BacktestData> {
  const calendar = await loadTradingCalendar();
  const loadStart = calendar.lastN(START, WARMUP)[0] ?? START;
  const extraSymbols = [
    ...new Set([...FIXED_ETF_POOL, ...GLOBAL_ETF_POOL, DEFENSIVE_ETF, BENCHMARK_SYMBOL, ...POOL_ORDER]),
  ];
  const symbols = [...new Set([...extraSymbols, ...WEAK_PERIOD_INDEXES])];

  const [sig, exe, provider, ca] = await Promise.all([
    getBars(symbols, loadStart, END, { adjust: 'qfq' }),
    getBars(symbols, loadStart, END, { adjust: 'bfq' }),
    loadUniverseProvider(START, END, { calendar, divisor: 20000, topN: 300 }),
    loadCorporateActions(symbols, loadStart, END),
  ]);

  const indexBars = new Map<string, readonly Bar[]>(
    WEAK_PERIOD_INDEXES.map((code) => [code, sig.get(code) ?? []]),
  );
  const realIndex = await loadIndexBars([BENCHMARK_SYMBOL], loadStart, END);
  for (const [code, bars] of realIndex) indexBars.set(code, bars);

  return {
    calendar,
    signalBars: sig,
    execBars: exe,
    benchmarkBars: exe.get(BENCHMARK_SYMBOL) ?? indexBars.get(BENCHMARK_SYMBOL) ?? [],
    indexBars,
    universe: (asOf) => provider.snapshotAt(asOf),
    corporateActions: ca,
  };
}

function runTrial(
  data: BacktestData,
  params: DualMomentumParams,
  overrides: Record<string, unknown> = {},
): BacktestResult {
  return runBacktest(data, {
    strategy: createDualMomentumStrategy(),
    params: { ...(params as unknown as Record<string, unknown>), ...overrides },
    start: START,
    end: END,
    initialCash: INITIAL_CASH,
    universeMode: 'fixed',
    priceMode: 'open',
    benchmarkSymbol: BENCHMARK_SYMBOL,
    suspension: { missingBar: true, zeroVolume: true },
    universeParams: { divisor: 20000, topN: 300 },
    rules: {
      commissionRate: params.commissionRate,
      minCommission: params.minCommission,
      slippageRate: params.slippage,
      lotSize: params.lotSize,
      stampDutyRate: params.etfExemptTax ? 0 : 0.001,
      transferFeeRate: 0,
    },
  });
}

// ────────────────────────────── L1 过滤复刻（带诊断开关） ──────────────────────────────

/** 与 `l1/decisions.ts` 的 `evaluateL1Filters` 逐条同构；`disabled` 只影响本脚本。 */
function filterWithSwitch(input: L1FilterInput, disabled: Disabled): L1FilterResult {
  if (!input.inPool) return { pass: false, reason: 'POOL_ABSENT' };
  if (!input.hasBar || input.snapshotPrice === null || !(input.snapshotPrice > 0)) {
    return { pass: false, reason: 'SUSPENDED' };
  }
  if (input.cooling) return { pass: false, reason: 'COOLDOWN' };

  const price = input.snapshotPrice;
  const upLimit = input.prevCloseAdj * (1 + input.limitRatio);
  const downLimit = input.prevCloseAdj * (1 - input.limitRatio);
  if (price >= upLimit || price <= downLimit) return { pass: false, reason: 'AT_LIMIT' };

  if (!disabled.has('dailyChange')) {
    const change = input.prevCloseAdj > 0 ? price / input.prevCloseAdj - 1 : Number.NaN;
    const min = input.dailyChangeMin ?? DAILY_CHANGE_MIN;
    const max = input.dailyChangeMax ?? DAILY_CHANGE_MAX;
    if (
      !Number.isFinite(change) ||
      change < min - DAILY_CHANGE_EPSILON ||
      change > max + DAILY_CHANGE_EPSILON
    ) {
      return { pass: false, reason: 'DAILY_CHANGE_OUT_OF_RANGE' };
    }
  }

  if (!disabled.has('ma')) {
    const { ma5, ma10, ma20, ma60 } = input;
    if (ma20 === null || ma20 <= 0 || !(price > ma20)) {
      return { pass: false, reason: 'BELOW_MA20' };
    }
    if (ma5 === null || ma10 === null || ma60 === null || !(ma5 > ma10 && ma10 > ma20 && ma20 > ma60)) {
      return { pass: false, reason: 'MA_NOT_BULLISH' };
    }
  }

  if (!disabled.has('wsmRange') && !inClosedRange(input.primary, input.primaryRange)) {
    return { pass: false, reason: 'MOMENTUM_OUT_OF_RANGE' };
  }
  if (!disabled.has('rsrsRange') && !inClosedRange(input.secondary, input.secondaryRange)) {
    return { pass: false, reason: 'MOMENTUM_OUT_OF_RANGE' };
  }
  if (!disabled.has('benchmark') && !(input.primary >= input.benchmarkPrimary)) {
    return { pass: false, reason: 'BELOW_BENCHMARK' };
  }
  return { pass: true, reason: null };
}

function inClosedRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

function isUsable(bar: Bar): boolean {
  if (!Number.isFinite(bar.volume) || bar.volume <= 0) return false;
  return [bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0);
}

function lastUsableClose(bars: readonly Bar[], idx: number): number | null {
  for (let i = idx; i >= 0; i -= 1) {
    if (isUsable(bars[i])) return bars[i].close;
  }
  return null;
}

/** `Bar`（回测引擎视图）→ `PriceBar`（L1 视图）；本脚本只用 `date`/`close`。 */
function toPriceBars(bars: readonly Bar[]): PriceBar[] {
  return bars.map((b) => ({ ...b, amount: 0, hfqFactor: 1 }));
}

function lastIndexAtOrBefore(bars: readonly Bar[], date: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

interface IndicatorSet {
  wsm: number;
  nday: number;
  rsrs: number;
  ma: Partial<Record<number, number>>;
}

/** 与策略 `calcIndicators` 同构（纯调用 l1/indicators 的导出函数）。 */
function calcIndicators(bars: readonly Bar[], p: DualMomentumParams): IndicatorSet {
  const need = dualMomentumLookback(p);
  if (bars.length < need) return { wsm: 0, nday: 0, rsrs: 0, ma: {} };
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const rsrsWindow = p.rsrsPeriod + p.rsrsStdPeriod;
  const wsm = calcWeightedSlopeMomentum(closes.slice(-p.wsmPeriod), p.useWsmV2);
  const nday = calcNdayReturnMomentum(closes, p.ndayReturnPeriod, p.ndayReturnAnnualize);
  const rsrs = calcRsrsZ(
    highs.slice(-rsrsWindow),
    lows.slice(-rsrsWindow),
    p.rsrsPeriod,
    p.rsrsStdPeriod,
    p.rsrsQualityFilter,
  );
  const ma: Partial<Record<number, number>> = {};
  for (const period of [p.maPeriod1, p.maPeriod2, p.maPeriod3, p.maPeriod4]) {
    ma[period] = calcMa(closes, period);
  }
  return { wsm, nday, rsrs, ma };
}

function maOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

interface DayStat {
  date: string;
  passCount: number;
  counts: Map<RejectReason, number>;
}

interface FilterStats {
  days: number;
  daysNoCandidate: number;
  avgPassing: number;
  passDayRatio: number;
  counts: Record<string, number>;
  totalEvaluations: number;
}

function emptyCounts(): Record<string, number> {
  return {
    POOL_ABSENT: 0,
    SUSPENDED: 0,
    COOLDOWN: 0,
    AT_LIMIT: 0,
    DAILY_CHANGE_OUT_OF_RANGE: 0,
    BELOW_MA20: 0,
    MA_NOT_BULLISH: 0,
    MOMENTUM_OUT_OF_RANGE: 0,
    BELOW_BENCHMARK: 0,
    PASS: 0,
  };
}

/** 逐日逐标的跑过滤链；返回每日通过数与原因码累计。 */
function computeFilterStats(
  data: BacktestData,
  p: DualMomentumParams,
  benchmarkPrices: readonly PriceBar[],
  disabled: Disabled,
): { stats: FilterStats; perDay: Map<string, DayStat> } {
  const days = data.calendar.slice(START, END);
  const counts = emptyCounts();
  const perDay = new Map<string, DayStat>();
  let passDay = 0;
  let noCandidate = 0;
  let totalPass = 0;

  for (const date of days) {
    const dayCounts = new Map<RejectReason, number>();
    let passCount = 0;
    const benchmarkPrimary = computeBenchmarkPrimary(benchmarkPrices, date, 'wsm');

    for (const symbol of POOL_ORDER) {
      const bars = data.signalBars.get(symbol) ?? [];
      const idx = lastIndexAtOrBefore(bars, date);
      const reason = evaluateOne(bars, idx, date, p, benchmarkPrimary, disabled);
      if (reason === null) {
        passCount += 1;
        counts.PASS += 1;
      } else {
        counts[reason] += 1;
        dayCounts.set(reason, (dayCounts.get(reason) ?? 0) + 1);
      }
    }

    totalPass += passCount;
    if (passCount > 0) passDay += 1;
    else noCandidate += 1;
    perDay.set(date, { date, passCount, counts: dayCounts });
  }

  return {
    stats: {
      days: days.length,
      daysNoCandidate: noCandidate,
      avgPassing: days.length > 0 ? totalPass / days.length : Number.NaN,
      passDayRatio: days.length > 0 ? passDay / days.length : Number.NaN,
      counts,
      totalEvaluations: days.length * POOL_ORDER.length,
    },
    perDay,
  };
}

/** 单标的单日判定：展开输入 → 带开关的过滤链。 */
function evaluateOne(
  bars: readonly Bar[],
  idx: number,
  date: string,
  p: DualMomentumParams,
  benchmarkPrimary: number,
  disabled: Disabled,
): RejectReason | null {
  return filterWithSwitch(expandInput(bars, idx, date, p, benchmarkPrimary), disabled).reason;
}

/** 自证：全开模式下本文件复刻版必须与生产 `evaluateL1Filters` 逐日逐标的完全一致。 */
function assertReplicaMatchesProduction(
  data: BacktestData,
  p: DualMomentumParams,
  benchmarkPrices: readonly PriceBar[],
): void {
  const days = data.calendar.slice(START, END);
  let checked = 0;
  let mismatched = 0;
  for (const date of days) {
    const benchmarkPrimary = computeBenchmarkPrimary(benchmarkPrices, date, 'wsm');
    for (const symbol of POOL_ORDER) {
      const bars = data.signalBars.get(symbol) ?? [];
      const idx = lastIndexAtOrBefore(bars, date);
      const expanded = expandInput(bars, idx, date, p, benchmarkPrimary);
      const own = filterWithSwitch(expanded, new Set()).reason;
      const prod = evaluateL1Filters(expanded).reason;
      checked += 1;
      if (own !== prod) {
        mismatched += 1;
        if (mismatched <= 3) {
          console.error(`复刻不一致：${date} ${symbol} own=${own} prod=${prod}`);
        }
      }
    }
  }
  if (mismatched > 0) {
    throw new Error(`过滤链复刻与生产实现不一致（${mismatched}/${checked}），拒绝用其结论`);
  }
  console.log(`自证通过：过滤链复刻与 evaluateL1Filters 逐日逐标的完全一致（${checked} 次）`);
}

function expandInput(
  bars: readonly Bar[],
  idx: number,
  date: string,
  p: DualMomentumParams,
  benchmarkPrimary: number,
): L1FilterInput {
  if (idx < 0) {
    return {
      inPool: true,
      hasBar: false,
      snapshotPrice: null,
      prevCloseAdj: 0,
      ma5: null,
      ma10: null,
      ma20: null,
      ma60: null,
      primary: 0,
      secondary: 0,
      benchmarkPrimary,
      primaryRange: [p.wsmMin, p.wsmMax],
      secondaryRange: [p.rsrsMin, p.rsrsMax],
      cooling: false,
      limitRatio: DEFAULT_LIMIT_RATIO,
      dailyChangeMin: p.dailyChangeMin,
      dailyChangeMax: p.dailyChangeMax,
    };
  }
  const last = bars[idx];
  const hasBar = last.date === date;
  const usable = hasBar && isUsable(last);
  const snapshotPrice = usable ? last.close : lastUsableClose(bars, idx);
  const prevCloseAdj = idx >= 1 && bars[idx - 1].close > 0 ? bars[idx - 1].close : last.close;
  const lookback = dualMomentumLookback(p);
  const window = bars.slice(Math.max(0, idx - (lookback - 1)), idx + 1);
  const ind = calcIndicators(window, p);
  return {
    inPool: true,
    hasBar,
    snapshotPrice,
    prevCloseAdj,
    ma5: maOrNull(ind.ma[p.maPeriod1]),
    ma10: maOrNull(ind.ma[p.maPeriod2]),
    ma20: maOrNull(ind.ma[p.maPeriod3]),
    ma60: maOrNull(ind.ma[p.maPeriod4]),
    primary: ind.wsm,
    secondary: ind.rsrs,
    benchmarkPrimary,
    primaryRange: [p.wsmMin, p.wsmMax],
    secondaryRange: [p.rsrsMin, p.rsrsMax],
    cooling: false,
    limitRatio: DEFAULT_LIMIT_RATIO,
    dailyChangeMin: p.dailyChangeMin,
    dailyChangeMax: p.dailyChangeMax,
  };
}

// ────────────────────────────── 诊断 1 主流程 ──────────────────────────────

const L1_GROUPS: { key: string; label: string; disabled: Layer[] }[] = [
  { key: 'full', label: '全留（默认）', disabled: [] },
  {
    key: 'only-ma',
    label: '仅 MA（含停牌/涨跌停）',
    disabled: ['dailyChange', 'wsmRange', 'rsrsRange', 'benchmark'],
  },
  {
    key: 'only-wsm',
    label: '仅 WSM 区间（含停牌/涨跌停）',
    disabled: ['dailyChange', 'ma', 'rsrsRange', 'benchmark'],
  },
  {
    key: 'only-rsrs',
    label: '仅 RSRS 区间（含停牌/涨跌停）',
    disabled: ['dailyChange', 'ma', 'wsmRange', 'benchmark'],
  },
  { key: 'ma+wsm', label: 'MA + WSM', disabled: ['dailyChange', 'rsrsRange', 'benchmark'] },
  { key: 'ma+wsm+rsrs', label: 'MA + WSM + RSRS', disabled: ['dailyChange', 'benchmark'] },
  { key: 'full-ma', label: '去掉 MA 层', disabled: ['ma'] },
  { key: 'full-wsm', label: '去掉 WSM 区间', disabled: ['wsmRange'] },
  { key: 'full-rsrs', label: '去掉 RSRS 区间', disabled: ['rsrsRange'] },
  { key: 'full-bench', label: '去掉基准过滤', disabled: ['benchmark'] },
  { key: 'full-daily', label: '去掉日涨跌过滤', disabled: ['dailyChange'] },
];

/** 只用现有参数能表达的「关层」回测组（MA / 基准无参数可关） */
const BACKTEST_GROUPS: { key: string; label: string; overrides: Record<string, unknown> }[] = [
  { key: 'bt-baseline', label: '默认（全留）', overrides: {} },
  { key: 'bt-no-wsm', label: '去掉 WSM 区间', overrides: { wsmMin: -1e9, wsmMax: 1e9 } },
  { key: 'bt-no-rsrs', label: '去掉 RSRS 区间', overrides: { rsrsMin: -1e9, rsrsMax: 1e9 } },
  { key: 'bt-no-daily', label: '去掉日涨跌过滤', overrides: { dailyChangeMin: -1e9, dailyChangeMax: 1e9 } },
  {
    key: 'bt-no-wsm-rsrs',
    label: '去掉 WSM + RSRS 区间',
    overrides: { wsmMin: -1e9, wsmMax: 1e9, rsrsMin: -1e9, rsrsMax: 1e9 },
  },
  {
    key: 'bt-ma-only-approx',
    label: '仅 MA + 基准（近似）',
    overrides: {
      wsmMin: -1e9,
      wsmMax: 1e9,
      rsrsMin: -1e9,
      rsrsMax: 1e9,
      dailyChangeMin: -1e9,
      dailyChangeMax: 1e9,
    },
  },
];

function cagrBetween(first: number, last: number, fromDate: string, toDate: string): number {
  const days = (Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000;
  if (!(days > 0) || !(first > 0) || !(last > 0)) return Number.NaN;
  return (last / first) ** (365.25 / days) - 1;
}

interface BacktestRow {
  key: string;
  label: string;
  cagr: number;
  maxDrawdown: number;
  calmar: number;
  avgExposure: number;
  allCashRatio: number;
  trades: number;
  turnover: number;
  volatility: number;
  finalEquity: number;
  segACagr: number;
  segBCagr: number;
}

function summarizeBacktest(key: string, label: string, r: BacktestResult): BacktestRow {
  const m = r.metrics;
  const eq = r.equity;
  const allCash = eq.filter((p) => p.riskMv === 0 && p.cashMv === 0).length;
  const segA = eq.filter((p) => p.date >= SEG_A_START && p.date <= SEG_A_END);
  const segB = eq.filter((p) => p.date >= SEG_B_START && p.date <= SEG_B_END);
  return {
    key,
    label,
    cagr: m.cagr,
    maxDrawdown: m.maxDrawdownRatio,
    calmar: m.calmarRatio,
    avgExposure: m.averageExposure,
    allCashRatio: eq.length > 0 ? allCash / eq.length : Number.NaN,
    trades: r.trades.length,
    turnover: m.turnoverAnnualized,
    volatility: m.annualizedVolatility,
    finalEquity: m.finalEquity,
    segACagr:
      segA.length > 1
        ? cagrBetween(segA[0].equity, segA[segA.length - 1].equity, segA[0].date, segA[segA.length - 1].date)
        : Number.NaN,
    segBCagr:
      segB.length > 1
        ? cagrBetween(segB[0].equity, segB[segB.length - 1].equity, segB[0].date, segB[segB.length - 1].date)
        : Number.NaN,
  };
}

// ────────────────────────────── 诊断 2：相关性与 IC ──────────────────────────────

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3 || n !== ys.length) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return Number.NaN;
  return sxy / Math.sqrt(sxx * syy);
}

function ranks(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length < 3) return Number.NaN;
  return pearson(ranks(xs), ranks(ys));
}

interface CorrResult {
  avgPairwise: number;
  minPair: { a: string; b: string; rho: number } | null;
  maxPair: { a: string; b: string; rho: number } | null;
  matrix: number[][];
}

function correlationOf(symbols: readonly string[], returns: Map<string, Map<string, number>>): CorrResult {
  const n = symbols.length;
  const matrix: number[][] = [];
  const pairs: { a: string; b: string; rho: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    matrix.push(new Array<number>(n).fill(Number.NaN));
  }
  for (let i = 0; i < n; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const a = returns.get(symbols[i]);
      const b = returns.get(symbols[j]);
      if (!a || !b) continue;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [date, r] of a) {
        const rb = b.get(date);
        if (rb !== undefined) {
          xs.push(r);
          ys.push(rb);
        }
      }
      const rho = pearson(xs, ys);
      matrix[i][j] = rho;
      matrix[j][i] = rho;
      if (Number.isFinite(rho)) pairs.push({ a: symbols[i], b: symbols[j], rho });
    }
  }
  pairs.sort((x, y) => x.rho - y.rho);
  return {
    avgPairwise: pairs.length > 0 ? pairs.reduce((s, p) => s + p.rho, 0) / pairs.length : Number.NaN,
    minPair: pairs[0] ?? null,
    maxPair: pairs[pairs.length - 1] ?? null,
    matrix,
  };
}

/** 日收益（前复权收盘，按 bar 序列相邻两根；停牌不跨日填充，直接跳过该日） */
function dailyReturns(bars: readonly Bar[], from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < bars.length; i += 1) {
    const d = bars[i].date;
    if (d < from || d > to) continue;
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev > 0 && cur > 0 && isUsable(bars[i])) out.set(d, cur / prev - 1);
  }
  return out;
}

interface IcSummary {
  n: number;
  mean: number;
  std: number;
  icir: number;
  posRatio: number;
  tStat: number;
}

function summarizeIc(series: readonly number[]): IcSummary {
  const n = series.length;
  if (n === 0) {
    return {
      n: 0,
      mean: Number.NaN,
      std: Number.NaN,
      icir: Number.NaN,
      posRatio: Number.NaN,
      tStat: Number.NaN,
    };
  }
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let variance = 0;
  for (const v of series) variance += (v - mean) ** 2;
  variance /= n;
  const std = Math.sqrt(variance);
  const pos = series.filter((v) => v > 0).length;
  return {
    n,
    mean,
    std,
    icir: std > 0 ? mean / std : Number.NaN,
    posRatio: pos / n,
    tStat: std > 0 ? (mean / std) * Math.sqrt(n) : Number.NaN,
  };
}

type ScoreFn = (bars: readonly Bar[], idx: number) => number;

interface IcSeries {
  dates: string[];
  values: number[];
}

/**
 * 横截面 IC：每日对池内标的的动量分与后续 k 日收益做 Spearman。
 * 只有「当日有 bar 且指标不全为 0」的标的进入横截面。
 */
function computeIc(
  data: BacktestData,
  p: DualMomentumParams,
  scoreFn: ScoreFn,
  horizon: number,
  from: string,
  to: string,
): IcSeries {
  const days = data.calendar.slice(from, to);
  const dates: string[] = [];
  const values: number[] = [];
  const lookback = dualMomentumLookback(p);

  for (const date of days) {
    const futureDate = data.calendar.next(date, horizon);
    if (futureDate === null) break;
    const scores: number[] = [];
    const fwd: number[] = [];

    for (const symbol of POOL_ORDER) {
      const bars = data.signalBars.get(symbol) ?? [];
      const idx = lastIndexAtOrBefore(bars, date);
      if (idx < lookback - 1) continue;
      if (bars[idx].date !== date) continue; // 当日无 bar（停牌）不进入横截面
      if (!isUsable(bars[idx])) continue;
      const fIdx = lastIndexAtOrBefore(bars, futureDate);
      if (fIdx <= idx) continue;
      const fwdRet = bars[fIdx].close / bars[idx].close - 1;
      if (!Number.isFinite(fwdRet)) continue;
      const score = scoreFn(bars, idx);
      if (!Number.isFinite(score)) continue;
      scores.push(score);
      fwd.push(fwdRet);
    }

    if (scores.length < 3) continue;
    const ic = spearman(scores, fwd);
    if (!Number.isFinite(ic)) continue;
    dates.push(date);
    values.push(ic);
  }
  return { dates, values };
}

// ────────────────────────────── 输出 ──────────────────────────────

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'n/a');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

async function main(): Promise<void> {
  const t0 = Date.now();
  const data = await loadPanel();
  const p = resolveDualMomentumParams({});
  /** 基准过滤用真实指数序列（与策略 `ctx.indexSeries` 同源），不是 ETF 价格。 */
  const benchmarkPrices = toPriceBars(data.indexBars?.get(BENCHMARK_SYMBOL) ?? data.benchmarkBars);
  console.log(
    `面板：${data.signalBars.size} 只 / sh000300 ${data.benchmarkBars.length} 根 / ` +
      `sh510300 ${(data.signalBars.get('sh510300') ?? []).length} 根`,
  );

  assertReplicaMatchesProduction(data, p, benchmarkPrices);

  // 基线自证：装载或参数若有漂移，这里立刻暴露
  const baselineResult = runTrial(data, p);
  const bm = baselineResult.metrics;
  const baselineOk =
    Math.abs(bm.finalEquity - BASELINE.finalEquity) < 0.01 &&
    baselineResult.trades.length === BASELINE.trades;
  console.log(
    `基线自证：final=${bm.finalEquity.toFixed(2)} trades=${baselineResult.trades.length} ` +
      `${baselineOk ? 'OK' : 'MISMATCH'}`,
  );
  if (!baselineOk) throw new Error('基线自证失败：装载或参数存在漂移，拒绝用其结论');

  // ── 诊断 1：L1 逐层统计 ──
  const l1Rows: {
    key: string;
    label: string;
    stats: FilterStats;
  }[] = [];
  const perDayMap = new Map<string, Map<string, DayStat>>();
  for (const g of L1_GROUPS) {
    const { stats, perDay } = computeFilterStats(data, p, benchmarkPrices, new Set(g.disabled));
    l1Rows.push({ key: g.key, label: g.label, stats });
    perDayMap.set(g.key, perDay);
    console.log(
      `L1 ${g.label}: 无候选天 ${pct(stats.daysNoCandidate / stats.days)} / ` +
        `有候选天 ${pct(stats.passDayRatio)} / 平均通过 ${stats.avgPassing.toFixed(2)} 只`,
    );
  }

  // ── 诊断 1：空仓归因（默认组） ──
  const fullPerDay = perDayMap.get('full');
  if (!fullPerDay) throw new Error('缺少 full 组统计');
  let cashDays = 0;
  let cashNoCandidate = 0;
  let cashHasCandidate = 0;
  const cashByYear = new Map<string, { total: number; noCandidate: number }>();
  for (const point of baselineResult.equity) {
    const isCash = point.riskMv === 0 && point.cashMv === 0;
    if (!isCash) continue;
    cashDays += 1;
    const day = fullPerDay.get(point.date);
    const noCand = day === undefined || day.passCount === 0;
    if (noCand) cashNoCandidate += 1;
    else cashHasCandidate += 1;
    const year = point.date.slice(0, 4);
    const bucket = cashByYear.get(year) ?? { total: 0, noCandidate: 0 };
    bucket.total += 1;
    if (noCand) bucket.noCandidate += 1;
    cashByYear.set(year, bucket);
  }

  // ── 诊断 1：参数化回测（只有 3 层可用参数表达） ──
  const btRows: BacktestRow[] = [];
  for (const g of BACKTEST_GROUPS) {
    const result = runTrial(data, p, g.overrides);
    const row = summarizeBacktest(g.key, g.label, result);
    btRows.push(row);
    console.log(
      `BT ${g.label}: cagr=${pct(row.cagr)} mdd=${pct(row.maxDrawdown)} expo=${pct(row.avgExposure)} ` +
        `allCash=${pct(row.allCashRatio)} trades=${row.trades}`,
    );
  }

  // ── 诊断 2：相关性 ──
  const symbols = [...POOL_ORDER];
  const returnsAll = new Map<string, Map<string, number>>();
  for (const s of symbols) returnsAll.set(s, dailyReturns(data.signalBars.get(s) ?? [], START, END));
  const corrAll = correlationOf(symbols, returnsAll);

  const years = ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];
  const corrByYear: Record<string, CorrResult> = {};
  for (const y of years) {
    const from = `${y}-01-01`;
    const to = `${y}-12-31`;
    const returns = new Map<string, Map<string, number>>();
    for (const s of symbols) returns.set(s, dailyReturns(data.signalBars.get(s) ?? [], from, to));
    corrByYear[y] = correlationOf(symbols, returns);
  }

  // ── 诊断 2：IC ──
  const wsmScore: ScoreFn = (bars, idx) => {
    const window = bars.slice(Math.max(0, idx - (p.wsmPeriod - 1)), idx + 1).map((b) => b.close);
    if (window.length < p.wsmPeriod) return Number.NaN;
    return calcWeightedSlopeMomentum(window, p.useWsmV2);
  };
  const rsrsScore: ScoreFn = (bars, idx) => {
    const n = p.rsrsPeriod + p.rsrsStdPeriod;
    if (idx + 1 < n) return Number.NaN;
    const window = bars.slice(idx + 1 - n, idx + 1);
    return calcRsrsZ(
      window.map((b) => b.high),
      window.map((b) => b.low),
      p.rsrsPeriod,
      p.rsrsStdPeriod,
      p.rsrsQualityFilter,
    );
  };

  const icRows: Record<string, Record<string, Record<string, IcSummary>>> = {};
  for (const [scoreName, scoreFn] of [
    ['wsm', wsmScore],
    ['rsrs', rsrsScore],
  ] as const) {
    icRows[scoreName] = {};
    for (const period of ['all', 'segA', 'segB']) {
      const [from, to] =
        period === 'segA'
          ? [SEG_A_START, SEG_A_END]
          : period === 'segB'
            ? [SEG_B_START, SEG_B_END]
            : [START, END];
      icRows[scoreName][period] = {};
      for (const h of [5, 10, 20]) {
        const series = computeIc(data, p, scoreFn, h, from, to);
        const summary = summarizeIc(series.values);
        icRows[scoreName][period][String(h)] = summary;
        console.log(
          `IC ${scoreName} h=${h} ${period}: n=${summary.n} mean=${f3(summary.mean)} ` +
            `std=${f3(summary.std)} icir=${f3(summary.icir)} pos=${pct(summary.posRatio)} t=${f3(summary.tStat)}`,
        );
      }
    }
  }

  // ── 落盘 ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    range: { start: START, end: END },
    baseline: { finalEquity: bm.finalEquity, trades: baselineResult.trades.length, ok: baselineOk },
    diagnosis1: {
      l1Groups: l1Rows,
      cashAttribution: {
        cashDays,
        cashNoCandidate,
        cashHasCandidate,
        totalDays: baselineResult.equity.length,
        byYear: [...cashByYear.entries()].map(([year, v]) => ({ year, ...v })),
      },
      backtestGroups: btRows,
    },
    diagnosis2: {
      pool: symbols,
      corrAll,
      corrByYear,
      ic: icRows,
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'diagnose.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.join(OUT_DIR, 'diagnose.json')}`);
}

main().catch((err) => {
  console.error('dmDiagnose 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
