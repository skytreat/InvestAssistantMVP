/**
 * M3 五福轮动 ETF 策略单测 —— **纯合成数据，不读 DuckDB**（CI 无行情库也能跑）
 *
 * 覆盖：
 * 1. 验收锚点①：Python oracle golden 逐位断言（动量 / MA / 量比 / 候选选择）
 * 2. 打分点数边界（25 点 null、26 点有值）
 * 3. 过滤链逐条淘汰（分值区间 / 跌幅 3% / 量比 1.9 / 正常期 R² / 走弱期 MA）
 * 4. 走弱期状态机（3/4 进入、3/4 退出、持续走弱每日重置、20 日强退）
 * 5. 候选系数 0.9 / 持仓保留优先 / 全空 → 防御 ETF
 * 6. `TargetSet.exitReasons` 四类归因
 * 7. 引擎集成：先卖后买 + T+1 在真实引擎里不被破坏
 */
import { describe, it, expect } from 'vitest';
import goldenJson from '../fixtures/backtest/wufu-golden.json';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import { runBacktest, type BacktestData } from '../../src/services/backtest/engine.js';
import { createWufuRotationStrategy } from '../../src/services/backtest/strategies/wufuRotation/index.js';
import { calculateMomentumScore } from '../../src/services/backtest/strategies/wufuRotation/momentum.js';
import {
  evaluateCandidate,
  momentumFilteredWindow,
  momentumRawWindow,
  momentumRequiredPoints,
  movingAverageOfLast,
  selectValidVolumeWindow,
  volumeRatioFromSeries,
  type FilterParams,
} from '../../src/services/backtest/strategies/wufuRotation/filters.js';
import {
  evaluateWeakPeriod,
  WEAK_PERIOD_INDEX_CODES,
  type WeakPeriodState,
} from '../../src/services/backtest/strategies/wufuRotation/weakPeriod.js';
import {
  buildCandidatePool,
  selectTargets,
} from '../../src/services/backtest/strategies/wufuRotation/candidate.js';
import type { CandidateMetrics } from '../../src/services/backtest/strategies/wufuRotation/filters.js';
import type {
  PositionView,
  StrategyContext,
  TargetSet,
  UniverseView,
} from '../../src/services/backtest/strategy/types.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import type { Bar } from '../../src/services/backtest/types.js';

// ─────────────────────────── golden 夹具类型 ───────────────────────────

interface GoldenMomentumCase {
  case: string;
  prices: number[];
  expected: { annualized: number; r2: number; score: number };
}
interface GoldenMaCase {
  case: string;
  closes: number[];
  expected: number;
}
interface GoldenVolumeCase {
  case: string;
  past5: number[];
  today: number;
  expected: number | null;
}
interface GoldenSymbolSpec {
  closes: number[];
  past5: number[];
  today: number;
  paused: boolean;
}
interface GoldenTargetCase {
  asOf: string;
  execDate: string;
  expectedSymbols: string[];
  expectedRegime: 'weak' | 'normal';
  expectedWeakDays: number;
  expectedDefensive: boolean;
  indexCounts: { below: number; above: number };
  top10: string[];
  candidates: string[];
  inputs: {
    dayIndex: number;
    priorWeak: boolean;
    priorWeakStart: number | null;
    universe: { fixed: string[]; dynamic: string[]; weak: string[] };
    holds: string[];
    indexCloses: Record<string, number[]>;
    defensiveEtf: string;
    symbols: Record<string, GoldenSymbolSpec>;
  };
  note: string;
}
interface GoldenData {
  source: string;
  momentum: GoldenMomentumCase[];
  ma: GoldenMaCase[];
  volumeRatio: GoldenVolumeCase[];
  targetSelection: GoldenTargetCase[];
}
const golden = goldenJson as unknown as GoldenData;

// ─────────────────────────── 合成序列（与 golden/Python 同源） ───────────────────────────

/** 稳定上涨 0.4%/日（score≈1.718、r²≈1） */
const UP_26 = [
  10, 10.04008, 10.080321, 10.120723, 10.161287, 10.202013, 10.242903, 10.283957, 10.325175, 10.366558,
  10.408108, 10.449824, 10.491707, 10.533757, 10.575977, 10.618365, 10.660924, 10.703653, 10.746553,
  10.789626, 10.832871, 10.876289, 10.919881, 10.963648, 11.007591, 11.051709,
];
/** UP_26 的末日跌 3.0006%（p[25]/p[24]≈0.96999 ≤ 0.97） */
const LOSS_26 = [...UP_26.slice(0, 25), 10.6773];
/** 上涨 + 5% 正弦扰动：score≈0.465、r²≈0.308（< 0.4） */
const R2_26 = [
  10, 10.188432, 10.36491, 10.517115, 10.634823, 10.710836, 10.741655, 10.727817, 10.673889, 10.588081,
  10.481547, 10.367403, 10.259567, 10.171519, 10.115089, 10.099377, 10.129922, 10.208173, 10.331326,
  10.492541, 10.681527, 10.885433, 11.089981, 11.280739, 11.444409, 11.570034,
];
/** 先涨 18 日再跌 8 日：末日 10.4498 < MA10 10.5848 */
const MA_26 = [
  10, 10.04008, 10.080321, 10.120723, 10.161287, 10.202013, 10.242903, 10.283957, 10.325175, 10.366558,
  10.408108, 10.449824, 10.491707, 10.533757, 10.575977, 10.618365, 10.660924, 10.703653, 10.67159, 10.639623,
  10.607752, 10.575977, 10.544296, 10.512711, 10.48122, 10.449824,
];
/** 常量成交量：量比 = 1.0 */
const FLAT_VOLUME = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000];

