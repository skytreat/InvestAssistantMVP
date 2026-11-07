/**
 * 纸面账户落账期（PA-10 / PA-11 / PA-12）
 *
 * ## 为什么这样写
 *
 * 结算**必须**复用回测的 `stepBacktestDay`（同一次 `startDay → 除权 → 成交 → 估值`），
 * 自己抄一份成交/估值代码必然与回测漂移（方案 §5.6 / PA-10 硬约束）。
 * 因此这里的角色只是「**准备输入 + 落库**」：
 *
 * 1. 由 `paper_order` 的 pending 行还原成 `TargetSet`（决策时已按 cutoff equity 算好
 *    `target_notional`，等价于回测里 `targetWeight × equityAtCutoff`，故传 `equityAtCutoffOverride`
 *    即可与回测逐位一致）；
 * 2. 从 `paper_position` / `paper_account.cash` 还原检查点组合（`Portfolio.restore`）；
 * 3. 调 `stepBacktestDay` 拿当日 fills / skipped / 净值点；
 * 4. 在**单事务**里回写订单状态、持仓、现金、净值。
 *
 * ## 关键口径
 *
 * - **停牌**（日历是交易日但当日无 bar）：引擎 `isSuspended` 返回 `suspended`，
 *   当日订单 `unfilled`，**不跨日顺延**（方案 §6.4）。
 * - **全市场未更新**：基准当日没有 bar ⇒ `blocked`，pending 保留，**绝不**落成停牌（方案 §7.4 / A12）。
 * - **DuckDB 锁冲突**（被回测批量占用）：同样 `blocked`，不重试、不落停牌。
 * - **逐日必落**：落账期每个交易日都写 `paper_equity`（无挂单日只做除权 + 收盘估值），
 *   否则「买入后不再调仓」的策略净值曲线会断，且无法与回测逐位对账（A1）。
 * - **幂等**：以 `paper_account.last_settled_date` 作日推进水位，重入时整日跳过。
 * - **崩溃**：单事务写，回滚后 pending 原样保留，下次补算（方案 §12.1.3 / A8）。
 */

import type Database from 'better-sqlite3';
import { Portfolio, type CorporateAction, type PortfolioRestorePosition } from '../backtest/account/portfolio.js';
import { loadCorporateActions } from '../backtest/corporateActions.js';
import { loadTradingCalendar, type TradingCalendar } from '../backtest/calendar.js';
import {
  BacktestInvariantError,
  closeAtOrBefore,
  stepBacktestDay,
  type BacktestData,
  type BacktestRunState,
  type StepBacktestDayArgs,
} from '../backtest/engine.js';
import { findBarByDate } from '../backtest/marketPanel.js';
import type { Strategy, TargetPosition, TargetSet } from '../backtest/strategy/types.js';
import type { Fill, SkippedOrder, TradeRules } from '../backtest/execution/simulator.js';
import type { Bar, SuspensionOptions } from '../backtest/types.js';
import { writeSystemLog } from '../logger.js';
import { resolveLatestQuoteDate, resolveTargetTradeDate } from '../marketData.js';
import { PaperError } from './errors.js';
import { feeSnapshotToTradeRules, type FeeSnapshot } from './fees.js';
import { buildPaperMarketData, type BuildPaperMarketDataInput, type PaperMarketData } from './marketData.js';
import { isDuckDbBusy, isSqliteBusy, withBusyRetry } from './retry.js';
import { resolvePaperStrategy } from './strategies.js';
import { todayLocalDate } from './accountService.js';
import {
  runPaperDecision,
  type PaperDecisionDeps,
  type PaperDecisionOutcome,
} from './decision.js';

/** 与回测默认一致：日历判为交易日但缺 bar / 零成交额 → 停牌 */
const DEFAULT_SUSPENSION: SuspensionOptions = { missingBar: true, zeroVolume: true };

/** 结算只走 `targetsOverride` 路径，`decide` 走不到；显式抛错避免静默跑错分支 */
const SETTLE_ONLY_STRATEGY = {
  id: 'paper-settle-only',
  version: '0.0.0',
  name: 'paper-settle-only',
  defaultParams: {},
  decide() {
    throw new BacktestInvariantError('纸面结算不应调用策略决策（targetsOverride 路径）');
  },
} as unknown as Strategy;

