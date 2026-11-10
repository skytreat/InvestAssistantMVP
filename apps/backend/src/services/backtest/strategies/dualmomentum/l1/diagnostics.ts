/**
 * DualMomentum L1 诊断工具（§12.2 四个诊断，纯函数、零 IO）。
 *
 * 定位：`docs/audit/dualmomentum-l1-alignment.md` §12.8 第 1 步「诊断 1–4」。
 * 本文件**不改变任何既有语义**——`evaluateL1Filters` 与锁定参数一律不动，
 * 只把「逐层消融 / 槽位拆分 / 相关性与 IC」做成可单测的纯函数，
 * 由驱动脚本 `optimize/dmDiagnose.ts` 注入数据执行。
 *
 * 口径说明：
 * - 逐层消融的「只留 X」= 关闭其余过滤层（停牌/涨停/冷却等**执行层**约束保留）；
 * - 相关性 / IC 用 `v_etf_qfq` 前复权日收益（诊断口径，非对齐口径；
 *   对齐阶段锁定序列仍走 L1 的 raw + hfq_factor 前复权到当日，两条轨不混用）；
 * - 前向 IC 的「未来收益」含 T+1…T+H（共 H 根），与 T 日指标/排序同源、无前视。
 */
import type { L1FilterInput } from './decisions.js';
import type { RejectReason } from './types.js';

export type FilterLayer = 'dailyChange' | 'ma' | 'primary' | 'secondary' | 'benchmark';

/** 消融开关：`null` = 全开（基线语义，逐层顺序与 `evaluateL1Filters` 一致）。 */
export type AblationConfig = Partial<Record<FilterLayer, boolean>> | null;

export interface LayerCounters {
  ma: number;
  primary: number;
  secondary: number;
  benchmark: number;
  dailyChange: number;
  /** 全部层都通过的标的数（排名截断前的通过数） */
  allPass: number;
}

/** 归因原因码：既有 10 种 + 槽位拆分后新增 2 种 */
export type AttributedRejectReason = RejectReason | 'PRIMARY_OUT_OF_RANGE' | 'SECONDARY_OUT_OF_RANGE';

export interface AttributedFilterResult {
  pass: boolean;
  reason: AttributedRejectReason | null;
  primaryInRange: boolean;
  secondaryInRange: boolean;
}

/**
 * 过滤链 + 槽位拆分归因（诊断 2 / 3 共用）。
 *
 * 与 `evaluateL1Filters` 的唯一差异：`reject_reason` 把 `MOMENTUM_OUT_OF_RANGE`
 * 拆成主槽 / 次槽两条（`PRIMARY_OUT_OF_RANGE` / `SECONDARY_OUT_OF_RANGE`），
 * 其余原因码逐字沿用。
 */
