/**
 * T152 · K 线交易标记（后端纯函数 + 回放口径）
 *
 * 覆盖 SDD_v3 §9.9 / Requirements §6.3 的核心规则：
 * - 4 类标记按「交易发生前持仓」推导
 * - 全历史回放（不是只回放窗口）
 * - bonus / dividend 参与持仓、但不输出；transfer 忽略
 * - 同日 bonus 先于买卖（与 core `calculateMovingWeightedCost` 同序）
 * - 超卖容错与空仓卖出兜底
 * - 复权价：qfq / hfq / bfq / raw；无当日行情取之前最近因子；无因子回退原价
 */
import { describe, it, expect } from 'vitest';
import {
  attachAdjustedPrices,
  deriveTradeMarkers,
  filterMarkersToWindow,
  type ReplayTradeRow,
  type TradeFactorPoint,
} from '../../src/services/klineTrades.js';

let seq = 0;
function row(overrides: Partial<ReplayTradeRow> = {}): ReplayTradeRow {
  seq += 1;
  return {
    id: seq,
    trade_type: 'buy',
    trade_date: '2026-01-05',
    trade_time: '09:30:00',
    quantity: 100,
    price: 10,
    ...overrides,
  };
}

function markers(rows: ReplayTradeRow[]) {
  return deriveTradeMarkers(rows);
}

describe('T152 · marker_type 推导', () => {
  it('空仓买入 → open；有仓买入 → add', () => {
    const out = markers([
      row({ id: 1, trade_date: '2026-01-05', quantity: 100 }),
      row({ id: 2, trade_date: '2026-01-06', quantity: 50 }),
    ]);
    expect(out.map((m) => m.marker_type)).toEqual(['open', 'add']);
  });

  it('部分卖出 → reduce；卖光 → close', () => {
    const out = markers([
      row({ id: 1, quantity: 100 }),
      row({ id: 2, trade_type: 'reduce', trade_date: '2026-01-06', quantity: 40 }),
      row({ id: 3, trade_type: 'clear', trade_date: '2026-01-07', quantity: 60 }),
    ]);
    expect(out.map((m) => m.marker_type)).toEqual(['open', 'reduce', 'close']);
  });

  it('clear 数量不足（仍有持仓）→ reduce，而不是 close', () => {
    const out = markers([
      row({ id: 1, quantity: 100 }),
      row({ id: 2, trade_type: 'clear', trade_date: '2026-01-06', quantity: 40 }),
    ]);
    expect(out[1].marker_type).toBe('reduce');
  });

  it('超卖 reduce → close（持仓夹到 0，不产生负持仓）', () => {
    const out = markers([
      row({ id: 1, quantity: 100 }),
      row({ id: 2, trade_type: 'reduce', trade_date: '2026-01-06', quantity: 150 }),
      row({ id: 3, trade_date: '2026-01-07', quantity: 10 }),
    ]);
    expect(out.map((m) => m.marker_type)).toEqual(['open', 'close', 'open']);
  });

  it('空仓卖出兜底：reduce → reduce，clear → close（不丢点）', () => {
    const out = markers([
      row({ id: 1, trade_type: 'reduce', trade_date: '2026-01-05', quantity: 100 }),
      row({ id: 2, trade_type: 'clear', trade_date: '2026-01-06', quantity: 100 }),
    ]);
    expect(out.map((m) => m.marker_type)).toEqual(['reduce', 'close']);
  });

  it('bonus 参与持仓但不输出；dividend 不影响数量也不输出', () => {
    const out = markers([
      row({ id: 1, quantity: 100 }),
      row({ id: 2, trade_type: 'bonus', trade_date: '2026-01-06', quantity: 100, price: 0 }),
      row({ id: 3, trade_type: 'dividend', trade_date: '2026-01-07', quantity: 100, price: 0.5 }),
      row({ id: 4, trade_type: 'reduce', trade_date: '2026-01-08', quantity: 150 }),
    ]);
    expect(out.map((m) => m.trade_type)).toEqual(['buy', 'reduce']);
    expect(out[1].marker_type).toBe('reduce');
  });

  it('同日 bonus 先于买卖（即使 bonus 的 trade_time 更晚）', () => {
    const out = markers([
      row({ id: 1, trade_date: '2026-01-05', quantity: 100 }),
      row({
        id: 2,
        trade_type: 'reduce',
        trade_date: '2026-01-06',
        trade_time: '09:30:00',
        quantity: 100,
      }),
      row({
        id: 3,
        trade_type: 'bonus',
        trade_date: '2026-01-06',
        trade_time: '15:00:00',
        quantity: 100,
        price: 0,
      }),
    ]);
    // bonus 先执行 → 持仓 200，再 reduce 100 → 仍有 100 ⇒ reduce（不是 close）
    expect(out[1].marker_type).toBe('reduce');
  });

  it('同日买卖按输入顺序（SQL 已按 trade_time/id 排序）', () => {
    const out = markers([
      row({ id: 1, trade_date: '2026-01-05', quantity: 100 }),
      row({ id: 2, trade_type: 'reduce', trade_date: '2026-01-06', trade_time: '10:00:00', quantity: 50 }),
      row({ id: 3, trade_type: 'reduce', trade_date: '2026-01-06', trade_time: '11:00:00', quantity: 50 }),
    ]);
    expect(out.map((m) => m.marker_type)).toEqual(['open', 'reduce', 'close']);
  });

  it('全历史回放后再筛窗口：窗口首日买入不是 open 时保持 add', () => {
    const all = markers([
      row({ id: 1, trade_date: '2025-12-01', quantity: 100 }),
      row({ id: 2, trade_date: '2026-01-05', quantity: 100 }),
    ]);
    const windowed = filterMarkersToWindow(all, '2026-01-05', '2026-01-10');
    expect(windowed).toHaveLength(1);
    expect(windowed[0].trade_date).toBe('2026-01-05');
    expect(windowed[0].marker_type).toBe('add');
  });

  it('窗口外记录不返回', () => {
    const all = markers([
      row({ id: 1, trade_date: '2025-12-01', quantity: 100 }),
      row({ id: 2, trade_date: '2026-01-05', quantity: 100 }),
      row({ id: 3, trade_date: '2026-02-01', quantity: 100 }),
    ]);
    const windowed = filterMarkersToWindow(all, '2026-01-01', '2026-01-31');
    expect(windowed.map((m) => m.trade_date)).toEqual(['2026-01-05']);
  });
});

