/**
 * 行情面板（M1）—— DuckDB **只读**取数封装
 *
 * 硬约束（AGENTS.md / proposal §3.1）：
 *   - 只走 `v_etf_qfq` / `v_etf_bfq` / `v_etf_hfq` 三个视图（口径由 tdx2db 的视图 DDL 决定，
 *     不在本模块重算复权，避免与视图口径漂移）；
 *   - 一次 `IN (...)` 拿全部标的全区间，**禁止逐标的循环查 DuckDB**；
 *   - `read_only=True` 由 `src/db/duckdb.ts` 的 instance 创建参数统一保证。
 *
 * 停牌两形态（proposal §3.3）：
 *   ① 当日缺 bar（该 symbol 在该交易日没有行）
 *   ② 有 bar 但 `volume = 0`（实测全库 ETF 零量行的 `amount` 也恒为 0，见 `docs/audit`）
 *   两条规则**都实现**，且可通过 {@link SuspensionOptions} 显式关闭任一条。
 */
import { queryDuckDB, queryDuckDBColumnar } from '../../db/duckdb.js';
import { FIXED_ETF_POOL } from './universe/fixedPool.js';
import type {
  Bar,
  AdjustMode,
  SymbolMeta,
  SuspensionOptions,
  SuspensionVerdict,
  ZeroVolumeSeriesMode,
} from './types.js';

/** 复权口径 → ETF 品种视图（⚠️ 指数/股票有独立的 `v_stock_*` 族，本模块只服务 ETF/LOF） */
const VIEW_BY_ADJUST: Record<AdjustMode, string> = {
  qfq: 'v_etf_qfq',
  bfq: 'v_etf_bfq',
  hfq: 'v_etf_hfq',
};

export interface GetBarsOptions {
  /** 复权口径，默认 `qfq` */
  adjust?: AdjustMode;
  /**
   * 零量 bar 在返回序列里的处理方式，默认 `keep`（原样返回，不丢信息）。
   *
   * `drop` 是给「收益序列」用的：把停牌日**剔除并缩短窗口**，这样相邻两根 bar
   * 之间的收益跨越停牌区间，**不会被填成 0%**（proposal §3.3 明确禁止「以 0 收益补齐」）。
   * 估值轨（要按最近有效价盯市）应保持 `keep`。
   */
  zeroVolumeSeries?: ZeroVolumeSeriesMode;
}

/**
 * 批量取日线面板（统一入口）
 * @param symbols 标的代码（`sh510300` 形式）
 * @param start 起始日（含，`YYYY-MM-DD`）
 * @param end 结束日（含）
 * @returns `Map<symbol, Bar[]>`（每只按 date 升序；缺失的标的直接不出现在 Map 里）
 */
export async function getBars(
  symbols: readonly string[],
  start: string,
  end: string,
  options: GetBarsOptions = {},
): Promise<Map<string, Bar[]>> {
  const result = new Map<string, Bar[]>();
  if (symbols.length === 0) return result;

  const view = VIEW_BY_ADJUST[options.adjust ?? 'qfq'];
  const placeholders = symbols.map(() => '?').join(', ');
  const res = await queryDuckDBColumnar(
    `SELECT symbol, date, open, high, low, close, preclose, volume, amount
       FROM ${view}
      WHERE symbol IN (${placeholders}) AND date BETWEEN ? AND ?
      ORDER BY symbol, date ASC`,
    [...symbols, start, end],
  );

  const symCol = res.column('symbol') as string[];
  const dateCol = res.column('date') as string[];
  const openCol = res.column('open') as number[];
  const highCol = res.column('high') as number[];
  const lowCol = res.column('low') as number[];
  const closeCol = res.column('close') as number[];
  const precloseCol = res.column('preclose') as number[];
  const volumeCol = res.column('volume') as number[];
  const amountCol = res.column('amount') as number[];

  for (let i = 0; i < symCol.length; i++) {
    const bar: Bar = {
      date: dateCol[i],
      open: openCol[i],
      high: highCol[i],
      low: lowCol[i],
      close: closeCol[i],
      preclose: precloseCol[i],
      volume: volumeCol[i],
      amount: amountCol[i],
    };
    const list = result.get(symCol[i]);
    if (list) list.push(bar);
    else result.set(symCol[i], [bar]);
  }

  return applyZeroVolumePolicyMap(result, options.zeroVolumeSeries ?? 'keep');
}

/** 对整个 Map 应用零量序列策略 */
export function applyZeroVolumePolicyMap(
  barsBySymbol: Map<string, Bar[]>,
  mode: ZeroVolumeSeriesMode,
): Map<string, Bar[]> {
  if (mode === 'keep') return barsBySymbol;
  const out = new Map<string, Bar[]>();
  for (const [symbol, bars] of barsBySymbol) out.set(symbol, applyZeroVolumePolicy(bars, mode));
  return out;
}

/**
 * 零量 bar 序列策略（纯函数）
 * @param mode `keep` 原样返回；`drop` 剔除零量 bar（序列变短，但不会凭空造出 0 收益）
 */
