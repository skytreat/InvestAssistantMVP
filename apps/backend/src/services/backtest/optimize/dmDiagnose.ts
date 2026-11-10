/**
 * DualMomentum 诊断驱动（§12.8 第 1 步：诊断 1–4）。
 *
 * 与 `dmSweep.ts` 同构：面板装载**逐字复刻** `cli.ts` 的 `--universe fixed` 分支
 * （同一组数据下结果可与 `--check-baseline` 交叉验证），只读 DuckDB，
 * 产物写 `data/dm-diagnose/`（不入 git），不写业务库、不写回测库。
 *
 * 用法：
 *   DUCKDB_PATH=<真库> npx tsx apps/backend/src/services/backtest/optimize/dmDiagnose.ts
 *
 * 产出（JSON，便于报告引用原始数字）：
 *   data/dm-diagnose/diagnosis.json
 *   - d1 摩擦拆账：基线 run 的 fees / slippage_cost 拆分 + 分年 + 年化占本金比
 *   - d2 leave-one-out：5 个消融变体 × {exposure, allCashRatio, avgPassedPerDay}
 *   - d3 槽位拆分归因：reject_reason（含 PRIMARY/SECONDARY_OUT_OF_RANGE）× 标的 × 全区间计数
 *   - d4 相关性矩阵 + 动量 IC（5/10/20 日秩相关）
 *
 * 口径：
 * - 逐层消融的「只留 X」= 关闭其余过滤层（停牌/涨停/冷却等**执行层**约束保留）；
 * - 相关性 / IC 用 `v_etf_qfq` 前复权日收益（诊断口径，非对齐口径）；
 * - 前向 IC 的「未来收益」含 T+1…T+H（共 H 根），与 T 日指标/排序同源、无前视；
 * - 日涨跌过滤用 DAS 锁定值 ±0.05（`DAILY_CHANGE_MIN` / `DAILY_CHANGE_MAX`）。
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
import { runBacktest, type BacktestData } from '../engine.js';
import type { Bar } from '../types.js';
import { createDualMomentumStrategy } from '../strategies/dualmomentum/index.js';
import { BENCHMARK_SYMBOL, POOL_ORDER } from '../strategies/dualmomentum/l1/params.js';
import { DUALMOMENTUM_DEFAULTS, resolveDualMomentumParams } from '../strategies/dualmomentum/params.js';
import {
  ABLATION_VARIANTS,
  ablationByKey,
  evaluateL1FiltersAttributed,
  momentumIcSeries,
  type AttributedRejectReason,
} from '../strategies/dualmomentum/l1/diagnostics.js';
import {
  calcMa,
  calcNdayReturnMomentum,
  calcRsrsZ,
  calcWeightedSlopeMomentum,
} from '../strategies/dualmomentum/l1/indicators.js';
import {
  COMBO_SLOTS,
  DAILY_CHANGE_MAX,
  DAILY_CHANGE_MIN,
  DEFAULT_LIMIT_RATIO,
} from '../strategies/dualmomentum/l1/params.js';

const START = '2019-01-02';
const END = '2026-11-06';
const INITIAL_CASH = 1_000_000;
const WARMUP = 61;
const OUT_DIR = path.resolve('data/dm-diagnose');

async function loadPanel(): Promise<BacktestData> {
  const calendar = await loadTradingCalendar();
  const loadStart = calendar.lastN(START, WARMUP)[0] ?? START;
  const benchmark = BENCHMARK_SYMBOL;
  const extraSymbols = [
    ...new Set([...FIXED_ETF_POOL, ...GLOBAL_ETF_POOL, DEFENSIVE_ETF, benchmark, ...POOL_ORDER]),
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

function runBaseline(data: BacktestData) {
  const strategy = createDualMomentumStrategy();
  const params = resolveDualMomentumParams({});
  return runBacktest(data, {
    strategy,
    params: params as unknown as Record<string, unknown>,
    start: START,
    end: END,
    initialCash: INITIAL_CASH,
    universeMode: 'fixed',
    priceMode: 'open',
    benchmarkSymbol: BENCHMARK_SYMBOL,
    suspension: { missingBar: true, zeroVolume: true },
    universeParams: { divisor: 20000, topN: 300 },
    rules: {
      commissionRate: DUALMOMENTUM_DEFAULTS.commissionRate,
      minCommission: DUALMOMENTUM_DEFAULTS.minCommission,
      slippageRate: DUALMOMENTUM_DEFAULTS.slippage,
      lotSize: DUALMOMENTUM_DEFAULTS.lotSize,
      stampDutyRate: DUALMOMENTUM_DEFAULTS.etfExemptTax ? 0 : 0.001,
      transferFeeRate: 0,
    },
  });
}

/** 诊断 1：摩擦拆账（fees = 佣金+印花税+过户；slippage_cost 独立列） */
function diagnoseFriction(result: ReturnType<typeof runBaseline>) {
  let feesTotal = 0;
  let slippageTotal = 0;
  let notionalBought = 0;
  let notionalSold = 0;
  const byYear: Record<string, { fees: number; slippage: number }> = {};
  for (const t of result.trades) {
    const y = t.date.slice(0, 4);
    byYear[y] ??= { fees: 0, slippage: 0 };
    byYear[y].fees += t.fee;
    byYear[y].slippage += t.slippageCost;
    feesTotal += t.fee;
    slippageTotal += t.slippageCost;
    if (t.side === 'buy') notionalBought += t.qty * t.price;
    else notionalSold += t.qty * t.price;
  }
  const notionalAll = notionalBought + notionalSold;
  const equityDays = result.equity.length;
  const years = equityDays / 250;
  const totalFriction = feesTotal + slippageTotal;
  const frictionPctOfCash = years > 0 ? totalFriction / INITIAL_CASH / years : 0;
  const feePctOfCash = years > 0 ? feesTotal / INITIAL_CASH / years : 0;
  const slippagePctOfCash = years > 0 ? slippageTotal / INITIAL_CASH / years : 0;
  return {
    totalFees: feesTotal,
    totalSlippage: slippageTotal,
    totalFriction,
    notionalBought,
    notionalSold,
    notionalAll,
    feeBpOfNotional: notionalAll > 0 ? (feesTotal / notionalAll) * 10_000 : 0,
    slippageBpOfNotional: notionalAll > 0 ? (slippageTotal / notionalAll) * 10_000 : 0,
    /** 摩擦占初始本金的年化比（fees / slippage / combined） */
    feePctOfCashPerYear: feePctOfCash,
    slippagePctOfCashPerYear: slippagePctOfCash,
    frictionPctOfCashPerYear: frictionPctOfCash,
    byYear,
  };
}

