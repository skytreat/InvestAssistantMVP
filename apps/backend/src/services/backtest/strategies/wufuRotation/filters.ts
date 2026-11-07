/**
 * 过滤链 —— 照抄 `五福轮动ETF_v5.2.py` L714-L760（逐票指标）+ L864-L876（`apply_filters`）
 *
 * 顺序（与 v5.2 的 `apply_filters` 语义等价，都是纯与运算）：
 * 1. 停牌 → 跳过（L899-L903 `current_data[etf].paused`）
 * 2. 数据不足 / 动量为 null → 跳过（L717-L721）
 * 3. `minScore ≤ score ≤ maxScore`（L722）
 * 4. 近 4 个收盘任一 `p[i]/p[i-1] < lossThreshold` → 淘汰（L725-L733，对应「近 3 日单日跌幅 >3%」）
 * 5. 量比 `null` 或 `≥ volumeRatioThreshold` → 淘汰（L757：`passed_volume = ratio is not None and ratio < threshold`）
 * 6. 正常期 `r2 > r2Threshold`（L735，`enable_r2_filter and not is_weak`）
 * 7. 走弱期 `close > MA(maLookback) * maThreshold`（L737-L743，`enable_ma_filter and is_weak`）
 *
 * 与 v5.2 的对齐状态：
 * - 历史序列按 `valid_mask` 剔除零量日（见 `selectValidVolumeWindow` / `momentumRawWindow`）；
 * - 短期风控边界为 `<`（v5.2 L732 `min(day_ratios) < g.loss`），恰好等于阈值的涨跌幅**保留**。
 * 以上两处均已与 v5.2 一致，不再作为「已知差异」登记。
 */
import { calculateMomentumScore } from './momentum.js';

/** 参与过滤的参数子集（与 `paramSchema` 对齐） */
export interface FilterParams {
  lookbackDays: number;
  minScore: number;
  maxScore: number;
  r2Threshold: number;
  maLookback: number;
  maThreshold: number;
  volumeRatioThreshold: number;
  volumeLookback: number;
  lossThreshold: number;
}

/** 通过过滤后的逐票指标 */
export interface CandidateMetrics {
  symbol: string;
  /** `asOf` 日收盘 */
  close: number;
  score: number;
  annualized: number;
  r2: number;
  /** 量比；`null` = 历史量不足或含 0（v5.2 视为「不拦截」） */
  volumeRatio: number | null;
  /** 截止 asOf 的 maLookback 日均值 */
  maValue: number | null;
}

/** 淘汰原因（仅用于诊断 / 测试断言，不落库） */
export type FilterRejectReason =
  'paused' | 'insufficient-data' | 'score-out-of-range' | 'short-term-loss' | 'volume-ratio' | 'r2' | 'ma';

export interface FilterEvaluation {
  passed: boolean;
  reason?: FilterRejectReason;
  /** 未通过时为 null（与 v5.2 的 `return None` 等价） */
  metrics: CandidateMetrics | null;
}

export function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * v5.2 `safe_lookback`（L890）：为「剔除零量日」预留的**日历 bar 数**。
 *
 * 原版 = `max(lookbackDays, volumeLookback, maLookback) + 20`（留白）`+ 20`（再留白）
 * ⇒ 默认 25/5/10 → **65**。引擎按这个数量预热，才能在停牌日后仍有 45 个有效点。
 */
export function momentumRawWindow(params: FilterParams): number {
  return Math.max(params.lookbackDays, params.volumeLookback, params.maLookback) + 40;
}

/**
 * v5.2 `lookback`（L891）：剔除零量日后**保留**的窗口长度 = `max(...) + 20`（默认 45）。
 */
export function momentumFilteredWindow(params: FilterParams): number {
  return Math.max(params.lookbackDays, params.volumeLookback, params.maLookback) + 20;
}

/**
 * v5.2 `valid_mask = (volume > 0) & (~volume.isna())`（L890-L895）：
 * 把**零成交量日（停牌）**从历史序列中剔除，再保留最后 `keep` 个有效点。
 *
 * 调用前提：`closes` 与 `volumes` 按下标一一对应（同一批 bar）。
 * 返回的 `closes` / `volumes` 仍按时间升序，最后一个是 asOf。
 */