const DEFAULT_FILTER_PARAMS: FilterParams = {
  lookbackDays: 25,
  minScore: 0,
  maxScore: 5,
  r2Threshold: 0.4,
  maLookback: 10,
  maThreshold: 1.0,
  volumeRatioThreshold: 1.8,
  volumeLookback: 5,
  lossThreshold: 0.97,
};

// ─────────────────────────── 假上下文 ───────────────────────────

interface FakeCtxInput {
  asOf?: string;
  execDate?: string;
  dayIndex?: number;
  params?: Record<string, unknown>;
  universe?: Partial<UniverseView>;
  closes?: Record<string, number[]>;
  volumes?: Record<string, number[]>;
  indexCloses?: Record<string, number[]>;
  paused?: Record<string, boolean>;
  positions?: PositionView[];
  cash?: number;
  equity?: number;
  tags?: Record<string, unknown>;
}

function makeCtx(input: FakeCtxInput): StrategyContext {
  const asOf = input.asOf ?? '2024-03-06';
  const closes = input.closes ?? {};
  const volumes = input.volumes ?? {};
  const paused = input.paused ?? {};
  const positions = input.positions ?? [];
  const tags = input.tags ?? {};

  const seriesOf = (symbol: string, n: number, field: 'close' | 'volume' = 'close'): number[] => {
    const src = (field === 'volume' ? volumes[symbol] : closes[symbol]) ?? [];
    return src.slice(-n);
  };

  return {
    asOf,
    execDate: input.execDate ?? asOf,
    params: input.params ?? {},
    universe: {
      asOf,
      marketLiquidityPassCount: 0,
      liquidityThreshold: 0,
      fixed: [],
      dynamic: [],
      weak: [],
      ...input.universe,
    },
    dayIndex: input.dayIndex ?? 0,
    series: seriesOf,
    seriesBatch: (symbols, n, field = 'close') => new Map(symbols.map((s) => [s, seriesOf(s, n, field)])),
    indexSeries: (code, n) => (input.indexCloses?.[code] ?? []).slice(-n),
    bars: () => [],
    movingAverage: (symbol, n) => {
      const xs = seriesOf(symbol, n);
      return xs.length >= n ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    },
    latest: (symbol, field = 'close') => {
      const xs = seriesOf(symbol, 1, field);
      return xs.length > 0 ? xs[0] : null;
    },
    isPaused: (symbol) => paused[symbol] ?? false,
    position: (symbol) => positions.find((p) => p.symbol === symbol) ?? null,
    positions: () => positions,
    cash: input.cash ?? 100_000,
    equity: input.equity ?? 100_000,
    tag: (key, value) => {
      tags[key] = value;
    },
    log: () => {},
  };
}

function positionOf(symbol: string, avgCost: number, qty = 1000): PositionView {
  return {
    symbol,
    qty,
    avgCost,
    costBasis: avgCost * qty,
    closeableQty: qty,
    marketValue: 0,
  };
}

function decideWith(ctx: StrategyContext, params: Record<string, unknown> = {}): TargetSet {
  const strategy = createWufuRotationStrategy();
  strategy.init?.({ params });
  // 策略读的是 `ctx.params`（引擎侧由 `strategy.defaultParams + request.params` 填充），
  // 只传给 `init()` 不会生效 —— 这里显式覆盖 `ctx.params`。
  const out = strategy.decide({ ...ctx, params });
  expect(out).not.toBeNull();
  return out as TargetSet;
}

// ─────────────────────────── 锚点①：golden 逐位断言 ───────────────────────────

