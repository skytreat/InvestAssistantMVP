import { describe, it, expect } from 'vitest';
import { calculateMACD } from '../src/indicators/macd';

describe('MACD', () => {
  it('长度不够返回空数组', () => {
    const result = calculateMACD([100, 101, 102, 103, 104]);
    expect(result.dif.length).toBe(0);
    expect(result.dea.length).toBe(0);
    expect(result.macd.length).toBe(0);
  });

  it('静态价格（全部 100）DIF DEA MACD 全 0', () => {
    const data = new Array(50).fill(100);
    const result = calculateMACD(data);
    // 静态价格 → EMA12=EMA26=100 → DIF=0 → DEA=0 → MACD=0
    const lastIdx = result.dif.length - 1;
    expect(result.dif[lastIdx]).toBeCloseTo(0, 4);
    expect(result.dea[lastIdx]).toBeCloseTo(0, 4);
    expect(result.macd[lastIdx]).toBeCloseTo(0, 4);
  });

  it('返回数组长度与输入一致', () => {
    const data = new Array(50).fill(100).map((v, i) => v + i); // 线性上涨
    const result = calculateMACD(data);
    expect(result.dif.length).toBe(50);
    expect(result.dea.length).toBe(50);
    expect(result.macd.length).toBe(50);
  });
});