describe('T152 · adj_price', () => {
  const factors: TradeFactorPoint[] = [
    { date: '2026-01-02', factor: 1.1 },
    { date: '2026-01-05', factor: 1.2 },
    { date: '2026-01-06', factor: 1.3 },
  ];

  function one(date = '2026-01-05', price = 10) {
    return markers([row({ trade_date: date, price, quantity: 100 })]);
  }

  it('qfq / hfq：price × 当日因子', () => {
    const qfq = attachAdjustedPrices(one(), 'qfq', factors);
    expect(qfq.trades[0].adj_price).toBeCloseTo(12, 6);
    expect(qfq.missingFactorDates).toEqual([]);

    const hfq = attachAdjustedPrices(one(), 'hfq', factors);
    expect(hfq.trades[0].adj_price).toBeCloseTo(12, 6);
  });

  it('无当日行情 → 取之前最近交易日的因子', () => {
    const out = attachAdjustedPrices(one('2026-01-04'), 'qfq', factors);
    expect(out.trades[0].adj_price).toBeCloseTo(11, 6);
  });

  it('bfq / raw：不乘因子，adj_price = price', () => {
    for (const fq of ['bfq', 'raw'] as const) {
      const out = attachAdjustedPrices(one(), fq, factors);
      expect(out.trades[0].adj_price).toBe(10);
      expect(out.missingFactorDates).toEqual([]);
    }
  });

  it('无可用因子 → 回退 price，并报告缺失日期', () => {
    const out = attachAdjustedPrices(one('2026-01-01'), 'qfq', factors);
    expect(out.trades[0].adj_price).toBe(10);
    expect(out.missingFactorDates).toEqual(['2026-01-01']);
  });

  it('因子为 0 / NaN → 视为缺失，不产生 0 价', () => {
    const out = attachAdjustedPrices(one(), 'qfq', [
      { date: '2026-01-05', factor: 0 },
      { date: '2026-01-06', factor: Number.NaN },
    ]);
    expect(out.trades[0].adj_price).toBe(10);
    expect(out.missingFactorDates).toEqual(['2026-01-05']);
  });
});
