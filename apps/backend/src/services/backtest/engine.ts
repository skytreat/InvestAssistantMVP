/**
 * 回测引擎（M2）—— 依据 proposal §5「时点与方法」与 §3.4「主循环」
 *
 * 主循环（逐交易日 T）：
 *   1. 用 **T-1 收盘后**的信息构建时点池（`universe.asOf === tPrev`，前视在引擎层被强制）
 *   2. 策略决策（ctx 里所有序列都截止到 T-1）
 *   3. T 日开盘前应用除权事件（分红进现金、送转加份额，成本基不变）
 *   4. T 开盘（或收盘）按目标仓位成交（先卖后买、T+1、停牌/涨跌停跳过）
 *   5. T 收盘估值 → 记录净值点（`equity = cash + riskMv + cashMv` 逐日核对）
 *
 * 🔴 **引擎是纯函数**：`runBacktest(data, request)` 不读库。
 *   - CLI 负责从 DuckDB 装载 `BacktestData`；
 *   - 单测用合成数据验证前视探针 / 现金恒等式，**CI 无行情库也能跑**；
 *   - 「篡改 T 之后的行情再跑一遍」这类实验不需要碰数据库。
 */
import { REPO_CODES } from '../assetClass.js';
import type { Bar, SuspensionOptions } from './types.js';
import { findBarByDate, isSuspended } from './marketPanel.js';
import { TradingCalendar } from './calendar.js';
import {
  DEFAULT_TRADE_RULES,
  executeTargets,
  type ExecutionBar,
  type ExecutionWarning,
  type Fill,
  type SkippedOrder,
  type TradeRules,
} from './execution/simulator.js';
import { Portfolio, type CorporateAction, type DividendRecord, type RoundTrip } from './account/portfolio.js';
import {
  computeMetrics,
  computeDrawdownSeries,
  type BacktestMetrics,
  type EquityPoint,
} from './metrics/metrics.js';
import { DEFENSIVE_ETF } from './universe/fixedPool.js';
import type { UniverseResolver } from './universe/provider.js';
import type {
  BarView,
  FillNotice,
  RoundTripNotice,
  SeriesField,
  Strategy,
  StrategyContext,
  UniverseView,
} from './strategy/types.js';
import type { TargetPosition, TargetSet } from './strategy/types.js';

/** 现金类桶（防御 ETF + 逆回购）—— 口径见 R3 §3.7 / `assetClass` 的 repo_code 规则 */
const CASH_BUCKET_SYMBOLS: ReadonlySet<string> = new Set([DEFENSIVE_ETF, ...REPO_CODES]);

export interface BacktestData {
  calendar: TradingCalendar;
  /** 决策轨（qfq）—— 策略只看这一轨 */
  signalBars: ReadonlyMap<string, readonly Bar[]>;
  /** 成交/估值轨（bfq）—— 费用、涨跌停、市值都按原始价 */
  execBars: ReadonlyMap<string, readonly Bar[]>;
  /** 基准（bfq），默认 sh510300 */
  benchmarkBars: readonly Bar[];
  /** 指数轨（qfq），用于走弱期判定；缺省为空 */
  indexBars?: ReadonlyMap<string, readonly Bar[]>;
  /** 逐日名录（**必须**按 asOf = T-1 调用） */
  universe: UniverseResolver;
  /** 除权事件（按 date 升序即可） */
  corporateActions?: readonly CorporateAction[];
}

export interface BacktestRequest {
  strategy: Strategy;
  /** 策略参数（与 strategy.defaultParams 合并；undefined 时用默认值） */
  params?: Readonly<Record<string, unknown>>;
  start: string;
  end: string;
  initialCash: number;
  universeMode?: 'fixed' | 'weak' | 'dynamic';
  priceMode?: 'open' | 'close';
  rules?: Partial<TradeRules>;
  suspension?: SuspensionOptions;
  benchmarkSymbol?: string;
  /**
   * 本次实际生效的池子口径（M1：由 `loadUniverseProvider` 入参决定）。
   *
   * **不是策略参数**：策略从不读取，仅作为审计元数据写入 `bt_run.universe_params_json`。
   */
  universeParams?: { divisor: number; topN: number };
}

