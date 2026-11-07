/**
 * M4 目标函数与选参规则
 *
 * 排序依据（批准方案 §3）：
 * - **选参**（训练段）：`selectionScore = mean(折1.train.CAGR, 折2.train.CAGR)`
 * - **报告**（测试段）：`oosMeanCagr / oosMeanSharpe / oosMeanCalmar` —— 主指标是样本外，
 *   样本内最优只作参照。
 * - 硬约束（不满足即不参与排序，但仍落库）：
 *   1. 任一折训练段 `maxDrawdownRatio ≤ 基线同段 × 1.2`（防止靠放大回撤换收益）
 *   2. 训练段平仓回合 `≥ 30`（样本太少时 CAGR 无统计意义）
 *   3. 全区间平均暴露 `≤ 100%`（口径校验：本引擎不可能超过，留作回归探针）
 *
 * ⚠️ 为什么不用 Sharpe 做主排序：Sharpe 对日收益波动敏感，而本策略暴露率在 60%~99%
 * 之间大幅摆动，Sharpe 会奖励"低暴露躺平"；CAGR 与用户实际关心的资金增长一致。
 * Sharpe / Calmar 作为辅助与稳定性判据保留。
 */
import type { BacktestMetrics } from '../metrics/metrics.js';
import type { FoldMetrics } from './split.js';
import { WALK_FORWARD_FOLDS } from './split.js';

export interface ConstraintConfig {
  /** 训练段最大回撤允许超过基线的倍数 */
  maxDrawdownSlack: number;
  /** 训练段最少平仓回合数 */
  minTrainRoundTrips: number;
  /** 全区间平均暴露上限 */
  maxAverageExposure: number;
}

export const DEFAULT_CONSTRAINTS: ConstraintConfig = {
  maxDrawdownSlack: 1.2,
  minTrainRoundTrips: 30,
  maxAverageExposure: 1.0,
};

export interface BaselineDrawdown {
  foldId: string;
  trainMaxDrawdownRatio: number;
}

export interface TrialEvaluation {
  /** 训练段平均 CAGR（选参唯一依据） */
  selectionScore: number | null;
  /** 样本外平均 CAGR（报告主指标） */
  oosMeanCagr: number | null;
  oosMeanSharpe: number | null;
  oosMeanCalmar: number | null;
  /** 样本外总回合数（两折测试段合计） */
  oosRoundTrips: number;
  eligible: boolean;
  violations: string[];
  folds: {
    foldId: string;
    trainCagr: number;
    testCagr: number;
    trainMaxDrawdownRatio: number;
    testMaxDrawdownRatio: number;
    trainRoundTrips: number;
    testRoundTrips: number;
  }[];
}

