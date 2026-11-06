import { describe, it, expect } from 'vitest';
import {
  computeMaxDrawdown,
  aggregateByExchange,
  aggregateByIndustry,
} from '../../src/services/portfolioRisk.js';

/**
 * 2026-11-06（J3）组合风控三项修复的单测：
 * ① maxDrawdown 单位/口径（旧实现返回 12,710.04% 的伪比率）
 * ② 分布聚合（交易所降级口径 / 行业口径）
 */
describe('computeMaxDrawdown 口径与单位', () => {
  it('无历史数据 → 0', () => {
    const r = computeMaxDrawdown([], new Map(), new Map());
    expect(r.value).toBe(0);
    expect(r.peakCostBasis).toBe(0);
  });

  it('单调上升 → 回撤为 0', () => {
    const r = computeMaxDrawdown(
      [
        { trade_date: '2026-01-01', priceProfit: 1000, priceYield: 0.01 },
        { trade_date: '2026-01-02', priceProfit: 2000, priceYield: 0.02 },
        { trade_date: '2026-01-03', priceProfit: 3000, priceYield: 0.03 },
      ],
      new Map(),
      new Map(),
    );
    expect(r.value).toBe(0);
    expect(r.peakCostBasis).toBeCloseTo(100000, 0); // 1000/0.01 = 100000
  });

  it('有回撤 → 百分比（分母=全期峰值持仓成本，不是利润峰值）', () => {
    // d1: 浮盈 2,000 / 成本 100,000；d2: 已实现 -10,000 且浮亏 -6,000 / 成本 200,000
    const r = computeMaxDrawdown(
      [
        { trade_date: '2026-01-01', priceProfit: 2000, priceYield: 0.02 },
        { trade_date: '2026-01-02', priceProfit: -6000, priceYield: -0.03 },
        { trade_date: '2026-01-03', priceProfit: -1000, priceYield: -0.01 },
      ],
      new Map([['2026-01-02', -10000]]),
      new Map(),
    );
    expect(r.peakPnl).toBe(2000); // 峰值利润
    expect(r.peakCostBasis).toBe(200000); // 峰值持仓成本（d2 反推 200000）
    expect(r.worstDate).toBe('2026-01-02');
    expect(r.troughPnl).toBe(-16000); // 2000 → -16000 = 回吐 18,000
    expect(r.value).toBeCloseTo(9, 6); // 18,000 / 200,000 = 9%
    // 不是旧口径「(峰值利润-当期)/峰值利润」：那个会得到 900%（分母 2,000）
    expect(r.value).toBeLessThan(100);
  });

  it('空仓行（收益率 0）不计入峰值成本，也不产生回撤', () => {
    const r = computeMaxDrawdown(
      [
        { trade_date: '2026-01-01', priceProfit: 0, priceYield: 0 },
        { trade_date: '2026-01-02', priceProfit: 1500, priceYield: 0.015 },
        { trade_date: '2026-01-03', priceProfit: 0, priceYield: 0 }, // 清仓行：利润转入已实现
        { trade_date: '2026-01-04', priceProfit: -1000, priceYield: -0.01 },
      ],
      new Map([['2026-01-03', 1500]]),
      new Map(),
    );
    expect(r.peakCostBasis).toBe(100000); // 1500/0.015；空仓行不得把成本拉成 0/0
    expect(r.value).toBeCloseTo(1, 6); // (1500 − 500)/100000 = 1%（1500 已实现 + 浮动 −1000）
  });

  it('分红累计计入盈亏曲线（分红不回吐）', () => {
    const noDiv = computeMaxDrawdown(
      [
        { trade_date: '2026-01-01', priceProfit: 1000, priceYield: 0.01 },
        { trade_date: '2026-01-02', priceProfit: -1500, priceYield: -0.015 },
      ],
      new Map(),
      new Map(),
    );
    const withDiv = computeMaxDrawdown(
      [
        { trade_date: '2026-01-01', priceProfit: 1000, priceYield: 0.01 },
        { trade_date: '2026-01-02', priceProfit: -1500, priceYield: -0.015 },
      ],
      new Map(),
      new Map([['2026-01-02', 200]]),
    );
    expect(withDiv.value).toBeLessThan(noDiv.value); // 分红抬高谷底 → 回撤更小
  });
});

describe('aggregateByExchange 交易所维度聚合', () => {
  it('按前缀聚合（不再逐持仓输出重复 sh/sz），权重合计 100', () => {
    const r = aggregateByExchange([
      { assetCode: 'sh600000', marketValue: 100 },
      { assetCode: 'sh510760', marketValue: 300 },
      { assetCode: 'sz000001', marketValue: 200 },
      { assetCode: 'hk00700', marketValue: 200 },
    ]);
    expect(r).toEqual([
      { industry: 'sh', weight: 50 },
      { industry: 'sz', weight: 25 },
      { industry: '其他', weight: 25 },
    ]);
    expect(r.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(100, 6);
  });

  it('零权重持仓在有行情时被剔除', () => {
    const r = aggregateByExchange([
      { assetCode: 'sh600000', marketValue: 1000 },
      { assetCode: 'sz000001', marketValue: 0 },
    ]);
    expect(r).toEqual([{ industry: 'sh', weight: 100 }]);
  });

  it('总市值为 0（行情缺失）→ 保留分桶但权重为 0', () => {
    const r = aggregateByExchange([
      { assetCode: 'sh600000', marketValue: 0 },
      { assetCode: 'sz000001', marketValue: 0 },
    ]);
    expect(r.map((x) => x.industry).sort()).toEqual(['sh', 'sz']);
    expect(r.every((x) => x.weight === 0)).toBe(true);
  });

  it('无持仓 → 空数组', () => {
    expect(aggregateByExchange([])).toEqual([]);
  });
});

describe('aggregateByIndustry 行业维度聚合', () => {
  it('按板块名聚合，无行业归属（ETF）归入「未分类」', () => {
    const r = aggregateByIndustry([
      { assetCode: 'sh600000', marketValue: 100, industry: '银行' },
      { assetCode: 'sz002049', marketValue: 200, industry: '半导体' },
      { assetCode: 'sh512400', marketValue: 300, industry: null }, // ETF 无行业
      { assetCode: 'sh588000', marketValue: 200, industry: '' },
    ]);
    expect(r).toEqual([
      { industry: '未分类', weight: 62.5 },
      { industry: '半导体', weight: 25 },
      { industry: '银行', weight: 12.5 },
    ]);
  });

  it('同板块多标的合并为一行', () => {
    const r = aggregateByIndustry([
      { assetCode: 'sh600000', marketValue: 100, industry: '银行' },
      { assetCode: 'sh601398', marketValue: 300, industry: '银行' },
    ]);
    expect(r).toEqual([{ industry: '银行', weight: 100 }]);
  });

  it('组合全为 ETF → 只有「未分类」一行（权重 100）', () => {
    const r = aggregateByIndustry([
      { assetCode: 'sh512400', marketValue: 1000, industry: null },
      { assetCode: 'sh510760', marketValue: 500, industry: null },
    ]);
    expect(r).toEqual([{ industry: '未分类', weight: 100 }]);
  });
});
