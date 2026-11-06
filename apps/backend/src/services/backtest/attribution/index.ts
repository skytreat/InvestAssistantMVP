/**
 * 六维归因（M3）—— 依据 `docs/audit/proposal-strategy-backtest-framework.md` §6
 *
 * 🔴 **纯函数**：`computeAttribution(result, options)` 只吃引擎产出，不读库、不碰 DuckDB。
 *
 * 两套视图（**不要混用**）：
 *
 * 1. **净额**（§6.3 可加性）—— 每个平仓回合一条记录，每维求和 == `totalPnl`：
 *    - 回合净额 = `RoundTrip.pnl`（`account/portfolio.ts` 用 core 的 `realizedPnL` 差分）。
 *      core 的卖出分支是 `revenue = qty × price − fee`（见
 *      `packages/core/src/movingWeightedCost.ts` 的 sell 分支），**卖出佣金已在 `pnl` 内**，
 *      故这里不再二次扣减 —— 否则 `Σ净额 = totalPnl + Σ卖出费`，可加性必破。
 *    - 期末未平仓 → 补伪回合（`exitReason = 'end-of-backtest'`），
 *      pnl = 期末市值 − 成本基 + 未归属分红。
 *    - 分红按「派现日仍持有 + 之后第一个平仓的回合」逐笔归属（每笔只归属一次）。
 *
 * 2. **毛额**（§6.2 恒等式）—— `totalPnl == riskPnl + cashPnl − fees`：
 *    - 直接用现金流口径：`−Σ买入 notional + Σ卖出 notional + Σ分红 + 期末桶市值`（费用单列）。
 *
 * ⚠️ 期末市值取自**最后一个净值点**的 `riskMv / cashMv`（引擎已按「最后有效收盘」估值），
 *    因此「Σ伪回合 + Σ已平仓回合」严格等于 `期末 equity − 期初现金`；
 *    单标的未平仓市值在桶内按「数量 × 该标的最后一次成交价」等比缩放
 *    （若该标的完全没有成交记录则退化为数量权重），**只影响桶内分摊，不影响合计**。
 */
import { calculateMovingWeightedCost, type TradeRecord } from '@invest/core';
import { REPO_CODES } from '../../assetClass.js';
import { DEFENSIVE_ETF } from '../universe/fixedPool.js';
import type { BacktestResult } from '../engine.js';
import type { Fill } from '../execution/simulator.js';
import type { AttributionRow } from '../store/backtestDb.js';
import type {
  AttributionBucket,
  AttributionDimension,
  AttributionDimensionName,
  AttributionOptions,
  AttributionReport,
  AttributionTopItem,
} from './types.js';

export type {
  AttributionBucket,
  AttributionDimension,
  AttributionDimensionName,
  AttributionIdentity,
  AttributionOptions,
  AttributionReport,
  AttributionTopItem,
} from './types.js';

/** 现金桶默认清单（与 `engine.ts` 的 `CASH_BUCKET_SYMBOLS` 同口径） */
const DEFAULT_CASH_BUCKET_SYMBOLS: readonly string[] = [DEFENSIVE_ETF, ...REPO_CODES];

const DIMENSION_ORDER: readonly AttributionDimensionName[] = [
  'symbol',
  'round_trip_id',
  'exit_reason',
  'month',
  'year',
  'branch_tag',
  'bucket',
];

/** 单维最多展示的桶数；超出部分合并为 `其它` */
const MAX_BUCKETS_PER_DIMENSION = 10;
const OTHER_KEY = '其它';
/** `其它` 占比告警阈值（§6.3） */
const OTHER_WARN_RATIO = 0.2;
/** 期末未平仓伪回合的退出原因 */
const END_OF_BACKTEST = 'end-of-backtest';
const UNKNOWN_REGIME = 'unknown';

/** 一条「净额」归因记录（真实回合或期末伪回合） */
interface AttributionUnit {
  symbol: string;
  /** `rt-<n>`（真实平仓）或 `eob-<symbol>-<n>`（期末伪回合） */
  unitId: string;
  openDate: string;
  closeDate: string;
  exitReason: string;
  /** 净额（已含归属分红） */
  pnl: number;
  tradeCount: number;
}

