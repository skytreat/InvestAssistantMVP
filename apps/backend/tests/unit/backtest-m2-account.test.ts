/**
 * M2 账户层单测 —— 对应验收锚点 ①（逐分对账）与「成本基传递」要求
 *
 * 🔴 口径唯一来源 = `@invest/core` 的 `calculateMovingWeightedCost`。
 *   本测试**不复算** core 的公式，只断言「账户层取到的是 core 的结果」：
 *   - 买入均价含手续费
 *   - 多次买入的移动加权
 *   - 部分卖出的已实现盈亏 / 成本基按比例减少
 *   - `bonus`（送转）**成本基不变**、均价摊薄
 *   - `dividend`（分红）只加现金、不动成本基；同日先送股后分红
 *   - 超卖由 core 兜底抛错（执行层应已封顶，这里是第二道防线）
 */
import { describe, it, expect } from 'vitest';
import { PositionOversellError } from '@invest/core';
import { Portfolio, type CorporateAction } from '../../src/services/backtest/account/portfolio.js';
import type { Fill } from '../../src/services/backtest/execution/simulator.js';

const D1 = '2024-01-03';
const D2 = '2024-01-04';

function buy(qty: number, price: number, fee = 5): Fill {
  return { date: D1, symbol: 'sh510300', side: 'buy', qty, price, fee, slippageCost: 0, reason: 'rebalance' };
}

function sell(qty: number, price: number, fee = 5, date = D2): Fill {
  return {
    date,
    symbol: 'sh510300',
    side: 'sell',
    qty,
    price,
    fee,
    slippageCost: 0,
    reason: 'rebalance-replace',
  };
}

describe('M2 账户 · 移动加权成本（复用 core）', () => {
  it('买入均价含手续费：100 份 @10.00 + 5 元佣金 → 10.05', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(100);
    expect(pos.costBasis).toBeCloseTo(1005, 8);
    expect(pos.avgCost).toBeCloseTo(10.05, 8);
    expect(p.cash).toBeCloseTo(98_995, 8);
  });

  it('多次买入按移动加权：100@10.05 + 100@11.05 → 均价 10.55', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    p.startDay();
    p.applyFill({ ...buy(100, 11), date: D2 });

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(200);
    expect(pos.costBasis).toBeCloseTo(2110, 8);
    expect(pos.avgCost).toBeCloseTo(10.55, 8);
  });

  it('部分卖出：已实现盈亏与成本基按剩余数量等比减少', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    p.startDay();
    p.applyFill({ ...buy(100, 11), date: D2 });

    p.startDay();
    p.applyFill(sell(100, 10));

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(100);
    expect(pos.costBasis).toBeCloseTo(1055, 8); // 2110 / 2
    expect(pos.avgCost).toBeCloseTo(10.55, 8); // 卖出不改均价

    expect(p.roundTrips).toHaveLength(1);
    const rt = p.roundTrips[0];
    // 卖出收入 100 × 10 - 5 = 995；成本 100 × 10.55 = 1055 → -60
    expect(rt.pnl).toBeCloseTo(-60, 8);
    expect(rt.returnPct).toBeCloseTo(-60 / 1055, 10);
    expect(rt.proceeds).toBeCloseTo(1000, 8);
    expect(rt.openDate).toBe(D1);
    expect(rt.closeDate).toBe(D2);
  });

  it('清仓后不再有持仓（qty=0），回合交易 openDate 复位', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    p.startDay();
    p.applyFill(sell(100, 10));
    expect(p.positions()).toHaveLength(0);
    expect(p.position('sh510300').qty).toBe(0);
    expect(p.cash).toBeCloseTo(100_000 - 1005 + 995, 8);
  });
});

describe('M2 账户 · T+1 可用量', () => {
  it('当日买入 closeableQty=0；次日 startDay 后全部可卖', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    expect(p.position('sh510300').closeableQty).toBe(0);

    p.startDay();
    expect(p.position('sh510300').closeableQty).toBe(100);
  });

  it('次日加仓时，当日新买部分仍不可卖', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    p.startDay();
    p.applyFill({ ...buy(100, 10), date: D2 });

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(200);
    expect(pos.closeableQty).toBe(100);
  });
});

describe('M2 账户 · 除权事件（成本基传递）', () => {
  it('bonus（送转）：份数增加、**成本基不变**、均价摊薄', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    const cashBefore = p.cash;

    const action: CorporateAction = { date: D2, symbol: 'sh510300', kind: 'bonus', bonusRatio: 0.5 };
    p.applyCorporateActions([action]);

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(150); // 100 × (1 + 0.5)
    expect(pos.costBasis).toBeCloseTo(1005, 8); // 不变
    expect(pos.avgCost).toBeCloseTo(1005 / 150, 8); // 6.7
    expect(p.cash).toBeCloseTo(cashBefore, 8); // 送转不动现金
  });

  it('dividend（分红）：只加现金、不动成本基', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    const cashBefore = p.cash;

    p.applyCorporateActions([{ date: D2, symbol: 'sh510300', kind: 'dividend', cashPerShare: 0.05 }]);

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(100);
    expect(pos.costBasis).toBeCloseTo(1005, 8);
    expect(pos.avgCost).toBeCloseTo(10.05, 8);
    expect(p.cash).toBeCloseTo(cashBefore + 100 * 0.05, 8);
  });

  it('同日先送股后分红：分红基数用送股后的份数（输入顺序无关）', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    const cashBefore = p.cash;

    // 故意把 dividend 放前面，账户层必须重排
    p.applyCorporateActions([
      { date: D2, symbol: 'sh510300', kind: 'dividend', cashPerShare: 0.05 },
      { date: D2, symbol: 'sh510300', kind: 'bonus', bonusRatio: 0.5 },
    ]);

    const pos = p.position('sh510300');
    expect(pos.qty).toBe(150);
    expect(pos.costBasis).toBeCloseTo(1005, 8);
    expect(p.cash).toBeCloseTo(cashBefore + 150 * 0.05, 8);
  });

  it('无持仓时除权事件不产生任何变动（不会凭空加现金/份数）', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyCorporateActions([
      { date: D2, symbol: 'sh510300', kind: 'dividend', cashPerShare: 0.05 },
      { date: D2, symbol: 'sh510300', kind: 'bonus', bonusRatio: 0.5 },
    ]);
    expect(p.cash).toBeCloseTo(100_000, 8);
    expect(p.position('sh510300').qty).toBe(0);
  });
});

