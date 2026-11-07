/**
 * 「五福轮动 ETF v5.2」日线主干（M3 移植）
 *
 * 只移植**日线决策主干**：
 * - 走弱期状态机（`weakPeriod.ts`）
 * - 动量打分 + 过滤链（`momentum.ts` / `filters.ts`）
 * - 候选池 / 持仓保留 / 防御回退（`candidate.ts`）
 *
 * 不重写的部分（已在别处实现）：
 * - 动态池（M1：`ctx.universe.fixed / dynamic / weak`，Python L424-L621）
 * - 成交模拟（M2：`execution/simulator.ts`，含滑点/佣金/涨跌停/停牌/T+1，Python L1144-L1214）
 *
 * 时点：决策发生在 T-1 收盘后（`ctx.asOf`），成交在 T 开盘（`priceMode: 'open'`）。
 *
 * 与 v5.2 字面不同（有意为之，均已登记）：
 * 1. `targetWeight = 1/holdingsNum`。`holdingsNum=1` 与 v5.2「全部可用现金」等价；
 *    `>1` 时 v5.2 按**剩余现金逐笔均分**（L1091-L1099），这里按**总权益等权**，是近似。
 * 2. 止损由「分钟级每 bar 检查 + 立即市价卖」改为「决策时按 `asOf` 收盘判定 + 当日不进 targets」，
 *    实际卖出发生在 T 开盘。
 * 3. 历史序列不剔除零量日（v5.2 用 `valid_mask`）；`asOf` 停牌仍走 `ctx.isPaused`。
 * 4. 短期风控「跌幅 ≥ 3%」用 `<=` 判定（v5.2 是严格 `<`）。
 */
import type { ParamField } from '../../../pluginEngine.js';
import {
  defineStrategy,
  type ExitReason,
  type Strategy,
  type StrategyContext,
  type TargetPosition,
  type TargetSet,
} from '../../strategy/types.js';
import { CANDIDATE_TOP_ROWS, buildCandidatePool, selectTargets } from './candidate.js';
import { evaluateCandidate, type CandidateMetrics, type FilterParams } from './filters.js';
import { evaluateWeakPeriodFromContext, type WeakPeriodState } from './weakPeriod.js';

/**
 * 策略参数（默认值全部来自 v5.2 L158-L195）
 *
 * ⚠️ 不含 `divisor` / `topN`：池子归 **universe 层**（M1 分层），由
 * `loadUniverseProvider` 的入参决定，策略从不读取。它们只作为审计元数据记入
 * `bt_run.universe_params_json`，不是可调参数（避免出现第二个真值源）。
 */
export interface WufuRotationParams extends FilterParams {
  holdingsNum: number;
  scoreThresholdRatio: number;
  maxWeakDays: number;
  stopLossThreshold: number;
  defensiveEtf: string;
}

export const WUFU_ROTATION_DEFAULTS: WufuRotationParams = {
  holdingsNum: 1,
  lookbackDays: 25,
  minScore: 0,
  maxScore: 5,
  r2Threshold: 0.4,
  maLookback: 10,
  maThreshold: 1.0,
  volumeRatioThreshold: 1.8,
  volumeLookback: 5,
  lossThreshold: 0.97,
  scoreThresholdRatio: 0.9,
  maxWeakDays: 20,
  stopLossThreshold: 0.95,
  defensiveEtf: 'sh511880',
};