/** 诊断 3 的输入：逐日逐标的的过滤输入（与适配器同口径：qfq 轨 + 指标 + 基准动量） */
interface AttributedDayRow {
  date: string;
  symbol: string;
  inPool: boolean;
  hasBar: boolean;
  usable: boolean;
  snapshotPrice: number | null;
  prevCloseAdj: number;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  primary: number;
  secondary: number;
  benchmarkPrimary: number;
}

interface DayIndicators {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  wsm: number;
  nday: number;
  rsrs: number;
}

function maSafe(v: number): number | null {
  return Number.isFinite(v) && v > 0 ? v : null;
}

function calcDayIndicators(
  bars: readonly Bar[],
  p: ReturnType<typeof resolveDualMomentumParams>,
): DayIndicators {
  const lookback = Math.max(
    p.wsmPeriod,
    p.ndayReturnPeriod,
    p.rsrsPeriod + p.rsrsStdPeriod,
    p.maPeriod1,
    p.maPeriod2,
    p.maPeriod3,
    p.maPeriod4,
  );
  if (bars.length < lookback) {
    return { ma5: null, ma10: null, ma20: null, ma60: null, wsm: 0, nday: 0, rsrs: 0 };
  }
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  return {
    ma5: maSafe(calcMa(closes, p.maPeriod1)),
    ma10: maSafe(calcMa(closes, p.maPeriod2)),
    ma20: maSafe(calcMa(closes, p.maPeriod3)),
    ma60: maSafe(calcMa(closes, p.maPeriod4)),
    wsm: calcWeightedSlopeMomentum(closes.slice(-p.wsmPeriod), p.useWsmV2),
    nday: calcNdayReturnMomentum(closes, p.ndayReturnPeriod, p.ndayReturnAnnualize),
    rsrs: calcRsrsZ(
      highs.slice(-(p.rsrsPeriod + p.rsrsStdPeriod)),
      lows.slice(-(p.rsrsPeriod + p.rsrsStdPeriod)),
      p.rsrsPeriod,
      p.rsrsStdPeriod,
      p.rsrsQualityFilter,
    ),
  };
}

