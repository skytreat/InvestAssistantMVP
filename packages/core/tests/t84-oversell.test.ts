/**
 * T84 持仓充足性校验（P0-13）—— core 层超卖防护
 *
 * 业务口径（Requirements §5.2）：减仓数量不得超过**当时**实际持仓。
 * 原实现对超卖 `continue` 静默吞掉，导致脏数据不可见；本测试锁定新行为。
 */
import { describe, it, expect } from 'vitest';
import {
  calculateMovingWeightedCost,
  PositionOversellError,
  type TradeRecord,
} from '../src/movingWeightedCost';

describe('T84 超卖防护：不再静默吞掉', () => {
  it('完全空仓卖出 → 抛 PositionOversellError', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-06', direction: 'sell', quantity: 100, price: 10, fee: 0 },
    ];
    expect(() => calculateMovingWeightedCost(trades)).toThrow(PositionOversellError);
  });

  it('持有 100 卖 150 → 抛错，且错误信息含日期与缺口', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 150, price: 11, fee: 0 },
    ];
    let caught: unknown;
    try {
      calculateMovingWeightedCost(trades);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PositionOversellError);
    const err = caught as PositionOversellError;
    expect(err.date).toBe('2026-08-06');
    expect(err.requested).toBe(150);
    expect(err.available).toBe(100);
    expect(err.shortfall).toBe(50);
  });

  it('跨界超卖：回放「先前买入」也不能支撑「更早的卖出」', () => {
    // 这是 P0-13 的原始场景：08-01 买 100、10-16 买 100、08-06 卖 105
    // 按时间序回放：08-01 buy100 → 08-06 sell105（此时只有 100）→ 必须抛错
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 105, price: 11, fee: 0 },
      { date: '2026-10-16', direction: 'buy', quantity: 100, price: 12, fee: 0 },
    ];
    expect(() => calculateMovingWeightedCost(trades)).toThrow(PositionOversellError);
  });

  it('精确持平（买 100 卖 100）→ 不抛错，totalQuantity=0', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 100, price: 11, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(0);
    expect(r.totalCostBasis).toBe(0);
    expect(r.avgCost).toBe(0);
  });

  it('持仓 100 卖 99 → 不抛错，剩 1 股', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 99, price: 11, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(1);
  });

  it('多分段减仓累加超卖 → 在超出那笔抛错', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 60, price: 11, fee: 0 },
      { date: '2026-08-07', direction: 'sell', quantity: 50, price: 11, fee: 0 },
    ];
    let caught: unknown;
    try {
      calculateMovingWeightedCost(trades);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PositionOversellError);
    expect((caught as PositionOversellError).available).toBe(40);
    expect((caught as PositionOversellError).shortfall).toBe(10);
  });

  it('strictOversell=false → 不抛错，但 hasOversell=true 且不产生负持仓', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 105, price: 11, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades, { strictOversell: false });
    expect(r.hasOversell).toBe(true);
    expect(r.oversellDetail).toBeTruthy();
    // 不得产生负持仓（显示口径容错，但结果必须为 0 而非负数）
    expect(r.totalQuantity).toBe(0);
    expect(r.totalCostBasis).toBe(0);
  });

  it('strictOversell=false 且数据正常 → hasOversell=false', () => {
    const trades: TradeRecord[] = [
      { date: '2026-08-01', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-08-06', direction: 'sell', quantity: 50, price: 11, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades, { strictOversell: false });
    expect(r.hasOversell).toBe(false);
    expect(r.oversellDetail).toBeNull();
    expect(r.totalQuantity).toBe(50);
  });

  it('回归：既有正常场景结果不受影响', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 5 },
      { date: '2026-10-12', direction: 'sell', quantity: 50, price: 12, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(50);
    expect(r.avgCost).toBeCloseTo(10.05, 4);
    expect(r.totalFee).toBe(5);
  });
});
