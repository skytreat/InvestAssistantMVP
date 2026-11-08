import { describe, expect, it } from 'vitest';
import {
  computeL1DecisionRows,
  evaluateL1Filters,
  type L1FilterInput,
} from '../../src/services/backtest/strategies/dualmomentum/l1/decisions.js';
import {
  makeSymbolSeries,
  POOL_ORDER,
} from '../../src/services/backtest/strategies/dualmomentum/l1/params.js';
import type { MarketSlice, PriceBar } from '../../src/services/backtest/strategies/dualmomentum/l1/types.js';

function day(index: number): string {
  const d = new Date(Date.UTC(2020, 0, 1));
  d.setUTCDate(d.getUTCDate() + index);
  return d.toISOString().slice(0, 10);
}

/** 精确几何价格序列：high/low 与 close 成正比 ⇒ RSRS 斜率恒定。 */
function makeBars(count: number, dailyLogSlope: number, start = 3): PriceBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = start * Math.exp(dailyLogSlope * i);
    return {
      date: day(i),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1000,
      amount: 1000 * close,
      hfqFactor: 1,
    };
  });
}

function sliceOf(series: PriceBar[][], tradingDays: string[] = []): MarketSlice {
  return {
    tradingDays: tradingDays.length > 0 ? tradingDays : series[0].map((b) => b.date),
    symbols: series.map((bars, i) => makeSymbolSeries(POOL_ORDER[i], bars)),
    benchmarkBars: makeBars(80, 0.0004, 10),
  };
}

const BASE_FILTER_INPUT: L1FilterInput = {
  inPool: true,
  hasBar: true,
  closeRaw: 3.15,
  prevCloseAdj: 3,
  ma5: 3.2,
  ma10: 3.1,
  ma20: 3.05,
  ma60: 2.9,
  primary: 0.5,
  secondary: 0.5,
  benchmarkPrimary: 0.2,
  primaryRange: [0, 5],
  secondaryRange: [0, 2],
  cooling: false,
  limitRatio: 0.1,
};

describe('过滤链（§3.3 1–9 步）', () => {
  it('恰好 +5% 通过，+5.001% 被拒', () => {
    expect(evaluateL1Filters(BASE_FILTER_INPUT)).toEqual({ pass: true, reason: null });
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, closeRaw: 3.15003 })).toEqual({
      pass: false,
      reason: 'DAILY_CHANGE_OUT_OF_RANGE',
    });
  });

  it('恰好 −5% 通过，−5.001% 被拒', () => {
    const downFive = {
      ...BASE_FILTER_INPUT,
      closeRaw: 2.85,
      ma5: 2.95,
      ma10: 2.9,
      ma20: 2.8,
      ma60: 2.75,
    };
    expect(evaluateL1Filters(downFive).pass).toBe(true);
    expect(evaluateL1Filters({ ...downFive, closeRaw: 2.84997 }).reason).toBe('DAILY_CHANGE_OUT_OF_RANGE');
  });

  it('触及涨跌停（≥+10% / ≤−10%）→ AT_LIMIT；9.99% 未触板但超 ±5%', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, closeRaw: 3.3003 }).reason).toBe('AT_LIMIT');
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, closeRaw: 2.6997 }).reason).toBe('AT_LIMIT');
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, closeRaw: 3.2997 }).reason).toBe(
      'DAILY_CHANGE_OUT_OF_RANGE',
    );
  });

  it('停牌优先于冷却：无 bar / 空收盘价 → SUSPENDED', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, hasBar: false, cooling: true }).reason).toBe(
      'SUSPENDED',
    );
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, closeRaw: null }).reason).toBe('SUSPENDED');
  });

  it('冷却期 → COOLDOWN', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, cooling: true }).reason).toBe('COOLDOWN');
  });

  it('MA20 为空（预热短路）或价格不高于 MA20 → BELOW_MA20', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, ma20: null }).reason).toBe('BELOW_MA20');
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, closeRaw: 3.0 }).reason).toBe('BELOW_MA20');
  });

  it('MA 非多头排列 → MA_NOT_BULLISH', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, ma5: 3.1, ma10: 3.2 }).reason).toBe('MA_NOT_BULLISH');
  });

  it('动量区间为闭区间：上界等于边界值通过', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, primary: 5, secondary: 2 }).pass).toBe(true);
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, primary: 5.000001 }).reason).toBe(
      'MOMENTUM_OUT_OF_RANGE',
    );
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, secondary: 2.000001 }).reason).toBe(
      'MOMENTUM_OUT_OF_RANGE',
    );
  });

  it('主动量低于基准 → BELOW_BENCHMARK；恰好等于基准通过', () => {
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, primary: 0.19, benchmarkPrimary: 0.2 }).reason).toBe(
      'BELOW_BENCHMARK',
    );
    expect(evaluateL1Filters({ ...BASE_FILTER_INPUT, primary: 0.2, benchmarkPrimary: 0.2 }).pass).toBe(true);
  });
});