/** 单日决策留痕（前视探针逐条比对它） */
export interface DecisionRecord {
  execDate: string;
  asOf: string;
  targets: TargetSet | null;
  fills: Fill[];
  skipped: SkippedOrder[];
  /** 当日成交模拟的数据缺陷事件（如 `PRECLOSE_MISSING`；**不影响成交**） */
  warnings: ExecutionWarning[];
  tags: Record<string, unknown>;
  logs: { level: 'info' | 'warn'; message: string }[];
}

export interface BacktestResult {
  meta: {
    strategyId: string;
    strategyVersion: string;
    strategyName: string;
    params: Record<string, unknown>;
    start: string;
    end: string;
    initialCash: number;
    universeMode: 'fixed' | 'weak' | 'dynamic';
    priceMode: 'open' | 'close';
    benchmarkSymbol: string;
    rules: TradeRules;
    suspension: SuspensionOptions;
    /**
     * M4 可观测性：时点池名称兜底计数（逐日累计 + 峰值）。
     *
     * 动态池分组用的是 `raw_symbol_name` 当前快照；无名称标的按代码兜底参与分组。
     * 这里只统计，不改变策略行为（口径不变）。
     */
    universeStats?: {
      days: number;
      noNameCandidateTotal: number;
      noNameCandidateMax: number;
      fallbackPoolMemberTotal: number;
      fallbackPoolMemberMax: number;
    };
    /**
     * 本次实际生效的池子口径（审计元数据；策略参数里没有 `divisor/topN`）。
     * 调用方未提供时为 `undefined`（如合成数据的单测）。
     */
    universeParams?: { divisor: number; topN: number };
  };
  equity: EquityPoint[];
  trades: Fill[];
  roundTrips: RoundTrip[];
  /** 现金分红流水（归因用；`RoundTrip.pnl` 不含分红，与 core 口径一致） */
  dividends: DividendRecord[];
  metrics: BacktestMetrics;
  decisions: DecisionRecord[];
  skipped: SkippedOrder[];
  /** 全区间成交模拟的数据缺陷事件（按日期/标的聚合；`length` 即发生次数） */
  warnings: ExecutionWarning[];
  tradedNotional: number;
}

/** 引擎内部一致性错误（现金为负 / 权益恒等式破裂） */
export class BacktestInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestInvariantError';
  }
}

/** 二叉查找：最后一根 date ≤ cutoff 的下标（无则 -1） */
function lastIndexAtOrBefore(bars: readonly Bar[] | undefined, cutoff: string): number {
  if (!bars || bars.length === 0) return -1;
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= cutoff) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 最近一根（≤ date）的收盘；没有则 null */
function closeAtOrBefore(bars: readonly Bar[] | undefined, date: string): number | null {
  const idx = lastIndexAtOrBefore(bars, date);
  return idx >= 0 ? bars![idx].close : null;
}

function fieldOf(bar: Bar, field: SeriesField): number {
  return bar[field];
}

/**
 * 换手上限（契约见 `TargetSet.maxTurnoverRatio`）。
 *
 * - **卖出强制**：`replace` 模式下必须清的持仓、以及 targets 里的减仓，先计入换手；
 * - **买入等比缩放**：`Σ|Δ| > ratio × equity` 时，只按剩余额度等比缩放增仓部分；
 * - 缩放到不足 1 元的标的记 `turnover-capped`，由调用方并入当日 `skipped`。
 *
 * 不做「卖出也缩放」：半仓清不掉会让 `replace` 语义失效（目标集无法达成），
 * 且 v5.2 本身没有换手上限，这条路径只服务于后续策略。
 */
