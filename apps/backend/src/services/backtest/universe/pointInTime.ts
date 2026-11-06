/**
 * 时点名录（M1）—— proposal §3.2
 *
 * ```text
 * Universe(T)   = { s | firstBar(s) ≤ T ≤ lastBar(s) }          ← 时点可交易集合
 * 阈值(T)       = mean(近 3 日全市场 ETF amount) / divisor       ← v5.2 divisor = 20000
 * 固定池(T)     = 固定池 ∩ Universe(T) ∩ { 近 3 日均额 > 阈值(T) }
 * 走弱期池(T)   = 全球池 ∩ Universe(T) ∩ { 近 3 日均额 > 阈值(T) }
 * 动态池(T)     = clean-name(Universe(T) ∩ 流动性通过) → 组内金额第一 → top N
 * ```
 *
 * 口径细节（逐条对齐 v5.2，**不擅自「修正」**）：
 *   - 近 3 日 = **截至 asOf（含当天）** 的 3 个交易日 —— 即「asOf 收盘后的快照」口径；
 *     ⚠️ 回测引擎在 T 日**开盘前**做决策时，必须传 `asOf = T-1`（本模块不提供「含当天」以外的口径，
 *     避免「引擎忘了错开一天」这类前视 bug 混进来）；
 *   - 日均额分母**固定 3**（停牌/缺数据的天数按 0 计入），不是「实际有 bar 的天数」；
 *   - 阈值严格大于才通过（`avg > threshold`），等于不算；
 *   - 有效交易日不足 3 个 → 阈值回退 **1000 万**（v5.2 的保守值）。
 */
import { queryDuckDB } from '../../../db/duckdb.js';
import type { SymbolMeta, SuspensionOptions } from '../types.js';
import { TradingCalendar, loadTradingCalendar } from '../calendar.js';
import { getEtfSymbolMeta } from '../marketPanel.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL, GLOBAL_ETF_POOL } from './fixedPool.js';
import { buildDynamicPool, type DynamicPoolCandidate, type DynamicPoolResult } from './nameCleaning.js';

/** 流动性阈值除数（v5.2 `g.global_threshold_divisor`） */
export const DEFAULT_LIQUIDITY_DIVISOR = 20000;
/** 动态池截断数量（v5.2 `top_300`） */
export const DEFAULT_DYNAMIC_TOP_N = 300;
/** 流动性回看的交易日数 */
export const LIQUIDITY_LOOKBACK_DAYS = 3;
/** 有效交易日不足时的保守阈值（v5.2 硬编码 10000000） */
export const LIQUIDITY_THRESHOLD_FALLBACK = 10_000_000;

/**
 * 走弱期状态机的四个指数（M3 用，**M1 不参与选池**，仅作为常量落位）
 * `sh000300` / `sh000510` / `sz399101` / `sz399006`
 */
export const WEAK_PERIOD_INDEXES: readonly string[] = ['sh000300', 'sh000510', 'sz399101', 'sz399006'];

// ───────────────────────────── 纯函数（可单测，不碰 DB） ─────────────────────────────

export interface DailyTotalAmount {
  date: string;
  /** 该交易日全市场 ETF 总成交额（元） */
  totalAmount: number;
}

export interface LiquidityThreshold {
  /** 参与计算的交易日（升序） */
  dates: string[];
  /** 每个交易日的全市场 ETF 总成交额（元） */
  totalByDate: number[];
  /** 总成交额的日均值（元） */
  avgTotal: number;
  /** 流动性阈值（元/日） */
  threshold: number;
  /** 是否走了「有效交易日 < 3 ⇒ 1000 万」的保守回退 */
  fallback: boolean;
}

/**
 * 流动性阈值 —— Python `calculate_global_etf_threshold`
 * @param totals 近 3 个交易日的全市场 ETF 总成交额
 * @param divisor 除数（默认 20000）
 */
export function computeLiquidityThreshold(
  totals: readonly DailyTotalAmount[],
  divisor: number = DEFAULT_LIQUIDITY_DIVISOR,
): LiquidityThreshold {
  if (divisor <= 0) throw new Error(`computeLiquidityThreshold: divisor 必须 > 0（收到 ${divisor}）`);
  const dates = totals.map((t) => t.date);
  const totalByDate = totals.map((t) => t.totalAmount);
  if (totals.length < LIQUIDITY_LOOKBACK_DAYS) {
    return {
      dates,
      totalByDate,
      avgTotal: totals.length > 0 ? totalByDate.reduce((a, b) => a + b, 0) / totals.length : 0,
      threshold: LIQUIDITY_THRESHOLD_FALLBACK,
      fallback: true,
    };
  }
  const avgTotal = totalByDate.reduce((a, b) => a + b, 0) / totalByDate.length;
  return { dates, totalByDate, avgTotal, threshold: avgTotal / divisor, fallback: false };
}