/** 参数 schema（沿用 `pluginEngine.ParamField`） */
export const WUFU_ROTATION_PARAM_SCHEMA: ParamField[] = [
  {
    key: 'holdingsNum',
    label: '目标持仓数',
    type: 'integer',
    default: WUFU_ROTATION_DEFAULTS.holdingsNum,
    min: 1,
    max: 10,
    step: 1,
    description: 'v5.2 `holdings_num`；1 = 全仓单只',
  },
  {
    key: 'lookbackDays',
    label: '动量周期',
    type: 'integer',
    default: WUFU_ROTATION_DEFAULTS.lookbackDays,
    min: 5,
    max: 120,
    step: 1,
    description: 'v5.2 `lookback_days`；实际取 lookbackDays+1 个收盘（含 asOf）',
  },
  {
    key: 'minScore',
    label: '动量得分下限',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.minScore,
    min: -10,
    max: 10,
    step: 0.1,
    description: 'v5.2 `min_score_threshold`',
  },
  {
    key: 'maxScore',
    label: '动量得分上限',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.maxScore,
    min: -10,
    max: 100,
    step: 0.1,
    description: 'v5.2 `max_score_threshold`',
  },
  {
    key: 'r2Threshold',
    label: 'R² 阈值（正常期）',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.r2Threshold,
    min: 0,
    max: 1,
    step: 0.05,
    description: 'v5.2 `r2_threshold`；正常期要求 r² > 阈值',
  },
  {
    key: 'maLookback',
    label: '均线周期（走弱期）',
    type: 'integer',
    default: WUFU_ROTATION_DEFAULTS.maLookback,
    min: 2,
    max: 60,
    step: 1,
    description: 'v5.2 `ma_lookback`；走弱期要求收盘 > MA(maLookback) × maThreshold',
  },
  {
    key: 'maThreshold',
    label: '均线阈值倍数',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.maThreshold,
    min: 0.5,
    max: 2,
    step: 0.01,
    description: 'v5.2 `ma_threshold`',
  },
  {
    key: 'volumeRatioThreshold',
    label: '量比上限',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.volumeRatioThreshold,
    min: 0.1,
    max: 20,
    step: 0.1,
    description: 'v5.2 `volume_threshold`；量比 ≥ 阈值即淘汰',
  },
  {
    key: 'volumeLookback',
    label: '量比回看日数',
    type: 'integer',
    default: WUFU_ROTATION_DEFAULTS.volumeLookback,
    min: 1,
    max: 60,
    step: 1,
    description: 'v5.2 `volume_lookback`；过去 N 个交易日（不含 asOf）均量',
  },
  {
    key: 'lossThreshold',
    label: '短期风控阈值',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.lossThreshold,
    min: 0.5,
    max: 1,
    step: 0.01,
    description: 'v5.2 `loss`；近 3 日任一 p[i]/p[i-1] ≤ 阈值即淘汰（0.97 = 跌 3%）',
  },
  {
    key: 'scoreThresholdRatio',
    label: '候选分数系数（正常期）',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.scoreThresholdRatio,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'v5.2 `score_threshold_ratio`；走弱期固定 1.0',
  },
  {
    key: 'maxWeakDays',
    label: '走弱期最长天数',
    type: 'integer',
    default: WUFU_ROTATION_DEFAULTS.maxWeakDays,
    min: 1,
    max: 120,
    step: 1,
    description: 'v5.2 `max_weak_days`；达到即强制退出走弱期',
  },
  {
    key: 'stopLossThreshold',
    label: '止损线（成本倍数）',
    type: 'number',
    default: WUFU_ROTATION_DEFAULTS.stopLossThreshold,
    min: 0.5,
    max: 1,
    step: 0.01,
    description: 'v5.2 `fixedStopLossThreshold`；asOf 收盘 ≤ 成本 × 阈值则清仓',
  },
  {
    key: 'defensiveEtf',
    label: '防御 ETF',
    type: 'string',
    default: WUFU_ROTATION_DEFAULTS.defensiveEtf,
    description: 'v5.2 `defensive_etf`；候选为空时持有（停牌则空仓）',
  },
];

/** 跨交易日状态（每个策略实例一份，`init()` 重置） */
interface WufuRotationState extends WeakPeriodState {
  /** 上一次决策用到的池（`drop-from-pool` 归因需要） */
  lastPool: ReadonlySet<string>;
}

