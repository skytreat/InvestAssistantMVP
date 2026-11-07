/**
 * 纸面账户影子决策（PA-08）与日更编排
 *
 * 时序（方案 §7.1）：17:04 段先结算 T，再决策 T+1。**S2 只做决策**（落账期结算属 PA-10）。
 *
 * 影子期口径（方案 §3.1 / §7.x）：
 *   - 决策日 `T` = 日历上的最近交易日，且**全市场行情已更新到 T**（否则阻塞，不猜）；
 *   - 成交日 = `nextTradingDay(T)`（工作日 − `raw_holidays`）；
 *   - 只写 `paper_order(status='shadow')`；**不写** `paper_position` / `paper_equity`（影子期持仓恒空）；
 *   - 同日重跑幂等：`UNIQUE(account_id, decision_date, asset_code)` + UPSERT，消失的目标标 `superseded`。
 *
 * 🔴 **策略内部状态不持久化**（`paper_account` 无 state 列，DDL 已定稿）
 *   ⇒ 每次决策把 `[start_date .. T]` 的决策**重放一遍**（`wufu-rotation` 的走弱期状态跨日演进）。
 *   ⇒ 回放中间日使用**空组合**（只重建策略状态），最终日 T 才用检查点组合。
 *      契约：纸面策略的 `decide()` 内部状态**不得依赖持仓**，否则回放会失真（当前两个内置策略满足）。
 */
import type Database from 'better-sqlite3';
import { Portfolio, type PortfolioRestorePosition } from '../backtest/account/portfolio.js';
import { BacktestInvariantError, makeContext, universeViewOf } from '../backtest/engine.js';
import { loadHolidayList, nextTradingDay } from '../backtest/calendar.js';
import { findBarByDate } from '../backtest/marketPanel.js';
import type { Bar } from '../backtest/types.js';
import type { Strategy, TargetSet } from '../backtest/strategy/types.js';
import { resolveLatestQuoteDate, resolveTargetTradeDate } from '../marketData.js';
import { writeSystemLog } from '../logger.js';
import { PaperError } from './errors.js';
import { resolvePaperStrategy } from './strategies.js';
import { todayLocalDate } from './accountService.js';
import { buildPaperMarketData, type BuildPaperMarketDataInput, type PaperMarketData } from './marketData.js';

/** `paper_account` 决策需要的列（只取本模块用到的） */
interface DecisionAccountRow {
  id: number;
  user_id: number;
  strategy_id: string;
  strategy_version: string;
  params_json: string;
  phase: 'shadow' | 'ledger';
  status: 'active' | 'paused' | 'closed';
  cash: number;
  start_date: string | null;
  ledger_start_date: string | null;
  benchmark_asset_code: string;
}

export interface PaperDecisionDeps {
  /** 判定「今天」的本地日期（YYYY-MM-DD）；缺省 = 当前本地日期 */
  today?: string;
  now?: Date;
  resolveCalendarDate?: (referenceDate: string) => Promise<string | null>;
  resolveQuoteDate?: (referenceDate: string) => Promise<string | null>;
  loadHolidays?: () => Promise<string[]>;
  /** 行情装载（单测注入合成数据，避免依赖行情库） */
  buildData?: (input: BuildPaperMarketDataInput) => Promise<PaperMarketData>;
}

export type PaperDecisionOutcome =
  | {
      status: 'done';
      accountId: number;
      decisionDate: string;
      tradeDate: string;
      /** 目标标的数（`intent_kind='target'`） */
      targetCount: number;
      /** 写入 / 更新后的订单行数 */
      orderCount: number;
      /** 本次被标记 `superseded` 的旧行数 */
      superseded: number;
      /** 策略在最终日给出的 warn 日志 */
      warnings: string[];
    }
  | { status: 'skipped'; accountId: number; reason: 'account-not-active' }
  | {
      status: 'blocked';
      accountId: number;
      reason:
        | 'calendar-unavailable'
        | 'quotes-not-updated'
        | 'calendar-mismatch'
        | 'benchmark-missing'
        | 'replay-empty';
      detail: string;
    }
  | { status: 'error'; accountId: number; code: string; message: string };

interface DraftOrder {
  assetCode: string;
  intentKind: 'target' | 'liquidate';
  side: 'buy' | 'sell';
  targetWeight: number | null;
  targetNotional: number;
  intentNotional: number;
}

