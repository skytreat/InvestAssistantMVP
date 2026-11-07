/**
 * M4 寻优执行器 —— 串行、逐组落库、内存看门狗
 *
 * 设计要点：
 * 1. **行情只装载一次**（`loadSweepData`），所有试次共享只读 `BacktestData`；
 * 2. **一次连续回测 = 四个评估段**（折1 训练/测试、折2 训练/测试），不重跑；
 * 3. **逐组落库**：每组跑完立刻 `writeRun` + `writeTrial`，内存里不攒结果；
 * 4. **并发度 1**：不并行、不开 worker（16 GB 机器上并行会挤爆）；
 * 5. **内存看门狗**：每组后读 RSS，> `--max-heap-mb`（默认 2500）立即停机并保留已落库结果。
 *
 * 选参只看训练段（`objective.evaluateTrial`），测试段只用于报告 —— 见 `split.ts` 的隔离断言。
 */
import type { BacktestResult } from '../engine.js';
import { runBacktest } from '../engine.js';
import { createWufuRotationStrategy } from '../strategies/wufuRotation/index.js';
import type { BacktestStore } from '../store/backtestDb.js';
import {
  WALK_FORWARD_FOLDS,
  assertFoldsIsolated,
  foldMetrics,
  yearlyMetrics,
  SWEEP_START,
  SWEEP_END,
  type FoldMetrics,
} from './split.js';
import {
  compactFullMetrics,
  compactYearly,
  evaluateTrial,
  type BaselineDrawdown,
  type TrialEvaluation,
  type TrialMetricsPayload,
} from './objective.js';
import {
  baselineParams,
  sampleTrials,
  fineTrials,
  stabilityTrials,
  totalCombinations,
  SEARCH_GRID,
  type TrialSpec,
} from './searchSpace.js';
import { loadSweepData, type SweepDataBundle } from './marketData.js';
import { WUFU_ROTATION_DEFAULTS } from '../strategies/wufuRotation/index.js';
import { momentumRawWindow } from '../strategies/wufuRotation/filters.js';
import { buildStabilitySurface, summarizeSweep, type SweepSummary, type StabilityCell } from './aggregate.js';

export interface SweepOptions {
  sweepId: string;
  /** 确定性种子（只影响参数抽样，不影响行情/引擎） */
  seed: number;
  /** pilot = baseline + 少量粗搜；coarse = baseline + 粗搜；full = 全流程 */
  mode: 'pilot' | 'coarse' | 'full';
  coarseCount: number;
  fineCount: number;
  /** 粗搜入 Top-K 的比例（默认 10%，最少 5 个） */
  topRatio?: number;
  initialCash?: number;
  maxMinutes?: number;
  maxHeapMb?: number;
  dbPath?: string;
  reportPath?: string;
  log?: (message: string) => void;
}

export interface TrialOutcome {
  trialId: string;
  phase: TrialSpec['phase'];
  seed: number;
  params: Record<string, number>;
  runId: string;
  evaluation: TrialEvaluation;
  metrics: TrialMetricsPayload;
  folds: FoldMetrics[];
}

export interface SweepResult {
  sweepId: string;
  baseline: TrialOutcome;
  trials: TrialOutcome[];
  stability: StabilityCell[];
  summary: SweepSummary;
  stoppedReason: null | 'max-minutes' | 'max-heap';
  heapPeakMb: number;
  elapsedSeconds: number;
}

function heapMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function skippedByReason(result: BacktestResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of result.skipped) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}

/**
 * 跑一次试次并落库。
 *
 * `run_id` 规则：`<sweepId>-<trialId>` —— 确定性，重跑同 sweep 覆盖旧行（`replaceExisting`），
 * 避免同一 sweep 反复执行堆出重复 run。
 */