function capTurnover(args: {
  date: string;
  targets: TargetSet;
  equity: number;
  held: readonly string[];
  currentValue: (symbol: string) => number;
}): { targets: TargetSet; skipped: SkippedOrder[] } {
  const ratio = args.targets.maxTurnoverRatio;
  if (ratio === undefined) return { targets: args.targets, skipped: [] };
  if (!(ratio >= 0)) {
    throw new BacktestInvariantError(`maxTurnoverRatio 必须 >= 0（收到 ${String(ratio)}）`);
  }

  const bySymbol = new Map(args.targets.targets.map((t) => [t.symbol, t]));
  const sideNotional = (t: TargetPosition): number =>
    t.targetNotional ?? (t.targetWeight !== undefined ? t.targetWeight * args.equity : 0);

  let sellNotional = 0;
  if (args.targets.mode === 'replace') {
    for (const symbol of args.held) {
      if (!bySymbol.has(symbol)) sellNotional += args.currentValue(symbol);
    }
  }
  let buyNotional = 0;
  for (const t of args.targets.targets) {
    // `hold` 的目标是不动：不产生任何 Δ，不能计入换手
    if (t.hold) continue;
    const cur = args.currentValue(t.symbol);
    const delta = sideNotional(t) - cur;
    if (delta > 0) buyNotional += delta;
    else sellNotional += -delta;
  }

  const cap = ratio * args.equity;
  if (sellNotional + buyNotional <= cap + 1e-9 || buyNotional <= 0) {
    return { targets: args.targets, skipped: [] };
  }

  const allowedBuy = Math.max(0, cap - sellNotional);
  const scale = allowedBuy / buyNotional;
  const skipped: SkippedOrder[] = [];
  const next = args.targets.targets.map((t) => {
    if (t.hold) return t;
    const cur = args.currentValue(t.symbol);
    const delta = sideNotional(t) - cur;
    if (delta <= 0) return t;
    const scaled = delta * scale;
    if (scaled < 1) {
      skipped.push({
        date: args.date,
        symbol: t.symbol,
        side: 'buy',
        qty: 0,
        reason: 'turnover-capped',
        detail: `计划增仓 ${delta.toFixed(2)} 元，缩放后 ${scaled.toFixed(2)} 元`,
      });
      return { ...t, targetNotional: cur, targetWeight: undefined };
    }
    return { ...t, targetNotional: cur + scaled, targetWeight: undefined };
  });
  return { targets: { ...args.targets, targets: next }, skipped };
}

/**
 * 目标集契约校验 —— 策略写错就抛，不静默。
 *
 * - `hold` 与 `targetWeight` / `targetNotional` 互斥（一个说「不动」，一个说「调到多少」）；
 * - `hold` 必须当日有持仓：没持仓却声明 hold，等于「保留」什么也没保留住；
 * - `buyBudget='remaining-cash-equal'` 与 `maxTurnoverRatio` 互斥（前者按现金分，后者按权益缩放）。
 */
function assertTargetSetValid(targets: TargetSet, date: string, qtyOf: (symbol: string) => number): void {
  if (targets.buyBudget === 'remaining-cash-equal' && targets.maxTurnoverRatio !== undefined) {
    throw new BacktestInvariantError(
      `buyBudget='remaining-cash-equal' 与 maxTurnoverRatio 互斥（${date}，策略错误）`,
    );
  }
  for (const t of targets.targets) {
    if (!t.hold) continue;
    if (t.targetWeight !== undefined || t.targetNotional !== undefined) {
      throw new BacktestInvariantError(
        `hold 与目标权重/金额互斥：${t.symbol}（${date}，策略错误）`,
      );
    }
    if (qtyOf(t.symbol) <= 0) {
      throw new BacktestInvariantError(`hold 无持仓：${t.symbol}（${date}，策略错误，不静默跳过）`);
    }
  }
}