interface AccountRow {
  id: number;
  user_id: number;
  strategy_id: string;
  strategy_version: string;
  params_json: string;
  fee_snapshot_json: string | null;
  phase: 'shadow' | 'ledger';
  status: 'active' | 'paused' | 'closed';
  cash: number;
  ledger_start_date: string | null;
  last_settled_date: string | null;
  benchmark_asset_code: string;
}

interface OrderRow {
  id: number;
  signal_id: string;
  asset_code: string;
  intent_kind: 'target' | 'liquidate';
  side: 'buy' | 'sell';
  rebalance_mode: 'replace' | 'incremental';
  target_weight: number | null;
  target_notional: number | null;
  cutoff_equity: number;
  seq: number;
}

interface PositionRow {
  asset_code: string;
  qty: number;
  avg_cost: number;
  cost_basis: number;
  closeable_qty: number;
  last_buy_date: string | null;
  last_price: number | null;
  last_price_date: string | null;
}

export type PaperSettleOutcome =
  | {
      status: 'done';
      accountId: number;
      tradeDate: string;
      filled: number;
      unfilled: number;
      noop: number;
    }
  | {
      status: 'skipped';
      accountId: number;
      tradeDate?: string;
      reason: 'account-not-active' | 'shadow-phase' | 'no-due-day' | 'already-settled';
    }
  | {
      status: 'blocked';
      accountId: number;
      tradeDate?: string;
      reason: 'quotes-not-updated' | 'calendar-mismatch' | 'benchmark-missing' | 'ledger-not-started';
      detail?: string;
    }
  | { status: 'error'; accountId: number; tradeDate?: string; code: string; message: string };

export interface PaperSettleDeps extends PaperDecisionDeps {
  /** 除权事件装载（单测可注入空实现） */
  loadActions?: (
    symbols: readonly string[],
    start: string,
    end: string,
  ) => Promise<CorporateAction[]>;
  /** 交易日历装载（单测注入内存日历，避免依赖真实行情库） */
  loadCalendar?: () => Promise<TradingCalendar>;
}

function loadAccount(db: Database.Database, accountId: number): AccountRow | undefined {
  return db.prepare('SELECT * FROM paper_account WHERE id = ? AND is_deleted = 0').get(accountId) as
    | AccountRow
    | undefined;
}

function loadPendingRows(db: Database.Database, accountId: number, tradeDate: string): OrderRow[] {
  return db
    .prepare(
      `SELECT * FROM paper_order
        WHERE account_id = ? AND trade_date = ? AND status = 'pending' AND is_deleted = 0
        ORDER BY seq ASC, id ASC`,
    )
    .all(accountId, tradeDate) as OrderRow[];
}

function loadPositions(db: Database.Database, accountId: number): PositionRow[] {
  return db
    .prepare(
      `SELECT * FROM paper_position WHERE account_id = ? AND is_deleted = 0 AND qty > 0
        ORDER BY asset_code ASC`,
    )
    .all(accountId) as PositionRow[];
}

/**
 * pending 行 → 引擎目标集；无挂单返回 `null`
 *
 * ⚠️ `liquidate` 行**不能**放进 `targets`：
 * 引擎的清仓逻辑是「replace 模式下、持仓标的**不在** targets 中 ⇒ 卖出」
 * （`simulator.ts` §1）。把清仓行塞成 `targetNotional: 0` 的 target，
 * 会让它被当买入目标处理（产出 `below-min-notional` / `round-lot-zero` 的**买单**跳过），
 * 真实卖出反而不发生 —— 2026-11-08 实测踩到，卖出单被写成 `side='buy'`。
 */
function targetsFromOrders(rows: readonly OrderRow[]): TargetSet | null {
  if (rows.length === 0) return null;
  const targets: TargetPosition[] = rows
    .filter((row) => row.intent_kind === 'target')
    .map((row) => ({
      symbol: row.asset_code,
      ...(row.target_weight !== null ? { targetWeight: row.target_weight } : {}),
      targetNotional: row.target_notional ?? 0,
      reason: 'rebalance',
    }));
  return { targets, mode: rows[0]?.rebalance_mode ?? 'replace' };
}

