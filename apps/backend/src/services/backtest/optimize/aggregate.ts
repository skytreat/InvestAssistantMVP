/**
 * M4 结果聚合 —— 样本外主指标、稳定性曲面、分年度一致性、过拟合披露
 *
 * 🔴 报告口径（用户红线）：
 * 1. **主指标是样本外**（两折测试段均值），样本内最优只作参照；
 * 2. 稳定性：核心参数 ±1 档的样本外表现，邻域中位数 ≥ 中心 70% 且两侧跌幅 <30% 才算
 *    `robust`，否则标 `unusable`（"该参数不可用"，不报漂亮单点）；
 * 3. **多重检验披露**：N 个试次里取最大 OOS 本身就是有偏的（best-of-N），
 *    报告必须同时给出中位数与最优-中位差，禁止只报最优。
 */
import type { TrialOutcome } from './runner.js';
import type { TrialMetricsPayload } from './objective.js';

export interface StabilityCell {
  param: string;
  centerValue: number;
  /** 中心值的样本外 CAGR */
  centerOosCagr: number | null;
  /** 邻居（升序） */
  neighbors: { value: number; oosCagr: number | null; trialId: string }[];
  /** 邻域中位数 */
  neighborMedian: number | null;
  /** 下侧最小（低于中心的那一档）跌幅 */
  lowerDropPct: number | null;
  /** 上侧最小跌幅 */
  upperDropPct: number | null;
  verdict: 'robust' | 'unusable' | 'insufficient';
}

function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 稳定性曲面：对每个核心参数，把中心值与 ±1 档邻居的**样本外 CAGR**排成一条曲线。
 *
 * 判定（批准方案）：
 * - `neighborMedian >= center * 0.7`
 * - 下侧/上侧跌幅都 < 30%（没有"紧挨悬崖"）
 * - 足够邻居（≥1）且中心值有限
 */
export function buildStabilitySurface(
  center: TrialOutcome,
  neighbors: readonly TrialOutcome[],
): StabilityCell[] {
  const centerOos = center.evaluation.oosMeanCagr;
  const byParam = new Map<string, { value: number; oosCagr: number | null; trialId: string }[]>();

  for (const n of neighbors) {
    const changedKeys = Object.keys(n.params).filter(
      (k) => Math.abs((n.params[k] ?? 0) - (center.params[k] ?? 0)) > 1e-9,
    );
    if (changedKeys.length !== 1) continue; // 只接受"只动一个参数"的邻居
    const key = changedKeys[0];
    const list = byParam.get(key) ?? [];
    list.push({ value: n.params[key], oosCagr: n.evaluation.oosMeanCagr, trialId: n.trialId });
    byParam.set(key, list);
  }

  const cells: StabilityCell[] = [];
  for (const [param, list] of byParam) {
    const sorted = [...list].sort((a, b) => a.value - b.value);
    const centerValue = center.params[param];
    const oosNumbers = sorted
      .map((n) => n.oosCagr)
      .filter((x): x is number => x !== null && Number.isFinite(x));
    const neighborMedian = oosNumbers.length > 0 ? median(oosNumbers) : null;

    const lower = sorted
      .filter((n) => n.value < centerValue)
      .map((n) => n.oosCagr)
      .filter((x): x is number => x !== null);
    const upper = sorted
      .filter((n) => n.value > centerValue)
      .map((n) => n.oosCagr)
      .filter((x): x is number => x !== null);
    const lowerDropPct =
      centerOos !== null && lower.length > 0 ? (centerOos - Math.min(...lower)) / Math.abs(centerOos) : null;
    const upperDropPct =
      centerOos !== null && upper.length > 0 ? (centerOos - Math.min(...upper)) / Math.abs(centerOos) : null;

    let verdict: StabilityCell['verdict'] = 'insufficient';
    if (centerOos !== null && centerOos > 0 && neighborMedian !== null && oosNumbers.length >= 2) {
      const passesMedian = neighborMedian >= centerOos * 0.7;
      const passesSides =
        (lowerDropPct === null || lowerDropPct < 0.3) && (upperDropPct === null || upperDropPct < 0.3);
      verdict = passesMedian && passesSides ? 'robust' : 'unusable';
    }

    cells.push({
      param,
      centerValue,
      centerOosCagr: centerOos,
      neighbors: sorted,
      neighborMedian,
      lowerDropPct,
      upperDropPct,
      verdict,
    });
  }
  return cells.sort((a, b) => a.param.localeCompare(b.param));
}

export interface SweepSummary {
  totalTrials: number;
  eligibleTrials: number;
  /** 训练段最优（选参依据）及其样本外表现 */
  bestBySelection: {
    trialId: string;
    params: Record<string, number>;
    trainMeanCagr: number | null;
    oosMeanCagr: number | null;
    oosMeanSharpe: number | null;
    oosRoundTrips: number;
    foldCagrs: { foldId: string; train: number; test: number }[];
    /** 每一折测试段都跑赢基线？ */
    beatsBaselineEachFold: boolean;
  } | null;
  /** 样本外最优（仅作披露，不作为结论） */
  bestByOos: { trialId: string; oosMeanCagr: number | null; selectionScore: number | null } | null;
  oosDistribution: { min: number; q1: number; median: number; q3: number; max: number };
  /** 最优 - 中位数（多重检验偏差的量级） */
  bestMinusMedian: number;
  topCandidates: {
    trialId: string;
    params: Record<string, number>;
    trainMeanCagr: number | null;
    oosMeanCagr: number | null;
  }[];
  /** 分年度一致性：最优 vs 基线 */
  yearlyConsistency: Record<string, { baseline: number; best: number; delta: number }>;
  disclosure: string[];
}

