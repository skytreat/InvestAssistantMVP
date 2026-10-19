import { describe, it, expect } from 'vitest';
import { calculateMACD } from '../src/indicators/macd';

describe('MACD §12.3 边界用例', () => {
  it('A11 输入单调上涨，MACD 柱状图应全非负', () => {
    // 线性上涨：EMA12（快）始终高于 EMA26（慢）→ DIF 全正 → DEA 全正 → MACD 柱全正
    // ⚠️ T51 起 MACD 由 fast-technical-indicators 计算，EMA 用前 N 期 SMA 播种，
    //    故前 (slowPeriod-1)+(signalPeriod-1) 根为 NaN（无值，非 0），断言只覆盖有值段。
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) {
      closes.push(100 + i);
    }
    const { dif, dea, macd } = calculateMACD(closes);
    const difWarmUp = 26 - 1;      // DIF 需要 slowPeriod 根播种
    const deaWarmUp = 25 + 9 - 1;  // DEA / 柱值还要再等 signalPeriod 根
    for (let i = 0; i < difWarmUp; i++) {
      expect(Number.isNaN(dif[i])).toBe(true);
    }
    for (let i = 0; i < deaWarmUp; i++) {
      expect(Number.isNaN(dea[i])).toBe(true);
      expect(Number.isNaN(macd[i])).toBe(true);
    }
    for (let i = deaWarmUp; i < macd.length; i++) {
      expect(macd[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('A12 构造 DIF 上穿 DEA 场景（金叉）', () => {
    // 先跌后涨：前 50 根每天 -2（快线跌得更狠 → DIF < DEA），后 20 根每天 +10（急涨让 DIF 快速反弹穿越 DEA）
    const closes: number[] = [];
    let price = 200;
    for (let i = 0; i < 50; i++) {
      closes.push(price);
      price -= 2;
    }
    for (let i = 0; i < 20; i++) {
      closes.push(price);
      price += 10;
    }
    const { dif, dea } = calculateMACD(closes);

    // 从 slowPeriod(26) 之后开始扫，避免 EMA 初值效应导致的假穿越
    let goldenCrossIdx = -1;
    for (let i = 26; i < dif.length - 1; i++) {
      if (dif[i] <= dea[i] && dif[i + 1] > dea[i + 1]) {
        goldenCrossIdx = i + 1;
        break;
      }
    }
    expect(goldenCrossIdx).toBeGreaterThanOrEqual(0);
    // 穿越发生后，DIF 持续高于 DEA
    for (let i = goldenCrossIdx; i < dif.length; i++) {
      expect(dif[i]).toBeGreaterThan(dea[i]);
    }
  });

  it('A13 构造 DIF 下穿 DEA 场景（死叉）', () => {
    // 对称 A12：先涨后跌
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 50; i++) {
      closes.push(price);
      price += 2;
    }
    for (let i = 0; i < 20; i++) {
      closes.push(price);
      price -= 10;
    }
    const { dif, dea } = calculateMACD(closes);

    let deathCrossIdx = -1;
    for (let i = 26; i < dif.length - 1; i++) {
      if (dif[i] >= dea[i] && dif[i + 1] < dea[i + 1]) {
        deathCrossIdx = i + 1;
        break;
      }
    }
    expect(deathCrossIdx).toBeGreaterThanOrEqual(0);
    // 穿越发生后，DIF 持续低于 DEA
    for (let i = deathCrossIdx; i < dif.length; i++) {
      expect(dif[i]).toBeLessThan(dea[i]);
    }
  });
});