export function selectValidVolumeWindow(
  closes: readonly number[],
  volumes: readonly number[],
  keep: number,
): { closes: number[]; volumes: number[] } {
  const outCloses: number[] = [];
  const outVolumes: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const vol = volumes[i];
    if (!(vol > 0)) continue; // NaN / 0 / 负数（停牌或坏数据）
    outCloses.push(closes[i]);
    outVolumes.push(vol);
  }
  if (keep > 0 && outCloses.length > keep) {
    return { closes: outCloses.slice(-keep), volumes: outVolumes.slice(-keep) };
  }
  return { closes: outCloses, volumes: outVolumes };
}

/** `closes` 末尾 n 个的均值；不足 n 返回 null（v5.2 L739-L743：不足则 `passed_ma=False`） */
export function movingAverageOfLast(closes: readonly number[], n: number): number | null {
  if (closes.length < n || n <= 0) return null;
  return meanOf(closes.slice(-n));
}

/**
 * 量比 —— v5.2 L766-L787 `get_volume_ratio` 的日线等效（B2）
 *
 * - 「今日量」= `asOf` 当日全日成交量（v5.2 的 13:10 分时投影在日线模式下等价于
 *   `elapsed_minutes = 240`，投影系数 = 240/240 = 1）；
 * - 「过去 5 日」= asOf **之前** 5 个交易日，不含 today；
 * - 任一历史量为 0 或数量不足 → null（L773 的 `<= 0 / == 0` 拒绝，异常也返回 None）。
 */
export function volumeRatioFromParts(past: readonly number[], today: number): number | null {
  if (past.length === 0) return null;
  if (past.some((v) => !(v > 0))) return null;
  const avg = meanOf(past);
  if (avg === 0) return null;
  return today / avg;
}

/**
 * 从「过去 `lookback` 日 + today」的合并序列取量比。
 *
 * 调用方传 `ctx.series(symbol, volumeLookback + 1, 'volume')`（6 个），
 * 前 `lookback` 个是历史、最后一个是 asOf 当日；数量不足 6 → null。
 */
export function volumeRatioFromSeries(series: readonly number[], lookback: number): number | null {
  if (series.length < lookback + 1) return null;
  const past = series.slice(series.length - lookback - 1, series.length - 1);
  return volumeRatioFromParts(past, series[series.length - 1]);
}

export interface EvaluateCandidateInput {
  symbol: string;
  /** 已剔除零成交量日的收盘序列（长度 ≥ lookbackDays + 1，末位 = asOf） */
  closes: readonly number[];
  /** 与 `closes` 对齐的成交量序列（同样已剔除零量日） */
  volumes: readonly number[];
  paused: boolean;
  /** 走弱期决定用 R² 还是 MA 过滤 */
  weak: boolean;
  params: FilterParams;
}

/** 逐票过滤（顺序见文件头注释） */
export function evaluateCandidate(input: EvaluateCandidateInput): FilterEvaluation {
  const { symbol, closes, volumes, paused, weak, params } = input;
  if (paused) return { passed: false, reason: 'paused', metrics: null };

  const momentum = calculateMomentumScore(closes, params.lookbackDays);
  if (!momentum) return { passed: false, reason: 'insufficient-data', metrics: null };
  const close = closes[closes.length - 1];

  if (momentum.score < params.minScore || momentum.score > params.maxScore) {
    return { passed: false, reason: 'score-out-of-range', metrics: null };
  }

  // 短期风控：近 3 个涨跌幅（需要 4 个收盘）
  if (closes.length >= 4) {
    for (let i = closes.length - 1; i >= closes.length - 3; i--) {
      const ratio = closes[i] / closes[i - 1];
      if (ratio < params.lossThreshold) {
        return { passed: false, reason: 'short-term-loss', metrics: null };
      }
    }
  }

  const volumeRatio = volumeRatioFromSeries(volumes, params.volumeLookback);
  // 量比为 null 视为「不拦截」；≥ 阈值才淘汰（v5.2 L757）
  if (!(volumeRatio !== null && volumeRatio < params.volumeRatioThreshold)) {
    return { passed: false, reason: 'volume-ratio', metrics: null };
  }

  const maValue = movingAverageOfLast(closes, params.maLookback);
  if (!weak) {
    if (!(momentum.r2 > params.r2Threshold)) {
      return { passed: false, reason: 'r2', metrics: null };
    }
  } else if (maValue === null || !(close > maValue * params.maThreshold)) {
    return { passed: false, reason: 'ma', metrics: null };
  }

  return {
    passed: true,
    metrics: {
      symbol,
      close,
      score: momentum.score,
      annualized: momentum.annualized,
      r2: momentum.r2,
      volumeRatio,
      maValue,
    },
  };
}
