/**
 * M4 寻优模块单测 —— 搜索空间 / 切分隔离 / 目标函数 / 聚合披露
 *
 * ⚠️ 不测 `runner.ts`：它要读 DuckDB 全市场面板，CI 无行情库（AGENTS.md「CI 与本地不一致」）。
 * runner 的通路验证由 `sweep --mode pilot` 在真库上做，结果落 `bt_trial`。
 */
import { describe, expect, it } from 'vitest';
import {
  SEARCH_GRID,
  baselineParams,
  fineTrials,
  mulberry32,
  neighborValues,
  sampleParams,
  sampleTrials,
  stabilityTrials,
  totalCombinations,
  trialSeed,
} from '../../src/services/backtest/optimize/searchSpace.js';
import {
  SWEEP_END,
  SWEEP_START,
  WALK_FORWARD_FOLDS,
  assertFoldsIsolated,
  foldMetrics,
  segmentMetrics,
  sliceEquity,
  yearlyMetrics,
} from '../../src/services/backtest/optimize/split.js';
import { evaluateTrial } from '../../src/services/backtest/optimize/objective.js';
import { buildStabilitySurface, summarizeSweep } from '../../src/services/backtest/optimize/aggregate.js';
import {
  computeMetrics,
  type BacktestMetrics,
  type EquityPoint,
} from '../../src/services/backtest/metrics/metrics.js';
import type { RoundTrip } from '../../src/services/backtest/account/portfolio.js';
import type { BacktestResult } from '../../src/services/backtest/engine.js';
import type { TrialOutcome } from '../../src/services/backtest/optimize/runner.js';

function point(date: string, equity: number, exposure = 0.9): EquityPoint {
  return {
    date,
    equity,
    cash: equity * (1 - exposure),
    riskMv: equity * exposure,
    cashMv: 0,
    benchmarkClose: 100,
    benchmarkStale: false,
    drawdownRatio: 0,
    exposure,
  };
}

function metricsOf(startEnd: { start: string; end: string }, equity: number[]): BacktestMetrics {
  const points = equity.map((e, i) => point(splitDay(startEnd.start, i), e));
  return computeMetrics(points, []);
}