describe('M3 wufu · golden（Python oracle 逐位）', () => {
  it('golden 夹具来源可追溯（记录 v5.2 sha256）', () => {
    expect(golden.source).toContain('五福轮动ETF_v5.2.py');
    expect(golden.source).toMatch(/sha256=[0-9a-f]{64}/);
  });

  it.each(golden.momentum.map((c) => [c.case, c] as const))('momentum %s 与 Python 逐位一致', (_name, c) => {
    const r = calculateMomentumScore(c.prices, 25);
    expect(r).not.toBeNull();
    expect(r!.annualized).toBeCloseTo(c.expected.annualized, 9);
    expect(r!.r2).toBeCloseTo(c.expected.r2, 9);
    expect(r!.score).toBeCloseTo(c.expected.score, 9);
  });

  it.each(golden.ma.map((c) => [c.case, c] as const))('ma %s 与 Python 逐位一致', (_name, c) => {
    const ma = movingAverageOfLast(c.closes, 10);
    expect(ma).not.toBeNull();
    expect(ma!).toBeCloseTo(c.expected, 12);
  });

  it.each(golden.volumeRatio.map((c) => [c.case, c] as const))(
    'volumeRatio %s 与 Python 逐位一致',
    (_name, c) => {
      // 走策略真实路径：6 点序列（前 5 为历史、末点为 asOf 当日）
      const ratio = volumeRatioFromSeries([...c.past5, c.today], 5);
      if (c.expected === null) {
        expect(ratio).toBeNull();
      } else {
        expect(ratio).not.toBeNull();
        expect(ratio!).toBeCloseTo(c.expected, 12);
      }
    },
  );

  it.each(golden.targetSelection.map((c) => [c.asOf, c] as const))(
    'targetSelection %s 期望目标集合一致',
    (_asOf, c) => {
      const tags: Record<string, unknown> = {};
      const closes: Record<string, number[]> = {};
      const volumes: Record<string, number[]> = {};
      const paused: Record<string, boolean> = {};
      for (const [symbol, spec] of Object.entries(c.inputs.symbols)) {
        closes[symbol] = spec.closes;
        volumes[symbol] = [...spec.past5, spec.today];
        paused[symbol] = spec.paused;
      }
      const positions = c.inputs.holds.map((symbol) => {
        const last = closes[symbol]?.at(-1) ?? 1;
        // avgCost = 末日收盘 → 不触发止损，隔离出「候选/防御」分支
        return positionOf(symbol, last);
      });

      const ctx = makeCtx({
        asOf: c.asOf,
        execDate: c.execDate,
        dayIndex: c.inputs.dayIndex,
        params: { defensiveEtf: c.inputs.defensiveEtf },
        universe: c.inputs.universe,
        closes,
        volumes,
        paused,
        indexCloses: c.inputs.indexCloses,
        positions,
        tags,
      });

      const ts = decideWith(ctx, { defensiveEtf: c.inputs.defensiveEtf });
      expect(ts.mode).toBe('replace');
      expect(ts.targets.map((t) => t.symbol)).toEqual(c.expectedSymbols);
      expect(tags.regime).toBe(c.expectedRegime);
      expect(tags.weakDays).toBe(c.expectedWeakDays);

      const expectedReason = c.expectedDefensive
        ? 'defensive-fallback'
        : c.inputs.holds.includes(c.expectedSymbols[0])
          ? 'holding-retained'
          : 'candidate-top';
      expect(ts.targets[0].reason).toBe(expectedReason);
      expect(ts.targets[0].targetWeight).toBeCloseTo(1 / 1, 12);
    },
  );
});

// ─────────────────────────── 打分边界 ───────────────────────────

describe('M3 wufu · 动量打分的点数边界', () => {
  it('25 点（不足 lookback+1）→ null', () => {
    expect(calculateMomentumScore(UP_26.slice(0, 25), 25)).toBeNull();
  });

  it('26 点 → 有值（r² 混合口径由上面的 golden 逐位断言锁死）', () => {
    expect(calculateMomentumScore(UP_26, 25)).not.toBeNull();
  });
});

// ─────────────────────────── 过滤链 ───────────────────────────

