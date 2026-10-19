import { describe, it, expect } from 'vitest';
import { calculateMovingWeightedCost, PositionOversellError, type TradeRecord } from '../src/movingWeightedCost';

describe('移动加权平均成本', () => {
  it('单笔买入', () => {
    const trades: TradeRecord[] = [{ date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 }];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(100);
    expect(r.avgCost).toBeCloseTo(10.05, 4);  // (1000 + 5) / 100
    expect(r.totalCostBasis).toBeCloseTo(1005, 2);
  });

  it('多次买入平均化', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-11', direction: 'buy', quantity: 200, price: 15, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(300);
    expect(r.avgCost).toBeCloseTo(13.3333, 4);  // (1000 + 3000) / 300
  });

  it('卖出后成本不变，已实现盈亏累计', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-12', direction: 'sell', quantity: 50, price: 12, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(50);
    expect(r.avgCost).toBeCloseTo(10, 4);  // 平均成本不变
    expect(r.realizedPnL).toBeCloseTo(100, 2);  // 50 * (12 - 10)
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
