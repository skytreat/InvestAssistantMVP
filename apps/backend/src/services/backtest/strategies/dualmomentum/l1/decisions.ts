/**
 * DualMomentum L1 决策序列（DAS-2 §3.3）。
 *
 * 输出「逐日逐标的」的指标值、过滤原因码、排名、是否选中；
 * **不产出**目标权重 / 买卖方向 / 成交 / 持仓（L2）。
 *
 * 纯函数，不做任何 IO；数据切片由调用方注入（对齐阶段必须是锁定快照）。
 */
import { calcNdayReturnMomentum, calcWeightedSlopeMomentum, precalcIndicators } from './indicators.js';
import {
  COMBO_SLOTS,
  DAILY_CHANGE_EPSILON,
  DAILY_CHANGE_MAX,
  DAILY_CHANGE_MIN,
  DEFAULT_LIMIT_RATIO,
  INDICATOR_LOOKBACK,
  MAX_HOLDINGS,
  NDAY_RETURN_PERIOD,
  WSM_PERIOD,
} from './params.js';
import { calcPrevCloseAdj, forwardAdjustWindow, lastIndexOnOrBefore, normalizeFactor } from './series.js';
import type { L1DecisionRow, MarketSlice, MomentumCombo, PriceBar, RejectReason } from './types.js';

export interface L1Options {
  /** §2.3 默认锁定 combo 1 */
  combo?: MomentumCombo;
  startDate?: string;
  /** 含当日 */
  endDate?: string;
  maxHoldings?: number;
  limitRatioBySymbol?: Readonly<Record<string, number>>;
  /**
   * 冷却表查询（L2 卖出事件产生）。
   * 纯 L1 没有组合状态，默认空 ⇒ 第 3 步永不触发、`cooldown_until` 列为空。
   */
  cooldownUntil?: (symbol: string, tradeDate: string) => string | null;
}

/** 过滤链输入（§3.3 第 1–9 步），与组合状态无关，便于逐条单测。 */
export interface L1FilterInput {
  inPool: boolean;
  hasBar: boolean;
  /** T 日 raw 收盘（停牌为 null） */
  closeRaw: number | null;
  prevCloseAdj: number;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  primary: number;
  secondary: number;
  benchmarkPrimary: number;
  primaryRange: readonly [number, number];
  secondaryRange: readonly [number, number];
  cooling: boolean;
  limitRatio: number;
}

export interface L1FilterResult {
  pass: boolean;
  reason: RejectReason | null;
}

/**
 * 过滤链（第 1–9 步，严格按 §3.3 顺序短路）。
 *
 * ⚠️ 预热段 `ma*` 为空 ⇒ 第 6 步固定失败（原因是 `BELOW_MA20`，
 * 不是跳过），这是「不足 60 根整体短路」的直接后果。
 */
export function evaluateL1Filters(input: L1FilterInput): L1FilterResult {
  if (!input.inPool) return { pass: false, reason: 'POOL_ABSENT' };
  if (!input.hasBar || input.closeRaw === null || !(input.closeRaw > 0)) {
    return { pass: false, reason: 'SUSPENDED' };
  }
  if (input.cooling) return { pass: false, reason: 'COOLDOWN' };

  const price = input.closeRaw;
  const upLimit = input.prevCloseAdj * (1 + input.limitRatio);
  const downLimit = input.prevCloseAdj * (1 - input.limitRatio);
  if (price >= upLimit || price <= downLimit) return { pass: false, reason: 'AT_LIMIT' };

  const change = input.prevCloseAdj > 0 ? price / input.prevCloseAdj - 1 : Number.NaN;
  if (
    !Number.isFinite(change) ||
    change < DAILY_CHANGE_MIN - DAILY_CHANGE_EPSILON ||
    change > DAILY_CHANGE_MAX + DAILY_CHANGE_EPSILON
  ) {
    return { pass: false, reason: 'DAILY_CHANGE_OUT_OF_RANGE' };
  }

  const { ma5, ma10, ma20, ma60 } = input;
  if (ma20 === null || ma20 <= 0 || !(price > ma20)) {
    return { pass: false, reason: 'BELOW_MA20' };
  }
  if (ma5 === null || ma10 === null || ma60 === null || !(ma5 > ma10 && ma10 > ma20 && ma20 > ma60)) {
    return { pass: false, reason: 'MA_NOT_BULLISH' };
  }
  if (
    !inClosedRange(input.primary, input.primaryRange) ||
    !inClosedRange(input.secondary, input.secondaryRange)
  ) {
    return { pass: false, reason: 'MOMENTUM_OUT_OF_RANGE' };
  }
  if (!(input.primary >= input.benchmarkPrimary)) {
    return { pass: false, reason: 'BELOW_BENCHMARK' };
  }
  return { pass: true, reason: null };
}

