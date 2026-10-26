/**
 * T51 golden 数据集回归网
 *
 * golden 不再是双端一致性的唯一保障（一致性由 fast-technical-indicators@1.1.6 版本锁定保证），
 * 降级为**回归网**：防库升级 / 防适配层改错 / 防 KDJ 手写实现漂移。
 *
 * ⚠️ 断言**逐位相等**，不允许容差：
 * - RSI 库侧已做 2 位小数取整，任何容差都会掩盖取整行为的变化
 * - KDJ 是递归平滑指标，末位差异即口径漂移
 */
import { describe, it, expect } from 'vitest';
import {
  calculateRSI,
  calculateMACD,
  calculateSMA,
  RSI_DEFAULT_PERIOD,
  MACD_DEFAULT_SLOW_PERIOD,
  MACD_DEFAULT_SIGNAL_PERIOD,
  A_SHARE_HISTOGRAM_SCALE,
  RSI_INSUFFICIENT_VALUE,
} from '../src/indicators/adapters';
import { calculateMovingWeightedCost, type TradeRecord } from '../src/movingWeightedCost';
import rsiGolden from './fixtures/golden/rsi.json';
import macdGolden from './fixtures/golden/macd.json';
import mwcGolden from './fixtures/golden/movingWeightedCost.json';
import mwcV3Golden from './fixtures/golden/movingWeightedCostV3.json';

function assertBitwiseEqual(actual: number[], expected: Array<number | null>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    if (want === null) {
      expect(Number.isNaN(actual[i])).toBe(true);
    } else {
      // toBe 即 Object.is：NaN 与 ±0 的处理也一并锁死
      expect(actual[i]).toBe(want);
    }
  }
}

describe('golden · RSI', () => {
  const closes = rsiGolden.closes as number[];

  it.each(rsiGolden.cases)('period=$params.period 逐位一致', (c) => {
    assertBitwiseEqual(calculateRSI(closes, c.params.period), c.expected);
  });

  it('golden 数据集本身非空且来自真实行情', () => {
    expect(rsiGolden.meta.barCount).toBe(221);
    expect(rsiGolden.meta.library).toBe('fast-technical-indicators@1.1.6');
    expect(closes.length).toBe(221);
    expect(closes.some((v) => v <= 0)).toBe(false);
  });

  it('返回值长度恒等于输入长度（形状契约）', () => {
    for (const n of [0, 1, 13, 14, 15, 40, 221]) {
      const slice = closes.slice(0, n);
      expect(calculateRSI(slice, RSI_DEFAULT_PERIOD).length).toBe(n);
    }
  });

  it('数据不足期填 50，而不是 NaN / undefined', () => {
    const rsi = calculateRSI([100, 101, 102], RSI_DEFAULT_PERIOD);
    expect(rsi).toEqual([RSI_INSUFFICIENT_VALUE, RSI_INSUFFICIENT_VALUE, RSI_INSUFFICIENT_VALUE]);
    expect(rsi.some((v) => Number.isNaN(v))).toBe(false);
  });
});