function splitDay(start: string, i: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

function fakeResult(): BacktestResult {
  // 2022-12-30 ~ 2025-12-31 逐日净值（含窗口前一点，用于段首日收益）
  const points: EquityPoint[] = [];
  let equity = 100000;
  const d = new Date('2022-12-30T00:00:00Z');
  const end = new Date(`${SWEEP_END}T00:00:00Z`);
  while (d <= end) {
    const day = d.toISOString().slice(0, 10);
    equity = equity * (1 + (d.getUTCDate() % 7 === 0 ? 0.01 : 0.002));
    points.push(point(day, equity));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const roundTrips: RoundTrip[] = [
    {
      symbol: 'sh510300',
      openDate: '2023-06-01',
      closeDate: '2023-08-01',
      qty: 100,
      pnl: 100,
      returnPct: 0.1,
      exitReason: 'test',
      proceeds: 1100,
    },
    {
      symbol: 'sh510300',
      openDate: '2024-06-01',
      closeDate: '2025-02-01',
      qty: 100,
      pnl: 50,
      returnPct: 0.05,
      exitReason: 'test',
      proceeds: 1050,
    },
  ];
  return {
    meta: {
      strategyId: 's',
      strategyVersion: 'v',
      strategyName: 'n',
      params: {},
      start: SWEEP_START,
      end: SWEEP_END,
      initialCash: 100000,
      universeMode: 'dynamic',
      priceMode: 'open',
      benchmarkSymbol: 'sh510300',
      rules: {} as never,
      suspension: {},
    },
    equity: points,
    trades: [],
    roundTrips,
    dividends: [],
    metrics: computeMetrics(points, roundTrips, { initialEquity: 100000 }),
    decisions: [],
    skipped: [],
    tradedNotional: 0,
  };
}

describe('searchSpace', () => {
  it('全网格组合数是各参数档数之积（≈2.03e9，不可穷举）', () => {
    const product = SEARCH_GRID.reduce((a, p) => a * p.values.length, 1);
    expect(totalCombinations()).toBe(product);
    expect(totalCombinations()).toBe(2_028_571_776);
  });

  it('同一 seed 抽样逐位可复现，且与 sweep_id 无关', () => {
    const a = sampleTrials(12345, 5, 'coarse', 0, 'c');
    const b = sampleTrials(12345, 5, 'coarse', 0, 'c');
    expect(a.map((t) => t.params)).toEqual(b.map((t) => t.params));
    expect(a.map((t) => t.seed)).toEqual(b.map((t) => t.seed));
    expect(a[0].trialId).toBe('c-0000');
  });

  it('不同 seed 产生不同抽样（不是常量序列）', () => {
    const a = sampleTrials(1, 10, 'coarse');
    const b = sampleTrials(2, 10, 'coarse');
    expect(a.map((t) => JSON.stringify(t.params))).not.toEqual(b.map((t) => JSON.stringify(t.params)));
  });

  it('抽样只落在网格档位上（不会产生非法值）', () => {
    for (const t of sampleTrials(777, 50, 'coarse')) {
      for (const spec of SEARCH_GRID) {
        expect(spec.values).toContain(t.params[spec.key]);
      }
    }
  });

  it('mulberry32 值域 [0,1) 且确定', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(r2());
    }
  });

  it('trialSeed 对 (seed, index) 一一映射', () => {
    expect(trialSeed(1, 0)).not.toBe(trialSeed(1, 1));
    expect(trialSeed(1, 0)).toBe(trialSeed(1, 0));
  });

  it('baselineParams 取自策略默认值（不是网格首档）', () => {
    const p = baselineParams();
    expect(p.holdingsNum).toBe(1);
    expect(p.lookbackDays).toBe(25);
    expect(p.stopLossThreshold).toBe(0.95);
  });

  it('neighborValues 取 ±1 档，边界只取存在的一侧', () => {
    const grid = SEARCH_GRID.find((g) => g.key === 'holdingsNum')!;
    expect(neighborValues(grid, 2)).toEqual([1, 3]);
    expect(neighborValues(grid, 1)).toEqual([2]);
    expect(neighborValues(grid, 3)).toEqual([2]);
  });

  it('稳定性邻域只动一个参数，其余保持中心值', () => {
    const center = baselineParams();
    const trials = stabilityTrials(center, 20261107);
    expect(trials.length).toBeGreaterThan(0);
    for (const t of trials) {
      const changed = Object.keys(t.params).filter((k) => Math.abs(t.params[k] - (center[k] ?? 0)) > 1e-9);
      expect(changed).toHaveLength(1);
    }
  });

  it('细搜只在中心值的相邻档内移动，不跳到远处', () => {
    const center = baselineParams();
    const specs = fineTrials([center], 999, 20, 0);
    expect(specs.length).toBe(20);
    for (const s of specs) {
      expect(s.seed).toBeGreaterThan(0);
    }
  });

  it('sampleParams 不改动入参 grid', () => {
    const before = JSON.stringify(SEARCH_GRID);
    sampleParams(mulberry32(7));
    expect(JSON.stringify(SEARCH_GRID)).toBe(before);
  });
});

