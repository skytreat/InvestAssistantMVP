/**
 * DualMomentum 参数扫描驱动（**加法式**，不改 wufu 的 runner / grid / split）。
 *
 * 设计约束：
 * 1. 面板装载**逐字复刻** `cli.ts` 的 `--universe fixed` 分支，保证同一组参数下结果与
 *    `cli.ts run --strategy dualmomentum ...` 逐位一致（`--check-baseline` 用于自证）。
 * 2. 只读 DuckDB；产物写 `data/dm-sweep/trials.jsonl`（不入 git），不写业务库。
 * 3. 只跑一维敏感度（stage 0）：每次只改一个参数，其余取 `DUALMOMENTUM_DEFAULTS`。
 *
 * 用法：
 *   npx tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --check-baseline
 *   npx tsx apps/backend/src/services/backtest/optimize/dmSweep.ts --stage0 --shard 0 --shards 2
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
import { collectStrategyExtraSymbols } from './marketData.js';
import { runBacktest, type BacktestData, type BacktestResult } from '../engine.js';
import type { Bar } from '../types.js';
import { createDualMomentumStrategy } from '../strategies/dualmomentum/index.js';
import { BENCHMARK_SYMBOL, POOL_ORDER } from '../strategies/dualmomentum/l1/params.js';
import {
  DUALMOMENTUM_DEFAULTS,
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
/** 与 cli.ts 一致：`Math.max(5, dualMomentumLookback(default) + 1)` = 61 */
const WARMUP = 61;
const BENCH_FOR_EXCESS = 'sh510300';

interface Spec {
  key: string;
  label: string;
  values: number[];
  /** 一维取值 → params 覆盖；涨跌幅需要同时改 min/max */
  override: (v: number) => Record<string, unknown>;
}

/** 阶段 0 的一维参数表（顺序即报告顺序） */
const STAGE0_DIMS: Spec[] = [
  {
    key: 'cashInterestRate',
    label: '闲置现金年化利率（引擎 opt-in；0 = 基线）',
    values: [0.0, 0.01, 0.02, 0.03],
    override: (v) => ({ cashInterestRate: v }),
  },
  {
    key: 'wsmMax',
    label: '主槽上限 wsmMax',
    values: [3, 5, 8, 12, 20, 100],
    override: (v) => ({ wsmMax: v }),
  },
  {
    key: 'wsmMin',
    label: '主槽下限 wsmMin',
    values: [-2, 0, 2, 5],
    override: (v) => ({ wsmMin: v }),
  },
  {
    key: 'rsrsMax',
    label: '次槽上限 rsrsMax',
    values: [1, 2, 3, 5, 100],
    override: (v) => ({ rsrsMax: v }),
  },
  {
    key: 'rsrsMin',
    label: '次槽下限 rsrsMin',
    values: [-2, -1, 0, 0.5],
    override: (v) => ({ rsrsMin: v }),
  },
  {
    key: 'wsmPeriod',
    label: 'WSM 窗口',
    values: [15, 20, 25, 30, 40, 60],
    override: (v) => ({ wsmPeriod: v }),
  },
  {
    key: 'rsrsPeriod',
    label: 'RSRS 窗口',
    values: [15, 20, 25, 30, 40],
    override: (v) => ({ rsrsPeriod: v }),
  },
  {
    key: 'maxHoldings',
    label: '最大持仓数',
    values: [2, 3, 4, 5, 6],
    override: (v) => ({ maxHoldings: v }),
  },
  {
    key: 'minHoldDays',
    label: '最短持有天数',
    values: [1, 3, 5, 10, 20],
    override: (v) => ({ minHoldDays: v }),
  },
  {
    key: 'overweightThreshold',
    label: '超配减仓阈值',
    values: [0.25, 0.33, 0.4, 0.5, 1.0],
    override: (v) => ({ overweightThreshold: v }),
  },
  {
    key: 'singlePositionCap',
    label: '单标的上限',
    values: [0.2, 0.25, 0.33, 0.5],
    override: (v) => ({ singlePositionCap: v }),
  },
  {
    key: 'maPeriod3',
    label: '价格检查 MA 窗口',
    values: [10, 20, 40, 60],
    override: (v) => ({ maPeriod3: v }),
  },
  {
    key: 'dailyChange',
    label: '单日涨跌幅过滤(±)',
    values: [0.03, 0.05, 0.1],
    override: (v) => ({ dailyChangeMin: -v, dailyChangeMax: v }),
  },
  {
    key: 'takeProfitThreshold',
    label: '止盈阈值',
    values: [0.15, 0.3, 1.0],
    override: (v) => ({ takeProfitThreshold: v }),
  },
  {
    key: 'stopLossDrawdown',
    label: '止损阈值(相对成本)',
    values: [0.06, 0.1, 0.2],
    override: (v) => ({ stopLossDrawdown: v }),
  },
];