function usableClose(bars: readonly Bar[], i: number): number | null {
  for (let k = i; k >= 0; k--) {
    const b = bars[k];
    if (b.volume > 0 && b.close > 0 && Number.isFinite(b.close)) return b.close;
  }
  return null;
}

/** 逐日逐标的收集过滤输入（诊断 2/3 共用；一次遍历全区间） */
function collectAttributedRows(
  data: BacktestData,
  params: ReturnType<typeof resolveDualMomentumParams>,
): AttributedDayRow[] {
  const tradingDays = data.calendar.all.filter((d) => d >= START && d <= END);
  const slots = COMBO_SLOTS[params.momentumCombo];
  const benchBars = data.indexBars?.get(BENCHMARK_SYMBOL) ?? [];
  const benchByDate = new Map<string, Bar>(benchBars.map((b) => [b.date, b]));

  const symIndex = new Map<string, Map<string, number>>();
  for (const sym of POOL_ORDER) {
    const bars = data.signalBars.get(sym) ?? [];
    const idx = new Map<string, number>();
    bars.forEach((b, i) => idx.set(b.date, i));
    symIndex.set(sym, idx);
  }

  const rows: AttributedDayRow[] = [];
  for (const date of tradingDays) {
    let benchPrimary = 0;
    if (benchByDate.get(date)) {
      const benchCloses = benchBars.filter((b) => b.date <= date).map((b) => b.close);
      benchPrimary =
        slots.benchmark === 'wsm'
          ? calcWeightedSlopeMomentum(benchCloses.slice(-params.wsmPeriod), params.useWsmV2)
          : calcNdayReturnMomentum(benchCloses, params.ndayReturnPeriod, params.ndayReturnAnnualize);
    }
    for (const sym of POOL_ORDER) {
      const bars = data.signalBars.get(sym) ?? [];
      const i = symIndex.get(sym)?.get(date);
      const inPool = bars.length > 0 && bars[0].date <= date;
      const hasBar = i !== undefined;
      const usable = hasBar && bars[i].volume > 0 && bars[i].close > 0;
      const snapshotPrice = usable ? bars[i].close : i !== undefined ? usableClose(bars, i) : null;
      const prevCloseAdj = hasBar
        ? i !== undefined && i >= 1
          ? bars[i - 1].close
          : bars.length > 0
            ? bars[0].close
            : 0
        : ((i !== undefined ? usableClose(bars, i) : null) ?? 0);

      const from = (i ?? bars.length) - 60;
      const windowBars = i !== undefined ? bars.slice(Math.max(0, from), i + 1) : bars.slice(-60);
      const ind = calcDayIndicators(windowBars, params);

      const primaryValue = slots.primary === 'wsm' ? ind.wsm : ind.nday;
      const secondaryValue = slots.secondary === 'rsrs' ? ind.rsrs : ind.wsm;

      rows.push({
        date,
        symbol: sym,
        inPool,
        hasBar,
        usable,
        snapshotPrice,
        prevCloseAdj,
        ma5: ind.ma5,
        ma10: ind.ma10,
        ma20: ind.ma20,
        ma60: ind.ma60,
        primary: primaryValue,
        secondary: secondaryValue,
        benchmarkPrimary: benchPrimary,
      });
    }
  }
  return rows;
}