async function runTrial(
  bundle: SweepDataBundle,
  store: BacktestStore,
  options: SweepOptions,
  spec: TrialSpec,
  baselines: readonly BaselineDrawdown[],
): Promise<TrialOutcome> {
  const initialCash = options.initialCash ?? 100000;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const strategy = createWufuRotationStrategy();
  const result = runBacktest(bundle.data, {
    strategy,
    params: spec.params,
    start: SWEEP_START,
    end: SWEEP_END,
    initialCash,
    universeMode: 'dynamic',
    priceMode: 'open',
    // 池子口径归 universe 层：只作审计元数据落 bt_run，不进策略 params
    universeParams: { divisor: bundle.divisor, topN: bundle.topN },
  });

  const folds = WALK_FORWARD_FOLDS.map((f) => foldMetrics(result, f, initialCash));
  const evaluation = evaluateTrial(folds, baselines, result.metrics.averageExposure);
  const yearly = yearlyMetrics(result, initialCash);

  const elapsedSeconds = (Date.now() - t0) / 1000;
  const metrics: TrialMetricsPayload = {
    selectionScore: evaluation.selectionScore,
    oosMeanCagr: evaluation.oosMeanCagr,
    oosMeanSharpe: evaluation.oosMeanSharpe,
    oosMeanCalmar: evaluation.oosMeanCalmar,
    oosRoundTrips: evaluation.oosRoundTrips,
    eligible: evaluation.eligible,
    violations: evaluation.violations,
    folds: evaluation.folds,
    full: compactFullMetrics(result.metrics),
    yearly: compactYearly(yearly),
    skipped: skippedByReason(result),
    heapUsedMb: heapMb(),
    elapsedSeconds,
  };

  const runId = `${options.sweepId}-${spec.trialId}`;
  store.writeRun(result, { runId, startedAt, replaceExisting: true });
  store.writeTrial({
    sweepId: options.sweepId,
    trialId: spec.trialId,
    phase: spec.phase,
    seed: spec.seed,
    params: spec.params,
    runId,
    score: evaluation.selectionScore,
    metrics: metrics as unknown as Record<string, unknown>,
    status: 'ok',
  });

  return {
    trialId: spec.trialId,
    phase: spec.phase,
    seed: spec.seed,
    params: spec.params,
    runId,
    evaluation,
    metrics,
    folds,
  };
}

/** 从已完成的试次里取训练段 Top-K（只在**合格**试次里取；不合格的没有排序依据） */
function topK(trials: readonly TrialOutcome[], k: number): TrialOutcome[] {
  return trials
    .filter((t) => t.evaluation.eligible && t.evaluation.selectionScore !== null)
    .sort((a, b) => (b.evaluation.selectionScore ?? -Infinity) - (a.evaluation.selectionScore ?? -Infinity))
    .slice(0, k);
}

/**
 * 网格里三个窗口参数的最大取值 ⇒ 面板必须预热的最大窗口。
 *
 * `lookbackDays=40` 要 41 个有效点；若仍按默认参数预热（65 根），起点附近会成片「数据不足」，
 * 所以 sweep 的装载窗口必须按网格上界推导，而不是策略默认值。
 */
function gridMaxWarmupDays(): number {
  const maxOf = (key: string): number => {
    const spec = SEARCH_GRID.find((p) => p.key === key);
    const fallback = (WUFU_ROTATION_DEFAULTS as unknown as Record<string, number>)[key];
    return spec ? Math.max(...spec.values) : fallback;
  };
  return momentumRawWindow({
    ...WUFU_ROTATION_DEFAULTS,
    lookbackDays: maxOf('lookbackDays'),
    volumeLookback: maxOf('volumeLookback'),
    maLookback: maxOf('maLookback'),
  });
}