describe('M3 wufu · 过滤链逐条淘汰', () => {
  const base = { symbol: 'sh512880', paused: false, weak: false, params: DEFAULT_FILTER_PARAMS };

  it('基准：UP_26 + 常量量 → 通过', () => {
    const r = evaluateCandidate({ ...base, closes: UP_26, volumes: FLAT_VOLUME });
    expect(r.passed).toBe(true);
    expect(r.metrics!.score).toBeCloseTo(1.718282, 6);
  });

  it('分值低于 minScore → 淘汰', () => {
    // golden 的 down 族：score ≈ -0.499
    const down = golden.momentum.find((c) => c.case === 'down@t25')!;
    const r = evaluateCandidate({ ...base, closes: down.prices, volumes: FLAT_VOLUME });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('score-out-of-range');
  });

  it('末日跌 3%（0.96999 ≤ 0.97）→ 淘汰', () => {
    const r = evaluateCandidate({ ...base, closes: LOSS_26, volumes: FLAT_VOLUME });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('short-term-loss');
  });

  it('恰好等于阈值（ratio === lossThreshold）→ 保留（v5.2 L732 是 `<` 而非 `<=`）', () => {
    // 阈值直接取「实际算出的 ratio」，避免 0.97 浮点表示带来的近似差
    const closes = [...UP_26];
    closes[closes.length - 1] = closes[closes.length - 2] * 0.96999;
    const exactRatio = closes[closes.length - 1] / closes[closes.length - 2];
    const r = evaluateCandidate({
      ...base,
      closes,
      volumes: FLAT_VOLUME,
      params: { ...DEFAULT_FILTER_PARAMS, lossThreshold: exactRatio },
    });
    expect(r.passed).toBe(true);
    expect(r.metrics!.symbol).toBe('sh512880');
  });

  it('量比 1.9 ≥ 1.8 → 淘汰', () => {
    const volumes = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_900_000];
    const r = evaluateCandidate({ ...base, closes: UP_26, volumes });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('volume-ratio');
  });

  it('正常期 r²=0.308 < 0.4 → 淘汰', () => {
    const momentum = calculateMomentumScore(R2_26, 25)!;
    expect(momentum.r2).toBeCloseTo(0.308426, 5);
    expect(momentum.score).toBeGreaterThan(0); // 先排除分值区间干扰
    const r = evaluateCandidate({ ...base, closes: R2_26, volumes: FLAT_VOLUME });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('r2');
  });

  it('走弱期收盘跌破 MA10 → 淘汰', () => {
    const r = evaluateCandidate({
      ...base,
      weak: true,
      closes: MA_26,
      volumes: FLAT_VOLUME,
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('ma');
  });

  it('停牌 → 直接淘汰', () => {
    const r = evaluateCandidate({ ...base, paused: true, closes: UP_26, volumes: FLAT_VOLUME });
    expect(r.passed).toBe(false);
    expect(r.reason).toBe('paused');
  });
});

// ─────────────────────────── 走弱期状态机 ───────────────────────────

describe('M3 wufu · 走弱期状态机', () => {
  /** nBelow=4：四指数全部跌破 MA10；3：三跌破一持有 */
  function indexSets(nBelow: number): Record<string, number[]> {
    const below = [4000, 3980, 3960, 3940, 3920, 3900, 3880, 3860, 3840, 3820, 3800];
    const above = [4000, 4020, 4040, 4060, 4080, 4100, 4120, 4140, 4160, 4180, 4200];
    const out: Record<string, number[]> = {};
    WEAK_PERIOD_INDEX_CODES.forEach((code, i) => {
      out[code] = i < nBelow ? below : above;
    });
    return out;
  }

  it('3/4 指数低于 MA10 → 进入走弱期（weakDays=1）', () => {
    const state: WeakPeriodState = { weak: false, startDayIndex: null };
    const snap = evaluateWeakPeriod({
      state,
      dayIndex: 0,
      maLookback: 10,
      maxWeakDays: 20,
      indexSeries: (code) => indexSets(3)[code],
    });
    expect(snap.weak).toBe(true);
    expect(snap.weakDays).toBe(1);
    expect(snap.belowCount).toBe(3);
    expect(snap.aboveCount).toBe(1);
  });

  it('3/4 站上 MA10 → 退出走弱期', () => {
    const state: WeakPeriodState = { weak: true, startDayIndex: 0 };
    const snap = evaluateWeakPeriod({
      state,
      dayIndex: 5,
      maLookback: 10,
      maxWeakDays: 20,
      indexSeries: (code) => indexSets(1)[code],
    });
    expect(snap.weak).toBe(false);
    expect(snap.weakDays).toBe(0);
    expect(state.weak).toBe(false);
  });

  it('持续走弱（每天 below>=3）→ weakDays 每日回 1，20 日强退不触发', () => {
    const state: WeakPeriodState = { weak: false, startDayIndex: null };
    const allBelow = indexSets(4);
    for (let day = 0; day < 30; day++) {
      const snap = evaluateWeakPeriod({
        state,
        dayIndex: day,
        maLookback: 10,
        maxWeakDays: 20,
        indexSeries: (code) => allBelow[code],
      });
      expect(snap.weak).toBe(true);
      expect(snap.weakDays).toBe(1);
    }
    // 第 30 天仍在走弱期 ⇒ 20 日硬退确实没被触发
    expect(state.weak).toBe(true);
  });

  it('计数达到 maxWeakDays → 强制退出（即使没有 3/4 站上）', () => {
    const state: WeakPeriodState = { weak: true, startDayIndex: 0 };
    // 2 below / 2 above：既不满足退出（above>=3），也不满足重置（below>=3）
    const snap = evaluateWeakPeriod({
      state,
      dayIndex: 25,
      maLookback: 10,
      maxWeakDays: 20,
      indexSeries: (code) => indexSets(2)[code],
    });
    expect(snap.weak).toBe(false);
    expect(snap.weakDays).toBe(0);
  });
});

// ─────────────────────────── 候选 / 保留 / 防御 ───────────────────────────

describe('M3 wufu · 候选池与目标选择', () => {
  function metric(symbol: string, score: number): CandidateMetrics {
    return {
      symbol,
      close: 10,
      score,
      annualized: score,
      r2: 1,
      volumeRatio: 1,
      maValue: 9,
    };
  }

  it('正常期系数 0.9：第 2 名 score = 第 1 名 × 0.89 → 不入候选', () => {
    const pool = buildCandidatePool([metric('A', 2), metric('B', 1.78), metric('C', 1.5)], {
      holdingsNum: 1,
      scoreThresholdRatio: 0.9,
      weak: false,
    });
    expect(pool.map((m) => m.symbol)).toEqual(['A']);
  });

  it('走弱期系数 1.0：第 2 名 score = 第 1 名 × 0.89 → 仍不入候选', () => {
    const pool = buildCandidatePool([metric('A', 2), metric('B', 1.78)], {
      holdingsNum: 1,
      scoreThresholdRatio: 0.9,
      weak: true,
    });
    expect(pool.map((m) => m.symbol)).toEqual(['A']);
  });

  it('持仓保留优先：持仓在候选中 → 不被第一名替换', () => {
    const selection = selectTargets({
      candidates: [metric('A', 2), metric('B', 1.9)],
      holdings: ['B'],
      stopLossSymbols: new Set(),
      holdingsNum: 1,
      defensiveSymbol: 'sh511880',
      defensivePaused: false,
    });
    expect(selection.picks.map((m) => m.symbol)).toEqual(['B']);
    expect(selection.retained.has('B')).toBe(true);
    expect(selection.defensive).toBe(false);
  });

  it('止损持仓不参与保留 → 由候选补足', () => {
    const selection = selectTargets({
      candidates: [metric('A', 2), metric('B', 1.9)],
      holdings: ['B'],
      stopLossSymbols: new Set(['B']),
      holdingsNum: 1,
      defensiveSymbol: 'sh511880',
      defensivePaused: false,
    });
    expect(selection.picks.map((m) => m.symbol)).toEqual(['A']);
  });

  it('候选全空 → 防御 ETF', () => {
    const selection = selectTargets({
      candidates: [],
      holdings: [],
      stopLossSymbols: new Set(),
      holdingsNum: 1,
      defensiveSymbol: 'sh511880',
      defensivePaused: false,
    });
    expect(selection.defensive).toBe(true);
  });

  it('候选全空且防御 ETF 停牌 → 空仓', () => {
    const selection = selectTargets({
      candidates: [],
      holdings: [],
      stopLossSymbols: new Set(),
      holdingsNum: 1,
      defensiveSymbol: 'sh511880',
      defensivePaused: true,
    });
    expect(selection.defensive).toBe(false);
    expect(selection.picks).toHaveLength(0);
  });
});

// ─────────────────────────── 退出原因 ───────────────────────────

describe('M3 wufu · TargetSet.exitReasons 归因', () => {
  const DEFENSIVE = 'sh511880';
  const risingIndex = (): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    for (const code of WEAK_PERIOD_INDEX_CODES) {
      out[code] = [4000, 4020, 4040, 4060, 4080, 4100, 4120, 4140, 4160, 4180, 4200];
    }
    return out;
  };
  const fallingIndex = (): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    WEAK_PERIOD_INDEX_CODES.forEach((code, i) => {
      out[code] =
        i < 3
          ? [4000, 3980, 3960, 3940, 3920, 3900, 3880, 3860, 3840, 3820, 3800]
          : [4000, 4020, 4040, 4060, 4080, 4100, 4120, 4140, 4160, 4180, 4200];
    });
    return out;
  };

  it('止损：asOf 收盘 ≤ 成本 × 0.95 → stop-loss 且不进 targets', () => {
    const tags: Record<string, unknown> = {};
    const ctx = makeCtx({
      universe: { fixed: ['sh510300'] },
      closes: {
        sh510300: UP_26,
        sh512880: [
          10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
          9,
        ],
      },
      volumes: { sh510300: FLAT_VOLUME, sh512880: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf('sh512880', 10)], // 9 ≤ 10 × 0.95
      tags,
    });
    const ts = decideWith(ctx);
    expect(ts.targets.map((t) => t.symbol)).toEqual(['sh510300']);
    expect(ts.exitReasons?.['sh512880']).toBe('stop-loss');
  });

  it('止损标的即使仍在候选里，也不允许被「补足」回买', () => {
    // 收盘 11.19 ≤ 成本 12 × 0.95 = 11.4 → 触发止损；
    // 但该票动量/量比/风控都通过（score≈1.7），本来会是候选第一名 ⇒ 必须被剔除
    const risingToDip = [...UP_26.slice(0, 25), 11.19];
    const ctx = makeCtx({
      universe: { fixed: ['sh512880'] },
      closes: { sh512880: risingToDip },
      volumes: { sh512880: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf('sh512880', 12)],
    });
    const ts = decideWith(ctx);
    expect(ts.targets.map((t) => t.symbol)).toEqual([DEFENSIVE]);
    expect(ts.exitReasons?.['sh512880']).toBe('stop-loss');
  });

  it('⑤ 空仓期防御标的吃满可用现金：holdingsNum>1 时目标权重仍是 100%', () => {
    // 场景复用止损用例（唯一候选被止损剔除 → 空仓期）
    const ctx = makeCtx({
      universe: { fixed: ['sh512880'] },
      closes: { sh512880: [...UP_26.slice(0, 25), 11.19] },
      volumes: { sh512880: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf('sh512880', 12)],
    });
    const ts = decideWith(ctx, { holdingsNum: 3 });
    expect(ts.targets.map((t) => t.symbol)).toEqual([DEFENSIVE]);
    expect(ts.targets[0].targetWeight).toBeCloseTo(1, 12);
  });

  it('drop-from-pool：上一日在池、今日不在池', () => {
    const strategy = createWufuRotationStrategy();
    strategy.init?.({ params: {} });

    const day1 = makeCtx({
      asOf: '2024-03-05',
      dayIndex: 0,
      universe: { fixed: ['sh512880', 'sh510300'] },
      closes: { sh512880: UP_26, sh510300: UP_26 },
      volumes: { sh512880: FLAT_VOLUME, sh510300: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf('sh512880', 11)],
    });
    strategy.decide(day1);

    const day2 = makeCtx({
      asOf: '2024-03-06',
      dayIndex: 1,
      universe: { fixed: ['sh510300'] },
      closes: { sh510300: UP_26 },
      volumes: { sh510300: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf('sh512880', 11)],
    });
    const ts = strategy.decide(day2) as TargetSet;
    expect(ts.targets.map((t) => t.symbol)).toEqual(['sh510300']);
    expect(ts.exitReasons?.['sh512880']).toBe('drop-from-pool');
  });

  it('out-of-candidate：仍在池中但分数掉出候选', () => {
    const ctx = makeCtx({
      universe: { fixed: ['sh510300', 'sh512880'] },
      // sh510300 涨得快（第一），sh512880 只涨 0.05%/日（score≈0.13）→ 远低于 0.9 系数
      closes: {
        sh510300: UP_26,
        sh512880: UP_26.map((v) => 1 + (v - 10) / 80),
      },
      volumes: { sh510300: FLAT_VOLUME, sh512880: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf('sh512880', 1.01)],
    });
    const ts = decideWith(ctx);
    expect(ts.targets.map((t) => t.symbol)).toEqual(['sh510300']);
    expect(ts.exitReasons?.['sh512880']).toBe('out-of-candidate');
  });

  it('weak-period-exit：走弱期标的被清掉', () => {
    const ctx = makeCtx({
      asOf: '2024-03-07',
      universe: { fixed: ['sh512880'], weak: ['sh512690'] },
      closes: { sh512690: LOSS_26, sh512880: UP_26 },
      volumes: { sh512690: FLAT_VOLUME, sh512880: FLAT_VOLUME },
      indexCloses: fallingIndex(),
      positions: [positionOf('sh512880', 11)],
    });
    const ts = decideWith(ctx);
    expect(ts.targets.map((t) => t.symbol)).toEqual([DEFENSIVE]);
    expect(ts.exitReasons?.['sh512880']).toBe('weak-period-exit');
  });

  it('② 历史零量日剔除：停牌日由更早交易日补足，打分与无停牌序列一致', () => {
    // 27 根原始 bar：首日 volume=0（模拟停牌），过滤后恰好还原 UP_26
    const rawCloses = [UP_26[0], ...UP_26];
    const rawVolumes = [0, ...Array<number>(UP_26.length).fill(1_000_000)];
    const ctx = makeCtx({
      asOf: '2024-03-06',
      universe: { fixed: ['sh512880'] },
      closes: { sh512880: rawCloses },
      volumes: { sh512880: rawVolumes },
      indexCloses: risingIndex(),
    });
    const ts = decideWith(ctx);
    expect(ts.targets.map((t) => t.symbol)).toEqual(['sh512880']);
    expect(ts.targets[0].score).toBeCloseTo(1.718282, 5);
  });

  it('② 扩窗默认关闭：有效点不足即淘汰，与原版一致，并记录淘汰数', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 10 * Math.pow(1.004, i));
    const volumes = Array.from({ length: 200 }, (_, i) => (i < 135 ? 1_000_000 : 0));
    const tags: Record<string, unknown> = {};
    const ctx = makeCtx({
      asOf: '2024-03-06',
      universe: { fixed: ['sh512880'] },
      closes: { sh512880: closes },
      volumes: { sh512880: volumes },
      indexCloses: risingIndex(),
      tags,
    });
    const ts = decideWith(ctx);
    // 默认路径固定取 65 根，里面全零量 ⇒ 有效点 0 < 26，直接淘汰（不向前扩）
    expect(ts.targets.map((t) => t.symbol)).toEqual([DEFENSIVE]);
    expect(tags.lookbackInsufficient).toBe(1);
    expect(tags.lookbackInsufficientTotal).toBe(1);
  });

  it('② 有效点不足时向前扩窗（显式开关）：65 根里全零量，扩到 130 根后凑够 26 个有效点', () => {
    // 200 根日历 bar：前 135 根有量、后 65 根零量（模拟长期停牌）；固定 65 根窗口内有效点 = 0
    const closes = Array.from({ length: 200 }, (_, i) => 10 * Math.pow(1.004, i));
    const volumes = Array.from({ length: 200 }, (_, i) => (i < 135 ? 1_000_000 : 0));
    const tags: Record<string, unknown> = {};
    const ctx = makeCtx({
      asOf: '2024-03-06',
      universe: { fixed: ['sh512880'] },
      closes: { sh512880: closes },
      volumes: { sh512880: volumes },
      indexCloses: risingIndex(),
      tags,
    });
    const ts = decideWith(ctx, { expandLookback: true });
    // 过滤后的有效点为 135 根里的最后 45 根（下标 90..134），动量取其中最后 26 根（109..134）
    const expected = calculateMomentumScore(closes.slice(109, 135), 25);
    expect(expected).not.toBeNull();
    expect(ts.targets.map((t) => t.symbol)).toEqual(['sh512880']);
    expect(ts.targets[0].score).toBeCloseTo(expected!.score, 8);
    // 扩窗后已够用 ⇒ 不记淘汰
    expect(tags.lookbackInsufficient).toBeUndefined();
  });

  it('② 扩窗见底仍不足：数据不足淘汰，空仓期回退防御', () => {
    // 只有 65 根日历 bar，其中仅 20 根有量 → 无论怎么扩都凑不满 26 个有效点
    const closes = Array.from({ length: 65 }, (_, i) => 10 * Math.pow(1.004, i));
    const volumes = Array.from({ length: 65 }, (_, i) => (i < 20 ? 1_000_000 : 0));
    const tags: Record<string, unknown> = {};
    const ctx = makeCtx({
      asOf: '2024-03-06',
      universe: { fixed: ['sh512880'] },
      closes: { sh512880: closes },
      volumes: { sh512880: volumes },
      indexCloses: risingIndex(),
      tags,
    });
    const ts = decideWith(ctx, { expandLookback: true });
    expect(ts.targets.map((t) => t.symbol)).toEqual([DEFENSIVE]);
    expect(tags.lookbackInsufficient).toBe(1);
  });

  it('defensive-fallback：防御 ETF 被换成股票', () => {
    const ctx = makeCtx({
      universe: { fixed: ['sh510300'] },
      closes: {
        sh510300: UP_26,
        [DEFENSIVE]: [
          100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
          100, 100, 100, 100, 100, 100,
        ],
      },
      volumes: { sh510300: FLAT_VOLUME, [DEFENSIVE]: FLAT_VOLUME },
      indexCloses: risingIndex(),
      positions: [positionOf(DEFENSIVE, 100)],
    });
    const ts = decideWith(ctx);
    expect(ts.targets.map((t) => t.symbol)).toEqual(['sh510300']);
    expect(ts.exitReasons?.[DEFENSIVE]).toBe('defensive-fallback');
  });
});