describe('golden · MACD', () => {
  const closes = macdGolden.closes as number[];

  it.each(macdGolden.cases)(
    'fast=$params.fastPeriod slow=$params.slowPeriod signal=$params.signalPeriod 逐位一致',
    (c) => {
      const r = calculateMACD(closes, c.params.fastPeriod, c.params.slowPeriod, c.params.signalPeriod);
      assertBitwiseEqual(r.dif, c.dif);
      assertBitwiseEqual(r.dea, c.dea);
      assertBitwiseEqual(r.macd, c.macd);
    },
  );

  it('SMA(5/10/20/60) 逐位一致', () => {
    for (const c of macdGolden.sma.values) {
      assertBitwiseEqual(calculateSMA(closes, c.period), c.values);
    }
  });

  it('柱值严格等于 2 × (DIF - DEA)（A 股通达信约定，不是美式）', () => {
    expect(A_SHARE_HISTOGRAM_SCALE).toBe(2);
    const r = calculateMACD(closes);
    for (let i = 0; i < r.macd.length; i++) {
      if (Number.isNaN(r.dea[i])) continue;
      expect(r.macd[i]).toBe(2 * (r.dif[i] - r.dea[i]));
    }
  });

  it('长度不足 slowPeriod + signalPeriod 时返回三个空数组', () => {
    const short = closes.slice(0, MACD_DEFAULT_SLOW_PERIOD + MACD_DEFAULT_SIGNAL_PERIOD - 1);
    const r = calculateMACD(short);
    expect(r.dif).toEqual([]);
    expect(r.dea).toEqual([]);
    expect(r.macd).toEqual([]);
  });

  it('warm-up 期（DIF/DEA/柱值播种期）为 NaN 而非 0', () => {
    const r = calculateMACD(closes);
    // DIF 需要 slowPeriod - 1 根播种
    for (let i = 0; i < MACD_DEFAULT_SLOW_PERIOD - 1; i++) {
      expect(Number.isNaN(r.dif[i])).toBe(true);
    }
    // DEA / 柱值还要再等 signalPeriod - 1 根
    for (let i = 0; i < MACD_DEFAULT_SLOW_PERIOD + MACD_DEFAULT_SIGNAL_PERIOD - 2; i++) {
      expect(Number.isNaN(r.dea[i])).toBe(true);
      expect(Number.isNaN(r.macd[i])).toBe(true);
    }
  });

  it('SMA 长度不足 period 时全 NaN', () => {
    const r = calculateSMA([1, 2], 5);
    expect(r.length).toBe(2);
    expect(r.every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('golden · 移动加权成本（5 场景）', () => {
  it('场景数为 5（SDD §12.3 A1-A5）', () => {
    expect(mwcGolden.scenarios.length).toBe(5);
    expect(mwcGolden.scenarios.map((s) => s.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
  });

  it.each(mwcGolden.scenarios)('$id $name 逐字段一致', (s) => {
    const actual = calculateMovingWeightedCost(s.trades as TradeRecord[]);
    expect(actual.totalQuantity).toBe(s.expected.totalQuantity);
    expect(actual.avgCost).toBe(s.expected.avgCost);
    expect(actual.totalCostBasis).toBe(s.expected.totalCostBasis);
    expect(actual.realizedPnL).toBe(s.expected.realizedPnL);
    expect(actual.totalFee).toBe(s.expected.totalFee);
    expect(actual.cashReceived).toBe(s.expected.cashReceived);
  });
});

describe('golden · 移动加权成本 V3（T119 送股/分红 5 场景）', () => {
  it('场景数为 5（SDD_v3 §8.3 B1-B5）', () => {
    expect(mwcV3Golden.scenarios.length).toBe(5);
    expect(mwcV3Golden.scenarios.map((s) => s.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
  });

  it.each(mwcV3Golden.scenarios)('$id $name 逐字段一致', (s) => {
    const actual = calculateMovingWeightedCost(s.trades as TradeRecord[]);
    expect(actual.totalQuantity).toBe(s.expected.totalQuantity);
    // 金额/盈亏类用容差断言：均价 10.05（fee=5）等浮点值不能 toBe（B5 场景）
    expect(actual.avgCost).toBeCloseTo(s.expected.avgCost, 6);
    expect(actual.totalCostBasis).toBeCloseTo(s.expected.totalCostBasis, 6);
    expect(actual.realizedPnL).toBeCloseTo(s.expected.realizedPnL, 6);
    expect(actual.totalFee).toBeCloseTo(s.expected.totalFee, 6);
    expect(actual.cashReceived).toBeCloseTo(s.expected.cashReceived, 6);
  });

  // 双口径可加（T119 G4）：含分红净利 = realizedPnL + cashReceived
  it('B5 双口径可加：价差 492 + 分红 50 = 542', () => {
    const s = mwcV3Golden.scenarios.find((x) => x.id === 'B5')!;
    const actual = calculateMovingWeightedCost(s.trades as TradeRecord[]);
    expect(actual.realizedPnL + actual.cashReceived).toBeCloseTo(542, 6);
  });
});