/** 执行完整 sweep（baseline → coarse → fine → stability） */
export async function runSweep(options: SweepOptions, store: BacktestStore): Promise<SweepResult> {
  assertFoldsIsolated();
  const log = options.log ?? ((m: string) => console.log(m));
  const startedAt = Date.now();
  const maxHeapMb = options.maxHeapMb ?? 2500;

  log(
    `sweep=${options.sweepId} seed=${options.seed} mode=${options.mode} ` +
      `coarse=${options.coarseCount} fine=${options.fineCount} 全网格=${totalCombinations()}`,
  );

  const bundle = await loadSweepData({
    start: SWEEP_START,
    end: SWEEP_END,
    warmupDays: gridMaxWarmupDays(),
  });
  log(
    `行情基座：面板 ${bundle.panelSymbols} 只 / ${bundle.panelBars} 根 bar（装载起点 ${bundle.loadStart}，warmup=${bundle.warmup}）`,
  );

  // 基线：默认参数；它的训练段回撤是硬约束的参照基准
  const baselineSpec: TrialSpec = {
    trialId: 'baseline',
    phase: 'baseline',
    seed: 0,
    params: baselineParams(),
  };
  const baseline = await runTrial(bundle, store, options, baselineSpec, []);
  const baselines: BaselineDrawdown[] = baseline.folds.map((f) => ({
    foldId: f.foldId,
    trainMaxDrawdownRatio: f.train.maxDrawdownRatio,
  }));
  // 基线试次用"自身基线"重算一次评估（首次评估传空 baselines 仅取指标，不参与排序）
  const baselineReevaluated: TrialOutcome = {
    ...baseline,
    evaluation: evaluateTrial(baseline.folds, baselines, baseline.metrics.full.averageExposure),
  };
  log(
    `基线：训练CAGR均值=${fmtPct(baselineReevaluated.evaluation.selectionScore)} ` +
      `样本外CAGR均值=${fmtPct(baselineReevaluated.evaluation.oosMeanCagr)} ` +
      `全区间CAGR=${fmtPct(baseline.metrics.full.cagr)}`,
  );

  const trials: TrialOutcome[] = [baselineReevaluated];
  let heapPeakMb = baseline.metrics.heapUsedMb;
  let stoppedReason: SweepResult['stoppedReason'] = null;

  const checkStop = (): boolean => {
    if (options.maxMinutes !== undefined && (Date.now() - startedAt) / 60000 >= options.maxMinutes) {
      stoppedReason = 'max-minutes';
      return true;
    }
    if (heapMb() > maxHeapMb) {
      stoppedReason = 'max-heap';
      return true;
    }
    return false;
  };

  const phaseRunner = async (specs: readonly TrialSpec[], label: string): Promise<TrialOutcome[]> => {
    const done: TrialOutcome[] = [];
    for (let i = 0; i < specs.length; i++) {
      // 每 5 组强制一次 GC：引擎每组的净值/成交数组体量不小，默认堆增长会把 RSS 推到红线
      // （实测无 GC 时约 +1 MB/组，75 组就从 1975 MB 爬到 2501 MB）
      const gc = (globalThis as { gc?: () => void }).gc;
      if (gc && i % 5 === 0) gc();
      if (checkStop()) {
        log(`⛔ ${label} 提前停止（${stoppedReason}，已完成 ${i}/${specs.length}）`);
        break;
      }
      const outcome = await runTrial(bundle, store, options, specs[i], baselines);
      trials.push(outcome);
      done.push(outcome);
      heapPeakMb = Math.max(heapPeakMb, outcome.metrics.heapUsedMb);
      log(
        `[${label} ${i + 1}/${specs.length}] ${outcome.trialId} ` +
          `trainCAGR=${fmtPct(outcome.evaluation.selectionScore)} ` +
          `oosCAGR=${fmtPct(outcome.evaluation.oosMeanCagr)} ` +
          `${outcome.evaluation.eligible ? 'OK' : 'INELIGIBLE'} ` +
          `${outcome.metrics.elapsedSeconds.toFixed(1)}s rss=${outcome.metrics.heapUsedMb}MB`,
      );
    }
    return done;
  };

  const coarseSpecs =
    options.mode === 'pilot'
      ? sampleTrials(options.seed, options.coarseCount, 'coarse', 0, 'pilot')
      : sampleTrials(options.seed, options.coarseCount, 'coarse', 0, 'c');
  await phaseRunner(coarseSpecs, options.mode === 'pilot' ? 'pilot' : 'coarse');

  if (options.mode === 'full' && stoppedReason === null) {
    const ratio = options.topRatio ?? 0.1;
    const coarseTop = topK(
      trials.filter((t) => t.phase === 'coarse'),
      Math.max(5, Math.floor(coarseSpecs.length * ratio)),
    );
    // 把基线本身也作为细搜中心：默认参数来自 M2/M3 的既有标定，若"默认附近"都不能改进，
    // 说明寻优确实没有增量（这比只在粗搜垃圾堆里细化更有说服力）
    const centers = [...coarseTop, baselineReevaluated].filter(
      (c, i, arr) => arr.findIndex((x) => x.trialId === c.trialId) === i,
    );
    const perCenter = Math.max(1, Math.floor(options.fineCount / Math.max(1, centers.length)));
    const specs = fineTrials(
      centers.map((c) => c.params),
      options.seed,
      perCenter,
      coarseSpecs.length,
    );
    log(`细搜：${centers.length} 个中心 × ${perCenter} 组 = ${specs.length} 组`);
    await phaseRunner(specs, 'fine');
  }

  // 稳定性邻域：围绕训练段最优（coarse+fine+baseline）的核心参数 ±1 档
  let stability: StabilityCell[] = [];
  if (stoppedReason === null) {
    const best = topK(
      trials.filter((t) => t.phase !== 'stability'),
      1,
    )[0];
    if (best) {
      const specs = stabilityTrials(best.params, options.seed);
      log(`稳定性：围绕 ${best.trialId} 扫描 ${specs.length} 个邻居（评估在测试段）`);
      const outcomes = await phaseRunner(specs, 'stability');
      stability = buildStabilitySurface(best, outcomes);
    }
  }

  // 稳定性邻居只用于曲面诊断，不参与"训练段最优"排名（否则会把邻域探针误当候选）
  const summary = summarizeSweep(
    trials.filter((t) => t.phase !== 'stability'),
    baselineReevaluated,
  );
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  if (options.reportPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(
      options.reportPath,
      JSON.stringify(
        {
          sweepId: options.sweepId,
          seed: options.seed,
          mode: options.mode,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          elapsedSeconds,
          heapPeakMb,
          stoppedReason,
          baseline: baselineReevaluated,
          trials,
          stability,
          summary,
        },
        null,
        2,
      ),
    );
    log(`报告已写入 ${options.reportPath}`);
  }

  return {
    sweepId: options.sweepId,
    baseline: baselineReevaluated,
    trials,
    stability,
    summary,
    stoppedReason,
    heapPeakMb,
    elapsedSeconds,
  };
}

function fmtPct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(2)}%`;
}