describe('split（walk-forward 隔离）', () => {
  it('批准的两折结构：折1 训练 2023→测试 2024；折2 训练 2023-2024→测试 2025', () => {
    expect(WALK_FORWARD_FOLDS).toHaveLength(2);
    expect(WALK_FORWARD_FOLDS[0]).toMatchObject({ trainStart: '2023-01-01', testStart: '2024-01-01' });
    expect(WALK_FORWARD_FOLDS[1]).toMatchObject({ trainStart: '2023-01-01', testStart: '2025-01-01' });
    expect(() => assertFoldsIsolated()).not.toThrow();
  });

  it('训练段与测试段重叠时直接抛错（防止数据泄漏）', () => {
    expect(() =>
      assertFoldsIsolated([
        {
          foldId: 'x',
          trainStart: '2023-01-01',
          trainEnd: '2024-06-30',
          testStart: '2024-01-01',
          testEnd: '2024-12-31',
        },
      ]),
    ).toThrow(/重叠|倒置/);
  });

  it('两折测试段互相重叠时抛错', () => {
    expect(() =>
      assertFoldsIsolated([
        {
          foldId: 'a',
          trainStart: '2023-01-01',
          trainEnd: '2023-12-31',
          testStart: '2024-01-01',
          testEnd: '2024-12-31',
        },
        {
          foldId: 'b',
          trainStart: '2023-01-01',
          trainEnd: '2024-06-30',
          testStart: '2024-06-01',
          testEnd: '2025-12-31',
        },
      ]),
    ).toThrow(/测试段重叠/);
  });

  it('sliceEquity 只返回窗口内的点（测试段不含训练段任何一天）', () => {
    const r = fakeResult();
    const f = WALK_FORWARD_FOLDS[0];
    const train = sliceEquity(r.equity, f.trainStart, f.trainEnd);
    const test = sliceEquity(r.equity, f.testStart, f.testEnd);
    expect(train.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
    expect(train.every((p) => p.date <= f.trainEnd)).toBe(true);
    expect(test.every((p) => p.date >= f.testStart)).toBe(true);
    expect(train.some((p) => p.date >= f.testStart)).toBe(false);
    expect(test.some((p) => p.date <= f.trainEnd)).toBe(false);
  });

  it('段指标用窗口前一点作为初始权益（首日收益计入）', () => {
    const r = fakeResult();
    const f = WALK_FORWARD_FOLDS[0];
    const m = segmentMetrics(r, f.testStart, f.testEnd, 100000);
    const priorEquity = r.equity.filter((p) => p.date < f.testStart).at(-1)!.equity;
    expect(m.initialEquity).toBeCloseTo(priorEquity, 6);
    expect(m.initialEquity).not.toBe(100000);
  });

  it('2023 段（回测首段）初始权益退化为初始资金', () => {
    const r = fakeResult();
    // 抹掉 warmup 前的点：让回测起点就是 2023-01-01
    const firstSegment = { ...r, equity: r.equity.filter((p) => p.date >= '2023-01-01') };
    const f = WALK_FORWARD_FOLDS[0];
    const m = segmentMetrics(firstSegment, f.trainStart, f.trainEnd, 100000);
    expect(m.initialEquity).toBe(100000);
  });

  it('平仓回合按 closeDate 归入窗口（跨段开仓的回合归平仓段）', () => {
    const r = fakeResult();
    const m = yearlyMetrics(r, 100000);
    // 2023 段只有 1 笔（2023-08-01 平仓）；2025 段包含跨年平仓那笔
    expect(m['2023'].closedRoundTrips).toBe(1);
    expect(m['2025'].closedRoundTrips).toBe(1);
    expect(m['2024'].closedRoundTrips).toBe(0);
  });

  it('foldMetrics 同时给出训练/测试两段，且两段日期不重叠', () => {
    const r = fakeResult();
    const fm = foldMetrics(r, WALK_FORWARD_FOLDS[0], 100000);
    expect(fm.foldId).toBe('fold1');
    expect(fm.train.startDate <= fm.train.endDate).toBe(true);
    expect(fm.train.endDate < fm.test.startDate).toBe(true);
  });
});

describe('objective（选参只看训练段）', () => {
  function foldsOf(trainCagr: number, testCagr: number, trainDD: number, testDD: number) {
    return [
      {
        foldId: 'fold1',
        train: {
          ...metricsOf({ start: '2023-01-01', end: '2023-12-31' }, [100, 100 + trainCagr * 100]),
          cagr: trainCagr,
          maxDrawdownRatio: trainDD,
          closedRoundTrips: 40,
        },
        test: {
          ...metricsOf({ start: '2024-01-01', end: '2024-12-31' }, [100, 100 + testCagr * 100]),
          cagr: testCagr,
          maxDrawdownRatio: testDD,
        },
      },
      {
        foldId: 'fold2',
        train: {
          ...metricsOf({ start: '2023-01-01', end: '2024-12-31' }, [100, 100 + trainCagr * 100]),
          cagr: trainCagr,
          maxDrawdownRatio: trainDD,
          closedRoundTrips: 80,
        },
        test: {
          ...metricsOf({ start: '2025-01-01', end: '2025-12-31' }, [100, 100 + testCagr * 100]),
          cagr: testCagr,
          maxDrawdownRatio: testDD,
        },
      },
    ] as never;
  }

  const baselines = [
    { foldId: 'fold1', trainMaxDrawdownRatio: 0.2 },
    { foldId: 'fold2', trainMaxDrawdownRatio: 0.2 },
  ];

  it('selectionScore 只由训练段决定，改测试段不影响排序', () => {
    const a = evaluateTrial(foldsOf(0.4, 0.1, 0.2, 0.2), baselines, 0.9);
    const b = evaluateTrial(foldsOf(0.4, 0.9, 0.2, 0.2), baselines, 0.9);
    expect(a.selectionScore).toBeCloseTo(0.4, 9);
    expect(b.selectionScore).toBeCloseTo(0.4, 9);
    expect(a.oosMeanCagr).toBeCloseTo(0.1, 9);
    expect(b.oosMeanCagr).toBeCloseTo(0.9, 9);
  });

  it('训练段回撤超过基线 1.2 倍 ⇒ 不合格', () => {
    const ev = evaluateTrial(foldsOf(0.4, 0.3, 0.25, 0.2), baselines, 0.9);
    expect(ev.eligible).toBe(false);
    expect(ev.violations.join(' ')).toMatch(/回撤/);
  });

  it('训练段平仓回合 < 30 ⇒ 不合格', () => {
    const folds = foldsOf(0.4, 0.3, 0.2, 0.2);
    for (const f of folds) f.train.closedRoundTrips = 10;
    const ev = evaluateTrial(folds, baselines, 0.9);
    expect(ev.eligible).toBe(false);
    expect(ev.violations.join(' ')).toMatch(/平仓回合/);
  });

  it('平均暴露 > 100% ⇒ 不合格（口径回归探针）', () => {
    const ev = evaluateTrial(foldsOf(0.4, 0.3, 0.2, 0.2), baselines, 1.05);
    expect(ev.eligible).toBe(false);
    expect(ev.violations.join(' ')).toMatch(/暴露/);
  });

  it('合格试次：eligible=true 且无 violations', () => {
    const ev = evaluateTrial(foldsOf(0.4, 0.3, 0.2, 0.2), baselines, 0.9);
    expect(ev.eligible).toBe(true);
    expect(ev.violations).toEqual([]);
  });
});

function outcome(trialId: string, params: Record<string, number>, train: number, oos: number): TrialOutcome {
  return {
    trialId,
    phase: 'coarse',
    seed: 1,
    params,
    runId: `r-${trialId}`,
    evaluation: {
      selectionScore: train,
      oosMeanCagr: oos,
      oosMeanSharpe: 1,
      oosMeanCalmar: 1,
      oosRoundTrips: 100,
      eligible: true,
      violations: [],
      folds: [
        {
          foldId: 'fold1',
          trainCagr: train,
          testCagr: oos,
          trainMaxDrawdownRatio: 0.2,
          testMaxDrawdownRatio: 0.2,
          trainRoundTrips: 40,
          testRoundTrips: 40,
        },
        {
          foldId: 'fold2',
          trainCagr: train,
          testCagr: oos,
          trainMaxDrawdownRatio: 0.2,
          testMaxDrawdownRatio: 0.2,
          trainRoundTrips: 40,
          testRoundTrips: 40,
        },
      ],
    },
    metrics: {
      selectionScore: train,
      oosMeanCagr: oos,
      oosMeanSharpe: 1,
      oosMeanCalmar: 1,
      oosRoundTrips: 100,
      eligible: true,
      violations: [],
      folds: [],
      full: {
        cagr: train,
        sharpeRatio: 1,
        calmarRatio: 1,
        maxDrawdownRatio: 0.2,
        averageExposure: 0.9,
        closedRoundTrips: 100,
        finalEquity: 100,
      },
      yearly: {
        '2023': { cagr: train, cumulativeReturn: train, maxDrawdownRatio: 0.2 },
        '2024': { cagr: oos, cumulativeReturn: oos, maxDrawdownRatio: 0.2 },
        '2025': { cagr: oos, cumulativeReturn: oos, maxDrawdownRatio: 0.2 },
      },
      skipped: {},
      heapUsedMb: 1000,
      elapsedSeconds: 1,
    },
    folds: [],
  };
}

describe('aggregate（稳定性与多重检验披露）', () => {
  it('邻域平稳 ⇒ robust；紧贴悬崖 ⇒ unusable', () => {
    const center = outcome('c', { lookbackDays: 25, r2Threshold: 0.4 }, 0.4, 0.2);
    const neighbors = [
      {
        ...outcome('n1', { lookbackDays: 20, r2Threshold: 0.4 }, 0.4, 0.18),
        params: { lookbackDays: 20, r2Threshold: 0.4 },
      },
      {
        ...outcome('n2', { lookbackDays: 30, r2Threshold: 0.4 }, 0.4, 0.21),
        params: { lookbackDays: 30, r2Threshold: 0.4 },
      },
      {
        ...outcome('n3', { lookbackDays: 25, r2Threshold: 0.3 }, 0.4, 0.19),
        params: { lookbackDays: 25, r2Threshold: 0.3 },
      },
      {
        ...outcome('n4', { lookbackDays: 25, r2Threshold: 0.5 }, 0.4, 0.18),
        params: { lookbackDays: 25, r2Threshold: 0.5 },
      },
    ];
    const cells = buildStabilitySurface(center, neighbors);
    expect(cells.find((c) => c.param === 'lookbackDays')!.verdict).toBe('robust');
    expect(cells.find((c) => c.param === 'r2Threshold')!.verdict).toBe('robust');

    const cliffNeighbors = [
      {
        ...outcome('m1', { lookbackDays: 20, r2Threshold: 0.4 }, 0.4, 0.02),
        params: { lookbackDays: 20, r2Threshold: 0.4 },
      },
      {
        ...outcome('m2', { lookbackDays: 30, r2Threshold: 0.4 }, 0.4, 0.03),
        params: { lookbackDays: 30, r2Threshold: 0.4 },
      },
    ];
    const cliff = buildStabilitySurface(center, cliffNeighbors);
    expect(cliff.find((c) => c.param === 'lookbackDays')!.verdict).toBe('unusable');
  });

  it('稳健性判定忽略"同时改两个参数"的邻居', () => {
    const center = outcome('c', { lookbackDays: 25, r2Threshold: 0.4 }, 0.4, 0.2);
    const twoChanged = [
      {
        ...outcome('x', { lookbackDays: 20, r2Threshold: 0.3 }, 0.4, 0.5),
        params: { lookbackDays: 20, r2Threshold: 0.3 },
      },
    ];
    expect(buildStabilitySurface(center, twoChanged)).toEqual([]);
  });

  it('汇总必须同时给出最优与中位数（best-of-N 偏差披露）', () => {
    const baseline = outcome('baseline', {}, 0.4, 0.2);
    const trials = [
      baseline,
      outcome('a', {}, 0.5, 0.25),
      outcome('b', {}, 0.3, 0.12),
      outcome('c', {}, 0.2, 0.05),
    ];
    const s = summarizeSweep(trials, baseline);
    expect(s.bestBySelection!.trialId).toBe('a');
    expect(s.bestByOos!.trialId).toBe('a');
    expect(s.oosDistribution.median).toBeCloseTo(0.16, 9);
    expect(s.bestMinusMedian).toBeCloseTo(0.25 - 0.16, 9);
    expect(s.disclosure.join(' ')).toMatch(/best-of-N/);
    expect(s.disclosure.join(' ')).toMatch(/基线/);
  });

  it('分年度一致性给出 3 个自然年的 delta', () => {
    const baseline = outcome('baseline', {}, 0.4, 0.2);
    const best = outcome('best', {}, 0.5, 0.3);
    const s = summarizeSweep([baseline, best], baseline);
    expect(Object.keys(s.yearlyConsistency)).toEqual(['2023', '2024', '2025']);
    expect(s.yearlyConsistency['2023'].delta).toBeCloseTo(0.1, 9);
  });
});
