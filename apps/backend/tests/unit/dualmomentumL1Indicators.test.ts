import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  calcMa,
  calcNdayReturnMomentum,
  calcRsrsZ,
  calcWeightedSlopeMomentum,
  precalcIndicators,
} from '../../src/services/backtest/strategies/dualmomentum/l1/indicators.js';
import { forwardAdjustWindow } from '../../src/services/backtest/strategies/dualmomentum/l1/series.js';
import type { PriceBar } from '../../src/services/backtest/strategies/dualmomentum/l1/types.js';

interface GoldenCase {
  end: number;
  wsm_v2: number;
  nday_return: number;
  rsrs_z: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
}

interface Golden {
  bars: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    hfq_factor: number;
  }>;
  cases: GoldenCase[];
}

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/dualmomentum/l1_indicator_golden.json', import.meta.url)),
    'utf8',
  ),
) as Golden;

const bars: PriceBar[] = golden.bars.map((b) => ({
  date: b.date,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume,
  amount: b.volume * b.close,
  hfqFactor: b.hfq_factor,
}));

/** 1e-9 相对容差，对齐 DAS-2 §9.4（浮点求和不做逐位相等）。 */
function expectAligned(actual: number, expected: number, label: string): void {
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance);
}

describe('L1 指标与 QuantInvest 参考实现逐位对齐', () => {
  it('60 根窗口：WSM / N 日涨幅 / RSRS-Z / MA 全部对齐', () => {
    for (const testCase of golden.cases) {
      const window = bars.slice(testCase.end - 59, testCase.end + 1);
      expect(window).toHaveLength(60);
      const adjusted = forwardAdjustWindow(window, window[window.length - 1].hfqFactor);
      const ind = precalcIndicators(adjusted.close, adjusted.high, adjusted.low);
      const label = `end=${testCase.end}`;
      expectAligned(ind.wsm, testCase.wsm_v2, `${label} wsm_v2`);
      expectAligned(ind.nday, testCase.nday_return, `${label} nday`);
      expectAligned(ind.rsrs, testCase.rsrs_z, `${label} rsrs`);
      expectAligned(ind.ma[5] as number, testCase.ma5, `${label} ma5`);
      expectAligned(ind.ma[10] as number, testCase.ma10, `${label} ma10`);
      expectAligned(ind.ma[20] as number, testCase.ma20, `${label} ma20`);
      expectAligned(ind.ma[60] as number, testCase.ma60, `${label} ma60`);
    }
  });
});

describe('不足 60 根：整体短路（不是逐指标退化）', () => {
  it('59 根 ⇒ 三个动量 0，MA 全部为空', () => {
    const window = bars.slice(0, 59);
    const ind = precalcIndicators(
      window.map((b) => b.close),
      window.map((b) => b.high),
      window.map((b) => b.low),
    );
    expect(ind.wsm).toBe(0);
    expect(ind.nday).toBe(0);
    expect(ind.rsrs).toBe(0);
    expect(ind.ma).toEqual({});
    expect(ind.ma[20]).toBeUndefined();
  });

  it('60 根才解冻：MA20 非空', () => {
    const window = bars.slice(0, 60);
    const ind = precalcIndicators(
      window.map((b) => b.close),
      window.map((b) => b.high),
      window.map((b) => b.low),
    );
    expect(ind.ma[20]).not.toBeUndefined();
  });
});

describe('指标自身的退化守卫', () => {
  it('WSM：少于 2 根 / 非正价格 → 0', () => {
    expect(calcWeightedSlopeMomentum([3])).toBe(0);
    expect(calcWeightedSlopeMomentum([3, 0])).toBe(0);
    expect(calcWeightedSlopeMomentum([3, -1])).toBe(0);
  });

  it('WSM：横盘（ss_total≈0）→ 输出 ≈0（浮点求和残差 ≤1e-12）', () => {
    expect(Math.abs(calcWeightedSlopeMomentum(new Array<number>(10).fill(3)))).toBeLessThanOrEqual(1e-12);
  });

  it('N 日涨幅：不足周期 → 0', () => {
    expect(calcNdayReturnMomentum(new Array<number>(24).fill(3))).toBe(0);
    expect(calcNdayReturnMomentum([3, 3.3], 25)).toBe(0);
  });

  it('RSRS：不足 50 根 → 0；价格恒定 → 0', () => {
    expect(calcRsrsZ(new Array<number>(49).fill(3), new Array<number>(49).fill(2.9))).toBe(0);
    expect(calcRsrsZ(new Array<number>(50).fill(3), new Array<number>(50).fill(3))).toBe(0);
  });

  it('MA：不足周期 → 0', () => {
    expect(calcMa([3, 3.1], 5)).toBe(0);
    expect(calcMa([3, 3.1, 3.2, 3.3, 3.4], 5)).toBeCloseTo(3.2, 12);
  });
});