export function applyZeroVolumePolicy(bars: readonly Bar[], mode: ZeroVolumeSeriesMode): Bar[] {
  if (mode === 'keep') return [...bars];
  return bars.filter((b) => b.volume !== 0);
}

/** 在按 date 升序的序列里二分查某一天的 bar */
export function findBarByDate(bars: readonly Bar[], date: string): Bar | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = bars[mid].date;
    if (d === date) return bars[mid];
    if (d < date) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * 单标的单日停牌判定（两形态，可分别关闭）
 *
 * ⚠️ 必须喂**未经 {@link applyZeroVolumePolicy} 剔除**的原始序列，
 *   否则形态②会被误报成形态①（`drop` 之后零量 bar 看起来就是「缺 bar」）。
 */
export function isSuspended(
  bars: readonly Bar[] | undefined,
  date: string,
  options: SuspensionOptions = {},
): SuspensionVerdict {
  const detectMissingBar = options.missingBar ?? true;
  const detectZeroVolume = options.zeroVolume ?? true;

  const bar = bars && bars.length > 0 ? findBarByDate(bars, date) : undefined;
  if (!bar) {
    return detectMissingBar ? { suspended: true, reason: 'missing-bar' } : { suspended: false, reason: null };
  }
  if (detectZeroVolume && bar.volume === 0) {
    return { suspended: true, reason: 'zero-volume' };
  }
  return { suspended: false, reason: null };
}

/** 单标的在一个交易日窗口内的面板摘要 */
export interface SymbolPanelSummary {
  symbol: string;
  /** 窗口内实际取到的 bar 数 */
  barCount: number;
  /** 窗口内「缺 bar」的交易日数 */
  missingBarCount: number;
  /** 窗口内「volume=0」的交易日数 */
  zeroVolumeCount: number;
  /** 按当前开关判定的停牌日数（含形态①②，取决于 options） */
  suspendedCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * 面板摘要：给定窗口交易日列表，逐标的统计两形态停牌
 * @param windowDates 窗口内的交易日（升序，通常是 `calendar.lastN(end, n)`）
 */
export function summarizePanel(
  barsBySymbol: Map<string, Bar[]>,
  windowDates: readonly string[],
  options: SuspensionOptions = {},
): Map<string, SymbolPanelSummary> {
  const out = new Map<string, SymbolPanelSummary>();
  for (const [symbol, bars] of barsBySymbol) {
    const byDate = new Map(bars.map((b) => [b.date, b]));
    let missingBarCount = 0;
    let zeroVolumeCount = 0;
    let suspendedCount = 0;
    for (const date of windowDates) {
      const bar = byDate.get(date);
      if (!bar) missingBarCount++;
      else if (bar.volume === 0) zeroVolumeCount++;
      if (isSuspended(bars, date, options).suspended) suspendedCount++;
    }
    out.set(symbol, {
      symbol,
      barCount: bars.length,
      missingBarCount,
      zeroVolumeCount,
      suspendedCount,
      firstDate: bars.length > 0 ? bars[0].date : null,
      lastDate: bars.length > 0 ? bars[bars.length - 1].date : null,
    });
  }
  return out;
}

/**
 * 全市场 ETF 元信息：首根 / 末根 bar + 当前快照名称
 *
 * - `firstBar` 是「上市日」的近似（首根 bar ≤ T ⇒ 当日在册可交易，proposal §3.2）
 * - `lastBar` 是「退市/长期停牌」的近似
 * - `name` 来自 `raw_symbol_name` 的**当前快照**（不是当日名称）⇒ **已知偏差**，
 *   见 `universe/nameCleaning.ts` 顶部注释
 */
export async function getEtfSymbolMeta(): Promise<SymbolMeta[]> {
  const metaRows = await queryDuckDB<{ symbol: string; first_bar: string; last_bar: string }>(
    `SELECT k.symbol AS symbol, min(k.date) AS first_bar, max(k.date) AS last_bar
       FROM raw_kline_daily k
       INNER JOIN raw_symbol_class c ON c.symbol = k.symbol AND c.class = 'etf'
      GROUP BY k.symbol
      ORDER BY k.symbol ASC`,
  );

  const nameRows = await queryDuckDB<{ symbol: string; name: string | null }>(
    `SELECT symbol, name FROM raw_symbol_name WHERE class = 'etf'`,
  );
  const nameBySymbol = new Map<string, string | null>();
  for (const r of nameRows) nameBySymbol.set(r.symbol, r.name);

  return metaRows.map((r) => ({
    symbol: r.symbol,
    name: nameBySymbol.get(r.symbol) ?? null,
    firstBar: r.first_bar,
    lastBar: r.last_bar,
  }));
}

/** 固定池（含防御标的）的完整代码集合 —— CLI 默认面板标的 */
export function defaultPanelSymbols(): string[] {
  return [...FIXED_ETF_POOL];
}
