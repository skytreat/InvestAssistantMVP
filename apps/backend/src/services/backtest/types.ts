/**
 * M1 数据适配层 —— 共享类型
 *
 * 边界（见 `docs/audit/proposal-strategy-backtest-framework.md` §3.1/§3.2）：
 *   - 本目录只做「取数 + 日历 + 停牌 + 时点名录」，**不做执行模拟、不做策略、不做归因**（M2 起）。
 *   - DuckDB **只读**（`read_only=True` 由 `src/db/duckdb.ts` 统一保证），本模块不写库。
 */

/** 复权口径：qfq 前复权（信号轨） / bfq 不复权（成交轨） / hfq 后复权 */
export type AdjustMode = 'qfq' | 'bfq' | 'hfq';

/**
 * 单根日线 bar（已归一化：`date` 为 `YYYY-MM-DD`，`volume` 为 number）
 *
 * ⚠️ `preclose` 来自视图自带列（`v_etf_*` 均已包含），口径随视图变化：
 *   - `v_etf_qfq.preclose` 是**复权后**的前收盘（与 qfq 序列连续，除权日不跳空）；
 *   - `v_etf_bfq.preclose` 是**不复权**前收盘（已含除权修正），是涨跌停判定的正确口径。
 */
export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  preclose: number;
  volume: number;
  amount: number;
}

/** 标的元信息（名录用）：首根/末根 bar 日期决定「时点可交易」 */
export interface SymbolMeta {
  symbol: string;
  /** `raw_symbol_name` 的**当前快照**名称；无行时为 null（已知偏差，见 nameCleaning.ts） */
  name: string | null;
  /** 全历史首根 bar 日期（上市日近似） */
  firstBar: string;
  /** 全历史末根 bar 日期（退市/停牌近似） */
  lastBar: string;
}

/** 停牌两形态判定开关（下游可显式关闭任一条） */
export interface SuspensionOptions {
  /** 形态一「当日缺 bar」→ 停牌（默认 true） */
  missingBar?: boolean;
  /** 形态二「有 bar 但 volume=0」→ 停牌（默认 true） */
  zeroVolume?: boolean;
}

export type SuspensionReason = 'missing-bar' | 'zero-volume';

export interface SuspensionVerdict {
  suspended: boolean;
  reason: SuspensionReason | null;
}

/** 零量 bar 在历史序列中的处理方式 */
export type ZeroVolumeSeriesMode = 'keep' | 'drop';
