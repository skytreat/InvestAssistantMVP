/**
 * indicators.test.ts — 单元测试 src/services/indicators.ts 的 calculateSMA
 *
 * calculateSMA 是纯函数（纯数学计算），不依赖 ConfigStore / 数据库。
 * 测试覆盖：正常路径、边界（length < period、period=1、空数组、负数输入）。
 */
import { describe, it, expect } from 'vitest';
import { calculateSMA } from '../../src/services/indicators.js';

describe('calculateSMA — 简单移动平均', () => {
  // ---------------------------------------------------------
  // 正常路径
  // ---------------------------------------------------------
  describe('正常路径', () => {
    it('[10,20,30,40,50] period=3 → 前 2 个 NaN，第 3 个 avg=20，后续累加', () => {
      const result = calculateSMA([10, 20, 30, 40, 50], 3);

      expect(result.length).toBe(5);

      expect(Number.isNaN(result[0])).toBe(true);
      expect(Number.isNaN(result[1])).toBe(true);

      // (10+20+30)/3 = 20
      expect(result[2]).toBeCloseTo(20);
      // (20+30+40)/3 = 30
      expect(result[3]).toBeCloseTo(30);
      // (30+40+50)/3 = 40
      expect(result[4]).toBeCloseTo(40);
    });

    it('[1,2,3,4,5,6] period=2 → 正确累加滑动窗口', () => {
      const result = calculateSMA([1, 2, 3, 4, 5, 6], 2);

      expect(result.length).toBe(6);
      expect(Number.isNaN(result[0])).toBe(true);

      expect(result[1]).toBeCloseTo(1.5);  // (1+2)/2
      expect(result[2]).toBeCloseTo(2.5);  // (2+3)/2
      expect(result[3]).toBeCloseTo(3.5);  // (3+4)/2
      expect(result[4]).toBeCloseTo(4.5);  // (4+5)/2
      expect(result[5]).toBeCloseTo(5.5);  // (5+6)/2
    });

    it('包含负数的输入 → 均值计算正确', () => {
      const result = calculateSMA([-5, -3, 0, 3, 5], 3);

      expect(result.length).toBe(5);
      expect(Number.isNaN(result[0])).toBe(true);
      expect(Number.isNaN(result[1])).toBe(true);

      // (-5 + -3 + 0)/3 = -8/3 ≈ -2.6667
      expect(result[2]).toBeCloseTo(-8 / 3, 6);
      // (-3 + 0 + 3)/3 = 0/3 = 0
      expect(result[3]).toBeCloseTo(0);
      // (0 + 3 + 5)/3 = 8/3 ≈ 2.6667
      expect(result[4]).toBeCloseTo(8 / 3, 6);
    });
  });

  // ---------------------------------------------------------
  // 边界：prices.length < period → 全 NaN 数组
  // ---------------------------------------------------------
  describe('边界: prices.length < period', () => {
    it('prices=[1,2], period=5 → 全 NaN，长度=2', () => {
      const result = calculateSMA([1, 2], 5);
      expect(result.length).toBe(2);
      expect(result.every((v) => Number.isNaN(v))).toBe(true);
    });

    it('prices=[100], period=2 → [NaN]', () => {
      const result = calculateSMA([100], 2);
      expect(result.length).toBe(1);
      expect(Number.isNaN(result[0])).toBe(true);
    });
  });

  // ---------------------------------------------------------
  // 边界：period=1 → 结果等于原数组
  // ---------------------------------------------------------
  describe('边界: period=1', () => {
    it('period=1 → 结果等于原数组每个元素', () => {
      const prices = [7, 13, 21, 34];
      const result = calculateSMA(prices, 1);
      expect(result).toEqual(prices);
    });

    it('单元素 [5] period=1 → [5]', () => {
      const result = calculateSMA([5], 1);
      expect(result).toEqual([5]);
    });

    it('单元素 [5] period=1 — 不产生 NaN', () => {
      const result = calculateSMA([5], 1);
      expect(result.length).toBe(1);
      expect(Number.isNaN(result[0])).toBe(false);
      expect(result[0]).toBe(5);
    });
  });

  // ---------------------------------------------------------
  // 边界：空数组
  // ---------------------------------------------------------
  describe('边界: 空数组', () => {
    it('[] period=3 → []', () => {
      const result = calculateSMA([], 3);
      expect(result).toEqual([]);
      expect(result.length).toBe(0);
    });

    it('[] period=1 → []', () => {
      const result = calculateSMA([], 1);
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------
  // 边界：period 恰好等于 prices.length
  // ---------------------------------------------------------
  describe('边界: period === prices.length', () => {
    it('period 等于 length → 只有最后一个元素有值，前面全 NaN', () => {
      const result = calculateSMA([10, 20, 30], 3);
      expect(result.length).toBe(3);
      expect(Number.isNaN(result[0])).toBe(true);
      expect(Number.isNaN(result[1])).toBe(true);
      expect(result[2]).toBeCloseTo(20);  // (10+20+30)/3
    });
  });
});
