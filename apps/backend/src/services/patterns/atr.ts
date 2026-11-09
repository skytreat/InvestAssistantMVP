/**
 * ATR（Wilder 平滑）—— 形态判据的自适应幅度基准
 *
 * 口径见 `docs/client/pattern_recognition_design.md` §5：
 *   TR[0] = high-low
 *   TR[i] = max(high-low, |high-prevClose|, |low-prevClose|)
 *   ATR[period-1] = mean(TR[0..period-1])
 *   ATR[i] = (ATR[i-1]×(period-1) + TR[i]) / period
 *   ATR[i] = NaN（预热不足）
 *
 * ⚠️ 预热不足时返回 NaN，调用方必须让相关判据**不成立**（不补零、不猜值）。
 */
import type { DailyKline } from '@invest/core';

export const DEFAULT_ATR_PERIOD = 14;

export function calculateATR(bars: DailyKline[], period: number = DEFAULT_ATR_PERIOD): number[] {
  const n = bars.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n === 0 || period < 1) return out;

  const tr: number[] = new Array(n).fill(NaN);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < n; i++) {
    const prevClose = bars[i - 1].close;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
  }

  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}
