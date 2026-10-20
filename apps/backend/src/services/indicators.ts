// src/services/indicators.ts
// MVP 简化：直接 re-export core 包指标（零额外依赖）
// 将来如需切换 fast-technical-indicators，只需改这个文件

export { calculateRSI as rsi, calculateMACD as macd } from '@invest/core';

// SMA 也需要一个——core 包还没实现 SMA，这里简易实现
/**
 * SMA 简单移动平均（与 core 包 RSI/MACD 同口径）
 * prices[0] = 最早, prices[n-1] = 最新
 * 输出数组长度 = prices.length，前 period-1 个为 NaN
 */
export function calculateSMA(prices: number[], period: number): number[] {
  if (prices.length < period) {
    return new Array(prices.length).fill(NaN);
  }
  const result: number[] = new Array(prices.length).fill(NaN);
  let sum = prices.slice(0, period).reduce((a, b) => a + b, 0);
  result[period - 1] = sum / period;
  for (let i = period; i < prices.length; i++) {
    sum += prices[i] - prices[i - period];
    result[i] = sum / period;
  }
  return result;
}