function sumNumbers(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

function byAbsPnlDesc(a: AttributionBucket, b: AttributionBucket): number {
  const diff = Math.abs(b.pnl) - Math.abs(a.pnl);
  if (diff !== 0) return diff;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function isCashBucket(symbol: string, cashSymbols: ReadonlySet<string>): boolean {
  return cashSymbols.has(symbol);
}

/** 毛额：风险/现金两个资产桶的现金流盈亏（费用单列） */
function computeGross(result: BacktestResult, cashSymbols: ReadonlySet<string>) {
  let riskPnl = 0;
  let cashPnl = 0;
  for (const t of result.trades) {
    const notional = t.qty * t.price;
    const signed = t.side === 'buy' ? -notional : notional;
    if (isCashBucket(t.symbol, cashSymbols)) cashPnl += signed;
    else riskPnl += signed;
  }
  for (const d of result.dividends) {
    if (isCashBucket(d.symbol, cashSymbols)) cashPnl += d.amount;
    else riskPnl += d.amount;
  }
  // ⚠️ 桶市值来自引擎最后一个净值点：引擎的桶划分用的是它自己的默认现金桶，
  //    因此 `options.cashBucketSymbols` 覆盖时，只有「每股行情」的归属会偏移，
  //    合计仍严格可加（两个桶加起来就是期末总市值）。
  const last = result.equity.length > 0 ? result.equity[result.equity.length - 1] : null;
  riskPnl += last?.riskMv ?? 0;
  cashPnl += last?.cashMv ?? 0;
  const fees = sumNumbers(result.trades.map((t) => t.fee));
  return { riskPnl, cashPnl, fees };
}

/** 把每笔分红归属到「该标的派现日之后第一个平仓的回合」；无回合则留给该标的的期末伪回合 */
function assignDividends(result: BacktestResult, units: AttributionUnit[]): Map<string, number> {
  const bySymbol = new Map<string, number[]>();
  result.roundTrips.forEach((rt, i) => {
    const list = bySymbol.get(rt.symbol) ?? [];
    list.push(i);
    bySymbol.set(rt.symbol, list);
  });
  const pendingForPseudo = new Map<string, number>();

  for (const div of result.dividends) {
    const candidates = (bySymbol.get(div.symbol) ?? [])
      .filter((i) => result.roundTrips[i].closeDate >= div.date)
      // 同一天多个回合时按数组序（= 成交发生序）取第一个
      .sort((a, b) => {
        const da = result.roundTrips[a].closeDate;
        const db = result.roundTrips[b].closeDate;
        if (da !== db) return da < db ? -1 : 1;
        return a - b;
      });
    if (candidates.length > 0) {
      const target = units[candidates[0]];
      target.pnl += div.amount;
    } else {
      pendingForPseudo.set(div.symbol, (pendingForPseudo.get(div.symbol) ?? 0) + div.amount);
    }
  }
  return pendingForPseudo;
}

/**
 * 期末未平仓 → 伪回合。
 *
 * 持仓量与成本基由**同一批成交 + core 同一套成本函数**回放得出（不另写成本算法）。
 * 市值分摊见文件头注释。
 */
function buildEndOfBacktestUnits(args: {
  trades: readonly Fill[];
  lastDate: string;
  lastRiskMv: number;
  lastCashMv: number;
  cashSymbols: ReadonlySet<string>;
  pendingDividends: ReadonlyMap<string, number>;
}): AttributionUnit[] {
  const { trades, lastDate, lastRiskMv, lastCashMv, cashSymbols, pendingDividends } = args;

  const recordsBySymbol = new Map<string, TradeRecord[]>();
  const qtyTracker = new Map<string, number>();
  const openDateBySymbol = new Map<string, string>();
  const lastTradePrice = new Map<string, number>();

  for (const t of trades) {
    const records = recordsBySymbol.get(t.symbol) ?? [];
    records.push({ date: t.date, direction: t.side, quantity: t.qty, price: t.price, fee: t.fee });
    recordsBySymbol.set(t.symbol, records);
    lastTradePrice.set(t.symbol, t.price);

    const qtyBefore = qtyTracker.get(t.symbol) ?? 0;
    if (t.side === 'buy' && qtyBefore === 0) openDateBySymbol.set(t.symbol, t.date);
    qtyTracker.set(t.symbol, qtyBefore + (t.side === 'buy' ? t.qty : -t.qty));
  }

  const open: { symbol: string; qty: number; costBasis: number }[] = [];
  for (const [symbol, records] of recordsBySymbol) {
    const state = calculateMovingWeightedCost([...records]);
    if (state.totalQuantity > 0) {
      open.push({ symbol, qty: state.totalQuantity, costBasis: state.totalCostBasis });
    }
  }
  // 确定性输出顺序（同分时按标的代码）
  open.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  const weightOf = (p: { symbol: string; qty: number }): number =>
    p.qty * (lastTradePrice.get(p.symbol) ?? 1);
  let riskWeight = 0;
  let cashWeight = 0;
  for (const p of open) {
    if (isCashBucket(p.symbol, cashSymbols)) cashWeight += weightOf(p);
    else riskWeight += weightOf(p);
  }

  return open.map((p, i) => {
    const isCash = isCashBucket(p.symbol, cashSymbols);
    const bucketMv = isCash ? lastCashMv : lastRiskMv;
    const weightSum = isCash ? cashWeight : riskWeight;
    const mv = weightSum > 0 ? bucketMv * (weightOf(p) / weightSum) : 0;
    const dividend = pendingDividends.get(p.symbol) ?? 0;
    return {
      symbol: p.symbol,
      unitId: `eob-${p.symbol}-${i + 1}`,
      openDate: openDateBySymbol.get(p.symbol) ?? lastDate,
      closeDate: lastDate,
      exitReason: END_OF_BACKTEST,
      pnl: mv - p.costBasis + dividend,
      tradeCount: 1,
    };
  });
}

/** 单维聚合 + `其它` 合并 + 告警（§6.3 输出纪律） */
function buildDimension(
  dimension: AttributionDimensionName,
  keys: readonly string[],
  units: readonly AttributionUnit[],
  totalPnl: number,
  warnings: string[],
): AttributionDimension {
  const agg = new Map<string, { pnl: number; tradeCount: number }>();
  keys.forEach((key, i) => {
    const cur = agg.get(key) ?? { pnl: 0, tradeCount: 0 };
    cur.pnl += units[i].pnl;
    cur.tradeCount += units[i].tradeCount;
    agg.set(key, cur);
  });

  let buckets: AttributionBucket[] = [...agg.entries()].map(([key, v]) => ({
    key,
    pnl: v.pnl,
    contributionPct: 0,
    tradeCount: v.tradeCount,
  }));
  buckets.sort(byAbsPnlDesc);

  const absTotal = sumNumbers(buckets.map((b) => Math.abs(b.pnl)));
  if (buckets.length > MAX_BUCKETS_PER_DIMENSION) {
    const tail = buckets.slice(MAX_BUCKETS_PER_DIMENSION);
    buckets = buckets.slice(0, MAX_BUCKETS_PER_DIMENSION);
    buckets.push({
      key: OTHER_KEY,
      pnl: sumNumbers(tail.map((b) => b.pnl)),
      contributionPct: 0,
      tradeCount: sumNumbers(tail.map((b) => b.tradeCount)),
      mergedCount: tail.length,
    });
    buckets.sort(byAbsPnlDesc);
    const other = buckets.find((b) => b.key === OTHER_KEY);
    const ratio = absTotal > 0 && other ? Math.abs(other.pnl) / absTotal : 0;
    if (ratio > OTHER_WARN_RATIO) {
      warnings.push(`${dimension}: 其它占比 ${(ratio * 100).toFixed(1)}% > 20%`);
    }
  }

  for (const b of buckets) {
    b.contributionPct = totalPnl !== 0 ? b.pnl / totalPnl : 0;
  }
  const total = sumNumbers(buckets.map((b) => b.pnl));
  return { dimension, buckets, sum: total, residual: Math.abs(total - totalPnl) };
}

/**
 * 计算六维归因。
 *
 * @param result `runBacktest` 的产出（纯数据，无副作用）
 * @param options 期初现金 + 现金桶（默认与引擎一致）
 */
export function computeAttribution(result: BacktestResult, options: AttributionOptions): AttributionReport {
  const cashSymbols = new Set(options.cashBucketSymbols ?? DEFAULT_CASH_BUCKET_SYMBOLS);
  const initialCash = options.initialCash;
  const last = result.equity.length > 0 ? result.equity[result.equity.length - 1] : null;
  const lastDate = last?.date ?? result.meta.end;
  const totalPnl = (last?.equity ?? initialCash) - initialCash;

  // ── 毛额视图（§6.2） ──
  const gross = computeGross(result, cashSymbols);
  const identityResidual = Math.abs(totalPnl - (gross.riskPnl + gross.cashPnl - gross.fees));

  // ── 净额视图：真实平仓回合 ──
  const units: AttributionUnit[] = result.roundTrips.map((rt, i) => ({
    symbol: rt.symbol,
    unitId: `rt-${i + 1}`,
    openDate: rt.openDate,
    closeDate: rt.closeDate,
    exitReason: rt.exitReason,
    pnl: rt.pnl,
    tradeCount: 1,
  }));
  const pendingDividends = assignDividends(result, units);

  // ── 净额视图：期末未平仓伪回合 ──
  units.push(
    ...buildEndOfBacktestUnits({
      trades: result.trades,
      lastDate,
      lastRiskMv: last?.riskMv ?? 0,
      lastCashMv: last?.cashMv ?? 0,
      cashSymbols,
      pendingDividends,
    }),
  );

  // ── 策略分支：开仓日 regime -> 平仓日 regime ──
  const regimeByDate = new Map<string, string>();
  for (const d of result.decisions) {
    const regime = d.tags['regime'];
    if (typeof regime === 'string' && regime.length > 0) regimeByDate.set(d.execDate, regime);
  }
  const branchPairs = units.map((u) => ({
    open: regimeByDate.get(u.openDate) ?? UNKNOWN_REGIME,
    close: regimeByDate.get(u.closeDate) ?? UNKNOWN_REGIME,
  }));
  const combinedBranches = branchPairs.map((p) => `${p.open}->${p.close}`);
  // 组合桶数过多会让 branch_tag 维度失去可读性（`weak->normal` × 多分支）：
  // 超过单维上限时退化为「只看平仓分支」，并保留 `unknown` 标记。
  const branchKeys =
    new Set(combinedBranches).size <= MAX_BUCKETS_PER_DIMENSION
      ? combinedBranches
      : branchPairs.map((p) => p.close);

  const dimensionKeys: Record<AttributionDimensionName, string[]> = {
    symbol: units.map((u) => u.symbol),
    round_trip_id: units.map((u) => u.unitId),
    exit_reason: units.map((u) => u.exitReason),
    month: units.map((u) => u.closeDate.slice(0, 7)),
    year: units.map((u) => u.closeDate.slice(0, 4)),
    branch_tag: branchKeys,
    bucket: units.map((u) => (isCashBucket(u.symbol, cashSymbols) ? 'cash' : 'risk')),
  };

  const warnings: string[] = [];
  const dimensions = DIMENSION_ORDER.map((dimension) =>
    buildDimension(dimension, dimensionKeys[dimension], units, totalPnl, warnings),
  );

  const top10: AttributionTopItem[] = dimensions
    .flatMap((d) =>
      d.buckets.map((b) => ({
        dimension: d.dimension,
        key: b.key,
        pnl: b.pnl,
        contributionPct: b.contributionPct,
      })),
    )
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
    .slice(0, 10);

  return {
    totalPnl,
    riskPnl: gross.riskPnl,
    cashPnl: gross.cashPnl,
    fees: gross.fees,
    identity: {
      totalPnl,
      riskPnl: gross.riskPnl,
      cashPnl: gross.cashPnl,
      fees: gross.fees,
      residual: identityResidual,
      ok: identityResidual <= 1e-6,
    },
    dimensions,
    top10,
    warnings,
  };
}

/**
 * 归因报告 → `bt_attribution` 扁平行（每维每桶一行）。
 *
 * `bucketType` 用维度名；`detail` 携带贡献占比与（按退出原因维度时的）退出原因。
 */
export function toAttributionRows(report: AttributionReport): AttributionRow[] {
  const rows: AttributionRow[] = [];
  for (const dim of report.dimensions) {
    for (const bucket of dim.buckets) {
      const detail: Record<string, unknown> = { contributionPct: bucket.contributionPct };
      if (dim.dimension === 'exit_reason') detail.exitReason = bucket.key;
      if (bucket.mergedCount !== undefined) detail.mergedCount = bucket.mergedCount;
      rows.push({
        bucketType: dim.dimension,
        bucketKey: bucket.key,
        pnl: bucket.pnl,
        contributionPct: bucket.contributionPct,
        tradeCount: bucket.tradeCount,
        detail,
      });
    }
  }
  return rows;
}
