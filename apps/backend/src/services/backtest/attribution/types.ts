/**
 * 归因模块的公开类型（M3）—— 依据 proposal §6.1 / §6.3
 *
 * 归因是**纯函数**：输入 `BacktestResult`（引擎产出）+ 现金桶配置，
 * 输出六维（本文件按 key 拆成 7 个桶类型，`month` 与 `year` 同属「时间」维度）。
 * 不读库、不写库、不碰 DuckDB。
 */

/** 归因维度名（= 落库 `bt_attribution.bucket_type`） */
export type AttributionDimensionName =
  'symbol' | 'round_trip_id' | 'exit_reason' | 'month' | 'year' | 'branch_tag' | 'bucket';

export interface AttributionOptions {
  /** 期初现金（= `BacktestResult.meta.initialCash`；用于 `totalPnl = 期末 equity − 本值`） */
  initialCash: number;
  /** 现金桶（默认 `[sh511880, ...REPO_CODES]`，与引擎 `CASH_BUCKET_SYMBOLS` 一致） */
  cashBucketSymbols?: readonly string[];
}

/** 单个归属桶（净额口径） */
export interface AttributionBucket {
  key: string;
  /** 净额 PnL（元；每维求和 == totalPnl） */
  pnl: number;
  /** pnl / totalPnl（totalPnl 为 0 时记 0） */
  contributionPct: number;
  /** 该桶涵盖的平仓笔数（含伪回合） */
  tradeCount: number;
  /** 由「其它」聚合而来的原始桶数（仅 `其它` 桶有值） */
  mergedCount?: number;
}

export interface AttributionDimension {
  dimension: AttributionDimensionName;
  /** 按 |pnl| 降序；桶数 > 10 时第 11 名及以后合并为 `其它` */
  buckets: AttributionBucket[];
  /** Σ bucket.pnl（必须 == totalPnl，误差贡献给 residual） */
  sum: number;
  /** |sum − totalPnl| */
  residual: number;
}

/** 跨维度 Top 10（按 |pnl|） */
export interface AttributionTopItem {
  dimension: AttributionDimensionName;
  key: string;
  pnl: number;
  contributionPct: number;
}

/**
 * 毛额恒等式（§6.2）：`totalPnl == riskPnl + cashPnl − fees`
 *
 * 与「净额」是两套视图：净额把费用摊进各回合（求和 == totalPnl），
 * 毛额把费用单列，风险/现金两个资产桶各算各自的现金流盈亏。
 */
export interface AttributionIdentity {
  totalPnl: number;
  riskPnl: number;
  cashPnl: number;
  fees: number;
  /** |totalPnl − (riskPnl + cashPnl − fees)| */
  residual: number;
  /** residual ≤ 1e-6 */
  ok: boolean;
}

export interface AttributionReport {
  totalPnl: number;
  riskPnl: number;
  cashPnl: number;
  fees: number;
  identity: AttributionIdentity;
  dimensions: AttributionDimension[];
  top10: AttributionTopItem[];
  /** 输出纪律告警（`其它` 占比 > 20% 等） */
  warnings: string[];
}
