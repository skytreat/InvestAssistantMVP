/**
 * M2 指标单测 —— 对应验收锚点「回撤必须是**比率**，不是金额」
 *
 * 覆盖：
 * - `computeDrawdownSeries` / `computeMaxDrawdown`（比率 + 金额分开）
 * - 累计收益 / CAGR / 月度收益
 * - 胜率 / 盈亏比 / 平均持有天数
 * - 平均风险暴露 / 年化换手
 * - alpha / beta（成对日收益）
 */
import { describe, it, expect } from 'vitest';
import {
  computeDrawdownSeries,
  computeMaxDrawdown,
  computeMetrics,
  computeMonthlyReturns,
  type EquityPoint,
} from '../../src/services/backtest/metrics/metrics.js';
import type { RoundTrip } from '../../src/services/backtest/account/portfolio.js';

function point(
  date: string,
  equity: number,
  opts: Partial<Pick<EquityPoint, 'cash' | 'riskMv' | 'cashMv' | 'benchmarkClose' | 'exposure'>> = {},
): EquityPoint {
  return {
    date,
    equity,
    cash: opts.cash ?? equity,
    riskMv: opts.riskMv ?? 0,
    cashMv: opts.cashMv ?? 0,
    benchmarkClose: opts.benchmarkClose ?? null,
    exposure: opts.exposure ?? 0,
    drawdownRatio: 0,
  };
}

function roundTrip(
  symbol: string,
  pnl: number,
  openDate = '2024-01-02',
  closeDate = '2024-01-10',
): RoundTrip {
  return {
    symbol,
    openDate,
    closeDate,
    qty: 100,
    pnl,
    returnPct: 0,
    exitReason: 'rebalance-replace',
    proceeds: 1000,
  };
}

describe('M2 指标 · 回撤（比率 vs 金额）', () => {
  it('100 → 120 → 90：回撤比率 0.25（=25%），金额 30', () => {
    const series = computeDrawdownSeries([100, 120, 90]);
    expect(series[0]).toBe(0);
    expect(series[1]).toBe(0);
    expect(series[2]).toBeCloseTo(0.25, 10);

    const dd = computeMaxDrawdown([
      { date: '2024-01-02', equity: 100 },
      { date: '2024-01-03', equity: 120 },
      { date: '2024-01-04', equity: 90 },
    ]);
    expect(dd.maxDrawdownRatio).toBeCloseTo(0.25, 10);
    expect(dd.maxDrawdownAmount).toBeCloseTo(30, 10);
    expect(dd.peakDate).toBe('2024-01-03');
    expect(dd.troughDate).toBe('2024-01-04');
    expect(dd.maxDrawdownDays).toBe(1);
  });

  it('比率与金额是**两个独立字段**（不能拿金额冒充比率）', () => {
    const dd = computeMaxDrawdown([
      { date: '2024-01-02', equity: 1000 },
      { date: '2024-01-03', equity: 500 },
    ]);
    expect(dd.maxDrawdownRatio).toBeCloseTo(0.5, 10);
    expect(dd.maxDrawdownAmount).toBeCloseTo(500, 10);
    expect(dd.maxDrawdownRatio).not.toBe(dd.maxDrawdownAmount);
  });

  it('单边上涨 → 回撤 0；空序列 → 全 0 且无日期', () => {
    expect(computeDrawdownSeries([100, 110, 130])).toEqual([0, 0, 0]);
    const dd = computeMaxDrawdown([]);
    expect(dd.maxDrawdownRatio).toBe(0);
    expect(dd.maxDrawdownAmount).toBe(0);
    expect(dd.peakDate).toBeNull();
    expect(dd.troughDate).toBeNull();
  });

  it('多个回撤区间取最深的一档（比率优先，而非金额）', () => {
    const dd = computeMaxDrawdown([
      { date: '2024-01-02', equity: 100 },
      { date: '2024-01-03', equity: 90 }, // -10% / -10 元
      { date: '2024-01-04', equity: 200 },
      { date: '2024-01-05', equity: 150 }, // -25% / -50 元 ← 更深
    ]);
    expect(dd.maxDrawdownRatio).toBeCloseTo(0.25, 10);
    expect(dd.maxDrawdownAmount).toBeCloseTo(50, 10);
    expect(dd.peakDate).toBe('2024-01-04');
    expect(dd.troughDate).toBe('2024-01-05');
  });
});