/** 当日净值点的附加项（引擎不产出）：缺 bar 的持仓数 */
function countStaleSymbols(
  execBars: ReadonlyMap<string, readonly Bar[]>,
  positions: readonly { symbol: string }[],
  tradeDate: string,
): number {
  let stale = 0;
  for (const pos of positions) {
    if (!findBarByDate(execBars.get(pos.symbol) ?? [], tradeDate)) stale += 1;
  }
  return stale;
}

interface SettleDayResult {
  fills: Fill[];
  skipped: SkippedOrder[];
  equity: {
    equity: number;
    cash: number;
    riskMv: number;
    cashMv: number;
    exposure: number;
    benchmarkClose: number | null;
    benchmarkStale: boolean;
  };
}

/** 跑一天（不落库），全部复用回测引擎的成交/估值逻辑 */
function runSettleDay(args: {
  data: BacktestData;
  portfolio: Portfolio;
  /** `null` = 该日无挂单：只做除权 + 收盘估值，不成交（与回测「策略返回 null」的日线一致） */
  targets: TargetSet | null;
  cutoffEquity: number;
  priceMode: 'open' | 'close';
  rules: TradeRules;
  actionsByDate: ReadonlyMap<string, readonly CorporateAction[]>;
  tradeDate: string;
}): SettleDayResult | null {
  if (args.data.calendar.prev(args.tradeDate) === null) return null;

  const state = {
    data: args.data,
    strategy: SETTLE_ONLY_STRATEGY,
    params: {},
    priceMode: args.priceMode,
    rules: args.rules,
    suspension: DEFAULT_SUSPENSION,
    actionsByDate: args.actionsByDate,
    portfolio: args.portfolio,
    equity: [],
    trades: [],
    skippedAll: [],
    warningsAll: [],
    decisions: [],
    roundTripNotified: new Set<number>(),
    universeStats: {
      days: 0,
      noNameCandidateTotal: 0,
      noNameCandidateMax: 0,
      fallbackPoolMemberTotal: 0,
      fallbackPoolMemberMax: 0,
    },
    tradedNotional: 0,
  } as unknown as BacktestRunState;

  const stepArgs: StepBacktestDayArgs =
    args.targets === null
      ? { dayIndex: 0, execDate: args.tradeDate, targetsOverride: null }
      : {
          dayIndex: 0,
          execDate: args.tradeDate,
          targetsOverride: args.targets,
          targetsTruncatedByCaller: true,
          equityAtCutoffOverride: args.cutoffEquity,
        };
  const record = stepBacktestDay(state, stepArgs);
  if (record === null) return null;

  const point = state.equity[state.equity.length - 1];
  if (!point) throw new BacktestInvariantError(`结算 ${args.tradeDate} 未产生净值点`);

  return {
    fills: state.trades,
    skipped: state.skippedAll,
    equity: {
      equity: point.equity,
      cash: point.cash,
      riskMv: point.riskMv,
      cashMv: point.cashMv,
      exposure: point.exposure,
      benchmarkClose: point.benchmarkClose,
      benchmarkStale: point.benchmarkStale ?? false,
    },
  };
}