/** 日均成交额：分母固定 3（v5.2 口径，停牌日按 0 计） */
export function avgDailyAmount(totalAmountInWindow: number, days: number = LIQUIDITY_LOOKBACK_DAYS): number {
  return totalAmountInWindow / days;
}

/** 流动性判定：严格大于（等于不算通过） */
export function passesLiquidity(avg: number, threshold: number): boolean {
  return avg > threshold;
}

/**
 * 时点可交易集合 —— `firstBar ≤ T ≤ lastBar`
 *
 * 边界（单测覆盖）：
 *   - 上市日当天（`firstBar == T`）→ **在**集合内（当日可交易）
 *   - 上市前一天（`firstBar == T+1`）→ **不在**
 *   - 末根 bar 当天（`lastBar == T`）→ **在**
 *   - 末根 bar 在前一天（`lastBar == T-1`）→ **不在**（近似「已退市/长期停牌」）
 */
export function isInUniverse(meta: SymbolMeta, asOf: string): boolean {
  return meta.firstBar <= asOf && meta.lastBar >= asOf;
}

/** 过滤出时点可交易集合 */
export function buildUniverse(metas: readonly SymbolMeta[], asOf: string): SymbolMeta[] {
  return metas.filter((m) => isInUniverse(m, asOf));
}

/** 名录命中的一只标的（含入池所需的口径字段，便于报告核对） */
export interface PoolPick {
  symbol: string;
  name: string | null;
  firstBar: string;
  lastBar: string;
  /** 近 3 日日均成交额（元，分母固定 3） */
  avgAmount: number;
}

/**
 * 从给定名单里取「在册 ∩ 流动性通过」的标的
 * @param symbols 名单（固定池 / 全球池）
 * @param metaBySymbol 元信息
 * @param windowTotalBySymbol 近 3 日成交额合计（元）
 */
export function pickPoolByLiquidity(
  symbols: readonly string[],
  metaBySymbol: ReadonlyMap<string, SymbolMeta>,
  windowTotalBySymbol: ReadonlyMap<string, number>,
  asOf: string,
  threshold: number,
  days: number = LIQUIDITY_LOOKBACK_DAYS,
): PoolPick[] {
  const picks: PoolPick[] = [];
  for (const symbol of symbols) {
    const meta = metaBySymbol.get(symbol);
    if (!meta || !isInUniverse(meta, asOf)) continue;
    const avg = avgDailyAmount(windowTotalBySymbol.get(symbol) ?? 0, days);
    if (!passesLiquidity(avg, threshold)) continue;
    picks.push({
      symbol,
      name: meta.name,
      firstBar: meta.firstBar,
      lastBar: meta.lastBar,
      avgAmount: avg,
    });
  }
  return picks.sort((a, b) => b.avgAmount - a.avgAmount);
}

/** 名单里有数据（`raw_kline_daily` 至少一根 bar）的标的数 —— 锚点「115/115 命中」用 */
export function countCovered(
  symbols: readonly string[],
  metaBySymbol: ReadonlyMap<string, SymbolMeta>,
): number {
  return symbols.filter((s) => metaBySymbol.has(s)).length;
}

// ───────────────────────────── DB 取数 + 组装 ─────────────────────────────

export interface UniverseOptions {
  /** 流动性阈值除数，默认 20000 */
  divisor?: number;
  /** 动态池截断数量，默认 300 */
  topN?: number;
  /** 复用已加载的日历（批量跑多个 T 时省一次查询） */
  calendar?: TradingCalendar;
  /** 停牌判定开关（仅影响名录里「T 日是否停牌」标记） */
  suspension?: SuspensionOptions;
}

/** 名录里单只标的的停牌标记（在 T 日） */
export interface SuspensionFlag {
  symbol: string;
  suspended: boolean;
  reason: 'missing-bar' | 'zero-volume' | null;
}

export interface UniverseSnapshot {
  /** 请求日（可能是非交易日） */
  requestedAsOf: string;
  /** 对齐后的交易日（非交易日回退到前一个交易日） */
  asOf: string;
  /**
   * 流动性窗口的 3 个交易日（**含 asOf 当天**，升序）
   *
   * ⚠️ v5.2 在运行时用的是 `context.previous_date`（不含当天）；本文件的对齐目标是
   * 可行性报告 / 锚点口径（含当天）。**回测引擎在 T 开盘前决策时必须传 `asOf = T-1`**，
   * 否则会用当天收盘后才拿到的成交额 → 前视。
   */
  liquidityDates: string[];
  liquidity: LiquidityThreshold;
  /** 全市场 ETF 总数（`raw_symbol_class.class='etf'`） */
  marketSymbolCount: number;
  /** Universe(T) 大小 */
  universeCount: number;
  /** 全市场通过流动性阈值只数（锚点 673） */
  marketLiquidityPassCount: number;
  fixedPoolSize: number;
  /**
   * 固定池 ∩ Universe(T)（在册可交易）
   * ⚠️ 锚点里的「固定池 112/114 可交易」指的是 {@link fixed} 的长度（= 流动性通过），不是本字段
   */
  fixedTradableCount: number;
  /** 固定池（含防御标的）在库里的命中数（锚点 115/115） */
  fixedCoverageCount: number;
  /** 固定池 ∩ Universe(T) ∩ 流动性（锚点 112/114） */
  fixed: PoolPick[];
  /** 全球池 ∩ Universe(T) ∩ 流动性（走弱期用池） */
  weak: PoolPick[];
  dynamic: DynamicPoolResult;
}

