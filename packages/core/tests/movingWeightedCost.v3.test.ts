import { describe, it, expect } from 'vitest';
import {
  calculateMovingWeightedCost,
  PositionOversellError,
  type TradeRecord,
} from '../src/movingWeightedCost';

/**
 * T119（V3.0）：送股 / 现金分红成本语义（SDD_v3 §8 / Requirements §3.6 INV-S4-11~17）
 *
 * 口径：
 * - bonus：股数 +n、总成本不变、均价 Q/(Q+n) 摊薄、不产生价差盈亏
 * - dividend：股数与成本不变、cashReceived += 股数×每股分红、不产生价差盈亏
 * - 同日先送股后分红（顺序由 core 保证，上层不得单独预处理）
 * - 双口径：realizedPnL（价差，不含分红）与 cashReceived 分别呈现、可加
 */
describe('T119 · 送股语义', () => {
  it('送股后股数正确、均价按比例摊薄、成本基不变', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'bonus', quantity: 60, price: 0, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(160);
    expect(r.avgCost).toBeCloseTo(6.25, 6); // 1000 / 160
    expect(r.totalCostBasis).toBe(1000);
    expect(r.realizedPnL).toBe(0); // 送股不产生价差盈亏
    expect(r.cashReceived).toBe(0);
  });

  it('多次送股连续摊薄', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 20, fee: 0 },
      { date: '2026-11-01', direction: 'bonus', quantity: 100, price: 0, fee: 0 },
      { date: '2026-12-01', direction: 'bonus', quantity: 200, price: 0, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(400);
    expect(r.avgCost).toBeCloseTo(2000 / 400, 6); // 5
    expect(r.totalCostBasis).toBe(2000);
  });

  it('空仓送股：股数增加、均价为 0（无成本可摊）', () => {
    const trades: TradeRecord[] = [{ date: '2026-10-30', direction: 'bonus', quantity: 60, price: 0 }];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(60);
    expect(r.avgCost).toBe(0);
    expect(r.totalCostBasis).toBe(0);
  });
});

describe('T119 · 现金分红语义', () => {
  it('分红后股数与均价不变、cashReceived = 股数×每股分红', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'dividend', quantity: 100, price: 0.5, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(100);
    expect(r.avgCost).toBe(10);
    expect(r.totalCostBasis).toBe(1000);
    expect(r.cashReceived).toBe(50);
    expect(r.realizedPnL).toBe(0); // 分红不进价差盈亏
  });

  it('多次分红累加 cashReceived', () => {
    const trades: TradeRecord[] = [
      { date: '2026-01-05', direction: 'buy', quantity: 200, price: 5, fee: 0 },
      { date: '2026-06-10', direction: 'dividend', quantity: 200, price: 0.2, fee: 0 },
      { date: '2026-12-05', direction: 'dividend', quantity: 200, price: 0.3, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.cashReceived).toBeCloseTo(200 * 0.2 + 200 * 0.3, 6); // ≈ 100（浮点容差）
  });
});

describe('T119 · 同日顺序（先送股后分红，core 保证）', () => {
  const mk = (dividendFirst: boolean): TradeRecord[] => {
    const base: TradeRecord = { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 };
    const bonus: TradeRecord = { date: '2026-10-30', direction: 'bonus', quantity: 60, price: 0, fee: 0 };
    const div: TradeRecord = { date: '2026-10-30', direction: 'dividend', quantity: 160, price: 0.5, fee: 0 };
    return [base, ...(dividendFirst ? [div, bonus] : [bonus, div])];
  };

  it('输入顺序 [bonus, dividend] 与 [dividend, bonus] 结果一致（分红基数 = 送股后股数）', () => {
    const r1 = calculateMovingWeightedCost(mk(false));
    const r2 = calculateMovingWeightedCost(mk(true));
    expect(r1.cashReceived).toBe(80); // 160 × 0.5
    expect(r2.cashReceived).toBe(80);
    expect(r1.totalQuantity).toBe(160);
    expect(r2.totalQuantity).toBe(160);
    expect(r1.avgCost).toBe(r2.avgCost);
  });

  it('若分红在送股前结算（旧缺陷）会得到 50 —— 断言现在**不是** 50', () => {
    const r = calculateMovingWeightedCost(mk(true));
    // 旧口径（先分红后送股，分红基数=送股前 100 股）会算出 100×0.5=50；
    // 正确口径分红基数=160 股 ⇒ 80。此断言防止回退。
    expect(r.cashReceived).not.toBe(50);
    expect(r.cashReceived).toBe(80);
  });
});

