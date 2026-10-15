import { describe, it, expect } from 'vitest';
import { calculateRSI } from '../src/indicators/rsi';

describe('RSI Wilder 法', () => {
  // 固定测试序列（前 14 天全部 100）
  const flat14 = new Array(15).fill(100);

  it('价格无变化时 RSI 应在合法区间', () => {
    const rsi = calculateRSI(flat14, 14);
    expect(rsi[rsi.length - 1]).toBeGreaterThanOrEqual(0);
    expect(rsi[rsi.length - 1]).toBeLessThanOrEqual(100);
  });

  it('10连涨 RSI 应接近 100', () => {
    const data: number[] = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      data.push(price);
      price += 1;  // 每天+1
    }
    const rsi = calculateRSI(data, 14);
    expect(rsi[rsi.length - 1]).toBeGreaterThan(70);  // 强势上涨
  });

  it('长度不够时返回 50 填充', () => {
    const rsi = calculateRSI([100, 101, 102], 14);
    expect(rsi.length).toBe(3);
    expect(rsi.every(v => v === 50)).toBe(true);
  });
});
