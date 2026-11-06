/**
 * 回测策略接口（M2）—— 依据 `docs/audit/proposal-strategy-backtest-framework.md` §4.1
 *
 * 设计取舍：
 * - **接口是纯的**：`decide(ctx)` 只能读 `ctx`，而 `ctx` 里的所有序列都截止到
 *   `asOf = T-1`。这是「三约束」在接口层的保证（§5.2）：
 *   策略拿不到 T 日及之后的任何行情，前视在类型层面就做不到。
 * - 参数沿用 `pluginEngine.ParamField`（`key/label/type/default/min/max/...`），
 *   M3 移植 v5.2 参数表时可直接复用既有参数表单，不另造一套 schema。
 * - `reason` 字段从第一天就带上（EntryReason / ExitReason，§6.1），
 *   否则 M3 归因时只能靠事后猜「这笔卖出是走弱还是掉出候选」。
 */
import type { ParamField } from '../../pluginEngine.js';
import { deriveDefaultParams } from '../../pluginEngine.js';
import type { Bar } from '../types.js';

/** 可以从序列里取的字段（与 `Bar` 对齐，去掉 date） */
export type SeriesField = 'open' | 'high' | 'low' | 'close' | 'preclose' | 'volume' | 'amount';

/**
 * 策略看到的持仓快照。
 *
 * 成本口径 = 项目统一的移动加权成本（含买入手续费），由 `account/portfolio.ts`
 * 直接调用 `@invest/core` 的 `calculateMovingWeightedCost` 得出，**不另算一套**。
 */
export interface PositionView {
  symbol: string;
  qty: number;
  /** 移动加权平均成本（含买入费用） */
  avgCost: number;
  costBasis: number;
  /** T+1 可卖量（上一交易日及更早买入的部分） */
  closeableQty: number;
  /** 决策时点（T-1 收盘）市值 */
  marketValue: number;
}

/** 建仓原因（M3 归因按此分组） */
export type EntryReason =
  'candidate-top' | 'holding-retained' | 'defensive-fallback' | 'rebalance' | 'manual';

/** 清仓/减仓原因（M3 归因按此分组） */
export type ExitReason =
  | 'weak-period-exit'
  | 'drop-from-pool'
  | 'out-of-candidate'
  | 'stop-loss'
  | 'rebalance-replace'
  | 'defensive-fallback';

/** 单个目标仓位 */
export interface TargetPosition {
  symbol: string;
  /** 目标权重（占总权益）；与 `targetNotional` 二者至少给一个 */
  targetWeight?: number;
  /** 目标金额（元）；优先于 `targetWeight` */
  targetNotional?: number;
  reason: EntryReason;
  score?: number;
}

/** 一天的决策结果 */
export interface TargetSet {
  targets: readonly TargetPosition[];
  /** `replace`：不在 targets 里的持仓清仓；`incremental`：只按 targets 调整，其余保持 */
  mode: 'replace' | 'incremental';
  /**
   * 换手上限（占权益比例）。
   *
   * ⚠️ M2 引擎**未实现**该字段（当前没有策略使用它，v5.2 也没有换手上限）；
   * 字段保留是为了 M3 移植时不改接口。设了但未生效会由引擎显式报错，避免「静默忽略」。
   */
  maxTurnoverRatio?: number;
}

/** 策略看到的 bar（带 symbol） */
export interface BarView extends Bar {
  symbol: string;
}

/** `onFill` 通知（成交回报） */
export interface FillNotice {
  date: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  reason: string;
}

/** `onRoundTrip` 通知（一笔完整平仓，用于策略自维护统计） */
export interface RoundTripNotice {
  symbol: string;
  openDate: string;
  closeDate: string;
  qty: number;
  pnl: number;
  returnPct: number;
  exitReason: string;
}

/** 当日时点名录（直接复用 M1 `UniverseSnapshot` 的字段形状，只取策略需要的部分） */
export interface UniverseView {
  readonly asOf: string;
  /** 全市场通过流动性阈值的只数 */
  readonly marketLiquidityPassCount: number;
  /** 流动性阈值（元/日） */
  readonly liquidityThreshold: number;
  readonly fixed: readonly string[];
  readonly dynamic: readonly string[];
  readonly weak: readonly string[];
}

/** 策略决策上下文（所有读取都截止到 `asOf`） */
export interface StrategyContext {
  /** 决策数据截止日（= T-1，交易日） */
  readonly asOf: string;
  /** 成交日（= T） */
  readonly execDate: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly universe: UniverseView;
  /** 从第 0 个回测交易日起的序号（便于策略做周期性动作） */
  readonly dayIndex: number;

  /** 最近 n 根序列值（qfq，截止 asOf，含当天） */
  series(symbol: string, n: number, field?: SeriesField): number[];
  seriesBatch(symbols: readonly string[], n: number, field?: SeriesField): Map<string, number[]>;
  /** 指数序列（qfq，截止 asOf） */
  indexSeries(indexSymbol: string, n: number): number[];
  /** 最近 n 根 bar（qfq，含 asOf） */
  bars(symbol: string, n: number): BarView[];
  movingAverage(symbol: string, n: number): number | null;
  latest(symbol: string, field?: SeriesField): number | null;
  /** asOf 当天是否停牌（M1 两形态：缺 bar / volume=0） */
  isPaused(symbol: string): boolean;

  position(symbol: string): PositionView | null;
  positions(): readonly PositionView[];
  readonly cash: number;
  /** asOf 收盘估值（现金 + 全部持仓市值，现金类 ETF 也计入） */
  readonly equity: number;

  /** 写入决策标签（落库到 bt_run.decision_tags / 决策日志） */
  tag(key: string, value: unknown): void;
  log(level: 'info' | 'warn', message: string): void;
}

/** 初始化上下文（引擎在跑第一根 bar 前调用一次） */
export interface StrategyInitContext {
  readonly params: Readonly<Record<string, unknown>>;
}

export interface Strategy {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  /** 参数 schema（复用 pluginEngine.ParamField） */
  readonly paramSchema: ParamField[];
  /** 自动从 schema 派生；调用方不得手写 */
  readonly defaultParams: Record<string, unknown>;
  /** 建议最小预热天数（引擎在区间前多载入这么多根 bar；不足时由策略自己判空） */
  readonly warmupDays: number;
  /** 期望成交价口径（M2 引擎两种都支持） */
  readonly priceMode: 'open' | 'close';

  init?(ctx: StrategyInitContext): void;
  /** 决策（T-1 收盘后，基于截至 T-1 的数据），返回 null = 不操作 */
  decide(ctx: StrategyContext): TargetSet | null;
  onFill?(notice: FillNotice): void;
  onRoundTrip?(notice: RoundTripNotice): void;
}

/** 策略定义入参：`defaultParams` 由 {@link defineStrategy} 自动派生 */
export type StrategySpec = Omit<Strategy, 'defaultParams'>;

/** 策略统一入口：自动补齐 `defaultParams`（与 `definePlugin` 同款约定） */
export function defineStrategy(spec: StrategySpec): Strategy {
  return { ...spec, defaultParams: deriveDefaultParams(spec.paramSchema) };
}