function isFiniteNumber(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 评估一组参数（基于同一次 2023-2025 连续回测的切片指标）。
 *
 * @param folds 两折指标（顺序须与 `WALK_FORWARD_FOLDS` 一致）
 * @param baselines 基线同段回撤（来自默认参数那一次回测）
 * @param fullAverageExposure 全区间平均暴露（口径回归探针）
 */
export function evaluateTrial(
  folds: readonly FoldMetrics[],
  baselines: readonly BaselineDrawdown[],
  fullAverageExposure: number,
  constraints: ConstraintConfig = DEFAULT_CONSTRAINTS,
): TrialEvaluation {
  const violations: string[] = [];
  const rows: TrialEvaluation['folds'] = [];

  for (const f of folds) {
    // 基线尚未测量时（基线试次自身）以"本段回撤"为参照 ⇒ ×1.2 恒通过，只作占位
    const base = baselines.find((b) => b.foldId === f.foldId) ?? {
      foldId: f.foldId,
      trainMaxDrawdownRatio: f.train.maxDrawdownRatio,
    };
    if (!isFiniteNumber(f.train.cagr)) violations.push(`${f.foldId}: 训练段 CAGR 非有限值`);
    if (fullAverageExposure > constraints.maxAverageExposure + 1e-9) {
      violations.push(
        `全区间平均暴露 ${(fullAverageExposure * 100).toFixed(2)}% > ${(constraints.maxAverageExposure * 100).toFixed(0)}%`,
      );
    }
    if (f.train.tradingDays > 0 && f.train.closedRoundTrips < constraints.minTrainRoundTrips) {
      violations.push(
        `${f.foldId}: 训练段平仓回合 ${f.train.closedRoundTrips} < ${constraints.minTrainRoundTrips}`,
      );
    }
    const allowed = base.trainMaxDrawdownRatio * constraints.maxDrawdownSlack;
    if (f.train.maxDrawdownRatio > allowed + 1e-9) {
      violations.push(
        `${f.foldId}: 训练段回撤 ${(f.train.maxDrawdownRatio * 100).toFixed(2)}% > 基线 ${(base.trainMaxDrawdownRatio * 100).toFixed(2)}% × ${constraints.maxDrawdownSlack}`,
      );
    }
    rows.push({
      foldId: f.foldId,
      trainCagr: f.train.cagr,
      testCagr: f.test.cagr,
      trainMaxDrawdownRatio: f.train.maxDrawdownRatio,
      testMaxDrawdownRatio: f.test.maxDrawdownRatio,
      trainRoundTrips: f.train.closedRoundTrips,
      testRoundTrips: f.test.closedRoundTrips,
    });
  }

  if (rows.length !== WALK_FORWARD_FOLDS.length) {
    violations.push(`折数 ${rows.length} ≠ ${WALK_FORWARD_FOLDS.length}`);
  }

  const trainCagrs = rows.map((r) => r.trainCagr).filter(isFiniteNumber);
  const testCagrs = rows.map((r) => r.testCagr).filter(isFiniteNumber);
  const selectionScore = trainCagrs.length === rows.length && rows.length > 0 ? mean(trainCagrs) : null;
  const oosMeanCagr = testCagrs.length === rows.length && rows.length > 0 ? mean(testCagrs) : null;
  const oosMeanSharpe =
    folds.length > 0 && folds.every((f) => isFiniteNumber(f.test.sharpeRatio))
      ? mean(folds.map((f) => f.test.sharpeRatio))
      : null;
  const oosMeanCalmar =
    folds.length > 0 && folds.every((f) => isFiniteNumber(f.test.calmarRatio))
      ? mean(folds.map((f) => f.test.calmarRatio))
      : null;
  const oosRoundTrips = rows.reduce((a, r) => a + r.testRoundTrips, 0);

  return {
    selectionScore,
    oosMeanCagr,
    oosMeanSharpe,
    oosMeanCalmar,
    oosRoundTrips,
    eligible: violations.length === 0 && selectionScore !== null,
    violations,
    folds: rows,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 落库用的紧凑指标（bt_trial.metrics_json） */
export interface TrialMetricsPayload {
  selectionScore: number | null;
  oosMeanCagr: number | null;
  oosMeanSharpe: number | null;
  oosMeanCalmar: number | null;
  oosRoundTrips: number;
  eligible: boolean;
  violations: string[];
  folds: TrialEvaluation['folds'];
  full: {
    cagr: number;
    sharpeRatio: number;
    calmarRatio: number;
    maxDrawdownRatio: number;
    averageExposure: number;
    closedRoundTrips: number;
    finalEquity: number;
  };
  yearly: Record<string, { cagr: number; cumulativeReturn: number; maxDrawdownRatio: number }>;
  skipped: Record<string, number>;
  heapUsedMb: number;
  elapsedSeconds: number;
}

export function compactFullMetrics(m: BacktestMetrics): TrialMetricsPayload['full'] {
  return {
    cagr: m.cagr,
    sharpeRatio: m.sharpeRatio,
    calmarRatio: m.calmarRatio,
    maxDrawdownRatio: m.maxDrawdownRatio,
    averageExposure: m.averageExposure,
    closedRoundTrips: m.closedRoundTrips,
    finalEquity: m.finalEquity,
  };
}

export function compactYearly(yearly: Record<string, BacktestMetrics>): TrialMetricsPayload['yearly'] {
  const out: TrialMetricsPayload['yearly'] = {};
  for (const [year, m] of Object.entries(yearly)) {
    out[year] = {
      cagr: m.cagr,
      cumulativeReturn: m.cumulativeReturn,
      maxDrawdownRatio: m.maxDrawdownRatio,
    };
  }
  return out;
}
