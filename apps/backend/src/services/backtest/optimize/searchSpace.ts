/**
 * M4 参数搜索空间 —— v5.2 可调参数的离散化 + 确定性随机抽样
 *
 * 依据 `docs/audit/proposal-strategy-backtest-framework.md` §7 / §8.4：
 * - **离散选项型**：每个参数给一组候选值（不做连续区间派生，避免"细粒度=过拟合"）；
 * - **连续型**：以固定步长离散化（如 `stopLossThreshold` 0.80~1.00 step 0.02），
 *   相邻两档即"稳定性邻域"的定义单元。
 *
 * 固定不搜的参数（`minScore/maxScore/defensiveEtf`）来自 M3 的口径锁定：
 * 它们是**保护性边界**，不属于策略择时参数。
 *
 * ⚠️ `divisor` / `topN` **不在策略参数里**（池子归 universe 层，M1 分层），
 * 故也不在此列；sweep 实际生效值由 `loadSweepData` 决定并记入 `bt_run.universe_params_json`。
 *
 * 确定性：`seed` 只由 `--seed`（整数）+ 试次序号决定，与 `sweep_id` 无关
 * ⇒ 同一个 `--seed` 重跑任何 sweep 都会得到**逐位一致**的参数序列。
 */
import { WUFU_ROTATION_DEFAULTS } from '../strategies/wufuRotation/index.js';

/** 参数取值粒度 */
export type GridKind = 'integer' | 'continuous';

export interface ParamSpec {
  key: string;
  kind: GridKind;
  /** 候选值（升序、去重） */
  values: readonly number[];
  /** 该参数是否参与「稳定性邻域」扫描（核心参数） */
  core: boolean;
}

/** 固定参数（不参与搜索；锁 M3 口径） */
export const FIXED_PARAMS = {
  minScore: 0,
  maxScore: 5,
  defensiveEtf: 'sh511880',
} as const;

function integerRange(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/**
 * 可搜参数网格（批准方案 §2）。
 *
 * ⚠️ 顺序固定：抽样时按此顺序取随机数 ⇒ 改顺序会改变同 seed 的参数序列。
 */
export const SEARCH_GRID: readonly ParamSpec[] = [
  { key: 'holdingsNum', kind: 'integer', values: [1, 2, 3], core: true },
  { key: 'lookbackDays', kind: 'integer', values: [15, 20, 25, 30, 35, 40], core: true },
  { key: 'r2Threshold', kind: 'continuous', values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], core: true },
  { key: 'maLookback', kind: 'integer', values: [5, 10, 15, 20, 25, 30], core: false },
  { key: 'maThreshold', kind: 'continuous', values: [0.97, 0.99, 1.0, 1.01, 1.03, 1.05], core: false },
  {
    key: 'volumeRatioThreshold',
    kind: 'continuous',
    values: [1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0],
    core: true,
  },
  { key: 'volumeLookback', kind: 'integer', values: [3, 5, 10, 15, 20, 30], core: false },
  { key: 'lossThreshold', kind: 'continuous', values: integerRange(0.9, 1.0, 0.01), core: true },
  { key: 'scoreThresholdRatio', kind: 'continuous', values: integerRange(0.5, 1.0, 0.05), core: true },
  { key: 'maxWeakDays', kind: 'integer', values: [5, 10, 15, 20, 30, 40, 60], core: false },
  { key: 'stopLossThreshold', kind: 'continuous', values: integerRange(0.8, 1.0, 0.02), core: false },
];

/** 全网格组合数（维度灾难的量化说明；≈2.03e9，显然不可穷举） */
export function totalCombinations(grid: readonly ParamSpec[] = SEARCH_GRID): number {
  return grid.reduce((acc, p) => acc * p.values.length, 1);
}

/** 32-bit FNV-1a —— 只用于把 `seed:index` 打散成 RNG 初值 */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：极小、确定、跨平台一致（不用 `Math.random`，故 seed 可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TrialSpec {
  trialId: string;
  phase: TrialPhase;
  seed: number;
  params: Record<string, number>;
}

export type TrialPhase = 'baseline' | 'coarse' | 'fine' | 'stability';

/** 由 `--seed` + 试次序号派生种子（**与 sweep_id 无关**，保证跨 sweep 复现） */
export function trialSeed(baseSeed: number, index: number): number {
  return hash32(`${baseSeed}:${index}`);
}

