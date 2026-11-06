/**
 * 引擎专用「时点名录」—— **一次预载 + 内存逐日快照**
 *
 * 为什么要这一层（与 M1 `resolveUniverseAt` 的关系）：
 * - `resolveUniverseAt(asOf)` 每次调用都会查 3 次库（日历 / ETF 名录 / 3 日成交额）；
 *   回测逐日调用 = 2000 个交易日 × 3 次往返，不可接受（§3.1「一次性批量取数后关闭连接」）。
 * - 但**口径不能另造**：本文件的 `assembleSnapshot()` 逐行照抄 `resolveUniverseAt` 的组装逻辑，
 *   调用的仍是 M1 的纯函数（`computeLiquidityThreshold` / `buildUniverse` / `pickPoolByLiquidity` /
 *   `buildDynamicPool` / `countCovered`）。
 * - 一致性由集成测试兜底：同一时点与本尊 `resolveUniverseAt` **逐字段相等**（真库档才有意义）。
 *
 * 内存形态：`Map<date, Map<symbol, amount>>`（区间内每个交易日 × 全部 ETF）。
 * 若区间很长（2018-2026 ≈ 2000 日 × 2000 只）会占几百 MB —— 这是当前唯一的重内存点，
 * M2 的 CLI 默认区间很短；M4 做长区间寻优时再换成列存（见实施计划偏差登记）。
 */
import { queryDuckDB } from '../../../db/duckdb.js';
import { getEtfSymbolMeta } from '../marketPanel.js';
import type { SymbolMeta } from '../types.js';
import { TradingCalendar, loadTradingCalendar } from '../calendar.js';
import {
  DEFAULT_DYNAMIC_TOP_N,
  DEFAULT_LIQUIDITY_DIVISOR,
  LIQUIDITY_LOOKBACK_DAYS,
  avgDailyAmount,
  buildUniverse,
  computeLiquidityThreshold,
  countCovered,
  passesLiquidity,
  pickPoolByLiquidity,
  type UniverseSnapshot,
} from './pointInTime.js';
import { buildDynamicPool, type DynamicPoolCandidate } from './nameCleaning.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL, GLOBAL_ETF_POOL } from './fixedPool.js';

export type UniverseResolver = (asOf: string) => UniverseSnapshot;

export interface UniverseProviderOptions {
  calendar?: TradingCalendar;
  divisor?: number;
  topN?: number;
}

/** 按 `resolveUniverseAt` 的口径组装快照（纯函数，便于对拍） */
export function assembleSnapshot(
  metas: readonly SymbolMeta[],
  aligned: string,
  liquidityDates: readonly string[],
  perSymbol: ReadonlyMap<string, number>,
  perDate: ReadonlyMap<string, number>,
  options: UniverseProviderOptions = {},
  requestedAsOf: string = aligned,
): UniverseSnapshot {
  const metaBySymbol = new Map(metas.map((m) => [m.symbol, m]));
  const liquidity = computeLiquidityThreshold(
    liquidityDates.map((date) => ({ date, totalAmount: perDate.get(date) ?? 0 })),
    options.divisor ?? DEFAULT_LIQUIDITY_DIVISOR,
  );
  const universe = buildUniverse(metas, aligned);
  const universeSet = new Map(universe.map((m) => [m.symbol, m]));

  let marketLiquidityPassCount = 0;
  for (const m of universe) {
    if (passesLiquidity(avgDailyAmount(perSymbol.get(m.symbol) ?? 0), liquidity.threshold)) {
      marketLiquidityPassCount++;
    }
  }

  const fixed = pickPoolByLiquidity(FIXED_ETF_POOL, metaBySymbol, perSymbol, aligned, liquidity.threshold);
  const weak = pickPoolByLiquidity(GLOBAL_ETF_POOL, metaBySymbol, perSymbol, aligned, liquidity.threshold);

  const candidates: DynamicPoolCandidate[] = [];
  for (const m of universe) {
    const avg = avgDailyAmount(perSymbol.get(m.symbol) ?? 0);
    if (!passesLiquidity(avg, liquidity.threshold)) continue;
    candidates.push({ symbol: m.symbol, name: m.name, avgAmount: avg });
  }

  return {
    requestedAsOf,
    asOf: aligned,
    liquidityDates: [...liquidityDates],
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

/** 内存时点名录 */
export class InMemoryUniverseProvider {
  private readonly snapshotCache = new Map<string, UniverseSnapshot>();

  constructor(
    private readonly metas: readonly SymbolMeta[],
    private readonly calendar: TradingCalendar,
    private readonly amountByDate: ReadonlyMap<string, ReadonlyMap<string, number>>,
    private readonly options: UniverseProviderOptions = {},
  ) {}

  /** 某个交易日的完整名录（非交易日对齐到前一个交易日） */
  snapshotAt(asOf: string): UniverseSnapshot {
    const aligned = this.calendar.alignOrBefore(asOf);
    if (aligned === null) {
      throw new Error(`InMemoryUniverseProvider: ${asOf} 早于交易日历起点`);
    }
    const cached = this.snapshotCache.get(aligned);
    if (cached) return cached;

    const liquidityDates = this.calendar.lastN(aligned, LIQUIDITY_LOOKBACK_DAYS);
    const perSymbol = new Map<string, number>();
    const perDate = new Map<string, number>();
    for (const date of liquidityDates) {
      const rows = this.amountByDate.get(date);
      if (!rows) continue;
      let total = 0;
      for (const [symbol, amount] of rows) {
        perSymbol.set(symbol, (perSymbol.get(symbol) ?? 0) + amount);
        total += amount;
      }
      perDate.set(date, total);
    }

    const snapshot = assembleSnapshot(
      this.metas,
      aligned,
      liquidityDates,
      perSymbol,
      perDate,
      this.options,
      asOf,
    );
    this.snapshotCache.set(aligned, snapshot);
    return snapshot;
  }
}

/** 取区间起点前若干交易日，保证第一天决策的 3 日流动性窗口完整 */
function preloadStart(calendar: TradingCalendar, start: string): string {
  const window = calendar.lastN(start, LIQUIDITY_LOOKBACK_DAYS + 1);
  return window[0] ?? start;
}

/**
 * 从 DuckDB 预载名录数据（只读，一次查询）
 *
 * @param start 回测区间起点（会额外向前取 3 个交易日）
 * @param end 回测区间终点
 */
export async function loadUniverseProvider(
  start: string,
  end: string,
  options: UniverseProviderOptions = {},
): Promise<InMemoryUniverseProvider> {
  const calendar = options.calendar ?? (await loadTradingCalendar());
  const from = preloadStart(calendar, start);
  const [metas, rows] = await Promise.all([
    getEtfSymbolMeta(),
    queryDuckDB<{ date: string; symbol: string; amount: number }>(
      `SELECT k.date AS date, k.symbol AS symbol, sum(k.amount) AS amount
         FROM raw_kline_daily k
         INNER JOIN raw_symbol_class c ON c.symbol = k.symbol AND c.class = 'etf'
        WHERE k.date BETWEEN ? AND ?
        GROUP BY k.date, k.symbol`,
      [from, end],
    ),
  ]);

  const amountByDate = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let bucket = amountByDate.get(r.date);
    if (!bucket) {
      bucket = new Map<string, number>();
      amountByDate.set(r.date, bucket);
    }
    bucket.set(r.symbol, r.amount);
  }

  return new InMemoryUniverseProvider(metas, calendar, amountByDate, options);
}