describe('逐日决策序列', () => {
  const slopes = [0.0008, 0.0013, 0.0018, 0.0023, 0.0028, 0.0033, 0.0038];

  it('7 只全部通过 → 排名按主槽降序、取前 6，第 7 名 RANK_TRUNCATED', () => {
    const slice = sliceOf(slopes.map((s) => makeBars(80, s)));
    const rows = computeL1DecisionRows(slice, {
      combo: 'nday_return_wsm_v2',
      startDate: day(79),
      endDate: day(79),
    });
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.filter_pass).toBe(true);
    }
    const selected = rows.filter((r) => r.selected);
    expect(selected).toHaveLength(6);
    expect(selected.map((r) => r.symbol)).toEqual(POOL_ORDER.slice(1));
    // 主槽值随斜率单调升 ⇒ 排名从其反向（最高动量 = rank 1）
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].symbol).toBe(POOL_ORDER[i]);
      expect(rows[i].rank).toBe(POOL_ORDER.length - i);
      if (i > 0) {
        expect(rows[i].momentum_primary as number).toBeGreaterThan(rows[i - 1].momentum_primary as number);
      }
    }
    const truncated = rows[0];
    expect(truncated.rank).toBe(7);
    expect(truncated.reject_reason).toBe('RANK_TRUNCATED');
    expect(truncated.selected).toBe(false);
    // 第 7 行仍算「通过 1–9 步」，只是被截断
    expect(truncated.filter_pass).toBe(true);
  });

  it('零成交量占位 bar：tradable_today=0，但 L1 决策不受影响（§3.3）', () => {
    const bars = makeBars(80, 0.0008);
    bars[79] = { ...bars[79], volume: 0, amount: 0 };
    const slice = {
      tradingDays: bars.map((b) => b.date),
      symbols: [makeSymbolSeries('sh510300', bars)],
      benchmarkBars: [],
    };
    const [row] = computeL1DecisionRows(slice, {
      combo: 'nday_return_wsm_v2',
      startDate: day(79),
      endDate: day(79),
    });
    expect(row.tradable_today).toBe(false);
    expect(row.has_bar).toBe(true);
    expect(row.filter_pass).toBe(true);
  });

  it('停牌日：has_bar=0、价格列为空、指标沿用最近可用序列、原因 SUSPENDED', () => {
    const bars = makeBars(80, 0.0008);
    bars.pop(); // T 日缺 bar
    const slice = {
      tradingDays: bars.map((b) => b.date).concat(day(79)),
      symbols: [makeSymbolSeries('sh510300', bars)],
      benchmarkBars: [],
    };
    const [row] = computeL1DecisionRows(slice, {
      combo: 'nday_return_wsm_v2',
      startDate: day(79),
      endDate: day(79),
    });
    expect(row.has_bar).toBe(false);
    expect(row.close_raw).toBeNull();
    expect(row.open_raw).toBeNull();
    expect(row.prev_close_raw).not.toBeNull();
    expect(row.ma20).not.toBeNull();
    expect(row.wsm_v2).not.toBeNull();
    expect(row.reject_reason).toBe('SUSPENDED');
    expect(row.rank).toBeNull();
  });

  it('513000 上市前：in_pool=0、指标列全空、原因 POOL_ABSENT', () => {
    const bars = makeBars(6, 0.0008).slice(3);
    const slice = {
      tradingDays: [day(0), day(1), day(2), day(3), day(4), day(5)],
      symbols: [makeSymbolSeries('sh513000', bars)],
      benchmarkBars: [],
    };
    const rows = computeL1DecisionRows(slice, { combo: 'wsm_v2_rsrs', startDate: day(0), endDate: day(5) });
    const before = rows.find((r) => r.trade_date === day(0));
    expect(before?.in_pool).toBe(false);
    expect(before?.reject_reason).toBe('POOL_ABSENT');
    expect(before?.ma5).toBeNull();
    expect(before?.wsm_v2).toBeNull();
    expect(before?.rank).toBeNull();
  });

  it('不足 60 根：指标 0 / MA 空，原因固定 BELOW_MA20', () => {
    const bars = makeBars(59, 0.0008);
    const slice = {
      tradingDays: bars.map((b) => b.date),
      symbols: [makeSymbolSeries('sh510300', bars)],
      benchmarkBars: [],
    };
    const [row] = computeL1DecisionRows(slice, { startDate: day(58), endDate: day(58) });
    expect(row.wsm_v2).toBe(0);
    expect(row.nday_return).toBe(0);
    expect(row.rsrs_z).toBe(0);
    expect(row.ma5).toBeNull();
    expect(row.ma60).toBeNull();
    expect(row.reject_reason).toBe('BELOW_MA20');
  });

  it('默认 combo 为主槽 WSM、次槽 RSRS', () => {
    const bars = makeBars(80, 0.0008);
    const slice = {
      tradingDays: bars.map((b) => b.date),
      symbols: [makeSymbolSeries('sh510300', bars)],
      benchmarkBars: [],
    };
    const [row] = computeL1DecisionRows(slice, { startDate: day(79), endDate: day(79) });
    expect(row.momentum_primary).toBe(row.wsm_v2);
    expect(row.momentum_secondary).toBe(row.rsrs_z);
  });

  it('序列非升序直接报错（避免二分查找静默取错 bar）', () => {
    const bars = makeBars(5, 0.0008);
    const broken = [bars[1], bars[0], bars[2], bars[3], bars[4]];
    const slice = {
      tradingDays: broken.map((b) => b.date),
      symbols: [makeSymbolSeries('sh510300', broken)],
      benchmarkBars: [],
    };
    expect(() => computeL1DecisionRows(slice)).toThrow(/严格升序/);
  });
});