function loadAccount(db: Database.Database, accountId: number): DecisionAccountRow {
  const row = db
    .prepare(
      `SELECT id, user_id, strategy_id, strategy_version, params_json, phase, status, cash,
              start_date, ledger_start_date, benchmark_asset_code
         FROM paper_account WHERE id = ? AND is_deleted = 0`,
    )
    .get(accountId) as DecisionAccountRow | undefined;
  if (!row) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 404, `纸面账户 ${accountId} 不存在`);
  return row;
}

/**
 * 落账期回放起点（「切换即冷启动」）
 *
 * 切换当日 `ledger_start_date = nextTradingDay(T)` 会晚于决策日 T，直接用它会得到空回放区间；
 * 故取 `min(ledger_start_date, decisionDate)`，保证切换当日就能产出第一笔 `pending`。
 */
function coldStartOf(account: DecisionAccountRow, decisionDate: string): string {
  const ledgerStart = account.ledger_start_date ?? decisionDate;
  return ledgerStart <= decisionDate ? ledgerStart : decisionDate;
}

function loadPositions(db: Database.Database, accountId: number): PortfolioRestorePosition[] {
  const rows = db
    .prepare(
      `SELECT asset_code, qty, avg_cost, closeable_qty FROM paper_position
        WHERE account_id = ? AND is_deleted = 0 AND qty > 0 ORDER BY asset_code`,
    )
    .all(accountId) as { asset_code: string; qty: number; avg_cost: number; closeable_qty: number }[];
  return rows.map((r) => ({
    symbol: r.asset_code,
    qty: r.qty,
    avgCost: r.avg_cost,
    closeableQty: r.closeable_qty,
  }));
}

/** 最后一根 date ≤ cutoff 的收盘价（找不到返回 null） */
function closeAtOrBefore(bars: readonly Bar[] | undefined, cutoff: string): number | null {
  if (!bars) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= cutoff) return bars[i].close;
  }
  return null;
}

function pricesAt(
  positions: readonly PortfolioRestorePosition[],
  execBars: PaperMarketData['execBars'],
  asOf: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of positions) out.set(p.symbol, closeAtOrBefore(execBars.get(p.symbol), asOf) ?? 0);
  return out;
}

/**
 * 把 `TargetSet` 翻成订单意图（影子期只落 `status='shadow'`）。
 *
 * - `hold: true` 不落行（无买卖意图；`paper_order.side` 无法表达 hold）
 * - `replace` 模式下不在 targets 里的持仓 → `intent_kind='liquidate'`，`side='sell'`，全额意图
 * - 目标既无 `targetWeight` 也无 `targetNotional` → 策略违约（抛，不静默跳过）
 */
function draftOrders(args: {
  targets: TargetSet;
  portfolio: Portfolio;
  prices: ReadonlyMap<string, number>;
  cutoffEquity: number;
}): DraftOrder[] {
  const { targets, portfolio, prices, cutoffEquity } = args;
  const drafts: DraftOrder[] = [];
  const targeted = new Set<string>();

  for (const t of targets.targets) {
    if (t.hold === true) {
      if (portfolio.position(t.symbol).qty <= 0) {
        throw new BacktestInvariantError(`纸上决策: ${t.symbol} 目标为 hold 但当期无持仓（策略违约）`);
      }
      targeted.add(t.symbol);
      continue;
    }
    targeted.add(t.symbol);

    let targetNotional: number | null = typeof t.targetNotional === 'number' ? t.targetNotional : null;
    if (targetNotional === null && typeof t.targetWeight === 'number') {
      targetNotional = t.targetWeight * cutoffEquity;
    }
    if (targetNotional === null) {
      throw new BacktestInvariantError(
        `纸上决策: ${t.symbol} 目标既无 targetWeight 也无 targetNotional（策略违约）`,
      );
    }

    const currentValue = portfolio.position(t.symbol).qty * (prices.get(t.symbol) ?? 0);
    const delta = targetNotional - currentValue;
    drafts.push({
      assetCode: t.symbol,
      intentKind: 'target',
      side: delta >= 0 ? 'buy' : 'sell',
      targetWeight: typeof t.targetWeight === 'number' ? t.targetWeight : null,
      targetNotional,
      intentNotional: Math.abs(delta),
    });
  }

  if (targets.mode === 'replace') {
    for (const pos of portfolio.positions()) {
      if (targeted.has(pos.symbol)) continue;
      const currentValue = pos.qty * (prices.get(pos.symbol) ?? 0);
      drafts.push({
        assetCode: pos.symbol,
        intentKind: 'liquidate',
        side: 'sell',
        targetWeight: 0,
        targetNotional: 0,
        intentNotional: currentValue,
      });
    }
  }

  return drafts;
}