/** 诊断 2：leave-one-out 消融（每个变体 × 全区间；只统计 L1 通过面，不重跑组合层） */
function ablationStudy(rows: AttributedDayRow[], params: ReturnType<typeof resolveDualMomentumParams>) {
  const results: Record<string, unknown>[] = [];
  const byDate = new Map<string, AttributedDayRow[]>();
  for (const row of rows) {
    let list = byDate.get(row.date);
    if (!list) {
      list = [];
      byDate.set(row.date, list);
    }
    list.push(row);
  }

  // 每个变体独立聚合：当日通过数 → 选中数 = min(通过数, maxHoldings)
  for (const variant of ABLATION_VARIANTS) {
    const config = ablationByKey(variant.key);
    const dayCount = byDate.size;
    let totalPassed = 0;
    let totalSelected = 0;
    let allCashDays = 0;
    for (const dayRows of byDate.values()) {
      let passed = 0;
      for (const row of dayRows) {
        const res = evaluateL1FiltersAttributed(
          {
            inPool: row.inPool,
            hasBar: row.hasBar,
            snapshotPrice: row.snapshotPrice,
            prevCloseAdj: row.prevCloseAdj,
            ma5: row.ma5,
            ma10: row.ma10,
            ma20: row.ma20,
            ma60: row.ma60,
            primary: row.primary,
            secondary: row.secondary,
            benchmarkPrimary: row.benchmarkPrimary,
            primaryRange: [params.wsmMin, params.wsmMax],
            secondaryRange: [params.rsrsMin, params.rsrsMax],
            cooling: false,
            limitRatio: DEFAULT_LIMIT_RATIO,
            dailyChangeMin: DAILY_CHANGE_MIN,
            dailyChangeMax: DAILY_CHANGE_MAX,
          },
          config,
        );
        if (res.pass) passed += 1;
      }
      totalPassed += passed;
      totalSelected += Math.min(passed, params.maxHoldings);
      if (passed === 0) allCashDays += 1;
    }
    results.push({
      variant: variant.key,
      label: variant.label,
      disabledLayers:
        config === null
          ? []
          : Object.entries(config)
              .filter(([, v]) => v === false)
              .map(([k]) => k),
      avgPassedPerDay: dayCount > 0 ? totalPassed / dayCount : 0,
      avgSelectedPerDay: dayCount > 0 ? totalSelected / dayCount : 0,
      allCashDayRatio: dayCount > 0 ? allCashDays / dayCount : 0,
      avgExposureProxy: dayCount > 0 ? totalSelected / dayCount / POOL_ORDER.length : 0,
    });
  }
  return results;
}

/** 诊断 3：原因码分布（全区间 × 标的 × 原因码；主/次槽拆分） */
function rejectReasonBreakdown(
  rows: AttributedDayRow[],
  params: ReturnType<typeof resolveDualMomentumParams>,
) {
  const byReason: Partial<Record<AttributedRejectReason, number>> = {};
  const bySymbolReason: Record<string, Partial<Record<AttributedRejectReason, number>>> = {};
  const selectedCount: Record<string, number> = {};
  for (const sym of POOL_ORDER) selectedCount[sym] = 0;

  const byDate = new Map<string, AttributedDayRow[]>();
  for (const row of rows) {
    let list = byDate.get(row.date);
    if (!list) {
      list = [];
      byDate.set(row.date, list);
    }
    list.push(row);
  }

  for (const [, dayRows] of byDate) {
    const passed: { symbol: string; primary: number }[] = [];
    for (const row of dayRows) {
      const res = evaluateL1FiltersAttributed(
        {
          inPool: row.inPool,
          hasBar: row.hasBar,
          snapshotPrice: row.snapshotPrice,
          prevCloseAdj: row.prevCloseAdj,
          ma5: row.ma5,
          ma10: row.ma10,
          ma20: row.ma20,
          ma60: row.ma60,
          primary: row.primary,
          secondary: row.secondary,
          benchmarkPrimary: row.benchmarkPrimary,
          primaryRange: [params.wsmMin, params.wsmMax],
          secondaryRange: [params.rsrsMin, params.rsrsMax],
          cooling: false,
          limitRatio: DEFAULT_LIMIT_RATIO,
          dailyChangeMin: DAILY_CHANGE_MIN,
          dailyChangeMax: DAILY_CHANGE_MAX,
        },
        null,
      );
      if (res.reason) {
        byReason[res.reason] = (byReason[res.reason] ?? 0) + 1;
        bySymbolReason[row.symbol] ??= {};
        bySymbolReason[row.symbol][res.reason] = (bySymbolReason[row.symbol][res.reason] ?? 0) + 1;
      } else {
        passed.push({ symbol: row.symbol, primary: row.primary });
      }
    }
    passed.sort((a, b) => b.primary - a.primary);
    const selectedSet = new Set(passed.slice(0, params.maxHoldings).map((p) => p.symbol));
    for (const row of dayRows) {
      if (selectedSet.has(row.symbol)) selectedCount[row.symbol]++;
    }
    for (let r = params.maxHoldings; r < passed.length; r++) {
      byReason['RANK_TRUNCATED'] = (byReason['RANK_TRUNCATED'] ?? 0) + 1;
      bySymbolReason[passed[r].symbol] ??= {};
      bySymbolReason[passed[r].symbol]['RANK_TRUNCATED'] =
        (bySymbolReason[passed[r].symbol]['RANK_TRUNCATED'] ?? 0) + 1;
    }
  }
  return { byReason, bySymbolReason, selectedCount, totalDays: byDate.size };
}

