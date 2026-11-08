/**
 * 连续序列（前复权到当日 T）与「除权调整后前收」（DAS-2 §3.1a）。
 *
 * ```text
 * F(t)   = 后复权因子（raw_adjust_factor）
 * adj(t) = raw(t) × F(t) / F(T)
 * prev_close_adj(T) = raw(T−1) × F(T−1) / F(T)
 * ```
 *
 * 指标只吃 `adj`：`adj(T) == raw(T)`，所以 MA 与 raw 快照价同量纲可直接比较。
 */
import type { PriceBar } from './types.js';

/** 因子缺失/非正时按 1 处理（参考实现 `f_today <= 0 → 1`）。 */
export function normalizeFactor(factor: number): number {
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

export interface AdjustedWindow {
  close: number[];
  high: number[];
  low: number[];
  /** 窗口内每根 bar 的因子（已归一化） */
  factors: number[];
}

/**
 * 把 `bars`（升序，末尾为 T 或 T 前最近可用 bar）整体前复权到 `endFactor`。
 *
 * 窗口长度由调用方控制（最多 `INDICATOR_LOOKBACK` 根）。
 */
export function forwardAdjustWindow(bars: readonly PriceBar[], endFactor: number): AdjustedWindow {
  const fT = normalizeFactor(endFactor);
  const close: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const factors: number[] = [];
  for (const bar of bars) {
    const f = normalizeFactor(bar.hfqFactor);
    close.push((bar.close * f) / fT);
    high.push((bar.high * f) / fT);
    low.push((bar.low * f) / fT);
    factors.push(f);
  }
  return { close, high, low, factors };
}

export interface PrevCloseResult {
  /** 除权调整后前收（§3.1a），非空 */
  prevCloseAdj: number;
  /** T 日生效因子 F(T)（停牌时为最近有效 bar 的因子） */
  factor: number;
}

/**
 * 计算 `prev_close_adj(T)`。
 *
 * - 索引 `lastIndex` 指向「≤ T 的最后一根 bar」（停牌时即 T 前最近一根）。
 * - `lastIndex == 0` 时参考实现用当日收盘代替前收（`prev_close_raw = close_today`），此处同义。
 * - 停牌日仍返回非空值（与「指标用最近可用序列」口径一致）；该值不参与过滤
 *   （第 2 步已短路为 `SUSPENDED`）。
 */
export function calcPrevCloseAdj(bars: readonly PriceBar[], lastIndex: number): PrevCloseResult {
  if (lastIndex < 0 || lastIndex >= bars.length) {
    return { prevCloseAdj: 0, factor: 1 };
  }
  const today = bars[lastIndex];
  const fToday = normalizeFactor(today.hfqFactor);
  if (lastIndex === 0) {
    return { prevCloseAdj: today.close, factor: fToday };
  }
  const prev = bars[lastIndex - 1];
  const fPrev = normalizeFactor(prev.hfqFactor);
  return { prevCloseAdj: (prev.close * fPrev) / fToday, factor: fToday };
}

/** 取「≤ 目标日期的最后一根 bar」的下标；没有则 -1（二分查找，O(log n)）。 */
export function lastIndexOnOrBefore(bars: readonly PriceBar[], date: string): number {
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