/** 写库（单事务，任何一步失败整体回滚） */
function writeSettleDay(args: {
  db: Database.Database;
  account: AccountRow;
  tradeDate: string;
  rows: readonly OrderRow[];
  result: SettleDayResult;
  portfolio: Portfolio;
  execBars: ReadonlyMap<string, readonly Bar[]>;
  nowText: string;
}): { filled: number; unfilled: number; noop: number } {
  const { db, account, tradeDate, rows, result, portfolio, execBars, nowText } = args;

  const updateOrder = db.prepare(
    `UPDATE paper_order
        SET status = ?, side = ?, filled_qty = ?, fill_price = ?, filled_notional = ?,
            fee = ?, slippage_cost = ?, unfilled_reason = ?, unfilled_detail = ?,
            settled_at = ?, updated_at = ?
      WHERE id = ?`,
  );
  const markAllDeleted = db.prepare(
    `UPDATE paper_position SET is_deleted = 1, updated_at = ? WHERE account_id = ? AND is_deleted = 0`,
  );
  const upsertPosition = db.prepare(
    `INSERT INTO paper_position (
       account_id, asset_code, qty, avg_cost, cost_basis, closeable_qty,
       last_buy_date, last_price, last_price_date, is_deleted, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(account_id, asset_code) DO UPDATE SET
       qty = excluded.qty,
       avg_cost = excluded.avg_cost,
       cost_basis = excluded.cost_basis,
       closeable_qty = excluded.closeable_qty,
       last_buy_date = excluded.last_buy_date,
       last_price = excluded.last_price,
       last_price_date = excluded.last_price_date,
       is_deleted = 0,
       updated_at = excluded.updated_at`,
  );
  const insertEquity = db.prepare(
    `INSERT INTO paper_equity (
       account_id, trade_date, equity, cash, risk_mv, cash_mv, exposure,
       benchmark_close, benchmark_stale, drawdown_ratio, stale_symbol_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, trade_date) DO UPDATE SET
       equity = excluded.equity,
       cash = excluded.cash,
       risk_mv = excluded.risk_mv,
       cash_mv = excluded.cash_mv,
       exposure = excluded.exposure,
       benchmark_close = excluded.benchmark_close,
       benchmark_stale = excluded.benchmark_stale,
       drawdown_ratio = excluded.drawdown_ratio,
       stale_symbol_count = excluded.stale_symbol_count,
       updated_at = datetime('now', 'localtime')`,
  );
  const updateAccount = db.prepare(
    `UPDATE paper_account
        SET cash = ?,
            last_settled_date = CASE
              WHEN last_settled_date IS NULL OR last_settled_date < ? THEN ?
              ELSE last_settled_date END,
            updated_at = ?
      WHERE id = ? AND is_deleted = 0`,
  );

  const counts = { filled: 0, unfilled: 0, noop: 0 };
  const usedFillIdx = new Set<number>();

  const tx = db.transaction(() => {
    // 幂等二次确认（事务内）：以 `last_settled_date` 作日推进水位。
    // ⚠️ 不能用「paper_equity 存在」作判据 —— 切阶段会在 `ledger_start_date` 写**种子净值点**
    //    （§3.3），首日结算必须覆盖它；也不能在事务外判水位，并发第二个写入者会重复除权。
    const water = db
      .prepare('SELECT last_settled_date FROM paper_account WHERE id = ?')
      .get(account.id) as { last_settled_date: string | null } | undefined;
    if (water?.last_settled_date && water.last_settled_date >= tradeDate) return;

    for (const row of rows) {
      // ⚠️ 同一标的可能出现「同符号、不同方向」成交/跳过（清仓目标 + 零手数买单等），
      //    故先按符号收窄，再优先取方向与订单一致的那条，避免卖出事件被写成 buy。
      const expectedSide: 'buy' | 'sell' = row.intent_kind === 'liquidate' ? 'sell' : row.side;
      const fillCandidates = result.fills
        .map((fill, idx) => ({ fill, idx }))
        .filter(({ fill, idx }) => !usedFillIdx.has(idx) && fill.symbol === row.asset_code);
      const matchedFill =
        fillCandidates.find(({ fill }) => fill.side === expectedSide) ?? fillCandidates[0];
      if (matchedFill) {
        usedFillIdx.add(matchedFill.idx);
        const fill = matchedFill.fill;
        updateOrder.run(
          'filled',
          fill.side,
          fill.qty,
          fill.price,
          Math.abs(fill.qty * fill.price),
          fill.fee,
          fill.slippageCost,
          null,
          null,
          nowText,
          nowText,
          row.id,
        );
        counts.filled += 1;
        continue;
      }

      const skipCandidates = result.skipped.filter((item) => item.symbol === row.asset_code);
      const skip = skipCandidates.find((item) => item.side === expectedSide) ?? skipCandidates[0];
      if (skip) {
        updateOrder.run(
          'unfilled',
          skip.side,
          0,
          null,
          0,
          0,
          0,
          skip.reason,
          skip.detail ?? null,
          nowText,
          nowText,
          row.id,
        );
        counts.unfilled += 1;
        continue;
      }

      updateOrder.run(
        'noop',
        row.intent_kind === 'liquidate' ? 'sell' : 'buy',
        0,
        null,
        0,
        0,
        0,
        null,
        null,
        nowText,
        nowText,
        row.id,
      );
      counts.noop += 1;
    }

    // 持仓：先全部软删除，再把当前持仓写回（禁止物理删除）
    markAllDeleted.run(nowText, account.id);
    for (const pos of portfolio.positions()) {
      const price = closeAtOrBefore(execBars.get(pos.symbol), tradeDate);
      const boughtToday = pos.closeableQty < pos.qty;
      upsertPosition.run(
        account.id,
        pos.symbol,
        pos.qty,
        pos.avgCost,
        pos.costBasis,
        pos.closeableQty,
        boughtToday ? tradeDate : null,
        price,
        price === null ? null : tradeDate,
        nowText,
        nowText,
      );
    }

    const peak =
      (
        db
          .prepare('SELECT MAX(equity) AS peak FROM paper_equity WHERE account_id = ? AND trade_date < ?')
          .get(account.id, tradeDate) as { peak: number | null } | undefined
      )?.peak ?? null;
    const drawdown = peak !== null && peak > 0 ? Math.max(0, (peak - result.equity.equity) / peak) : 0;

    insertEquity.run(
      account.id,
      tradeDate,
      result.equity.equity,
      result.equity.cash,
      result.equity.riskMv,
      result.equity.cashMv,
      result.equity.exposure,
      result.equity.benchmarkClose,
      result.equity.benchmarkStale ? 1 : 0,
      drawdown,
      countStaleSymbols(execBars, portfolio.positions(), tradeDate),
      nowText,
    );

    updateAccount.run(result.equity.cash, tradeDate, tradeDate, nowText, account.id);
  });

  tx.immediate();
  return counts;
}