/** 信号 id（内部自关联键；确定性，保证同日重跑 upsert 命中） */
export function paperSignalId(accountId: number, decisionDate: string, assetCode: string): string {
  return `psig_${accountId}_${decisionDate}_${assetCode}`;
}

/** 影子决策主流程 */
export async function runPaperDecision(
  db: Database.Database,
  accountId: number,
  deps: PaperDecisionDeps = {},
): Promise<PaperDecisionOutcome> {
  const account = loadAccount(db, accountId);
  if (account.status !== 'active') return { status: 'skipped', accountId, reason: 'account-not-active' };
  // 落账期（S3 起）：决策同样跑，只是产出 `pending`（次日 17:04 结算）
  const orderStatus: 'shadow' | 'pending' = account.phase === 'ledger' ? 'pending' : 'shadow';

  const resolveCalendar = deps.resolveCalendarDate ?? resolveTargetTradeDate;
  const resolveQuote = deps.resolveQuoteDate ?? resolveLatestQuoteDate;
  const holidays = deps.loadHolidays ?? loadHolidayList;
  const buildData = deps.buildData ?? buildPaperMarketData;

  const referenceDate = deps.today ?? todayLocalDate(deps.now);
  const calendarDate = await resolveCalendar(referenceDate);
  if (!calendarDate) {
    return { status: 'blocked', accountId, reason: 'calendar-unavailable', detail: referenceDate };
  }
  const quoteDate = await resolveQuote(referenceDate);
  if (!quoteDate || quoteDate < calendarDate) {
    return {
      status: 'blocked',
      accountId,
      reason: 'quotes-not-updated',
      detail: `${referenceDate} 日历=${calendarDate} 行情=${quoteDate ?? '无'}`,
    };
  }

  const decisionDate = calendarDate;
  const params = JSON.parse(account.params_json) as Record<string, unknown>;
  // 落账期「切换即冷启动」：回放起点 = `ledger_start_date`，影子期的历史决策不参与重建。
  // 切换当日 `ledger_start_date = nextTradingDay(T)` 会晚于决策日 T，故取两者较小值，
  // 否则回放区间为空（§8.2 冷启动口径：水位重置，历史影子订单不补记）。
  const replayStart =
    orderStatus === 'pending'
      ? coldStartOf(account, decisionDate)
      : account.start_date ?? decisionDate;
  const positions = loadPositions(db, accountId);

  const data = await buildData({
    strategyId: account.strategy_id,
    params,
    replayStart,
    end: decisionDate,
    benchmark: account.benchmark_asset_code,
    heldSymbols: positions.map((p) => p.symbol),
  });

  // 方案 §7.3：T 必须是真交易日（全市场行情已更新），基准当日也必须有 bar —— 否则阻塞
  if (!data.calendar.has(decisionDate)) {
    return {
      status: 'blocked',
      accountId,
      reason: 'calendar-mismatch',
      detail: `日历无 ${decisionDate}（行情= ${quoteDate}）`,
    };
  }
  if (!findBarByDate(data.benchmarkBars, decisionDate)) {
    return {
      status: 'blocked',
      accountId,
      reason: 'benchmark-missing',
      detail: `基准 ${account.benchmark_asset_code} 在 ${decisionDate} 无 bar`,
    };
  }

  let tradeDate: string;
  try {
    tradeDate = nextTradingDay(decisionDate, await holidays());
  } catch (err) {
    return {
      status: 'blocked',
      accountId,
      reason: 'calendar-unavailable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const days = data.calendar.slice(replayStart, decisionDate);
  if (days.length === 0) {
    return {
      status: 'blocked',
      accountId,
      reason: 'replay-empty',
      detail: `回放区间 ${replayStart}~${decisionDate} 无交易日`,
    };
  }

  // ── 回放：重建策略内部状态（中间日空组合，仅最终日用检查点组合）──
  const strategy: Strategy = resolvePaperStrategy(account.strategy_id, account.strategy_version);
  strategy.init?.({ params });

  const emptyPortfolio = new Portfolio(account.cash);
  const checkpointPortfolio = new Portfolio(account.cash);
  if (positions.length > 0) checkpointPortfolio.restore(positions, account.cash, decisionDate);
  const emptyPrices = new Map<string, number>();
  const checkpointPrices = pricesAt(positions, data.execBars, decisionDate);

  let finalTargets: TargetSet | null = null;
  const finalWarnings: string[] = [];

  for (let i = 0; i < days.length; i++) {
    const asOf = days[i];
    const execDate = i + 1 < days.length ? days[i + 1] : tradeDate;
    const snapshot = data.universe(asOf);
    if (snapshot.asOf !== asOf) {
      throw new BacktestInvariantError(
        `纸上决策: 时点名录用 ${snapshot.asOf} 而不是 ${asOf}（行情缺日，不能猜）`,
      );
    }
    const isFinal = i === days.length - 1;
    const portfolio = isFinal ? checkpointPortfolio : emptyPortfolio;
    const prices = isFinal ? checkpointPrices : emptyPrices;
    const logs: { level: 'info' | 'warn'; message: string }[] = [];

    const ctx = makeContext({
      asOf,
      execDate,
      dayIndex: i,
      params,
      signalBars: data.signalBars,
      indexBars: data.indexBars,
      universeView: universeViewOf(snapshot),
      portfolio,
      pricesAtAsOf: prices,
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs,
    });

    const targets = strategy.decide(ctx);
    if (isFinal) {
      finalTargets = targets;
      for (const l of logs) if (l.level === 'warn') finalWarnings.push(l.message);
    }
  }

  const drafts = finalTargets
    ? draftOrders({
        targets: finalTargets,
        portfolio: checkpointPortfolio,
        prices: checkpointPrices,
        cutoffEquity: checkpointPortfolio.equity(checkpointPrices),
      })
    : [];

  const upsert = db.prepare(`
    INSERT INTO paper_order (
      account_id, signal_id, decision_date, trade_date, seq, asset_code,
      intent_kind, side, rebalance_mode, target_weight, target_notional,
      cutoff_equity, intent_notional, status, is_replayed, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(account_id, signal_id) DO UPDATE SET
      trade_date = excluded.trade_date,
      seq = excluded.seq,
      intent_kind = excluded.intent_kind,
      side = excluded.side,
      rebalance_mode = excluded.rebalance_mode,
      target_weight = excluded.target_weight,
      target_notional = excluded.target_notional,
      cutoff_equity = excluded.cutoff_equity,
      intent_notional = excluded.intent_notional,
      status = excluded.status,
      is_deleted = 0,
      updated_at = datetime('now', 'localtime')
  `);
  const cutoffEquity = checkpointPortfolio.equity(checkpointPrices);
  const rebalanceMode = finalTargets?.mode ?? 'replace';

  const writeAll = db.transaction(() => {
    const settled = db
      .prepare(
        `SELECT COUNT(*) AS n FROM paper_order
          WHERE account_id = ? AND decision_date = ? AND settled_at IS NOT NULL`,
      )
      .get(accountId, decisionDate) as { n: number };
    if (settled.n > 0) {
      throw new PaperError(
        'PAPER_ALREADY_SETTLED',
        409,
        `${decisionDate} 已有 ${settled.n} 条已结算订单，禁止重写信号`,
      );
    }

    const keys: string[] = [];
    drafts.forEach((d, seq) => {
      const signalId = paperSignalId(accountId, decisionDate, d.assetCode);
      keys.push(signalId);
      upsert.run(
        accountId,
        signalId,
        decisionDate,
        tradeDate,
        seq,
        d.assetCode,
        d.intentKind,
        d.side,
        rebalanceMode,
        d.targetWeight,
        d.targetNotional,
        cutoffEquity,
        d.intentNotional,
        orderStatus,
      );
    });

    let superseded = 0;
    if (keys.length > 0) {
      const placeholders = keys.map(() => '?').join(',');
      const res = db
        .prepare(
          `UPDATE paper_order SET status = 'superseded', updated_at = datetime('now', 'localtime')
            WHERE account_id = ? AND decision_date = ? AND settled_at IS NULL
              AND status IN ('shadow', 'pending')
              AND signal_id NOT IN (${placeholders})`,
        )
        .run(accountId, decisionDate, ...keys);
      superseded = res.changes;
    } else {
      const res = db
        .prepare(
          `UPDATE paper_order SET status = 'superseded', updated_at = datetime('now', 'localtime')
            WHERE account_id = ? AND decision_date = ? AND settled_at IS NULL
              AND status IN ('shadow', 'pending')`,
        )
        .run(accountId, decisionDate);
      superseded = res.changes;
    }

    db.prepare(
      `UPDATE paper_account SET
         start_date = COALESCE(start_date, ?),
         last_decision_date = CASE
           WHEN last_decision_date IS NULL OR last_decision_date < ? THEN ?
           ELSE last_decision_date END,
         updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
    ).run(decisionDate, decisionDate, decisionDate, accountId);

    return superseded;
  });

  const superseded = writeAll();

  return {
    status: 'done',
    accountId,
    decisionDate,
    tradeDate,
    targetCount: drafts.filter((d) => d.intentKind === 'target').length,
    orderCount: drafts.length,
    superseded,
    warnings: finalWarnings,
  };
}

export interface PaperDecisionStageSummary {
  /** 本段判定日（日历 T） */
  decisionDate: string | null;
  accounts: number;
  done: number;
  blocked: number;
  skipped: number;
  failed: number;
  results: PaperDecisionOutcome[];
}

/**
 * 17:04 纸面日更段：遍历 `active` 账户逐个决策。
 *
 * - 影子期 → `paper_order(status='shadow')`；落账期 → `status='pending'`（次日 17:04 结算，PA-10）；
 * - 策略版本不匹配 → **账户置 paused + ERROR 日志**（方案 §7.5 / §12.3，不回退最新版本）。
 */
export async function runPaperDecisionStage(args: {
  db: Database.Database;
  deps?: PaperDecisionDeps;
  /** 关闭 system_log 写入（单测用） */
  silent?: boolean;
}): Promise<PaperDecisionStageSummary> {
  const db = args.db;
  const deps = args.deps ?? {};
  const rows = db
    .prepare(`SELECT id FROM paper_account WHERE is_deleted = 0 AND status = 'active' ORDER BY id`)
    .all() as { id: number }[];

  const results: PaperDecisionOutcome[] = [];
  let failed = 0;
  const pause = db.prepare(
    `UPDATE paper_account SET status = 'paused', updated_at = datetime('now', 'localtime') WHERE id = ?`,
  );

  for (const row of rows) {
    try {
      results.push(await runPaperDecision(db, row.id, deps));
    } catch (err) {
      failed++;
      const code = err instanceof PaperError ? err.code : 'INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'STRATEGY_VERSION_NOT_FOUND' || code === 'STRATEGY_NOT_FOUND') {
        pause.run(row.id);
      }
      if (!args.silent) {
        writeSystemLog({
          logType: 'paper_account',
          level: 'ERROR',
          message: `纸面账户 ${row.id} 决策失败：${message}`,
          checkItem: code,
        });
      }
      results.push({ status: 'error', accountId: row.id, code, message });
    }
  }

  let decisionDate: string | null = null;
  for (const r of results) if (r.status === 'done') decisionDate = r.decisionDate;

  const summary: PaperDecisionStageSummary = {
    decisionDate,
    accounts: rows.length,
    done: results.filter((r) => r.status === 'done').length,
    blocked: results.filter((r) => r.status === 'blocked').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed,
    results,
  };

  if (!args.silent) {
    const blockedReasons: string[] = [];
    for (const r of results) if (r.status === 'blocked') blockedReasons.push(`${r.accountId}:${r.reason}`);
    writeSystemLog({
      logType: 'paper_account',
      level: summary.done > 0 || summary.accounts === 0 ? 'INFO' : 'WARN',
      message:
        `纸面日更：账户 ${summary.accounts} / 完成 ${summary.done} / 阻塞 ${summary.blocked} / 跳过 ${summary.skipped}` +
        (decisionDate ? `（决策日 ${decisionDate}）` : ''),
      detail: blockedReasons.length > 0 ? `阻塞：${blockedReasons.join(', ')}` : undefined,
    });
  }

  return summary;
}