describe('M2 账户 · 超卖兜底', () => {
  it('卖出量超过持仓 → core 抛 PositionOversellError', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    p.startDay();

    expect(() => p.applyFill(sell(150, 10))).toThrow(PositionOversellError);
  });
});

describe('M2 账户 · 估值', () => {
  it('equity = 现金 + Σ 持仓市值', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    p.startDay();

    const prices = new Map([['sh510300', 11]]);
    expect(p.marketValue(prices)).toBeCloseTo(1100, 8);
    expect(p.equity(prices)).toBeCloseTo(98_995 + 1100, 8);
  });

  it('价格缺失按 0 计（引擎负责沿用最近有效价）', () => {
    const p = new Portfolio(100_000);
    p.startDay();
    p.applyFill(buy(100, 10));
    expect(p.marketValue(new Map())).toBe(0);
    expect(p.equity(new Map())).toBeCloseTo(p.cash, 8);
  });
});

describe('M2 账户 · 从检查点恢复（纸面账户 §5.6）', () => {
  it('均价/成本基/现金逐位还原，T+1 冻结量 = qty − closeableQty', () => {
    const p = new Portfolio(1); // 初始值随即被 restore 覆盖
    p.restore(
      [
        { symbol: 'sh510300', qty: 1000, avgCost: 10.05, closeableQty: 800 },
        { symbol: 'sh511880', qty: 500, avgCost: 100.2, closeableQty: 500 },
      ],
      50_000,
      D2,
    );

    const a = p.position('sh510300');
    expect(a.qty).toBe(1000);
    expect(a.avgCost).toBeCloseTo(10.05, 10);
    expect(a.costBasis).toBeCloseTo(10_050, 8);
    // 今日买入的 200 份不可卖
    expect(a.closeableQty).toBe(800);
    expect(p.position('sh511880').closeableQty).toBe(500);
    expect(p.cash).toBe(50_000);
    expect(p.positions()).toHaveLength(2);

    // 结算阶段：startDay 清空「当日买入」冻结 → 全部可卖
    p.startDay();
    expect(p.position('sh510300').closeableQty).toBe(1000);

    // 估值仍走同一口径
    expect(
      p.equity(
        new Map([
          ['sh510300', 11],
          ['sh511880', 101],
        ]),
      ),
    ).toBeCloseTo(50_000 + 11_000 + 50_500, 8);
  });

  it('恢复后卖出：成本基沿用检查点均价，回合建仓日 = 恢复日', () => {
    const p = new Portfolio(1);
    p.restore([{ symbol: 'sh510300', qty: 1000, avgCost: 10.05, closeableQty: 0 }], 50_000, D2);
    p.startDay();
    p.applyFill({ ...sell(1000, 12), fee: 5, date: D2 });

    expect(p.positions()).toHaveLength(0);
    expect(p.roundTrips).toHaveLength(1);
    const rt = p.roundTrips[0];
    expect(rt.openDate).toBe(D2); // 恢复日（回合报告须走全量回放）
    // 卖出收入 1000×12 − 5 = 11 995；成本 1000×10.05 = 10 050 → +1945
    expect(rt.pnl).toBeCloseTo(1945, 8);
    expect(p.cash).toBeCloseTo(50_000 + 11_995, 8);
  });

  it('非法检查点必须拒绝（不允许带着脏状态继续结算）', () => {
    const base = new Portfolio(1);
    expect(() =>
      base.restore(
        [
          { symbol: 'sh510300', qty: 100, avgCost: 10, closeableQty: 100 },
          { symbol: 'sh510300', qty: 100, avgCost: 10, closeableQty: 100 },
        ],
        100_000,
        D2,
      ),
    ).toThrow(/重复持仓/);

    expect(() =>
      new Portfolio(1).restore([{ symbol: 'sh510300', qty: 0, avgCost: 10, closeableQty: 0 }], 100_000, D2),
    ).toThrow(/持仓份数/);

    expect(() =>
      new Portfolio(1).restore(
        [{ symbol: 'sh510300', qty: 100, avgCost: 10, closeableQty: 200 }],
        100_000,
        D2,
      ),
    ).toThrow(/可用份数/);

    expect(() =>
      new Portfolio(1).restore([{ symbol: 'sh510300', qty: 100, avgCost: 10, closeableQty: 100 }], -1, D2),
    ).toThrow(/现金/);

    const used = new Portfolio(100_000);
    used.startDay();
    used.applyFill(buy(100, 10));
    expect(() =>
      used.restore([{ symbol: 'sh510300', qty: 100, avgCost: 10, closeableQty: 100 }], 100_000, D2),
    ).toThrow(/空账户/);
  });
});
