/**
 * DualMomentum 对齐阶段锁定参数（DAS-2 §2.1 / §2.2 / §2.3）。
 *
 * ⚠️ 这些值属于**对齐契约**，不是可调策略参数。改任何一个都必须先改 DAS-2，
 * 否则 L1 逐位对齐立刻失效。
 */
import type { MomentumCombo, SymbolSeries } from './types.js';

/** §2.1 标的池顺序（并列排名按此顺序，不是代码字典序）。 */
export const POOL_ORDER = [
  'sh510300',
  'sh510500',
  'sz159915',
  'sh513500',
  'sh513100',
  'sh513000',
  'sh518880',
] as const;

/** §2.1 聚宽代码映射。 */
export const JQ_CODE_BY_SYMBOL: Readonly<Record<string, string>> = {
  sh510300: '510300.XSHG',
  sh510500: '510500.XSHG',
  sz159915: '159915.XSHE',
  sh513500: '513500.XSHG',
  sh513100: '513100.XSHG',
  sh513000: '513000.XSHG',
  sh518880: '518880.XSHG',
  sh000300: '000300.XSHG',
};

/** §2.1 基准（不可交易）。 */
export const BENCHMARK_SYMBOL = 'sh000300';

export const WSM_PERIOD = 25;
export const USE_WSM_V2 = true;
export const NDAY_RETURN_PERIOD = 25;
export const NDAY_RETURN_ANNUALIZE = true;
export const RSRS_PERIOD = 25;
export const RSRS_STD_PERIOD = 25;
export const RSRS_ENABLE_QUALITY_FILTER = false;
export const MA_PERIODS = [5, 10, 20, 60] as const;
export const MA_FOR_PRICE_CHECK = 20;

/** `needed = max(25, 25, 25+25, 60) = 60`：不足 60 根时**整体短路返回 0**（§3.2(d)）。 */
export const INDICATOR_LOOKBACK = Math.max(
  WSM_PERIOD,
  NDAY_RETURN_PERIOD,
  RSRS_PERIOD + RSRS_STD_PERIOD,
  ...MA_PERIODS,
);

export const WSM_MIN = 0.0;
export const WSM_MAX = 5.0;
export const RSRS_MIN = 0.0;
export const RSRS_MAX = 2.0;
export const DAILY_CHANGE_MIN = -0.05;
export const DAILY_CHANGE_MAX = 0.05;
/** §9.5 边界容差，必须保留。 */
export const DAILY_CHANGE_EPSILON = 1e-9;
export const MAX_HOLDINGS = 6;

/** §4.4 涨跌停比例；跨境 ETF 同为 0.10（以 Python `calc_limit_prices` 为准）。 */
export const DEFAULT_LIMIT_RATIO = 0.1;

export interface ComboSlots {
  /** 主槽指标（`wsm` 槽位） */
  primary: 'wsm' | 'nday';
  /** 次槽指标（`rsrs` 槽位） */
  secondary: 'rsrs' | 'wsm';
  /** 主槽过滤区间，作用在**槽位**上（§2.3） */
  primaryRange: readonly [number, number];
  /** 次槽过滤区间，作用在**槽位**上（combo 3 下是「WSM ≤ 200%」） */
  secondaryRange: readonly [number, number];
  /** 基准动量算法 */
  benchmark: 'wsm' | 'nday';
}

export const COMBO_SLOTS: Readonly<Record<MomentumCombo, ComboSlots>> = {
  wsm_v2_rsrs: {
    primary: 'wsm',
    secondary: 'rsrs',
    primaryRange: [WSM_MIN, WSM_MAX],
    secondaryRange: [RSRS_MIN, RSRS_MAX],
    benchmark: 'wsm',
  },
  nday_return_rsrs: {
    primary: 'nday',
    secondary: 'rsrs',
    primaryRange: [WSM_MIN, WSM_MAX],
    secondaryRange: [RSRS_MIN, RSRS_MAX],
    benchmark: 'nday',
  },
  nday_return_wsm_v2: {
    primary: 'nday',
    secondary: 'wsm',
    primaryRange: [WSM_MIN, WSM_MAX],
    // ⚠️ 槽位名固定：次槽仍是 rsrs_min/rsrs_max → 这里是 WSM ≤ 2
    secondaryRange: [RSRS_MIN, RSRS_MAX],
    benchmark: 'nday',
  },
};

/** 由标的符号构造 §2.1 顺序的 `SymbolSeries` 元数据。 */
export function makeSymbolSeries(symbol: string, bars: SymbolSeries['bars']): SymbolSeries {
  return {
    symbol,
    jqCode: JQ_CODE_BY_SYMBOL[symbol] ?? symbol,
    bars,
  };
}
