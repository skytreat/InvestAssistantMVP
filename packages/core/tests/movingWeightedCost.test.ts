import { describe, it, expect } from 'vitest';
import {
  calculateMovingWeightedCost,
  PositionOversellError,
  type TradeRecord,
} from '../src/movingWeightedCost';

describe('移动加权平均成本', () => {
  it('单笔买入', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(100);
    expect(r.avgCost).toBeCloseTo(10.05, 4); // (1000 + 5) / 100
    expect(r.totalCostBasis).toBeCloseTo(1005, 2);
  });

  it('多次买入平均化', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-11', direction: 'buy', quantity: 200, price: 15, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(300);
    expect(r.avgCost).toBeCloseTo(13.3333, 4); // (1000 + 3000) / 300
  });

  it('卖出后成本不变，已实现盈亏累计', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-12', direction: 'sell', quantity: 50, price: 12, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(50);
    expect(r.avgCost).toBeCloseTo(10, 4); // 平均成本不变
    expect(r.realizedPnL).toBeCloseTo(100, 2); // 50 * (12 - 10)
  });

  /**
   * 2026-11-06（J3 费用口径）：未平仓成本中携带的手续费残值 `feeInCostBasis`。
   * 买入费用进入成本基；卖出按剩余数量等比释放；清仓归零。
   */
  describe('feeInCostBasis（未平仓成本内手续费残值）', () => {
    it('全部未平仓 → 残值等于全部买入费用', () => {
      const r = calculateMovingWeightedCost([
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
      ]);
      expect(r.feeInCostBasis).toBeCloseTo(5, 6);
      expect(r.totalFee).toBeCloseTo(5, 6);
    });

    it('部分卖出 → 按卖出比例释放（不随成本均价变化）', () => {
      const r = calculateMovingWeightedCost([
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 6 },
        { date: '2026-10-11', direction: 'sell', quantity: 50, price: 12, fee: 2 },
      ]);
      // 未平仓 50/100 → 保留 3 元买入费用；卖出手续费不进入成本基
      expect(r.feeInCostBasis).toBeCloseTo(3, 6);
      expect(r.totalFee).toBeCloseTo(8, 6);
    });

    it('多次买入后部分卖出 → 按剩余比例释放累计残值', () => {
      const r = calculateMovingWeightedCost([
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
        { date: '2026-10-11', direction: 'buy', quantity: 100, price: 12, fee: 7 },
        { date: '2026-10-12', direction: 'sell', quantity: 100, price: 11, fee: 1 },
      ]);
      // 累计 12 元残值，卖出 100/200 → 释放 6 元
      expect(r.feeInCostBasis).toBeCloseTo(6, 6);
      expect(r.totalFee).toBeCloseTo(13, 6);
    });

    it('全部平仓（clear）→ 残值归零', () => {
      const r = calculateMovingWeightedCost([
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
        { date: '2026-10-12', direction: 'sell', quantity: 100, price: 11, fee: 2 },
      ]);
      expect(r.totalQuantity).toBe(0);
      expect(r.totalCostBasis).toBe(0);
      expect(r.feeInCostBasis).toBe(0);
    });

    it('送股 / 分红不改变残值', () => {
      const r = calculateMovingWeightedCost([
        { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
        { date: '2026-10-11', direction: 'bonus', quantity: 10, price: 0, fee: 0 },
        { date: '2026-10-12', direction: 'dividend', quantity: 110, price: 0.5, fee: 0 },
      ]);
      expect(r.feeInCostBasis).toBeCloseTo(5, 6);
    });

    it('超卖容错路径按实际可卖数量平掉 → 残值归零', () => {
      const r = calculateMovingWeightedCost(
        [
          { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
          { date: '2026-10-12', direction: 'sell', quantity: 150, price: 11, fee: 1 },
        ],
        { strictOversell: false },
      );
      expect(r.totalQuantity).toBe(0);
      expect(r.feeInCostBasis).toBe(0);
    });
  });

  it('空仓卖出：T84 起改为抛 PositionOversellError（原「不报错」是 P0-13 的 bug 行为）', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-12', direction: 'sell', quantity: 50, price: 12, fee: 0 },
    ];
    expect(() => calculateMovingWeightedCost(trades)).toThrow(PositionOversellError);

    // 显示路径显式声明容错口径：不抛，且不产生负持仓
    const r = calculateMovingWeightedCost(trades, { strictOversell: false });
    expect(r.totalQuantity).toBe(0);
    expect(r.avgCost).toBe(0);
    expect(r.hasOversell).toBe(true);
  });
});