export function evaluateL1FiltersAttributed(
  input: L1FilterInput,
  ablation: AblationConfig = null,
): AttributedFilterResult {
  const layers = {
    dailyChange: ablation?.dailyChange !== false,
    ma: ablation?.ma !== false,
    primary: ablation?.primary !== false,
    secondary: ablation?.secondary !== false,
    benchmark: ablation?.benchmark !== false,
  };

  if (!input.inPool)
    return { pass: false, reason: 'POOL_ABSENT', primaryInRange: true, secondaryInRange: true };
  if (!input.hasBar || input.snapshotPrice === null || !(input.snapshotPrice > 0)) {
    return { pass: false, reason: 'SUSPENDED', primaryInRange: true, secondaryInRange: true };
  }
  if (input.cooling) return { pass: false, reason: 'COOLDOWN', primaryInRange: true, secondaryInRange: true };

  const price = input.snapshotPrice;
  const upLimit = input.prevCloseAdj * (1 + input.limitRatio);
  const downLimit = input.prevCloseAdj * (1 - input.limitRatio);
  if (price >= upLimit || price <= downLimit) {
    return { pass: false, reason: 'AT_LIMIT', primaryInRange: true, secondaryInRange: true };
  }

  const dailyChangeOk = (() => {
    const change = input.prevCloseAdj > 0 ? price / input.prevCloseAdj - 1 : Number.NaN;
    const lo = input.dailyChangeMin ?? -0.05;
    const hi = input.dailyChangeMax ?? 0.05;
    const EPSILON = 1e-9; // DAILY_CHANGE_EPSILON（锁定常量；此处复刻其数值，不 import 避免循环依赖）
    return Number.isFinite(change) && change >= lo - EPSILON && change <= hi + EPSILON;
  })();

  const primaryInRange = input.primary >= input.primaryRange[0] && input.primary <= input.primaryRange[1];
  const secondaryInRange =
    input.secondary >= input.secondaryRange[0] && input.secondary <= input.secondaryRange[1];

  if (layers.dailyChange && !dailyChangeOk) {
    return { pass: false, reason: 'DAILY_CHANGE_OUT_OF_RANGE', primaryInRange, secondaryInRange };
  }

  const { ma5, ma10, ma20, ma60 } = input;
  if (layers.ma) {
    if (ma20 === null || ma20 <= 0 || !(price > ma20)) {
      return { pass: false, reason: 'BELOW_MA20', primaryInRange, secondaryInRange };
    }
    if (ma5 === null || ma10 === null || ma60 === null || !(ma5 > ma10 && ma10 > ma20 && ma20 > ma60)) {
      return { pass: false, reason: 'MA_NOT_BULLISH', primaryInRange, secondaryInRange };
    }
  }

  if (layers.primary && !primaryInRange) {
    return {
      pass: false,
      reason: 'PRIMARY_OUT_OF_RANGE',
      primaryInRange,
      secondaryInRange,
    };
  }
  if (layers.secondary && !secondaryInRange) {
    return {
      pass: false,
      reason: 'SECONDARY_OUT_OF_RANGE',
      primaryInRange,
      secondaryInRange,
    };
  }
  if (layers.benchmark && !(input.primary >= input.benchmarkPrimary)) {
    return { pass: false, reason: 'BELOW_BENCHMARK', primaryInRange, secondaryInRange };
  }
  return { pass: true, reason: null, primaryInRange, secondaryInRange };
}

/** §12.2 诊断 2 的五个消融变体（相对基线只动一个开关组合）。 */
export const ABLATION_VARIANTS = [
  {
    key: 'ma-only',
    label: '只留 MA（价格 vs MA20 + 四线多头）',
    config: { dailyChange: false, primary: false, secondary: false, benchmark: false },
  },
  {
    key: 'wsm-only',
    label: '只留主槽动量区间',
    config: { dailyChange: false, ma: false, secondary: false, benchmark: false },
  },
  {
    key: 'rsrs-only',
    label: '只留次槽动量区间',
    config: { dailyChange: false, ma: false, primary: false, benchmark: false },
  },
  { key: 'no-daily-change', label: '去掉日涨跌过滤（其余全开）', config: { dailyChange: false } },
  { key: 'full', label: '全开（基线）', config: null },
] as const;

export type AblationKey = (typeof ABLATION_VARIANTS)[number]['key'];

/** 变体名 → 开关（未知键返回 null = 基线） */
export function ablationByKey(key: AblationKey): AblationConfig {
  const v = ABLATION_VARIANTS.find((x) => x.key === key);
  return v?.config ?? null;
}

/**
 * 逐层淘汰计数（诊断 2 的「哪一层把仓位挡在门外」）。
 *
 * 用「首个淘汰层」口径：按 `evaluateL1Filters` 的短路顺序逐层探，
 * 每个被否决的标的记到**第一个**否决它的层名下（与执行时实际命中的原因码一致）。
 * 全部层都过的标的计入 `allPass`（排名截断前的通过数）。
 */
export function layerEliminationCounts(rows: readonly L1FilterInput[]): LayerCounters {
  const counters: LayerCounters = {
    ma: 0,
    primary: 0,
    secondary: 0,
    benchmark: 0,
    dailyChange: 0,
    allPass: 0,
  };
  for (const row of rows) {
    if (!probeDailyChange(row)) {
      counters.dailyChange++;
      continue;
    }
    if (!probeMa(row)) {
      counters.ma++;
      continue;
    }
    if (!(row.primary >= row.primaryRange[0] && row.primary <= row.primaryRange[1])) {
      counters.primary++;
      continue;
    }
    if (!(row.secondary >= row.secondaryRange[0] && row.secondary <= row.secondaryRange[1])) {
      counters.secondary++;
      continue;
    }
    if (!(row.primary >= row.benchmarkPrimary)) {
      counters.benchmark++;
      continue;
    }
    counters.allPass++;
  }
  return counters;
}