describe('M3 wufu · ② valid_mask 与窗口常量', () => {
  it('剔除 volume=0 / NaN 的 bar，并保留最后 keep 个有效点', () => {
    const closes = [1, 2, 3, 4, 5, 6];
    const volumes = [1, 0, 1, Number.NaN, 1, 1];
    expect(selectValidVolumeWindow(closes, volumes, 3)).toEqual({
      closes: [3, 5, 6],
      volumes: [1, 1, 1],
    });
  });

  it('窗口常量与 v5.2 safe_lookback / lookback 一致（默认 65 / 45）', () => {
    expect(momentumRawWindow(DEFAULT_FILTER_PARAMS)).toBe(65);
    expect(momentumFilteredWindow(DEFAULT_FILTER_PARAMS)).toBe(45);
  });

  it('所需有效点由参数推导：默认 26；lookbackDays=40 → 41', () => {
    expect(momentumRequiredPoints(DEFAULT_FILTER_PARAMS)).toBe(26);
    expect(momentumRequiredPoints({ ...DEFAULT_FILTER_PARAMS, lookbackDays: 40 })).toBe(41);
    expect(momentumRequiredPoints({ ...DEFAULT_FILTER_PARAMS, volumeLookback: 30 })).toBe(31);
  });

  it('扩窗窗口同样由参数推导：lookbackDays=40 → raw 80 / keep 60', () => {
    const p = { ...DEFAULT_FILTER_PARAMS, lookbackDays: 40 };
    expect(momentumRawWindow(p)).toBe(80);
    expect(momentumFilteredWindow(p)).toBe(60);
  });
});