/** 诊断 4：相关性矩阵 + 动量 IC */
function correlationAndIc(
  data: BacktestData,
  rows: AttributedDayRow[],
  params: ReturnType<typeof resolveDualMomentumParams>,
) {
  const slots = COMBO_SLOTS[params.momentumCombo];
  const dates = [...new Set(rows.map((r) => r.date))].sort();

  // 每个标的的 bar 序列（date 升序）+ 前收表（date → prev close，二分查找）
  const barsBySym = new Map<string, readonly Bar[]>();
  for (const sym of POOL_ORDER) barsBySym.set(sym, data.signalBars.get(sym) ?? []);
  const lastIdxOnOrBefore = (bars: readonly Bar[], date: string): number => {
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
  };
  const dailyReturn = (sym: string, d: string): number => {
    const bars = barsBySym.get(sym) ?? [];
    const i = lastIdxOnOrBefore(bars, d);
    if (i < 1) return Number.NaN;
    const c = bars[i].close;
    const cp = bars[i - 1].close;
    if (cp <= 0 || !Number.isFinite(c)) return Number.NaN;
    return c / cp - 1;
  };
  const returns: number[][] = dates.map((d) => POOL_ORDER.map((sym) => dailyReturn(sym, d)));

  const corrPairs: Record<string, { r: number; n: number }> = {};
  for (let i = 0; i < POOL_ORDER.length; i++) {
    for (let j = i + 1; j < POOL_ORDER.length; j++) {
      const a: number[] = [];
      const b: number[] = [];
      for (const rr of returns) {
        const x = rr[i];
        const y = rr[j];
        if (Number.isFinite(x) && Number.isFinite(y)) {
          a.push(x);
          b.push(y);
        }
      }
      let r = Number.NaN;
      if (a.length >= 100) {
        const ma = a.reduce((s, v) => s + v, 0) / a.length;
        const mb = b.reduce((s, v) => s + v, 0) / b.length;
        let cov = 0;
        let va = 0;
        let vb = 0;
        for (let k = 0; k < a.length; k++) {
          const da = a[k] - ma;
          const db = b[k] - mb;
          cov += da * db;
          va += da * da;
          vb += db * db;
        }
        r = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : Number.NaN;
      }
      corrPairs[`${POOL_ORDER[i]}|${POOL_ORDER[j]}`] = { r, n: a.length };
    }
  }

  // 对称矩阵
  const matrix: number[][] = [];
  for (let i = 0; i < POOL_ORDER.length; i++) {
    const rowM: number[] = [];
    for (let j = 0; j < POOL_ORDER.length; j++) {
      if (i === j) rowM.push(1);
      else if (i < j) rowM.push(corrPairs[`${POOL_ORDER[i]}|${POOL_ORDER[j]}`].r);
      else rowM.push(corrPairs[`${POOL_ORDER[j]}|${POOL_ORDER[i]}`].r);
    }
    matrix.push(rowM);
  }

  // IC：主槽动量排序 vs 未来 5/10/20 交易日收益
  const rowByDate = new Map<string, AttributedDayRow[]>();
  for (const row of rows) {
    let list = rowByDate.get(row.date);
    if (!list) {
      list = [];
      rowByDate.set(row.date, list);
    }
    list.push(row);
  }
  const closeOnOrBefore = (sym: string, date: string): number | undefined => {
    const bars = data.signalBars.get(sym) ?? [];
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= date) return bars[i].close;
    return undefined;
  };
  const ics: Record<string, ReturnType<typeof momentumIcSeries>> = {};
  for (const h of [5, 10, 20]) {
    const perDayPrimary: number[][] = [];
    const perDayForward: (number | null)[][] = [];
    for (let di = 0; di < dates.length; di++) {
      const d = dates[di];
      const dayRows = rowByDate.get(d);
      if (!dayRows || di + h >= dates.length) continue;
      const target = dates[di + h];
      perDayPrimary.push(dayRows.map((r) => r.primary));
      perDayForward.push(
        dayRows.map((r) => {
          const c0 = closeOnOrBefore(r.symbol, d);
          const cH = closeOnOrBefore(r.symbol, target);
          if (c0 === undefined || cH === undefined || c0 <= 0) return null;
          return cH / c0 - 1;
        }),
      );
    }
    ics[String(h)] = momentumIcSeries(perDayPrimary, perDayForward, h);
  }

  return {
    slots,
    corrPairs,
    matrix,
    ics,
    note: '日收益按同日截面对齐；相关性用 Pearson；IC 用 Spearman（ties 平均秩），前向收益 T+H 交易日',
  };
}