function probeDailyChange(row: L1FilterInput): boolean {
  const change = row.prevCloseAdj > 0 ? (row.snapshotPrice ?? 0) / row.prevCloseAdj - 1 : Number.NaN;
  const lo = row.dailyChangeMin ?? -0.05;
  const hi = row.dailyChangeMax ?? 0.05;
  const EPSILON = 1e-9;
  return Number.isFinite(change) && change >= lo - EPSILON && change <= hi + EPSILON;
}

function probeMa(row: L1FilterInput): boolean {
  const price = row.snapshotPrice ?? 0;
  const { ma5, ma10, ma20, ma60 } = row;
  if (ma20 === null || ma20 <= 0 || !(price > ma20)) return false;
  return ma5 !== null && ma10 !== null && ma60 !== null && ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
}

/** 截面相关性矩阵（Pearson，对称；`values[i][j]` = 第 i、j 列的日收益相关）。 */
export function correlationMatrix(values: number[][]): number[][] {
  const n = values.length;
  const cols: number[][] = Array.from({ length: n }, (_, j) => values.map((row) => row[j]));
  const means = cols.map((col) => col.reduce((a, b) => a + b, 0) / n);
  const devs = cols.map((col, j) => col.map((v) => v - means[j]));
  const mat: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    const s2i = devs[i].reduce((a, b) => a + b * b, 0);
    for (let j = 0; j < n; j++) {
      if (i === j) {
        row.push(1);
        continue;
      }
      const s2j = devs[j].reduce((a, b) => a + b * b, 0);
      const dot = devs[i].reduce((a, b, k) => a + b * devs[j][k], 0);
      const den = Math.sqrt(s2i * s2j);
      row.push(den > 0 ? dot / den : Number.NaN);
    }
    mat.push(row);
  }
  return mat;
}

/** 逐截面秩相关（Spearman；`ties` 用平均秩）。`xs` / `ys` 等长，返回单截面 IC。 */
export function spearmanRankCorrelation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const rank = (values: readonly number[]): number[] => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(n);
    let k = 0;
    while (k < n) {
      let m = k;
      while (m + 1 < n && order[m + 1].v === order[k].v) m++;
      const avg = (k + m) / 2 + 1; // 平均秩（1-based）
      for (let t = k; t <= m; t++) ranks[order[t].i] = avg;
      k = m + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx;
    const b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : Number.NaN;
}

export interface IcStats {
  horizon: number;
  mean: number;
  std: number;
  icir: number;
  positiveRatio: number;
  validSections: number;
}

/**
 * 动量排序 IC（诊断 4）：逐交易日算「主槽动量横截面排序」与「该标的未来 `horizon` 日收益」的秩相关。
 *
 * @param perDayDate 每个截面的日期（升序）
 * @param perDayPrimary 每个截面的横截面主槽动量（与 `symbols` 同序）
 * @param perDayForward 每个截面的横截面未来收益（已按 `horizon` 预先算好；不足期填 null）
 * @param minCount 截面最少有效标的数（不足则该截面不计入）
 */
export function momentumIcSeries(
  perDayPrimary: readonly (readonly number[])[],
  perDayForward: readonly (readonly (number | null)[])[],
  horizon: number,
  minCount = 4,
): IcStats {
  const ics: number[] = [];
  for (let d = 0; d < perDayPrimary.length; d++) {
    const p = perDayPrimary[d];
    const f = perDayForward[d];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < p.length; i++) {
      if (f[i] !== null && Number.isFinite(p[i])) {
        xs.push(p[i]);
        ys.push(f[i] as number);
      }
    }
    if (xs.length < minCount) continue;
    const ic = spearmanRankCorrelation(xs, ys);
    if (Number.isFinite(ic)) ics.push(ic);
  }
  if (ics.length === 0)
    return {
      horizon,
      mean: Number.NaN,
      std: Number.NaN,
      icir: Number.NaN,
      positiveRatio: Number.NaN,
      validSections: 0,
    };
  const mean = ics.reduce((a, b) => a + b, 0) / ics.length;
  const std = Math.sqrt(ics.reduce((a, b) => a + (b - mean) ** 2, 0) / (ics.length - 1));
  return {
    horizon,
    mean,
    std,
    icir: std > 0 ? mean / std : Number.NaN,
    positiveRatio: ics.filter((v) => v > 0).length / ics.length,
    validSections: ics.length,
  };
}