describe('T119 · 摊薄均价参与后续卖出', () => {
  it('送股后卖出的价差盈亏按摊薄后均价计', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'bonus', quantity: 100, price: 0, fee: 0 },
      { date: '2026-11-10', direction: 'sell', quantity: 100, price: 12, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    // 摊薄后均价 = 1000/200 = 5；卖出 100@12 ⇒ 1200 − 100×5 = 700
    expect(r.realizedPnL).toBe(700);
    expect(r.totalQuantity).toBe(100);
    expect(r.totalCostBasis).toBe(500);
  });

  it('送股摊薄不影响超卖校验（送股增加可卖数量）', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'bonus', quantity: 50, price: 0, fee: 0 },
      { date: '2026-11-10', direction: 'sell', quantity: 120, price: 12, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades); // 120 ≤ 150，不超卖
    expect(r.hasOversell).toBe(false);
    expect(r.totalQuantity).toBe(30);
    // 120 股 @ 均价 1000/150 = 6.6667：1440 − 120×(1000/150) = 1440 − 800 = 640
    expect(r.realizedPnL).toBeCloseTo(640, 4);
  });

  it('送股不能替代真实买入支撑超卖（strict 抛错）', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-30', direction: 'bonus', quantity: 60, price: 0, fee: 0 },
      { date: '2026-11-10', direction: 'sell', quantity: 100, price: 12, fee: 0 },
    ];
    expect(() => calculateMovingWeightedCost(trades)).toThrow(PositionOversellError);
    const r = calculateMovingWeightedCost(trades, { strictOversell: false });
    expect(r.hasOversell).toBe(true);
    expect(r.totalQuantity).toBe(0); // 夹到 0，不得负持仓
  });
});

describe('T119 · 双口径呈现（价差与含分红净利分别可加）', () => {
  it('realizedPnL 不含分红；含分红净利 = realizedPnL + cashReceived', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'dividend', quantity: 100, price: 0.5, fee: 0 },
      { date: '2026-11-10', direction: 'sell', quantity: 100, price: 15, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.realizedPnL).toBe(500); // 100×(15−10)，分红不摊成本
    expect(r.cashReceived).toBe(50);
    expect(r.realizedPnL + r.cashReceived).toBe(550);
  });

  it('送股 + 分红 + 卖出混合：三个口径分量互不串扰', () => {
    const trades: TradeRecord[] = [
      { date: '2026-10-10', direction: 'buy', quantity: 100, price: 10, fee: 0 },
      { date: '2026-10-30', direction: 'bonus', quantity: 100, price: 0, fee: 0 },
      { date: '2026-10-30', direction: 'dividend', quantity: 200, price: 0.1, fee: 0 },
      { date: '2026-11-10', direction: 'sell', quantity: 200, price: 11, fee: 0 },
    ];
    const r = calculateMovingWeightedCost(trades);
    expect(r.totalQuantity).toBe(0);
    expect(r.cashReceived).toBeCloseTo(20, 6); // 200 × 0.1（送股后基数；浮点容差）
    // 均价摊薄至 1000/200 = 5；卖出 200@11 ⇒ 2200 − 200×5 = 1200
    expect(r.realizedPnL).toBeCloseTo(1200, 6);
    expect(r.realizedPnL + r.cashReceived).toBeCloseTo(1220, 6);
  });
});