function createState(): WufuRotationState {
  return { weak: false, startDayIndex: null, lastPool: new Set() };
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 合并调用方参数与默认值（只做类型收敛，不做范围校验） */
export function resolveWufuRotationParams(raw: Readonly<Record<string, unknown>>): WufuRotationParams {
  const d = WUFU_ROTATION_DEFAULTS;
  return {
    holdingsNum: Math.max(1, Math.trunc(toNumber(raw.holdingsNum, d.holdingsNum))),
    lookbackDays: Math.max(2, Math.trunc(toNumber(raw.lookbackDays, d.lookbackDays))),
    minScore: toNumber(raw.minScore, d.minScore),
    maxScore: toNumber(raw.maxScore, d.maxScore),
    r2Threshold: toNumber(raw.r2Threshold, d.r2Threshold),
    maLookback: Math.max(1, Math.trunc(toNumber(raw.maLookback, d.maLookback))),
    maThreshold: toNumber(raw.maThreshold, d.maThreshold),
    volumeRatioThreshold: toNumber(raw.volumeRatioThreshold, d.volumeRatioThreshold),
    volumeLookback: Math.max(1, Math.trunc(toNumber(raw.volumeLookback, d.volumeLookback))),
    lossThreshold: toNumber(raw.lossThreshold, d.lossThreshold),
    scoreThresholdRatio: toNumber(raw.scoreThresholdRatio, d.scoreThresholdRatio),
    maxWeakDays: Math.max(1, Math.trunc(toNumber(raw.maxWeakDays, d.maxWeakDays))),
    stopLossThreshold: toNumber(raw.stopLossThreshold, d.stopLossThreshold),
    defensiveEtf: String(raw.defensiveEtf ?? d.defensiveEtf),
  };
}

/** 去重且保持顺序 */
function dedupe(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of symbols) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 由池 + 已过滤指标选出最终目标与退出原因 */
function decideWufuRotation(ctx: StrategyContext, state: WufuRotationState): TargetSet {
  const p = resolveWufuRotationParams(ctx.params);

  // ── 1) 走弱期状态机 ──
  const weakSnapshot = evaluateWeakPeriodFromContext(ctx, state, p.maLookback, p.maxWeakDays);
  const weak = weakSnapshot.weak;
  ctx.tag('regime', weak ? 'weak' : 'normal');
  ctx.tag('weakDays', weakSnapshot.weakDays);

  // ── 2) 池：走弱期用 weak 池，正常期用 fixed ∪ dynamic ──
  const pool = weak ? dedupe(ctx.universe.weak) : dedupe([...ctx.universe.fixed, ...ctx.universe.dynamic]);
  const poolSet = new Set(pool);

  // ── 3) 逐票打分 + 过滤（一次批量取序列，避免逐票往返） ──
  const closesBySymbol = ctx.seriesBatch(pool, p.lookbackDays + 1, 'close');
  const volumesBySymbol = ctx.seriesBatch(pool, p.volumeLookback + 1, 'volume');
  const passed: CandidateMetrics[] = [];
  for (const symbol of pool) {
    const evaluation = evaluateCandidate({
      symbol,
      closes: closesBySymbol.get(symbol) ?? [],
      volumes: volumesBySymbol.get(symbol) ?? [],
      paused: ctx.isPaused(symbol),
      weak,
      params: p,
    });
    if (evaluation.passed && evaluation.metrics) passed.push(evaluation.metrics);
  }

  // 降序；同分按代码升序（决定论，v5.2 依赖 Python `sort` 的稳定性）
  passed.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const top10 = passed.slice(0, CANDIDATE_TOP_ROWS);

  // ── 4) 候选池（正常期系数 0.9 / 走弱期 1.0） ──
  const candidates = buildCandidatePool(top10, {
    holdingsNum: p.holdingsNum,
    scoreThresholdRatio: p.scoreThresholdRatio,
    weak,
  });

  // ── 5) 止损：asOf 收盘 ≤ 成本 × 阈值 → 当日不进 targets ──
  const positions = ctx.positions();
  const stopLossSymbols = new Set<string>();
  for (const pos of positions) {
    const close = ctx.latest(pos.symbol);
    if (close !== null && pos.avgCost > 0 && close <= pos.avgCost * p.stopLossThreshold) {
      stopLossSymbols.add(pos.symbol);
    }
  }

  // ── 6) 持仓保留 + 补足，走空则防御 ETF ──
  // 止损标的当日**不进 targets**（连补足也不允许），故先从候选里剔除
  const eligibleCandidates = candidates.filter((m) => !stopLossSymbols.has(m.symbol));
  const selection = selectTargets({
    candidates: eligibleCandidates,
    holdings: positions.map((pos) => pos.symbol),
    stopLossSymbols,
    holdingsNum: p.holdingsNum,
    defensiveSymbol: p.defensiveEtf,
    defensivePaused: ctx.isPaused(p.defensiveEtf),
  });

  const targetWeight = 1 / p.holdingsNum;
  let targets: TargetPosition[];
  if (selection.defensive) {
    targets = [{ symbol: p.defensiveEtf, targetWeight, reason: 'defensive-fallback' }];
  } else {
    targets = selection.picks.map((m) => ({
      symbol: m.symbol,
      targetWeight,
      reason: selection.retained.has(m.symbol) ? ('holding-retained' as const) : ('candidate-top' as const),
      score: m.score,
    }));
  }

  // ── 7) 退出原因（M3 归因依赖） ──
  const targetSymbols = new Set(targets.map((t) => t.symbol));
  const defensiveTargeted = targets.some((t) => t.symbol !== p.defensiveEtf);
  const exitReasons: Record<string, ExitReason> = {};
  for (const pos of positions) {
    const symbol = pos.symbol;
    if (targetSymbols.has(symbol)) continue;
    if (stopLossSymbols.has(symbol)) {
      exitReasons[symbol] = 'stop-loss';
    } else if (symbol === p.defensiveEtf && defensiveTargeted) {
      exitReasons[symbol] = 'defensive-fallback';
    } else if (weak && !poolSet.has(symbol)) {
      // 走弱期清掉的持仓（不在走弱池里）
      exitReasons[symbol] = 'weak-period-exit';
    } else if (state.lastPool.has(symbol) && !poolSet.has(symbol)) {
      exitReasons[symbol] = 'drop-from-pool';
    } else {
      exitReasons[symbol] = 'out-of-candidate';
    }
  }

  state.lastPool = poolSet;
  return { targets, mode: 'replace', exitReasons };
}

/** 返回**新实例**（每次调用独立的跨日状态，便于并行跑多组参数/多区间） */
export function createWufuRotationStrategy(): Strategy {
  const state = createState();
  return defineStrategy({
    id: 'wufu-rotation',
    version: '5.2.0-m3',
    name: '五福轮动 ETF v5.2（日线主干）',
    paramSchema: WUFU_ROTATION_PARAM_SCHEMA,
    warmupDays: WUFU_ROTATION_DEFAULTS.lookbackDays + 1,
    priceMode: 'open',

    init() {
      state.weak = false;
      state.startDayIndex = null;
      state.lastPool = new Set();
    },

    decide(ctx: StrategyContext): TargetSet {
      return decideWufuRotation(ctx, state);
    },
  });
}