describe('M2 指标 · 收益与月度', () => {
  it('累计收益与 CAGR 按日历天数复利', () => {
    const points = [point('2024-01-02', 100_000), point('2025-01-01', 110_000)];
    const m = computeMetrics(points, [], { initialEquity: 100_000 });

    expect(m.cumulativeReturn).toBeCloseTo(0.1, 10);
    const days = (Date.parse('2025-01-01') - Date.parse('2024-01-02')) / 86_400_000;
    expect(m.calendarDays).toBe(days);
    expect(m.cagr).toBeCloseTo(Math.pow(1.1, 365.25 / days) - 1, 10);
    expect(m.tradingDays).toBe(2);
    expect(m.startDate).toBe('2024-01-02');
    expect(m.endDate).toBe('2025-01-01');
  });

  it('月度收益：首月对初始权益，后续月对上一月最后一点', () => {
    const points = [point('2024-01-15', 105_000), point('2024-01-31', 110_000), point('2024-02-29', 99_000)];
    const r = computeMonthlyReturns(points, 100_000);
    expect(r).toHaveLength(2);
    expect(r[0].month).toBe('2024-01');
    expect(r[0].returnPct).toBeCloseTo(0.1, 10);
    expect(r[1].month).toBe('2024-02');
    expect(r[1].returnPct).toBeCloseTo(-0.1, 10);
  });

  it('平均风险暴露 = exposure 日均值', () => {
    const points = [
      point('2024-01-02', 100_000, { exposure: 0.6 }),
      point('2024-01-03', 100_000, { exposure: 0.8 }),
    ];
    const m = computeMetrics(points, [], { initialEquity: 100_000 });
    expect(m.averageExposure).toBeCloseTo(0.7, 10);
  });

  it('年化换手 = 总成交额 / 平均权益 / 年数', () => {
    const points = [point('2024-01-02', 100_000), point('2025-01-01', 100_000)];
    const m = computeMetrics(points, [], { initialEquity: 100_000, tradedNotional: 100_000 });
    const years = m.calendarDays / 365.25;
    expect(m.turnoverAnnualized).toBeCloseTo(100_000 / 100_000 / years, 10);
  });
});

describe('M2 指标 · 回合交易', () => {
  it('胜率 = 盈利回合数 / 总回合数；盈亏比 = 平均盈利 / 平均亏损', () => {
    const trips = [roundTrip('a', 100), roundTrip('b', 300), roundTrip('c', -200)];
    const m = computeMetrics([point('2024-01-02', 100_000), point('2024-01-10', 100_200)], trips, {
      initialEquity: 100_000,
    });

    expect(m.closedRoundTrips).toBe(3);
    expect(m.winRate).toBeCloseTo(2 / 3, 10);
    expect(m.profitLossRatio).toBeCloseTo(200 / 200, 10);
    expect(m.averageHoldingDays).toBe(8); // 01-02 → 01-10
  });

  it('无亏损回合时盈亏比为 null（不是 Infinity）', () => {
    const m = computeMetrics([point('2024-01-02', 100_000)], [roundTrip('a', 100)], {
      initialEquity: 100_000,
    });
    expect(m.winRate).toBe(1);
    expect(m.profitLossRatio).toBeNull();
  });

  it('无回合交易时胜率为 0', () => {
    const m = computeMetrics([point('2024-01-02', 100_000)], [], { initialEquity: 100_000 });
    expect(m.closedRoundTrips).toBe(0);
    expect(m.winRate).toBe(0);
  });
});

describe('M2 指标 · alpha / beta', () => {
  it('策略日收益恒为基准两倍 → beta=2、alpha≈0', () => {
    // 基准日收益：+1%, -2%, +3%, -1%
    const bench = [100, 101, 98.98, 101.9494, 100.929906];
    // 策略日收益：+2%, -4%, +6%, -2%
    const equity = [100, 102, 97.92, 103.7952, 101.719296];
    const dates = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];

    const points = equity.map((e, i) => point(dates[i], e, { benchmarkClose: bench[i] }));
    const m = computeMetrics(points, [], { initialEquity: 100 });

    expect(m.beta).toBeCloseTo(2, 8);
    expect(m.alphaAnnualized).toBeCloseTo(0, 8);
  });

  it('无基准时 alpha / beta 为 null', () => {
    const m = computeMetrics([point('2024-01-02', 100), point('2024-01-03', 110)], [], {
      initialEquity: 100,
    });
    expect(m.beta).toBeNull();
    expect(m.alphaAnnualized).toBeNull();
  });
});

describe('M2 指标 · 空序列兜底', () => {
  it('空净值点返回全 0 且不抛错', () => {
    const m = computeMetrics([], [], { initialEquity: 100_000 });
    expect(m.tradingDays).toBe(0);
    expect(m.cumulativeReturn).toBe(0);
    expect(m.maxDrawdownRatio).toBe(0);
    expect(m.monthlyReturns).toEqual([]);
  });
});
