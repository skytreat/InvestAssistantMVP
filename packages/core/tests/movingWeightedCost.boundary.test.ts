/**
 * 移动加权成本边界用例（SDD §12.3 A1-A4 补齐 + A5 送转股 + A4 清仓再买入）
 */
import { describe, it, expect } from 'vitest';
import { calculateMovingWeightedCost, type TradeRecord } from '../src/movingWeightedCost';

describe('移动加权成本边界（SDD §12.3）', () => {
  // A1: 首次买入（历史持仓为空）
  it('A1 首次买入，avgCost = (qty*price+fee)/qty', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(100);
    expect(r.avgCost).toBeCloseTo(10, 4);
    expect(r.realizedPnL).toBe(0);
  });

  // A2: 连续多次买入不同价格 → avg_cost = total_cost / total_qty
  it('A2 多次买入平均化', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-11', direction: 'buy', quantity: 200, price: 15, fee: 0 },
      { date: '2026-10-12', direction: 'buy', quantity: 100, price: 20, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(400);
    expect(r.avgCost).toBeCloseTo(15, 4); // (1000+3000+2000)/400
  });

  // A3: 减仓（卖部分持仓）→ avg_cost 不变
  it('A3 减仓 avgCost 不变 realizedPnL 累计', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-15', direction: 'sell', quantity: 30, price: 15, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(70);
    expect(r.avgCost).toBeCloseTo(10, 4);
    expect(r.realizedPnL).toBeCloseTo(150, 2); // 30*(15-10)
  });

  // A4: 清仓再买入 → prev_history.avg_cost 对新持仓无影响
  it('A4 清仓再买入：新持仓 avgCost 以新买入价为准', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-20', direction: 'sell', quantity: 100, price: 12, fee: 0 }, // 清仓
      { date: '2026-10-21', direction: 'buy', quantity: 50, price: 20, fee: 0 }, // 再买
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(50);
    expect(r.avgCost).toBeCloseTo(20, 4); // 新买入价，不受清仓前 10 影响
    expect(r.realizedPnL).toBeCloseTo(200, 2); // 100*(12-10)
  });

  // A5: 送转股（除权自动导入）→ qty 增加 avgCost 按除权比例稀释
  it('A5 送转股：direction=buy + 除权逻辑稀释 avgCost', () => {
    // 10 送 10：原有 100 股 × 10 元 → 送 100 股 × 0 元
    // MVP 核心算法不含除权，但如果我们按 direction=buy + price=0 模拟：
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'buy', quantity: 100, price: 0, fee: 0 }, // 送股
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(200);
    expect(r.avgCost).toBeCloseTo(5, 4); // 总成本 1000 / 新数量 200
  });

  // 补充：全卖后 avgCost=0
  it('全卖后 totalQuantity=0 avgCost=0', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-20', direction: 'sell', quantity: 100, price: 12, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(0);
    expect(r.avgCost).toBe(0);
    expect(r.totalCostBasis).toBe(0);
  });

  // 补充：fee 计入成本基
  it('手续费计入 avgCost', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 10 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.avgCost).toBeCloseTo(10.1, 4); // (1000+10)/100
    expect(r.totalCostBasis).toBeCloseTo(1010, 2);
    expect(r.totalFee).toBeCloseTo(10, 2);
  });
});