/** 结算某账户所有「交易日已到」的日（含无挂单日），按 trade_date 升序逐日推进 */
export async function settleAccountPending(
  db: Database.Database,
  accountId: number,
  deps: PaperSettleDeps = {},
): Promise<PaperSettleOutcome[]> {
  const account = loadAccount(db, accountId);
  if (!account) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 404, '纸面账户不存在');
  if (account.status !== 'active') {
    return [{ status: 'skipped', accountId, reason: 'account-not-active' }];
  }
  if (account.phase !== 'ledger') {
    return [{ status: 'skipped', accountId, reason: 'shadow-phase' }];
  }
  if (!account.ledger_start_date) {
    return [{ status: 'blocked', accountId, reason: 'ledger-not-started' }];
  }

  const now = deps.now ?? new Date();
  const today = deps.today ?? todayLocalDate(now);
  const calendarDate = deps.resolveCalendarDate
    ? await deps.resolveCalendarDate(today)
    : await resolveTargetTradeDate(today);
  if (!calendarDate) return [{ status: 'blocked', accountId, reason: 'calendar-mismatch' }];

  const quoteDate = deps.resolveQuoteDate
    ? await deps.resolveQuoteDate(today)
    : await resolveLatestQuoteDate();
  if (!quoteDate || quoteDate < calendarDate) {
    return [
      {
        status: 'blocked',
        accountId,
        reason: 'quotes-not-updated',
        detail: `quoteDate=${quoteDate ?? 'null'} < calendarDate=${calendarDate}`,
      },
    ];
  }

  const loadCalendar = deps.loadCalendar ?? loadTradingCalendar;
  const calendar = await loadCalendar();
  if (!calendar.has(calendarDate)) {
    return [{ status: 'blocked', accountId, reason: 'calendar-mismatch' }];
  }

  // 从水位之后的下一个交易日开始：无挂单日也要落估值点（与回测逐日一致，A1）
  const fromDate = account.last_settled_date
    ? calendar.next(account.last_settled_date) ?? null
    : account.ledger_start_date;
  const dueDates = fromDate ? calendar.slice(fromDate, calendarDate) : [];

  if (dueDates.length === 0) {
    return [{ status: 'skipped', accountId, reason: 'no-due-day' }];
  }

  const outcomes: PaperSettleOutcome[] = [];
  for (const tradeDate of dueDates) {
    const outcome = await settleOneDay(db, accountId, tradeDate, deps, now, today);
    outcomes.push(outcome);
    if (outcome.status !== 'done') break;
  }
  return outcomes;
}