/** 随机抽一组参数（每个参数独立均匀抽一档） */
export function sampleParams(
  rng: () => number,
  grid: readonly ParamSpec[] = SEARCH_GRID,
): Record<string, number> {
  const params: Record<string, number> = {};
  for (const spec of grid) {
    const idx = Math.floor(rng() * spec.values.length);
    params[spec.key] = spec.values[Math.min(idx, spec.values.length - 1)];
  }
  return params;
}

/** 默认参数（基线试次 + 固定参数补齐） */
export function baselineParams(): Record<string, number> {
  const params: Record<string, number> = {};
  for (const spec of SEARCH_GRID) {
    const d = WUFU_ROTATION_DEFAULTS as unknown as Record<string, number>;
    params[spec.key] = d[spec.key];
  }
  return params;
}

/**
 * 粗搜：`count` 组确定性随机抽样。
 *
 * @param baseSeed `--seed`（记录到 `bt_trial.seed`，用于复现）
 * @param count 本阶段试次数
 * @param offset 试次序号偏移（fine 阶段接在 coarse 之后，避免重复 trialId）
 */
export function sampleTrials(
  baseSeed: number,
  count: number,
  phase: TrialPhase,
  offset = 0,
  tag = 's',
): TrialSpec[] {
  const out: TrialSpec[] = [];
  for (let i = 0; i < count; i++) {
    const index = offset + i;
    const seed = trialSeed(baseSeed, index);
    const rng = mulberry32(seed);
    out.push({
      trialId: `${tag}-${String(index).padStart(4, '0')}`,
      phase,
      seed,
      params: sampleParams(rng),
    });
  }
  return out;
}

/** 某参数在网格里的相邻档（±1 档；越界则只取存在的一侧） */
export function neighborValues(spec: ParamSpec, current: number): number[] {
  const idx = spec.values.findIndex((v) => Math.abs(v - current) < 1e-9);
  if (idx < 0) {
    // 当前值不在网格（如基线默认 0.95 在 stopLoss 网格里没有）—— 取最近档的两侧
    const sorted = [...spec.values].sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
    return sorted.slice(0, 2).filter((v) => Math.abs(v - current) > 1e-9);
  }
  const out: number[] = [];
  if (idx > 0) out.push(spec.values[idx - 1]);
  if (idx < spec.values.length - 1) out.push(spec.values[idx + 1]);
  return out;
}

/**
 * 稳定性邻域：核心参数逐个 ±1 档，其余参数保持中心值。
 *
 * @param baseSeed 用于派生邻域试次种子（`st-<param>-<value>` 的 hash）
 */
export function stabilityTrials(
  center: Record<string, number>,
  baseSeed: number,
  paramsFilter: readonly string[] = SEARCH_GRID.filter((p) => p.core).map((p) => p.key),
): TrialSpec[] {
  const out: TrialSpec[] = [];
  for (const spec of SEARCH_GRID) {
    if (!paramsFilter.includes(spec.key)) continue;
    const current = center[spec.key];
    for (const value of neighborValues(spec, current)) {
      const seed = hash32(`${baseSeed}:st:${spec.key}:${value}`);
      out.push({
        trialId: `st-${spec.key}-${String(value).replace(/\./g, 'p')}`,
        phase: 'stability',
        seed,
        params: { ...center, [spec.key]: value },
      });
    }
  }
  return out;
}

/**
 * 细搜：围绕粗搜 Top-K 的邻域重采样。
 *
 * 做法：对每个入围中心，核心参数在中心档 ±1 档内随机挑一档，非核心参数保持中心值。
 * 这样每个试次都是"最优点附近的一步"，比全空间随机更能刻画局部曲面。
 */
export function fineTrials(
  centers: readonly Record<string, number>[],
  baseSeed: number,
  perCenter: number,
  offset: number,
): TrialSpec[] {
  const out: TrialSpec[] = [];
  let seq = 0;
  for (const center of centers) {
    for (let i = 0; i < perCenter; i++) {
      const index = offset + seq;
      const seed = trialSeed(baseSeed, index);
      const rng = mulberry32(seed);
      const params: Record<string, number> = { ...center };
      for (const spec of SEARCH_GRID) {
        if (!spec.core) continue;
        if (rng() < 0.5) continue; // 半数参数保持中心值
        const idx = spec.values.findIndex((v) => Math.abs(v - center[spec.key]) < 1e-9);
        if (idx < 0) continue;
        const shift = rng() < 0.5 ? -1 : 1;
        const next = idx + shift;
        if (next >= 0 && next < spec.values.length) params[spec.key] = spec.values[next];
      }
      out.push({ trialId: `fn-${String(index).padStart(4, '0')}`, phase: 'fine', seed, params });
      seq++;
    }
  }
  return out;
}
