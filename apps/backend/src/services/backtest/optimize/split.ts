/**
 * M4 样本切分 —— 扩张式 walk-forward（两折）
 *
 * 批准口径（用户 2026-11-07 确认）：
 * - **折 1**：训练 2023-01-01~2023-12-31 → 测试 2024-01-01~2024-12-31
 * - **折 2**：训练 2023-01-01~2024-12-31 → 测试 2025-01-01~2025-12-31
 *
 * 为什么是扩张式而不是滚动固定窗口：只有 3 年样本，固定窗口会把训练集压到 1 年
 * （参数个数 11 对 250 个交易日，维度灾难更严重）；扩张式保证"测试段永远在训练段之后"，
 * 且**训练段不因折而异的前移而丢弃历史**（前移起点到 2020 会改变固定池口径，用户已否决）。
 *
 * 🔴 隔离断言：任何一折都必须满足 `trainEnd < testStart`，且两折测试段互不重叠。
 * 这不是注释，是 `assertFoldsIsolated()` 在启动时硬校验。
 */
import type { BacktestResult } from '../engine.js';
import type { BacktestMetrics, EquityPoint } from '../metrics/metrics.js';
import { computeMetrics } from '../metrics/metrics.js';
import type { RoundTrip } from '../account/portfolio.js';

export interface WalkForwardFold {
  foldId: string;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
}

/** 用户批准的切分；**改这里等于改验收口径**，需同步报告 */
export const WALK_FORWARD_FOLDS: readonly WalkForwardFold[] = [
  {
    foldId: 'fold1',
    trainStart: '2023-01-01',
    trainEnd: '2023-12-31',
    testStart: '2024-01-01',
    testEnd: '2024-12-31',
  },
  {
    foldId: 'fold2',
    trainStart: '2023-01-01',
    trainEnd: '2024-12-31',
    testStart: '2025-01-01',
    testEnd: '2025-12-31',
  },
];

/** 全区间（一次连续回测的区间；切片评估由此派生） */
export const SWEEP_START = '2023-01-01';
export const SWEEP_END = '2025-12-31';

/** 切分合法性硬校验（启动时调用；失败直接抛，不跑到一半才发现泄漏） */
export function assertFoldsIsolated(folds: readonly WalkForwardFold[] = WALK_FORWARD_FOLDS): void {
  if (folds.length === 0) throw new Error('walk-forward 至少需要一折');
  for (const f of folds) {
    if (!(f.trainStart <= f.trainEnd)) {
      throw new Error(`${f.foldId}: trainStart(${f.trainStart}) 必须 ≤ trainEnd(${f.trainEnd})`);
    }
    if (!(f.trainEnd < f.testStart)) {
      throw new Error(
        `${f.foldId}: 训练段与测试段重叠/倒置（trainEnd=${f.trainEnd} 必须 < testStart=${f.testStart}）`,
      );
    }
    if (!(f.testStart <= f.testEnd)) {
      throw new Error(`${f.foldId}: testStart(${f.testStart}) 必须 ≤ testEnd(${f.testEnd})`);
    }
  }
  // 测试段两两不重叠（允许相邻，如 2024 与 2025）
  for (let i = 0; i < folds.length; i++) {
    for (let j = i + 1; j < folds.length; j++) {
      const a = folds[i];
      const b = folds[j];
      if (a.testStart <= b.testEnd && b.testStart <= a.testEnd) {
        throw new Error(
          `测试段重叠：${a.foldId}(${a.testStart}~${a.testEnd}) 与 ${b.foldId}(${b.testStart}~${b.testEnd})`,
        );
      }
    }
  }
}

/** 取窗口内的净值点（闭区间；date 为 YYYY-MM-DD，可直接字符串比较） */
export function sliceEquity(points: readonly EquityPoint[], start: string, end: string): EquityPoint[] {
  return points.filter((p) => p.date >= start && p.date <= end);
}

/** 取窗口内**平仓**的回合（按 closeDate；跨窗口开仓的回合整笔归属平仓窗口） */
export function sliceRoundTrips(roundTrips: readonly RoundTrip[], start: string, end: string): RoundTrip[] {
  return roundTrips.filter((r) => r.closeDate >= start && r.closeDate <= end);
}

/**
 * 窗口指标。
 *
 * `initialEquity` 取"窗口前最后一个净值点"（窗口首日收益因此计入）；窗口从回测起点
 * 开始时退化为 `fallbackInitialCash`。这样各窗口的 CAGR 是**从窗口起点自身**起算的，
 * 不与全区间累计收益混淆。
 */
export function segmentMetrics(
  result: BacktestResult,
  start: string,
  end: string,
  fallbackInitialCash: number,
): BacktestMetrics {
  const points = sliceEquity(result.equity, start, end);
  const prior = result.equity.filter((p) => p.date < start);
  const initialEquity = prior.length > 0 ? prior[prior.length - 1].equity : fallbackInitialCash;
  return computeMetrics(points, sliceRoundTrips(result.roundTrips, start, end), { initialEquity });
}

export interface FoldMetrics {
  foldId: string;
  train: BacktestMetrics;
  test: BacktestMetrics;
}

/** 一折的训练段/测试段指标（同一份连续回测结果上切片，不重跑） */
export function foldMetrics(result: BacktestResult, fold: WalkForwardFold, initialCash: number): FoldMetrics {
  return {
    foldId: fold.foldId,
    train: segmentMetrics(result, fold.trainStart, fold.trainEnd, initialCash),
    test: segmentMetrics(result, fold.testStart, fold.testEnd, initialCash),
  };
}

/** 自然年切片（分年度一致性报告用） */
export function yearlyMetrics(
  result: BacktestResult,
  initialCash: number,
  years: readonly number[] = [2023, 2024, 2025],
): Record<string, BacktestMetrics> {
  const out: Record<string, BacktestMetrics> = {};
  for (const year of years) {
    out[String(year)] = segmentMetrics(result, `${year}-01-01`, `${year}-12-31`, initialCash);
  }
  return out;
}