/** 读近 3 日「逐标的成交额合计」+「逐日全市场合计」 */
async function loadAmountWindow(dates: readonly string[]): Promise<{
  perSymbol: Map<string, number>;
  perDate: Map<string, number>;
}> {
  const perSymbol = new Map<string, number>();
  const perDate = new Map<string, number>();
  if (dates.length === 0) return { perSymbol, perDate };

  const placeholders = dates.map(() => '?').join(', ');
  const rows = await queryDuckDB<{ date: string; symbol: string; amount: number }>(
    `SELECT k.date AS date, k.symbol AS symbol, sum(k.amount) AS amount
       FROM raw_kline_daily k
       INNER JOIN raw_symbol_class c ON c.symbol = k.symbol AND c.class = 'etf'
      WHERE k.date IN (${placeholders})
      GROUP BY k.date, k.symbol`,
    [...dates],
  );

  for (const r of rows) {
    perSymbol.set(r.symbol, (perSymbol.get(r.symbol) ?? 0) + r.amount);
    perDate.set(r.date, (perDate.get(r.date) ?? 0) + r.amount);
  }
  return { perSymbol, perDate };
}

/**
 * 解析某个时点 T 的完整名录（固定池 / 动态池 / 走弱期池 + 阈值）
 *
 * @param asOf 目标日期（非交易日会**回退**到前一个交易日，并在 `requestedAsOf` 里保留原值）
 */
export async function resolveUniverseAt(
  asOf: string,
  options: UniverseOptions = {},
): Promise<UniverseSnapshot> {
  const calendar = options.calendar ?? (await loadTradingCalendar());
  const aligned = calendar.alignOrBefore(asOf);
  if (aligned === null) {
    throw new Error(`resolveUniverseAt: ${asOf} 早于交易日历起点（${calendar.all[0] ?? '空日历'}）`);
  }

  const liquidityDates = calendar.lastN(aligned, LIQUIDITY_LOOKBACK_DAYS);
  const metas = await getEtfSymbolMeta();
  const metaBySymbol = new Map(metas.map((m) => [m.symbol, m]));

  const { perSymbol, perDate } = await loadAmountWindow(liquidityDates);
  const liquidity = computeLiquidityThreshold(
    liquidityDates.map((date) => ({ date, totalAmount: perDate.get(date) ?? 0 })),
    options.divisor ?? DEFAULT_LIQUIDITY_DIVISOR,
  );

  const universe = buildUniverse(metas, aligned);
  const universeSet = new Map(universe.map((m) => [m.symbol, m]));

  // 全市场通过流动性阈值的只数（只统计在册标的，退市标的不算）
  let marketLiquidityPassCount = 0;
  for (const m of universe) {
    const avg = avgDailyAmount(perSymbol.get(m.symbol) ?? 0);
    if (passesLiquidity(avg, liquidity.threshold)) marketLiquidityPassCount++;
  }

  const fixed = pickPoolByLiquidity(FIXED_ETF_POOL, metaBySymbol, perSymbol, aligned, liquidity.threshold);
  const weak = pickPoolByLiquidity(GLOBAL_ETF_POOL, metaBySymbol, perSymbol, aligned, liquidity.threshold);

  // 动态池候选 = Universe(T) ∩ 流动性通过
  const candidates: DynamicPoolCandidate[] = [];
  for (const m of universe) {
    const avg = avgDailyAmount(perSymbol.get(m.symbol) ?? 0);
    if (!passesLiquidity(avg, liquidity.threshold)) continue;
    candidates.push({ symbol: m.symbol, name: m.name, avgAmount: avg });
  }

  return {
    requestedAsOf: asOf,
    asOf: aligned,
    liquidityDates,
    liquidity,
    marketSymbolCount: metas.length,
    universeCount: universe.length,
    marketLiquidityPassCount,
    fixedPoolSize: FIXED_ETF_POOL.length,
    fixedTradableCount: FIXED_ETF_POOL.filter((s) => universeSet.has(s)).length,
    fixedCoverageCount: countCovered([...FIXED_ETF_POOL, DEFENSIVE_ETF], metaBySymbol),
    fixed,
    weak,
    dynamic: buildDynamicPool(candidates, options.topN ?? DEFAULT_DYNAMIC_TOP_N),
  };
}
