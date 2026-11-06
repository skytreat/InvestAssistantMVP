/**
 * 候选池与最终目标 —— 照抄 `五福轮动ETF_v5.2.py` L974-L1060（`get_final_ranked_etfs` 第三/四步）
 *
 * 1. 过滤后按 score 降序取前 10（L952-L954）
 * 2. 阈值参考分 = `top10[holdingsNum-1].score`；系数 = 走弱期 1.0 / 正常期 `scoreThresholdRatio(0.9)`
 *    → `candidate = score >= 参考分 × 系数`（L983-L989）
 * 3. 持仓保留优先：`当前持仓 ∩ candidate`，不足 holdingsNum 时按 candidate 顺序补足（L1000-L1013）
 * 4. 候选为空 → 防御 ETF（L1042-L1048，`check_defensive_etf_available` 由调用方判定）
 *
 * 顺序细节：v5.2 在「保留数 ≥ holdingsNum」时按 score 降序取前 N，否则保留原持仓顺序再补足；
 * 这里**始终**按 score 降序（决定论更强，N=1 时与 v5.2 完全一致；N>1 只影响下单先后）。
 */
import type { CandidateMetrics } from './filters.js';

/** v5.2 L954：只取前 10 名参与阈值计算 */
export const CANDIDATE_TOP_ROWS = 10;

export interface CandidatePoolOptions {
  holdingsNum: number;
  scoreThresholdRatio: number;
  weak: boolean;
}

/**
 * 由 top10 + 参考分系数得出候选池（已按 score 降序）。
 *
 * `top10` 不足 holdingsNum 时，v5.2 把全部 top10 当候选（L990-L993）。
 */
export function buildCandidatePool(
  top10: readonly CandidateMetrics[],
  options: CandidatePoolOptions,
): CandidateMetrics[] {
  const { holdingsNum, scoreThresholdRatio, weak } = options;
  if (top10.length < holdingsNum) return [...top10];

  const reference = top10[holdingsNum - 1].score;
  const ratio = weak ? 1.0 : scoreThresholdRatio;
  const threshold = reference * ratio;
  return top10.filter((m) => m.score >= threshold);
}

export interface SelectTargetsInput {
  /** 候选池（按 score 降序） */
  candidates: readonly CandidateMetrics[];
  /** 当前持仓 symbol（顺序 = 账户持仓顺序） */
  holdings: readonly string[];
  /** 收盘价已跌破成本止损线的持仓（当日不进 targets） */
  stopLossSymbols: ReadonlySet<string>;
  holdingsNum: number;
  defensiveSymbol: string;
  /** 防御 ETF 当日是否停牌 */
  defensivePaused: boolean;
}

export interface TargetSelection {
  /** 最终目标（保留优先 → 候选顺序补足）；走空时为空 */
  picks: readonly CandidateMetrics[];
  /** `picks` 中属于「原持仓保留」的 symbol 集合 */
  retained: ReadonlySet<string>;
  /** true = 走空，目标为防御 ETF */
  defensive: boolean;
}

export function selectTargets(input: SelectTargetsInput): TargetSelection {
  const { candidates, holdings, stopLossSymbols, holdingsNum, defensiveSymbol, defensivePaused } = input;

  const candidateBySymbol = new Map(candidates.map((m) => [m.symbol, m]));
  const retainedMetrics = holdings
    .filter((symbol) => !stopLossSymbols.has(symbol) && candidateBySymbol.has(symbol))
    .map((symbol) => candidateBySymbol.get(symbol) as CandidateMetrics)
    .sort((a, b) => b.score - a.score);

  let picks: CandidateMetrics[];
  if (retainedMetrics.length >= holdingsNum) {
    picks = retainedMetrics.slice(0, holdingsNum);
  } else {
    const retainedSymbols = new Set(retainedMetrics.map((m) => m.symbol));
    const additional = candidates
      .filter((m) => !retainedSymbols.has(m.symbol))
      .slice(0, holdingsNum - retainedMetrics.length);
    picks = [...retainedMetrics, ...additional];
  }

  const retained = new Set(retainedMetrics.map((m) => m.symbol));

  if (picks.length === 0 && !defensivePaused && defensiveSymbol.length > 0) {
    return { picks: [], retained, defensive: true };
  }
  return { picks, retained, defensive: false };
}