/** 汇总一个 sweep（所有试次已在内存里，但只留汇总，不重新读库） */
export function summarizeSweep(trials: readonly TrialOutcome[], baseline: TrialOutcome): SweepSummary {
  const oosNumbers = trials
    .map((t) => t.evaluation.oosMeanCagr)
    .filter((x): x is number => x !== null && Number.isFinite(x));

  const eligible = trials.filter((t) => t.evaluation.eligible);
  const bySelection = [...eligible].sort(
    (a, b) => (b.evaluation.selectionScore ?? -Infinity) - (a.evaluation.selectionScore ?? -Infinity),
  )[0];
  const byOos = [...trials]
    .filter((t) => t.evaluation.oosMeanCagr !== null)
    .sort((a, b) => (b.evaluation.oosMeanCagr ?? -Infinity) - (a.evaluation.oosMeanCagr ?? -Infinity))[0];

  const baseOos = baseline.evaluation.oosMeanCagr;
  const beatsBaselineEachFold =
    bySelection !== undefined &&
    bySelection.evaluation.folds.every((f, i) => {
      const b = baseline.evaluation.folds[i];
      return b !== undefined && f.testCagr >= b.testCagr;
    });

  const yearlyConsistency: SweepSummary['yearlyConsistency'] = {};
  if (bySelection) {
    for (const year of ['2023', '2024', '2025']) {
      const base = baseline.metrics.yearly[year]?.cagr ?? 0;
      const best = bySelection.metrics.yearly[year]?.cagr ?? 0;
      yearlyConsistency[year] = { baseline: base, best, delta: best - base };
    }
  }

  const oosMedian = oosNumbers.length > 0 ? median(oosNumbers) : NaN;
  const bestVal = oosNumbers.length > 0 ? Math.max(...oosNumbers) : NaN;

  const disclosure: string[] = [];
  disclosure.push(
    `共 ${trials.length} 个试次（合格 ${eligible.length}）；样本外均值 CAGR 中位数 ${pct(oosMedian)}，最优 ${pct(bestVal)}`,
  );
  if (Number.isFinite(bestVal) && Number.isFinite(oosMedian)) {
    disclosure.push(
      `最优-中位差 ${pct(bestVal - oosMedian)}：best-of-N 选择本身带来向上的选择偏差，不可当作期望收益`,
    );
  }
  disclosure.push(`基线样本外均值 CAGR ${pct(baseOos)}；若"最优"未显著超过基线，则寻优无增量（甚至负增量）`);
  if (
    bySelection &&
    baseline.evaluation.selectionScore !== null &&
    bySelection.evaluation.selectionScore !== null
  ) {
    const gain = bySelection.evaluation.selectionScore - baseline.evaluation.selectionScore;
    disclosure.push(
      `训练段相对基线的提升 ${pct(gain)}；样本外对应差值 ${pct((bySelection.evaluation.oosMeanCagr ?? 0) - (baseOos ?? 0))}` +
        (gain > 0 && (bySelection.evaluation.oosMeanCagr ?? 0) < (baseOos ?? 0)
          ? ' ⇒ **样本内提升未延续到样本外（过拟合嫌疑）**'
          : ''),
    );
  }

  return {
    totalTrials: trials.length,
    eligibleTrials: eligible.length,
    bestBySelection: bySelection
      ? {
          trialId: bySelection.trialId,
          params: bySelection.params,
          trainMeanCagr: bySelection.evaluation.selectionScore,
          oosMeanCagr: bySelection.evaluation.oosMeanCagr,
          oosMeanSharpe: bySelection.evaluation.oosMeanSharpe,
          oosRoundTrips: bySelection.evaluation.oosRoundTrips,
          foldCagrs: bySelection.evaluation.folds.map((f) => ({
            foldId: f.foldId,
            train: f.trainCagr,
            test: f.testCagr,
          })),
          beatsBaselineEachFold,
        }
      : null,
    bestByOos: byOos
      ? {
          trialId: byOos.trialId,
          oosMeanCagr: byOos.evaluation.oosMeanCagr,
          selectionScore: byOos.evaluation.selectionScore,
        }
      : null,
    oosDistribution:
      oosNumbers.length > 0
        ? {
            min: Math.min(...oosNumbers),
            q1: quantile(oosNumbers, 0.25),
            median: oosMedian,
            q3: quantile(oosNumbers, 0.75),
            max: bestVal,
          }
        : { min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN },
    bestMinusMedian: Number.isFinite(bestVal) && Number.isFinite(oosMedian) ? bestVal - oosMedian : NaN,
    topCandidates: [...eligible]
      .sort((a, b) => (b.evaluation.selectionScore ?? -Infinity) - (a.evaluation.selectionScore ?? -Infinity))
      .slice(0, 10)
      .map((t) => ({
        trialId: t.trialId,
        params: t.params,
        trainMeanCagr: t.evaluation.selectionScore,
        oosMeanCagr: t.evaluation.oosMeanCagr,
      })),
    yearlyConsistency,
    disclosure,
  };
}

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(2)}%`;
}

/** 供 CLI 打印用：把 TrialMetricsPayload 里的分年度摘要拍平 */
export function yearlyOf(m: TrialMetricsPayload): Record<string, { cagr: number; maxDD: number }> {
  const out: Record<string, { cagr: number; maxDD: number }> = {};
  for (const [year, v] of Object.entries(m.yearly)) out[year] = { cagr: v.cagr, maxDD: v.maxDrawdownRatio };
  return out;
}