/** 构造某一时点的策略上下文（所有读取都截止到 asOf） */
function makeContext(args: {
  asOf: string;
  execDate: string;
  dayIndex: number;
  params: Readonly<Record<string, unknown>>;
  signalBars: ReadonlyMap<string, readonly Bar[]>;
  indexBars: ReadonlyMap<string, readonly Bar[]>;
  universeView: UniverseView;
  portfolio: Portfolio;
  pricesAtAsOf: ReadonlyMap<string, number>;
  suspension: SuspensionOptions;
  tags: Record<string, unknown>;
  logs: { level: 'info' | 'warn'; message: string }[];
}): StrategyContext {
  const cutoffCache = new Map<string, number>();
  const cutoffIndex = (symbol: string): number => {
    const cached = cutoffCache.get(symbol);
    if (cached !== undefined) return cached;
    const idx = lastIndexAtOrBefore(args.signalBars.get(symbol), args.asOf);
    cutoffCache.set(symbol, idx);
    return idx;
  };

  const seriesOf = (symbol: string, n: number, field: SeriesField = 'close'): number[] => {
    const bars = args.signalBars.get(symbol);
    const idx = cutoffIndex(symbol);
    if (!bars || idx < 0) return [];
    const start = Math.max(0, idx - n + 1);
    const out: number[] = [];
    for (let i = start; i <= idx; i++) out.push(fieldOf(bars[i], field));
    return out;
  };

  const positionView = (symbol: string) => {
    const pos = args.portfolio.position(symbol);
    if (pos.qty <= 0) return null;
    const price = args.pricesAtAsOf.get(symbol) ?? 0;
    return { ...pos, marketValue: pos.qty * price };
  };

  return {
    asOf: args.asOf,
    execDate: args.execDate,
    params: args.params,
    universe: args.universeView,
    dayIndex: args.dayIndex,
    series: seriesOf,
    seriesBatch(symbols, n, field = 'close') {
      const out = new Map<string, number[]>();
      for (const s of symbols) out.set(s, seriesOf(s, n, field));
      return out;
    },
    indexSeries(indexSymbol, n) {
      const bars = args.indexBars.get(indexSymbol);
      const idx = lastIndexAtOrBefore(bars, args.asOf);
      if (!bars || idx < 0) return [];
      const start = Math.max(0, idx - n + 1);
      return bars.slice(start, idx + 1).map((b) => b.close);
    },
    bars(symbol, n): BarView[] {
      const bars = args.signalBars.get(symbol);
      const idx = cutoffIndex(symbol);
      if (!bars || idx < 0) return [];
      const start = Math.max(0, idx - n + 1);
      return bars.slice(start, idx + 1).map((b) => ({ ...b, symbol }));
    },
    movingAverage(symbol, n) {
      const xs = seriesOf(symbol, n, 'close');
      if (xs.length < n) return null;
      return xs.reduce((a, b) => a + b, 0) / n;
    },
    latest(symbol, field = 'close') {
      const xs = seriesOf(symbol, 1, field);
      return xs.length > 0 ? xs[0] : null;
    },
    isPaused(symbol) {
      return isSuspended(args.signalBars.get(symbol), args.asOf, args.suspension).suspended;
    },
    position: positionView,
    positions() {
      const out = [];
      for (const p of args.portfolio.positions()) {
        const price = args.pricesAtAsOf.get(p.symbol) ?? 0;
        out.push({ ...p, marketValue: p.qty * price });
      }
      return out;
    },
    get cash() {
      return args.portfolio.cash;
    },
    get equity() {
      return args.portfolio.equity(args.pricesAtAsOf);
    },
    tag(key, value) {
      args.tags[key] = value;
    },
    log(level, message) {
      args.logs.push({ level, message });
    },
  };
}

/** 从 `UniverseSnapshot` 取策略需要的部分 */
function universeViewOf(snapshot: ReturnType<UniverseResolver>): UniverseView {
  return {
    asOf: snapshot.asOf,
    marketLiquidityPassCount: snapshot.marketLiquidityPassCount,
    liquidityThreshold: snapshot.liquidity.threshold,
    fixed: snapshot.fixed.map((p) => p.symbol),
    dynamic: snapshot.dynamic.pool.map((p) => p.symbol),
    weak: snapshot.weak.map((p) => p.symbol),
  };
}

