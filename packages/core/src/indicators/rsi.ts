/**
 * RSI 相对强弱指标（Wilder 指数平滑法）
 *
 * 公式（Wilder 原始定义，不是 EMA 替代版）：
 * - 初始平均涨跌 = 前 N 日涨跌的简单平均
 * - 后续平均涨跌 = (prev_avg * (N-1) + current_change) / N
 * - RS = avg_gain / avg_loss
 * - RSI = 100 - 100 / (1 + RS)
 */

export function calculateRSI(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);

  const rsi: number[] = new Array(closes.length).fill(50);
  const changes: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // 初始平均涨跌（简单平均）
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += -changes[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // 第一个 RSI 值（位置 period）
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi[period] = 100 - 100 / (1 + rs);

  // Wilder 平滑
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi[i + 1] = 100 - 100 / (1 + rs);
  }

  return rsi;
}
