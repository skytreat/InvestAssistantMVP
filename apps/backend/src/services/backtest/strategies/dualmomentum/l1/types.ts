/**
 * DualMomentum L1 层类型定义（DAS-2 §6）。
 *
 * L1 只负责「指标 → 过滤 → 排名 → 是否选中」，不产出任何组合状态（目标权重、
 * 买卖方向、成交、持仓）。这些属于 L2，见 `docs/audit/dualmomentum-l1-alignment.md`。
 */

/** 单根日线（raw 不复权价 + 当日后复权因子）。 */
export interface PriceBar {
  /** YYYY-MM-DD */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  /** 后复权因子 F(t)，须 > 0；指数无复权时固定为 1 */
  hfqFactor: number;
}

/** 单只标的的升序日线序列。 */
export interface SymbolSeries {
  /** `sh510300` 形式 */
  symbol: string;
  /** `510300.XSHG` 形式（导出列 3） */
  jqCode: string;
  /** 按 date 升序，缺失日即停牌（不得前向填充） */
  bars: PriceBar[];
}

/**
 * L1 的数据切片。
 *
 * 对齐阶段必须来自 DAS-2 §5 的**一次性快照**；本层不做任何 IO，
 * 由调用方注入，避免默认取实时行情库（会随新数据变化）。
 */
export interface MarketSlice {
  /** 决策日（交易日历），升序；不得合成「有效交易日」 */
  tradingDays: string[];
  /** 标的池，**顺序即 §2.1 池内顺序**（并列排名靠它打破） */
  symbols: SymbolSeries[];
  /** 基准 sh000300 的日线（不可交易，仅用于大盘择时） */
  benchmarkBars: PriceBar[];
}

/** §2.3 三种动量组合（槽位语义固定）。 */
export type MomentumCombo = 'wsm_v2_rsrs' | 'nday_return_rsrs' | 'nday_return_wsm_v2';

/** §3.3 原因码。 */
export type RejectReason =
  | 'POOL_ABSENT'
  | 'SUSPENDED'
  | 'COOLDOWN'
  | 'AT_LIMIT'
  | 'DAILY_CHANGE_OUT_OF_RANGE'
  | 'BELOW_MA20'
  | 'MA_NOT_BULLISH'
  | 'MOMENTUM_OUT_OF_RANGE'
  | 'BELOW_BENCHMARK'
  | 'RANK_TRUNCATED';

/**
 * 逐日逐标的决策行（DAS-2 §6.2 第 1–25 列）。
 *
 * `null` 表示 CSV 里的**空字段**（不是 0）。第 26–33 列为 L2 字段，本层不产出。
 */
export interface L1DecisionRow {
  trade_date: string;
  symbol: string;
  jq_code: string;
  in_pool: boolean;
  has_bar: boolean;
  tradable_today: boolean;
  hfq_factor: number | null;
  /**
   * 列 8：T 日 bar 的 raw 收盘（无 bar 为空）。
   * ⚠️ 不可成交日（零成交量占位 bar）的过滤/规划价用「最近有效收盘」，
   * 该值与本列不同，且不单独出列（见对齐说明 D1）。
   */
  close_raw: number | null;
  prev_close_raw: number | null;
  open_raw: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  wsm_v2: number | null;
  nday_return: number | null;
  rsrs_z: number | null;
  momentum_primary: number | null;
  momentum_secondary: number | null;
  benchmark_primary: number | null;
  filter_pass: boolean;
  reject_reason: RejectReason | null;
  rank: number | null;
  selected: boolean;
  cooldown_until: string | null;
}