async function settleOneDay(
  db: Database.Database,
  accountId: number,
  tradeDate: string,
  deps: PaperSettleDeps,
  now: Date,
  today: string,
): Promise<PaperSettleOutcome> {
  // 逐日重读账户：补算多日时前一天的成交会改变 `cash`（不能用外层快照）
  const account = loadAccount(db, accountId);
  if (!account) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 404, `纸面账户 ${accountId} 不存在`);
  const rows = loadPendingRows(db, accountId, tradeDate);

  const positions = loadPositions(db, accountId);
  const symbols = positions.map((pos) => pos.asset_code);
  const targetSymbols = rows.map((row) => row.asset_code);
  const params = JSON.parse(account.params_json) as Record<string, unknown>;

  const buildData = deps.buildData ?? buildPaperMarketData;
  const dataInput: BuildPaperMarketDataInput = {
    strategyId: account.strategy_id,
    params,
    replayStart: tradeDate,
    end: tradeDate,
    benchmark: account.benchmark_asset_code,
    heldSymbols: [...symbols, ...targetSymbols],
    // 结算走 `targetsOverride`，不需要时点名录（省掉每日一次的全市场池查询）
    withUniverse: false,
  };

  let data: PaperMarketData;
  try {
    data = await buildData(dataInput);
  } catch (err) {
    if (isDuckDbBusy(err)) {
      return {
        status: 'blocked',
        accountId,
        tradeDate,
        reason: 'benchmark-missing',
        detail: 'DuckDB 行情句柄被占用（不落停牌，待下次补算）',
      };
    }
    throw err;
  }

  // 基准当日无 bar ⇒ 全市场未更新（方案 §7.4 / A12）：绝不把整仓判成停牌
  if (!findBarByDate(data.benchmarkBars, tradeDate)) {
    return {
      status: 'blocked',
      accountId,
      tradeDate,
      reason: 'benchmark-missing',
      detail: `基准 ${account.benchmark_asset_code} 在 ${tradeDate} 无 bar`,
    };
  }

  const loadActions = deps.loadActions ?? loadCorporateActions;
  let actionsByDate: Map<string, readonly CorporateAction[]>;
  try {
    const actions = await loadActions(
      [...symbols, ...targetSymbols, account.benchmark_asset_code],
      tradeDate,
      tradeDate,
    );
    const sameDay = actions.filter((action) => action.date === tradeDate);
    actionsByDate = new Map([[tradeDate, sameDay]]);
  } catch (err) {
    if (isDuckDbBusy(err)) {
      return {
        status: 'blocked',
        accountId: account.id,
        tradeDate,
        reason: 'benchmark-missing',
        detail: 'DuckDB 行情句柄被占用（除权装载失败，待下次补算）',
      };
    }
    throw err;
  }

  if (!account.fee_snapshot_json) {
    throw new PaperError('FEE_CONFIG_NOT_FOUND', 409, '纸面账户缺少费用快照，无法结算');
  }
  const rules = feeSnapshotToTradeRules(JSON.parse(account.fee_snapshot_json) as FeeSnapshot);
  const priceMode =
    resolvePaperStrategy(account.strategy_id, account.strategy_version).priceMode ?? 'open';

  const restorePositions: PortfolioRestorePosition[] = positions.map((pos) => ({
    symbol: pos.asset_code,
    qty: pos.qty,
    avgCost: pos.avg_cost,
    closeableQty: pos.closeable_qty,
  }));
  const portfolio = new Portfolio(account.cash);
  if (restorePositions.length > 0) {
    portfolio.restore(
      restorePositions,
      account.cash,
      data.calendar.prev(tradeDate) ?? tradeDate,
    );
  }

  const result = runSettleDay({
    data: data as unknown as BacktestData,
    portfolio,
    targets: targetsFromOrders(rows),
    cutoffEquity: rows[0]?.cutoff_equity ?? 0,
    priceMode,
    rules,
    actionsByDate,
    tradeDate,
  });
  if (result === null) {
    return {
      status: 'blocked',
      accountId: account.id,
      tradeDate,
      reason: 'calendar-mismatch',
      detail: `交易日 ${tradeDate} 没有上一交易日`,
    };
  }

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const nowText = `${today} ${hh}:${mm}:${ss}`;

  let counts;
  try {
    counts = await withBusyRetry(() =>
      writeSettleDay({
        db,
        account,
        tradeDate,
        rows,
        result,
        portfolio,
        execBars: data.execBars,
        nowText,
      }),
    );
  } catch (err) {
    if (isDuckDbBusy(err)) {
      return { status: 'blocked', accountId, tradeDate, reason: 'benchmark-missing' };
    }
    if (isSqliteBusy(err)) {
      return {
        status: 'error',
        accountId,
        tradeDate,
        code: 'PAPER_DB_BUSY',
        message: `结算 ${tradeDate} 时 SQLite 写冲突重试耗尽`,
      };
    }
    throw err;
  }

  return {
    status: 'done',
    accountId: account.id,
    tradeDate,
    filled: counts.filled,
    unfilled: counts.unfilled,
    noop: counts.noop,
  };
}

