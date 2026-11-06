/**
 * 过滤链 —— 照抄 `五福轮动ETF_v5.2.py` L714-L760（逐票指标）+ L864-L876（`apply_filters`）
 *
 * 顺序（与 v5.2 的 `apply_filters` 语义等价，都是纯与运算）：
 * 1. 停牌 → 跳过（L899-L903 `current_data[etf].paused`）
 * 2. 数据不足 / 动量为 null → 跳过（L717-L721）
 * 3. `minScore ≤ score ≤ maxScore`（L722）
 * 4. 近 4 个收盘任一 `p[i]/p[i-1] ≤ lossThreshold` → 淘汰（L725-L733，对应「近 3 日单日跌幅 >3%」）
 * 5. 量比 `null` 或 `≥ volumeRatioThreshold` → 淘汰（L757：`passed_volume = ratio is not None and ratio < threshold`）
 * 6. 正常期 `r2 > r2Threshold`（L735，`enable_r2_filter and not is_weak`）
 * 7. 走弱期 `close > MA(maLookback) * maThreshold`（L737-L743，`enable_ma_filter and is_weak`）
 *
 * 与 v5.2 字面不同的两处（已登记在 M3 报告）：
 * - 短期风控用 `<=` 淘汰（v5.2 是 `min(day_ratios) < g.loss`），即「恰好 -3.00%」也算触发；
 * - 历史序列**不做**零量日剔除（v5.2 用 `valid_mask` 过滤历史零量 bar；日线档只有 `asOf` 的停牌判定）。
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
  /** 截止 asOf 的收盘（长度 ≥ lookbackDays + 1） */
  closes: readonly number[];
  /** 截止 asOf 的成交量（长度 ≥ volumeLookback + 1） */
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
      if (ratio <= params.lossThreshold) {
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
