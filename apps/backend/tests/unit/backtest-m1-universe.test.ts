import { describe, expect, it } from 'vitest';
import {
  LIQUIDITY_THRESHOLD_FALLBACK,
  avgDailyAmount,
  buildUniverse,
  computeLiquidityThreshold,
  countCovered,
  isInUniverse,
  passesLiquidity,
  pickPoolByLiquidity,
} from '../../src/services/backtest/universe/pointInTime.js';
import type { SymbolMeta } from '../../src/services/backtest/types.js';

function meta(symbol: string, firstBar: string, lastBar: string, name: string | null = null): SymbolMeta {
  return { symbol, name, firstBar, lastBar };
}

const T = '2026-10-12';

describe('时点可交易集合 —— firstBar ≤ T ≤ lastBar', () => {
  it('上市日当天（firstBar == T）⇒ 在集合内', () => {
    expect(isInUniverse(meta('a', T, T), T)).toBe(true);
  });

  it('上市前一天（firstBar == T 的下一交易日）⇒ 不在集合内', () => {
    expect(isInUniverse(meta('b', '2026-10-13', '2026-10-30'), T)).toBe(false);
  });

  it('末根 bar 当天（lastBar == T）⇒ 在集合内', () => {
    expect(isInUniverse(meta('c', '2026-01-02', T), T)).toBe(true);
  });

  it('末根 bar 在前一天（lastBar == T-1）⇒ 不在集合内（近似退市）', () => {
    expect(isInUniverse(meta('d', '2026-01-02', '2026-10-09'), T)).toBe(false);
  });

  it('首末同日且等于 T ⇒ 在集合内（上市当天即末日）', () => {
    expect(isInUniverse(meta('e', T, T), T)).toBe(true);
    expect(isInUniverse(meta('e', T, T), '2026-10-13')).toBe(false);
  });

  it('buildUniverse 只保留边界内的标的', () => {
    const metas = [
      meta('in-1', '2020-01-02', T),
      meta('in-2', T, T),
      meta('out-late', '2026-10-13', '2026-10-30'),
      meta('out-delisted', '2020-01-02', '2026-10-09'),
    ];
    expect(buildUniverse(metas, T).map((m) => m.symbol)).toEqual(['in-1', 'in-2']);
  });
});

describe('流动性阈值 —— 近 3 日全市场 ETF 总成交额 / divisor', () => {
  const totals = [
    { date: '2026-10-08', totalAmount: 4016.68e8 },
    { date: '2026-10-09', totalAmount: 4487.4e8 },
    { date: '2026-10-12', totalAmount: 4531.64e8 },
  ];

  it('T=2026-10-12 实测三档金额 → 阈值 ≈ 2172.6 万/日（锚点）', () => {
    const r = computeLiquidityThreshold(totals, 20000);
    expect(r.fallback).toBe(false);
    expect(r.avgTotal / 1e8).toBeCloseTo(4345.24, 2);
    // 4345.24 亿 / 20000 = 2172.62 万
    expect(r.threshold / 1e4).toBeCloseTo(2172.62, 1);
  });

  it('divisor 可参数化（旧版脚本 divisor=15000 → 2897 万）', () => {
    const r = computeLiquidityThreshold(totals, 15000);
    expect(r.threshold / 1e4).toBeCloseTo(2896.83, 1);
  });

  it('有效交易日 < 3 ⇒ 回退 1000 万（v5.2 保守值）', () => {
    const r = computeLiquidityThreshold(totals.slice(0, 2), 20000);
    expect(r.fallback).toBe(true);
    expect(r.threshold).toBe(LIQUIDITY_THRESHOLD_FALLBACK);
  });

  it('空输入不抛错，回退 1000 万', () => {
    const r = computeLiquidityThreshold([], 20000);
    expect(r.fallback).toBe(true);
    expect(r.threshold).toBe(10_000_000);
    expect(r.avgTotal).toBe(0);
  });

  it('divisor ≤ 0 抛错（避免除零静默给出 Infinity）', () => {
    expect(() => computeLiquidityThreshold(totals, 0)).toThrow();
  });

  it('日均额分母固定 3（停牌日按 0 计入，不按「实际有 bar 天数」）', () => {
    expect(avgDailyAmount(3000)).toBe(1000);
    // 只有 1 天有成交，另 2 天停牌 ⇒ 仍是 /3，不是 /1
    expect(avgDailyAmount(3000, 3)).toBe(1000);
    expect(avgDailyAmount(3000, 1)).toBe(3000);
  });

  it('阈值严格大于才通过（等于不算）', () => {
    expect(passesLiquidity(2172.62e4, 2172.62e4)).toBe(false);
    expect(passesLiquidity(2172.62e4 + 1, 2172.62e4)).toBe(true);
    expect(passesLiquidity(2172.62e4 - 1, 2172.62e4)).toBe(false);
  });
});

describe('名单取池 —— 在册 ∩ 流动性通过', () => {
  const metaBySymbol = new Map<string, SymbolMeta>([
    ['sh510300', meta('sh510300', '2012-05-28', T, '300ETF')],
    ['sh520830', meta('sh520830', '2024-07-01', T, '沙特ETF')],
    ['sh516190', meta('sh516190', '2021-03-01', T, '文娱ETF')],
    ['delisted', meta('delisted', '2020-01-02', '2026-10-09', '已退')],
  ]);
  // 阈值 2172.6 万；沙特 1423.7 万 / 文娱 1819.7 万 均在阈值下
  const totalBySymbol = new Map<string, number>([
    ['sh510300', 30_000e4 * 3],
    ['sh520830', 1423.7e4 * 3],
    ['sh516190', 1819.7e4 * 3],
    ['delisted', 9999e4 * 3],
  ]);
  const threshold = 2172.62e4;

  it('不在册（已退市）与低于阈值的标的被剔除', () => {
    const picks = pickPoolByLiquidity(
      ['sh510300', 'sh520830', 'sh516190', 'delisted', 'not-in-db'],
      metaBySymbol,
      totalBySymbol,
      T,
      threshold,
    );
    expect(picks.map((p) => p.symbol)).toEqual(['sh510300']);
  });

  it('结果按日均成交额降序', () => {
    const picks = pickPoolByLiquidity(
      ['sh516190', 'sh510300'],
      metaBySymbol,
      new Map([
        ['sh516190', 3000e4 * 3],
        ['sh510300', 9000e4 * 3],
      ]),
      T,
      threshold,
    );
    expect(picks.map((p) => p.symbol)).toEqual(['sh510300', 'sh516190']);
    expect(picks[0].avgAmount).toBe(9000e4);
  });

  it('countCovered：在库命中数（有 bar 即算，不看流动性）', () => {
    expect(countCovered(['sh510300', 'delisted', 'not-in-db'], metaBySymbol)).toBe(2);
    expect(countCovered([], metaBySymbol)).toBe(0);
  });
});