export interface PaperDailyStageSummary {
  accounts: number;
  settled: number;
  decisions: number;
  failed: number;
  outcomes: PaperDecisionOutcome[];
  settleOutcomes: PaperSettleOutcome[];
}

/**
 * 17:04 段：**先结算（T）再决策（T → T+1）**（方案 §7.1）。
 *
 * 影子账户跳过结算（没有 pending），只跑决策；落账账户两者都跑。
 */
export async function runPaperDailyStage(args: {
  db: Database.Database;
  deps?: PaperSettleDeps;
  silent?: boolean;
}): Promise<PaperDailyStageSummary> {
  const { db, deps = {}, silent = false } = args;
  const accounts = db
    .prepare(`SELECT id FROM paper_account WHERE is_deleted = 0 AND status = 'active' ORDER BY id ASC`)
    .all() as { id: number }[];

  const summary: PaperDailyStageSummary = {
    accounts: accounts.length,
    settled: 0,
    decisions: 0,
    failed: 0,
    outcomes: [],
    settleOutcomes: [],
  };

  for (const account of accounts) {
    try {
      const settleOutcomes = await settleAccountPending(db, account.id, deps);
      summary.settleOutcomes.push(...settleOutcomes);
      summary.settled += settleOutcomes.filter((item) => item.status === 'done').length;
      for (const outcome of settleOutcomes) {
        if (outcome.status === 'error' || outcome.status === 'blocked') {
          summary.failed += 1;
          if (!silent) {
            writeSystemLog({
              logType: 'paper_account',
              level: 'warn',
              message: `纸面账户结算未完成（account=${account.id}）`,
              detail: JSON.stringify(outcome),
            });
          }
        }
      }

      const decision = await runPaperDecision(db, account.id, deps);
      summary.outcomes.push(decision);
      if (decision.status === 'done') summary.decisions += 1;
      if (decision.status === 'error') summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      const code = (err as { code?: string }).code ?? 'PAPER_INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      summary.outcomes.push({ status: 'error', accountId: account.id, code, message });
      if (!silent) {
        writeSystemLog({
          logType: 'paper_account',
          level: 'error',
          message: `纸面账户日更异常（account=${account.id}）`,
          detail: `${code}: ${message}`,
        });
      }
    }
  }

  if (!silent) {
    writeSystemLog({
      logType: 'paper_account',
      level: summary.failed > 0 ? 'warn' : 'info',
      message: '纸面账户日更完成',
      detail: `accounts=${summary.accounts} settled=${summary.settled} decisions=${summary.decisions} failed=${summary.failed}`,
    });
  }

  return summary;
}
