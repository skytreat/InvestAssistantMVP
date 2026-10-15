/**
 * MACD 指数平滑异同移动平均线
 *
 * EMA 初值口径：EMA 第一个值 = 首日收盘价（不是 SMA！这是 MVP 约定）
 * - EMA(X, period) = price[0] 当 i=0
 *                  = alpha * price[i] + (1-alpha) * EMA[i-1] 当 i>0
 *   其中 alpha = 2 / (period + 1)
 * - DIF = EMA12 - EMA26
 * - DEA = EMA(DIF, 9)
 * - MACD柱 = 2 * (DIF - DEA)
 */

export interface MACDResult {
  dif: number[];
  dea: number[];
  macd: number[];  // 柱状图值，2*(DIF-DEA)
}

function ema(values: number[], period: number): number[] {
  const alpha = 2 / (period + 1);
  const result: number[] = new Array(values.length);
  result[0] = values[0];  // 初值 = 首日收盘价（MVP 约定，golden 数据集基于此）
  for (let i = 1; i < values.length; i++) {
    result[i] = alpha * values[i] + (1 - alpha) * result[i - 1];
  }
  return result;
}

export function calculateMACD(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  if (closes.length < slowPeriod + signalPeriod) {
    return { dif: [], dea: [], macd: [] };
  }

  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);

  const dif: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    dif[i] = emaFast[i] - emaSlow[i];
  }

  const dea = ema(dif, signalPeriod);

  const macd: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    macd[i] = 2 * (dif[i] - dea[i]);
  }

  return { dif, dea, macd };
}