// ─────────────────────────── 引擎集成：先卖后买 + T+1 ───────────────────────────

function weekdays(count: number): string[] {
  const out: string[] = [];
  const d = new Date('2024-01-02T00:00:00Z');
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function barsOf(dates: readonly string[], prices: readonly number[]): Bar[] {
  return dates.map((date, i) => ({
    date,
    open: prices[i],
    high: prices[i],
    low: prices[i],
    close: prices[i],
    preclose: i > 0 ? prices[i - 1] : prices[i],
    volume: 1_000_000,
    amount: prices[i] * 1_000_000,
  }));
}

describe('M3 wufu · 引擎集成（先卖后买 / T+1）', () => {
  const DATES = weekdays(30);
  const A = 'sh510300';
  const B = 'sh512880';

  // A：0.5%/日 上涨，第 27 日跌 4%（触发短期风控）→ 被 B 替换
  const aBase = DATES.map((_d, i) => 10 * Math.exp(0.005 * i));
  const aPrices = aBase.map((v, i) => {
    if (i <= 26) return v;
    return v * 0.96 * (i >= 28 ? 1.02 : 1) * (i >= 29 ? 1.01 : 1);
  });
  // B：0.4%/日 稳定上涨
  const bPrices = DATES.map((_d, i) => 10 * Math.exp(0.004 * i));

  const indexSeries = DATES.map((_d, i) => 4000 * Math.exp(0.001 * i));

  function snapshot(asOf: string): UniverseSnapshot {
    const picks = [A, B].map((symbol) => ({
      symbol,
      name: symbol,
      firstBar: DATES[0],
      lastBar: DATES[DATES.length - 1],
      avgAmount: 1e9,
    }));
    return {
      requestedAsOf: asOf,
      asOf,
      liquidityDates: [asOf],
      liquidity: {
        dates: [asOf],
        totalByDate: [1e9],
        avgTotal: 1e9,
        threshold: 10_000_000,
        fallback: false,
      },
      marketSymbolCount: 2,
      universeCount: 2,
      marketLiquidityPassCount: 2,
      fixedPoolSize: 2,
      fixedTradableCount: 2,
      fixedCoverageCount: 2,
      fixed: picks,
      weak: [],
      dynamic: { groups: [], pool: [], excludedCount: 0, skippedCount: 0, specialCount: 0, normalCount: 0 },
    };
  }

  const aBars = barsOf(DATES, aPrices);
  const bBars = barsOf(DATES, bPrices);
  const indexBars = new Map(WEAK_PERIOD_INDEX_CODES.map((code) => [code, barsOf(DATES, indexSeries)]));
  const data: BacktestData = {
    calendar: new TradingCalendar(DATES),
    signalBars: new Map([
      [A, aBars],
      [B, bBars],
    ]),
    execBars: new Map([
      [A, aBars],
      [B, bBars],
    ]),
    benchmarkBars: aBars,
    indexBars,
    universe: (asOf) => snapshot(asOf),
  };

  it('5 个决策日内发生换仓：同一天先卖后买，T+1 不被破坏', () => {
    const res = runBacktest(data, {
      strategy: createWufuRotationStrategy(),
      start: DATES[26],
      end: DATES[29],
      initialCash: 100_000,
      benchmarkSymbol: A,
    });

    const sells = res.trades.filter((t) => t.side === 'sell');
    const buys = res.trades.filter((t) => t.side === 'buy');
    expect(buys.length).toBeGreaterThan(0);
    expect(sells.length).toBeGreaterThan(0);

    // ① 先卖后买：同一交易日里所有卖单排在所有买单之前
    const byDate = new Map<string, typeof res.trades>();
    for (const t of res.trades) {
      const list = byDate.get(t.date) ?? [];
      byDate.set(t.date, [...list, t]);
    }
    let replaceDays = 0;
    for (const fills of byDate.values()) {
      const lastSell = fills.map((f) => f.side).lastIndexOf('sell');
      const firstBuy = fills.map((f) => f.side).indexOf('buy');
      if (lastSell >= 0 && firstBuy >= 0) {
        replaceDays++;
        expect(lastSell).toBeLessThan(firstBuy);
      }
    }
    expect(replaceDays).toBeGreaterThan(0);

    // ② T+1：同一标的不会当日买当日卖；回合的平仓日一定晚于开仓日
    const firstBuyDate = new Map<string, string>();
    for (const t of buys) if (!firstBuyDate.has(t.symbol)) firstBuyDate.set(t.symbol, t.date);
    for (const s of sells) expect(firstBuyDate.get(s.symbol)).not.toBe(s.date);
    expect(res.roundTrips.length).toBeGreaterThan(0);
    for (const rt of res.roundTrips) expect(rt.closeDate > rt.openDate).toBe(true);
    expect(res.skipped.every((s) => s.reason !== 't-plus-1')).toBe(true);

    // ③ 换仓归因：A 因短期风控掉出候选
    const replaced = res.decisions.find((d) => d.targets?.exitReasons?.[A] === 'out-of-candidate');
    expect(replaced).toBeDefined();

    // ④ 正常期标签
    for (const d of res.decisions) {
      expect(d.tags.regime).toBe('normal');
      expect(d.tags.weakDays).toBe(0);
    }
  });
});
