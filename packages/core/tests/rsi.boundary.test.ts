import { describe, it, expect } from 'vitest';
import { calculateRSI } from '../src/indicators/rsi';

describe('RSI §12.3 边界用例', () => {
  it('A8 全阳线（每天 +1）20 根，最后 RSI 应接近 100（≥99）', () => {
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      closes.push(price);
      price += 1;
    }
    const rsi = calculateRSI(closes, 14);
    // 全阳线 avg_loss=0，Wilder 法 rs→100，RSI=100-100/101≈99.01
    expect(rsi[rsi.length - 1]).toBeGreaterThanOrEqual(99);
    expect(rsi[rsi.length - 1]).toBeLessThanOrEqual(100);
  });

  it('A9 全阴线（每天 -1）20 根，最后 RSI 应接近 0（≤1）', () => {
    const closes: number[] = [];
    let price = 120;
    for (let i = 0; i < 20; i++) {
      closes.push(price);
      price -= 1;
    }
    const rsi = calculateRSI(closes, 14);
    // 全阴线 avg_gain=0，rs=0，RSI=100-100/1=0
    expect(rsi[rsi.length - 1]).toBeLessThanOrEqual(1);
    expect(rsi[rsi.length - 1]).toBeGreaterThanOrEqual(0);
  });

  it('A10 行情数据不足 14 根（如 3 根），返回长度 = 输入长度', () => {
    const closes = [100, 101, 102];
    const rsi = calculateRSI(closes, 14);
    // 现有实现：不计算，返回同长度 50 填充（不是 null）
    expect(rsi.length).toBe(3);
    expect(rsi.every((v) => v === 50)).toBe(true);
  });
});