interface RowDraft extends Omit<
  L1DecisionRow,
  'filter_pass' | 'reject_reason' | 'rank' | 'selected' | 'benchmark_primary'
> {
  /** 内部用：主槽值（已保证有限） */
  primary: number;
  rejectReason: RejectReason | null;
  benchmarkPrimary: number;
}

/** 生成 L1 逐日逐标的决策行（行序：trade_date 升序，同日按池内顺序）。 */
export function computeL1DecisionRows(slice: MarketSlice, options: L1Options = {}): L1DecisionRow[] {
  const combo = options.combo ?? 'wsm_v2_rsrs';
  const slots = COMBO_SLOTS[combo];
  const maxHoldings = options.maxHoldings ?? MAX_HOLDINGS;
  validateSlice(slice);

  const rows: L1DecisionRow[] = [];
  for (const tradeDate of slice.tradingDays) {
    if (options.startDate !== undefined && tradeDate < options.startDate) continue;
    if (options.endDate !== undefined && tradeDate > options.endDate) continue;

    const benchmarkPrimary = computeBenchmarkPrimary(slice.benchmarkBars, tradeDate, slots.benchmark);

    const drafts: RowDraft[] = slice.symbols.map((series) =>
      buildRowDraft(series.symbol, series.jqCode, series.bars, tradeDate, combo, benchmarkPrimary, options),
    );

    // 第 10 步：仅对通过 1–9 步的行做**稳定**降序排名（并列保持池内顺序）
    const passed = drafts.filter((d) => d.rejectReason === null);
    passed.sort((a, b) => b.primary - a.primary);
    const rankBySymbol = new Map<string, number>();
    passed.forEach((d, idx) => rankBySymbol.set(d.symbol, idx + 1));

    for (const draft of drafts) {
      const rank = rankBySymbol.get(draft.symbol) ?? null;
      const filterPass = rank !== null;
      let rejectReason = draft.rejectReason;
      if (filterPass && rank !== null && rank > maxHoldings) rejectReason = 'RANK_TRUNCATED';
      rows.push({
        trade_date: draft.trade_date,
        symbol: draft.symbol,
        jq_code: draft.jq_code,
        in_pool: draft.in_pool,
        has_bar: draft.has_bar,
        tradable_today: draft.tradable_today,
        hfq_factor: draft.hfq_factor,
        close_raw: draft.close_raw,
        prev_close_raw: draft.prev_close_raw,
        open_raw: draft.open_raw,
        ma5: draft.ma5,
        ma10: draft.ma10,
        ma20: draft.ma20,
        ma60: draft.ma60,
        wsm_v2: draft.wsm_v2,
        nday_return: draft.nday_return,
        rsrs_z: draft.rsrs_z,
        momentum_primary: draft.momentum_primary,
        momentum_secondary: draft.momentum_secondary,
        benchmark_primary: draft.benchmarkPrimary,
        filter_pass: filterPass,
        reject_reason: rejectReason,
        rank,
        selected: rank !== null && rank <= maxHoldings,
        cooldown_until: draft.cooldown_until,
      });
    }
  }
  return rows;
}