interface Args {
  mode: 'stage0' | 'check-baseline';
  shard: number;
  shards: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  let mode: Args['mode'] = 'stage0';
  let shard = 0;
  let shards = 1;
  let out = path.resolve('data/dm-sweep/trials.jsonl');
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stage0') mode = 'stage0';
    else if (a === '--check-baseline') mode = 'check-baseline';
    else if (a === '--shard') shard = Number(argv[++i]);
    else if (a === '--shards') shards = Math.max(1, Number(argv[++i]));
    else if (a === '--out') out = path.resolve(argv[++i]);
  }
  return { mode, shard, shards, out };
}

/** 固定池面板：与 cli.ts 的 fixed 分支逐字一致 */
async function loadPanel(): Promise<BacktestData> {
  const calendar = await loadTradingCalendar();
  const loadStart = calendar.lastN(START, WARMUP)[0] ?? START;
  const benchmark = BENCHMARK_SYMBOL;
  const extraSymbols = [
    ...new Set([
      ...FIXED_ETF_POOL,
      ...GLOBAL_ETF_POOL,
      ...DEFENSIVE_ETF,
      benchmark,
      ...POOL_ORDER,
      // 🔴 策略会下单但不在固定池里的标的（防御回退 / 池扩展）必须装进面板，
      //    否则「成交不了」会静默退化成切现金（ADR-024 §6 实测踩坑）
      ...collectStrategyExtraSymbols(),
    ]),
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
    benchmarkBars: exe.get(benchmark) ?? indexBars.get(benchmark) ?? [],
    indexBars,
    universe: (asOf) => provider.snapshotAt(asOf),
    corporateActions: ca,
  };
}

function runTrial(data: BacktestData, params: DualMomentumParams, start = START, end = END): BacktestResult {
  const strategy = createDualMomentumStrategy();
  return runBacktest(data, {
    strategy,
    params: params as unknown as Record<string, unknown>,
    start,
    end,
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
    cashInterestRate: params.cashInterestRate,
  });
}

/** 区间收益 → 年化（按日历天数） */
function cagrBetween(first: number, last: number, fromDate: string, toDate: string): number {
  const days = (Date.parse(toDate) - Date.parse(fromDate)) / 86_400_000;
  if (!(days > 0) || !(first > 0) || !(last > 0)) return NaN;
  return (last / first) ** (365.25 / days) - 1;
}

function closeOn(bars: readonly { date: string; close: number }[], date: string): number | null {
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].date <= date) return bars[i].close;
  }
  return null;
}

interface TrialRow {
  param: string;
  value: number;
  cagr: number;
  maxDrawdown: number;
  calmar: number;
  excessVs510300: number;
  finalEquity: number;
  cumulativeReturn: number;
  avgExposure: number;
  riskZeroRatio: number;
  allCashRatio: number;
  turnover: number;
  volatility: number;
  trades: number;
  segACagr: number;
  segBCagr: number;
  flags: string[];
  seconds: number;
}