async function main(): Promise<void> {
  const data = await loadPanel();
  console.log(
    `面板：${data.signalBars.size} 只 / 基准 ${BENCHMARK_SYMBOL} ${data.benchmarkBars.length} 根 / 指数 ${data.indexBars?.size ?? 0} 只`,
  );

  const t0 = Date.now();
  const result = runBaseline(data);
  const m = result.metrics;
  console.log(
    `BASELINE final=${m.finalEquity.toFixed(2)} cum=${(m.cumulativeReturn * 100).toFixed(2)}% ` +
      `cagr=${(m.cagr * 100).toFixed(2)}% mdd=${(m.maxDrawdownRatio * 100).toFixed(2)}% ` +
      `expo=${(m.averageExposure * 100).toFixed(2)}% turnover=${m.turnoverAnnualized.toFixed(2)} ` +
      `trades=${result.trades.length} equityDays=${result.equity.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const d1 = diagnoseFriction(result);

  const params = resolveDualMomentumParams({});
  const rows = collectAttributedRows(data, params);
  const d2 = ablationStudy(rows, params);
  const d3 = rejectReasonBreakdown(rows, params);
  const d4 = correlationAndIc(data, rows, params);

  const report = {
    generatedAt: new Date().toISOString(),
    interval: { start: START, end: END, initialCash: INITIAL_CASH },
    baseline: {
      finalEquity: m.finalEquity,
      cagr: m.cagr,
      maxDrawdown: m.maxDrawdownRatio,
      averageExposure: m.averageExposure,
      turnover: m.turnoverAnnualized,
      trades: result.trades.length,
      equityDays: result.equity.length,
    },
    d1Friction: d1,
    d2Ablation: d2,
    d3RejectReason: d3,
    d4CorrelationIc: d4,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'diagnosis.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`已写出：${outPath}`);

  console.log(`\n── 诊断 1（摩擦拆账）──`);
  console.log(
    `fees=${d1.totalFees.toFixed(2)} / slippage=${d1.totalSlippage.toFixed(2)} / 合计=${d1.totalFriction.toFixed(2)} 元`,
  );
  console.log(
    `占初始本金/年：fees ${(d1.feePctOfCashPerYear * 100).toFixed(2)}% + slippage ${(d1.slippagePctOfCashPerYear * 100).toFixed(2)}% = ${(d1.frictionPctOfCashPerYear * 100).toFixed(2)}%`,
  );
  console.log(
    `占单边成交额：fees ${d1.feeBpOfNotional.toFixed(1)}bp / slippage ${d1.slippageBpOfNotional.toFixed(1)}bp`,
  );

  console.log(`\n── 诊断 2（leave-one-out）──`);
  for (const r of d2) {
    const x = r as {
      variant: string;
      label: string;
      avgPassedPerDay: number;
      avgSelectedPerDay: number;
      allCashDayRatio: number;
      avgExposureProxy: number;
    };
    console.log(
      `${x.variant.padEnd(16)} ${x.label.padEnd(28)} 日均通过=${x.avgPassedPerDay.toFixed(2)} / 日均选中=${x.avgSelectedPerDay.toFixed(2)} / 全现金日=${(x.allCashDayRatio * 100).toFixed(2)}% / 暴露代理=${(x.avgExposureProxy * 100).toFixed(2)}%`,
    );
  }

  console.log(`\n── 诊断 3（原因码 × 标的）──`);
  const reasonOrder = [
    'POOL_ABSENT',
    'SUSPENDED',
    'COOLDOWN',
    'AT_LIMIT',
    'DAILY_CHANGE_OUT_OF_RANGE',
    'BELOW_MA20',
    'MA_NOT_BULLISH',
    'PRIMARY_OUT_OF_RANGE',
    'SECONDARY_OUT_OF_RANGE',
    'MOMENTUM_OUT_OF_RANGE',
    'BELOW_BENCHMARK',
    'RANK_TRUNCATED',
  ];
  for (const reason of reasonOrder) {
    const total = d3.byReason[reason as AttributedRejectReason];
    if (!total) continue;
    const perSym = POOL_ORDER.map(
      (s) => `${s.slice(2)}=${d3.bySymbolReason[s]?.[reason as AttributedRejectReason] ?? 0}`,
    ).join(' ');
    console.log(`${reason.padEnd(28)} ${String(total).padStart(6)}  ${perSym}`);
  }
  console.log(
    'selected 计数（全区间）：' +
      POOL_ORDER.map((s) => `${s.slice(2)}=${d3.selectedCount[s] ?? 0}`).join(' '),
  );

  console.log(`\n── 诊断 4（相关性 + IC）──`);
  console.log('两两相关（qfq 日收益，同日截面对齐；`*` = 截面对数 < 500）：');
  console.log(''.padEnd(10) + POOL_ORDER.map((s) => s.slice(2).padStart(8)).join(''));
  for (let i = 0; i < POOL_ORDER.length; i++) {
    const row = POOL_ORDER.map((s, j) => {
      if (j < i) return ''.padEnd(8);
      if (j === i) return '  1.000'.padStart(8);
      const p = d4.corrPairs[`${POOL_ORDER[i]}|${s}`];
      if (!p) return ''.padEnd(8);
      const r = Number.isFinite(p.r) ? p.r.toFixed(3) : 'n/a';
      return `${r}${p.n < 500 ? '*' : ''}`.padStart(8);
    }).join('');
    console.log(POOL_ORDER[i].slice(2).padEnd(10) + row);
  }
  for (const h of [5, 10, 20]) {
    const ic = d4.ics[String(h)];
    const tStat = Number.isFinite(ic.icir) ? ic.icir * Math.sqrt(ic.validSections) : Number.NaN;
    console.log(
      `IC(h=${h})：均值=${(ic.mean * 100).toFixed(2)} std=${(ic.std * 100).toFixed(2)} ICIR=${ic.icir.toFixed(2)} t=${Number.isFinite(tStat) ? tStat.toFixed(1) : 'n/a'} 正占比=${(ic.positiveRatio * 100).toFixed(1)}% 有效截面=${ic.validSections}`,
    );
  }
}

main().catch((err) => {
  console.error('dmDiagnose 失败：', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