function buildRowDraft(
  symbol: string,
  jqCode: string,
  bars: readonly PriceBar[],
  tradeDate: string,
  combo: MomentumCombo,
  benchmarkPrimary: number,
  options: L1Options,
): RowDraft {
  const slots = COMBO_SLOTS[combo];
  const lastIndex = lastIndexOnOrBefore(bars, tradeDate);

  // 第 1 步：标的尚未上市 → 指标列全空（§7.4）
  if (lastIndex < 0) {
    return {
      trade_date: tradeDate,
      symbol,
      jq_code: jqCode,
      in_pool: false,
      has_bar: false,
      tradable_today: false,
      hfq_factor: null,
      close_raw: null,
      prev_close_raw: null,
      open_raw: null,
      ma5: null,
      ma10: null,
      ma20: null,
      ma60: null,
      wsm_v2: null,
      nday_return: null,
      rsrs_z: null,
      momentum_primary: null,
      momentum_secondary: null,
      primary: 0,
      benchmarkPrimary,
      rejectReason: 'POOL_ABSENT',
      cooldown_until: null,
    };
  }

  const bar = bars[lastIndex];
  const hasBar = bar.date === tradeDate;
  const factor = normalizeFactor(bar.hfqFactor);
  const { prevCloseAdj } = calcPrevCloseAdj(bars, lastIndex);

  const windowStart = Math.max(0, lastIndex - (INDICATOR_LOOKBACK - 1));
  const window = bars.slice(windowStart, lastIndex + 1);
  const adjusted = forwardAdjustWindow(window, factor);
  const ind = precalcIndicators(adjusted.close, adjusted.high, adjusted.low);

  const closeRaw = hasBar ? bar.close : null;
  const openRaw = hasBar ? bar.open : null;

  const tradableToday = hasBar && isUsableBar(bar);
  const primaryValue = slots.primary === 'wsm' ? ind.wsm : ind.nday;
  const secondaryValue = slots.secondary === 'rsrs' ? ind.rsrs : ind.wsm;
  const ma5 = ind.ma[5] ?? null;
  const ma10 = ind.ma[10] ?? null;
  const ma20 = ind.ma[20] ?? null;
  const ma60 = ind.ma[60] ?? null;

  const cooldownUntil = options.cooldownUntil?.(symbol, tradeDate) ?? null;
  const cooling = cooldownUntil !== null && tradeDate <= cooldownUntil;

  const filter = evaluateL1Filters({
    inPool: true,
    hasBar,
    closeRaw,
    prevCloseAdj,
    ma5,
    ma10,
    ma20,
    ma60,
    primary: primaryValue,
    secondary: secondaryValue,
    benchmarkPrimary,
    primaryRange: slots.primaryRange,
    secondaryRange: slots.secondaryRange,
    cooling,
    limitRatio: options.limitRatioBySymbol?.[symbol] ?? DEFAULT_LIMIT_RATIO,
  });
  const rejectReason = filter.reason;

  return {
    trade_date: tradeDate,
    symbol,
    jq_code: jqCode,
    in_pool: true,
    has_bar: hasBar,
    tradable_today: tradableToday,
    hfq_factor: factor,
    close_raw: closeRaw,
    prev_close_raw: prevCloseAdj,
    open_raw: openRaw,
    ma5,
    ma10,
    ma20,
    ma60,
    wsm_v2: ind.wsm,
    nday_return: ind.nday,
    rsrs_z: ind.rsrs,
    momentum_primary: primaryValue,
    momentum_secondary: secondaryValue,
    primary: primaryValue,
    benchmarkPrimary,
    rejectReason,
    cooldown_until: cooling ? cooldownUntil : null,
  };
}

/** §6.2 第 6 列：`has_bar && volume>0 && 价>0`（仅支撑本列，不参与过滤）。 */
function isUsableBar(bar: PriceBar): boolean {
  if (!Number.isFinite(bar.volume) || bar.volume <= 0) return false;
  return [bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0);
}

function inClosedRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

/**
 * 基准主槽动量（§3.3 第 9 步）。指数无复权，直接用 close；
 * 数据不足时算法自身返回 0（与 `precalc_benchmark_momentum` 一致）。
 */
export function computeBenchmarkPrimary(
  benchmarkBars: readonly PriceBar[],
  tradeDate: string,
  algorithm: 'wsm' | 'nday',
): number {
  const lastIndex = lastIndexOnOrBefore(benchmarkBars, tradeDate);
  if (lastIndex < 0) return 0;
  const closes: number[] = [];
  for (let i = 0; i <= lastIndex; i++) closes.push(benchmarkBars[i].close);
  if (algorithm === 'wsm') {
    return calcWeightedSlopeMomentum(closes.slice(-WSM_PERIOD));
  }
  return calcNdayReturnMomentum(closes, NDAY_RETURN_PERIOD);
}

/** 防御性校验：序列必须升序且日期唯一，否则二分查找会静默取错 bar。 */
function validateSlice(slice: MarketSlice): void {
  let prevDay: string | null = null;
  for (const day of slice.tradingDays) {
    if (prevDay !== null && day <= prevDay) {
      throw new Error(`MarketSlice.tradingDays 必须严格升序：${prevDay} → ${day}`);
    }
    prevDay = day;
  }
  for (const series of slice.symbols) {
    for (let i = 1; i < series.bars.length; i++) {
      if (series.bars[i].date <= series.bars[i - 1].date) {
        throw new Error(
          `${series.symbol} 的 bars 必须严格升序：${series.bars[i - 1].date} → ${series.bars[i].date}`,
        );
      }
    }
  }
}