function evaluate(
  data: BacktestData,
  benchBars: readonly { date: string; close: number }[],
  params: DualMomentumParams,
  param: string,
  value: number,
): TrialRow {
  const t0 = Date.now();
  const result = runTrial(data, params);
  const m = result.metrics;
  const eq = result.equity;
  const first = eq[0];
  const last = eq[eq.length - 1];

  const benchFirst = first ? closeOn(benchBars, first.date) : null;
  const benchLast = last ? closeOn(benchBars, last.date) : null;
  const benchCagr =
    benchFirst !== null && benchLast !== null && first && last
      ? cagrBetween(benchFirst, benchLast, first.date, last.date)
      : NaN;

  const segA = eq.filter((p) => p.date >= SEG_A_START && p.date <= SEG_A_END);
  const segB = eq.filter((p) => p.date >= SEG_B_START && p.date <= SEG_B_END);
  const segACagr =
    segA.length > 1
      ? cagrBetween(segA[0].equity, segA[segA.length - 1].equity, segA[0].date, segA[segA.length - 1].date)
      : NaN;
  const segBCagr =
    segB.length > 1
      ? cagrBetween(segB[0].equity, segB[segB.length - 1].equity, segB[0].date, segB[segB.length - 1].date)
      : NaN;

  const riskZero = eq.filter((p) => p.riskMv === 0).length;
  const allCash = eq.filter((p) => p.riskMv === 0 && p.cashMv === 0).length;

  const flags: string[] = [];
  if (result.trades.length === 0) flags.push('zero-trades');
  if (!Number.isFinite(m.cagr)) flags.push('non-finite-cagr');
  if (eq.length < 100) flags.push(`short-equity(${eq.length})`);
  if (last && first && Math.abs(last.equity - m.finalEquity) > 1e-6) flags.push('final-equity-mismatch');
  let maxAbsDaily = 0;
  for (let i = 1; i < eq.length; i += 1) {
    if (eq[i - 1].equity > 0) {
      const r = eq[i].equity / eq[i - 1].equity - 1;
      if (Math.abs(r) > Math.abs(maxAbsDaily)) maxAbsDaily = r;
    }
  }
  if (Math.abs(maxAbsDaily) > 0.15) flags.push(`daily-jump(${(maxAbsDaily * 100).toFixed(2)}%)`);
  const skips = result.skipped.length;
  if (skips / Math.max(1, skips + result.trades.length) > 0.05) {
    flags.push(`many-skipped(${skips})`);
  }

  return {
    param,
    value,
    cagr: m.cagr,
    maxDrawdown: m.maxDrawdownRatio,
    calmar: m.calmarRatio,
    excessVs510300: m.cagr - benchCagr,
    finalEquity: m.finalEquity,
    cumulativeReturn: m.cumulativeReturn,
    avgExposure: m.averageExposure,
    riskZeroRatio: eq.length > 0 ? riskZero / eq.length : NaN,
    allCashRatio: eq.length > 0 ? allCash / eq.length : NaN,
    turnover: m.turnoverAnnualized,
    volatility: m.annualizedVolatility,
    trades: result.trades.length,
    segACagr,
    segBCagr,
    flags,
    seconds: (Date.now() - t0) / 1000,
  };
}

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'n/a');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const data = await loadPanel();
  const benchBars = data.signalBars.get(BENCH_FOR_EXCESS) ?? [];
  const panelInfo =
    `面板：${data.signalBars.size} 只 / 基准 ${BENCHMARK_SYMBOL} ${data.benchmarkBars.length} 根 / ` +
    `sh510300 ${benchBars.length} 根 / 指数 ${data.indexBars?.size ?? 0} 只`;
  console.log(panelInfo);

  if (args.mode === 'check-baseline') {
    const params = resolveDualMomentumParams({});
    const result = runTrial(data, params);
    const m = result.metrics;
    console.log(
      `BASELINE final=${m.finalEquity.toFixed(2)} cum=${(m.cumulativeReturn * 100).toFixed(2)}% ` +
        `cagr=${(m.cagr * 100).toFixed(2)}% mdd=${(m.maxDrawdownRatio * 100).toFixed(2)}% ` +
        `trades=${result.trades.length} equityDays=${result.equity.length}`,
    );
    return;
  }

  // 一维展开：同一组覆盖只算一次（默认参数会被多个维度共享）
  const trials: {
    param: string;
    label: string;
    value: number;
    overrides: Record<string, unknown>;
  }[] = [];
  for (const dim of STAGE0_DIMS) {
    for (const v of dim.values) {
      trials.push({ param: dim.key, label: dim.label, value: v, overrides: dim.override(v) });
    }
  }
  const picked = trials.filter((_, i) => i % args.shards === args.shard);
  console.log(
    `阶段 0：共 ${trials.length} 组（去重后实际计算见日志），本分片 ${picked.length} 组（shard ${args.shard}/${args.shards}）`,
  );

  const cache = new Map<string, TrialRow>();
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const rows: TrialRow[] = [];

  for (const trial of picked) {
    const key = JSON.stringify(trial.overrides);
    let row = cache.get(key);
    if (!row) {
      const params = resolveDualMomentumParams({ ...DUALMOMENTUM_DEFAULTS, ...trial.overrides });
      row = evaluate(data, benchBars, params, trial.param, trial.value);
      cache.set(key, row);
      fs.appendFileSync(
        args.out,
        `${JSON.stringify({ ...row, stage: 0, param: trial.param, label: trial.label, value: trial.value, overrides: trial.overrides })}\n`,
        'utf8',
      );
      console.log(
        `[${trial.param}=${trial.value}] cagr=${pct(row.cagr)} mdd=${pct(row.maxDrawdown)} ` +
          `expo=${pct(row.avgExposure)} trades=${row.trades} ${row.seconds.toFixed(1)}s` +
          (row.flags.length > 0 ? ` ⚠ ${row.flags.join(',')}` : ''),
      );
    }
    rows.push({ ...row, param: trial.param, value: trial.value });
  }

  // 分片只打印自己的曲线；合并报告在跑完后用 trials.jsonl 统一出
  for (const dim of STAGE0_DIMS) {
    const line = rows
      .filter((r) => r.param === dim.key)
      .sort((a, b) => a.value - b.value)
      .map((r) => `${r.value}:${pct(r.cagr)}/${pct(r.avgExposure)}`)
      .join('  ');
    if (line) console.log(`曲线 ${dim.label}: ${line}`);
  }
}

main().catch((err) => {
  console.error('dmSweep 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