/** 运行一次回测（纯函数，不读库/不写库） */
export function runBacktest(data: BacktestData, request: BacktestRequest): BacktestResult {
  const strategy = request.strategy;
  const params: Record<string, unknown> = { ...strategy.defaultParams, ...(request.params ?? {}) };
  const universeMode = request.universeMode ?? 'fixed';
  const priceMode = request.priceMode ?? strategy.priceMode;
  const suspension: SuspensionOptions = request.suspension ?? {};
  const rules: TradeRules = { ...DEFAULT_TRADE_RULES, ...(request.rules ?? {}) };
  const benchmarkSymbol = request.benchmarkSymbol ?? 'sh510300';

  if (!(request.initialCash > 0)) {
    throw new BacktestInvariantError(`initialCash 必须 > 0（收到 ${request.initialCash}）`);
  }

  strategy.init?.({ params });

  const dates = data.calendar.slice(request.start, request.end);
  if (dates.length === 0) {
    throw new BacktestInvariantError(`区间内没有交易日：${request.start} ~ ${request.end}`);
  }

  const portfolio = new Portfolio(request.initialCash);
  const equity: EquityPoint[] = [];
  const trades: Fill[] = [];
  const skippedAll: SkippedOrder[] = [];
  const warningsAll: ExecutionWarning[] = [];
  const decisions: DecisionRecord[] = [];
  let tradedNotional = 0;

  const actionsByDate = new Map<string, CorporateAction[]>();
  for (const a of data.corporateActions ?? []) {
    const list = actionsByDate.get(a.date) ?? [];
    list.push(a);
    actionsByDate.set(a.date, list);
  }

  const roundTripNotified = new Set<number>();
  const universeStats = {
    days: 0,
    noNameCandidateTotal: 0,
    noNameCandidateMax: 0,
    fallbackPoolMemberTotal: 0,
    fallbackPoolMemberMax: 0,
  };

  for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
    const execDate = dates[dayIndex];
    const asOf = data.calendar.prev(execDate);
    if (asOf === null) continue;

    // ── 1) 时点池（asOf = T-1）＋ 决策上下文 ──
    const snapshot = data.universe(asOf);
    if (snapshot.asOf !== asOf) {
      throw new BacktestInvariantError(
        `时点池对齐错误：请求 asOf=${asOf}，实际 asOf=${snapshot.asOf}（回测决策必须用 T-1）`,
      );
    }

    if (snapshot.noNameCandidateCount !== undefined) {
      universeStats.days++;
      universeStats.noNameCandidateTotal += snapshot.noNameCandidateCount;
      universeStats.noNameCandidateMax = Math.max(
        universeStats.noNameCandidateMax,
        snapshot.noNameCandidateCount,
      );
      const fb = snapshot.fallbackPoolMemberCount ?? 0;
      universeStats.fallbackPoolMemberTotal += fb;
      universeStats.fallbackPoolMemberMax = Math.max(universeStats.fallbackPoolMemberMax, fb);
    }

    const pricesAtAsOf = new Map<string, number>();
    for (const pos of portfolio.positions()) {
      pricesAtAsOf.set(pos.symbol, closeAtOrBefore(data.execBars.get(pos.symbol), asOf) ?? 0);
    }

    const tags: Record<string, unknown> = {};
    const logs: { level: 'info' | 'warn'; message: string }[] = [];
    const ctx = makeContext({
      asOf,
      execDate,
      dayIndex,
      params,
      signalBars: data.signalBars,
      indexBars: data.indexBars ?? new Map(),
      universeView: universeViewOf(snapshot),
      portfolio,
      pricesAtAsOf,
      suspension,
      tags,
      logs,
    });

    let targets = strategy.decide(ctx);
    const capSkipped: SkippedOrder[] = [];
    if (targets) {
      assertTargetSetValid(targets, execDate, (symbol) => portfolio.position(symbol).qty);
      const capped = capTurnover({
        date: execDate,
        targets,
        equity: ctx.equity,
        held: portfolio.positions().map((p) => p.symbol),
        currentValue: (symbol: string) => {
          const pos = portfolio.position(symbol);
          return pos.qty * (pricesAtAsOf.get(symbol) ?? 0);
        },
      });
      targets = capped.targets;
      capSkipped.push(...capped.skipped);
      if (capSkipped.length > 0) ctx.tag('turnoverCapped', capSkipped.length);
    }

    // ── 2) 除权事件（T 日开盘前；按 T-1 收盘持仓生效） ──
    portfolio.startDay();
    const actions = actionsByDate.get(execDate);
    if (actions && actions.length > 0) portfolio.applyCorporateActions(actions);

    // ── 3) 成交（T 开盘/收盘价 + 摩擦） ──
    const fills: Fill[] = [];
    const daySkipped: SkippedOrder[] = [];
    const dayWarnings: ExecutionWarning[] = [];
    if (targets) {
      const execRequest = {
        date: execDate,
        targets: targets.targets,
        mode: targets.mode,
        heldSymbols: portfolio.positions().map((p) => p.symbol),
        equityAtCutoff: ctx.equity,
        cash: portfolio.cash,
        priceMode,
        rules,
        positionOf: (symbol: string) => portfolio.position(symbol),
        barOf: (symbol: string): ExecutionBar | undefined => {
          const bar = findBarByDate(data.execBars.get(symbol) ?? [], execDate);
          return bar
            ? { open: bar.open, close: bar.close, preclose: bar.preclose, volume: bar.volume }
            : undefined;
        },
        suspensionOf: (symbol: string) => isSuspended(data.execBars.get(symbol), execDate, suspension),
        buyBudget: targets?.buyBudget,
        exitReasons: targets?.exitReasons,
      };

      const result = executeTargets(execRequest);
      fills.push(...result.fills);
      daySkipped.push(...result.skipped);
      daySkipped.push(...capSkipped);
      dayWarnings.push(...result.warnings);

      for (const fill of fills) {
        portfolio.applyFill(fill);
        trades.push(fill);
        tradedNotional += fill.qty * fill.price;
        if (strategy.onFill) {
          const notice: FillNotice = {
            date: fill.date,
            symbol: fill.symbol,
            side: fill.side,
            qty: fill.qty,
            price: fill.price,
            fee: fill.fee,
            reason: fill.reason,
          };
          strategy.onFill(notice);
        }
      }
    }

    for (let i = roundTripNotified.size; i < portfolio.roundTrips.length; i++) {
      roundTripNotified.add(i);
      if (strategy.onRoundTrip) {
        const rt = portfolio.roundTrips[i];
        const notice: RoundTripNotice = {
          symbol: rt.symbol,
          openDate: rt.openDate,
          closeDate: rt.closeDate,
          qty: rt.qty,
          pnl: rt.pnl,
          returnPct: rt.returnPct,
          exitReason: rt.exitReason,
        };
        strategy.onRoundTrip(notice);
      }
    }

    // ── 4) T 收盘估值（停牌/缺 bar 沿用最近有效价） ──
    let riskMv = 0;
    let cashMv = 0;
    for (const pos of portfolio.positions()) {
      const price = closeAtOrBefore(data.execBars.get(pos.symbol), execDate) ?? 0;
      const mv = pos.qty * price;
      if (CASH_BUCKET_SYMBOLS.has(pos.symbol)) cashMv += mv;
      else riskMv += mv;
    }
    const cash = portfolio.cash;
    const totalEquity = cash + riskMv + cashMv;

    const benchIdx = lastIndexAtOrBefore(data.benchmarkBars, execDate);
    const benchmarkClose = benchIdx >= 0 ? data.benchmarkBars[benchIdx].close : null;
    // 当日无基准 bar（沿用上一有效收盘）→ 标记 stale，指标层据此整对剔除 alpha/beta
    const benchmarkStale = benchIdx >= 0 && data.benchmarkBars[benchIdx].date !== execDate;
    equity.push({
      date: execDate,
      equity: totalEquity,
      cash,
      riskMv,
      cashMv,
      benchmarkClose,
      benchmarkStale,
      exposure: totalEquity > 0 ? riskMv / totalEquity : 0,
      // 回撤在全部点收集后统一算（仍写成 0，最终会被覆盖）
      drawdownRatio: 0,
    });

    if (cash < -1e-6) {
      throw new BacktestInvariantError(`现金为负：${execDate} cash=${cash}（成交模拟器应已拦截）`);
    }

    decisions.push({
      execDate,
      asOf,
      targets,
      fills: [...fills],
      skipped: [...daySkipped],
      warnings: [...dayWarnings],
      tags,
      logs,
    });
    skippedAll.push(...daySkipped);
    warningsAll.push(...dayWarnings);
  }

  // 回撤序列补齐
  const drawdowns = computeDrawdownSeries(equity.map((p) => p.equity));
  for (let i = 0; i < equity.length; i++) equity[i].drawdownRatio = drawdowns[i];

  const metrics = computeMetrics(equity, portfolio.roundTrips, {
    initialEquity: request.initialCash,
    tradedNotional,
  });

  return {
    meta: {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      strategyName: strategy.name,
      params,
      start: request.start,
      end: request.end,
      initialCash: request.initialCash,
      universeMode,
      priceMode,
      benchmarkSymbol,
      rules,
      suspension,
      universeStats: universeStats.days > 0 ? universeStats : undefined,
      universeParams: request.universeParams,
    },
    equity,
    trades,
    roundTrips: portfolio.roundTrips,
    dividends: portfolio.dividends,
    metrics,
    decisions,
    skipped: skippedAll,
    warnings: warningsAll,
    tradedNotional,
  };
}
