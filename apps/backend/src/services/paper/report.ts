/**
 * 纸面账户只读报告（PA-09）
 *
 * 影子期（方案 §7.8 / PA-09）：展示 `paper_order` 的**目标标的 / 权重 / 信号**，
 * 以及三项质量指标：
 *   1. **目标数**（逐决策日）；
 *   2. **信号稳定性**（相邻决策日的目标集合是否一致）；
 *   3. **数据完整性**（目标标的在决策日有没有 bar、是不是零量停牌）。
 *   影子期**不读** `paper_position` / `paper_equity`（这两张表影子期恒空，读了只会误导）。
 *
 * 落账期：净值序列 + 持仓 + 订单状态分布 + 三项闲置现金口径（§6.7）。
 *
 * ⚠️ 只读：本模块**不写任何表**；`paper_order` 的 `status='shadow'` 行只是信号留痕。
 */
import type Database from 'better-sqlite3';
import { getBars } from '../backtest/marketPanel.js';
import type { Bar } from '../backtest/types.js';
import { getPaperAccount, type PaperAccountDto } from './accountService.js';

export interface PaperOrderDto {
  id: number;
  signalId: string;
  decisionDate: string;
  tradeDate: string;
  seq: number;
  assetCode: string;
  intentKind: 'target' | 'liquidate';
  side: 'buy' | 'sell';
  rebalanceMode: 'replace' | 'incremental';
  targetWeight: number | null;
  targetNotional: number;
  cutoffEquity: number;
  intentNotional: number;
  status: 'shadow' | 'pending' | 'noop' | 'filled' | 'unfilled' | 'superseded';
  filledQty: number;
  fillPrice: number | null;
  filledNotional: number;
  fee: number;
  slippageCost: number;
  unfilledReason: string | null;
  unfilledDetail: string | null;
  isReplayed: boolean;
  settledAt: string | null;
}

export interface PaperPositionDto {
  assetCode: string;
  qty: number;
  avgCost: number;
  costBasis: number;
  closeableQty: number;
  lastPrice: number | null;
  lastPriceDate: string | null;
}

export interface PaperEquityPoint {
  tradeDate: string;
  equity: number;
  cash: number;
  riskMv: number;
  cashMv: number;
  exposure: number;
  benchmarkClose: number | null;
  benchmarkStale: boolean;
  drawdownRatio: number | null;
  staleSymbolCount: number;
}

interface PaperOrderRow {
  id: number;
  signal_id: string;
  decision_date: string;
  trade_date: string;
  seq: number;
  asset_code: string;
  intent_kind: 'target' | 'liquidate';
  side: 'buy' | 'sell';
  rebalance_mode: 'replace' | 'incremental';
  target_weight: number | null;
  target_notional: number;
  cutoff_equity: number;
  intent_notional: number;
  status: PaperOrderDto['status'];
  filled_qty: number;
  fill_price: number | null;
  filled_notional: number;
  fee: number;
  slippage_cost: number;
  unfilled_reason: string | null;
  unfilled_detail: string | null;
  is_replayed: number;
  settled_at: string | null;
}

function toOrderDto(r: PaperOrderRow): PaperOrderDto {
  return {
    id: r.id,
    signalId: r.signal_id,
    decisionDate: r.decision_date,
    tradeDate: r.trade_date,
    seq: r.seq,
    assetCode: r.asset_code,
    intentKind: r.intent_kind,
    side: r.side,
    rebalanceMode: r.rebalance_mode,
    targetWeight: r.target_weight,
    targetNotional: r.target_notional,
    cutoffEquity: r.cutoff_equity,
    intentNotional: r.intent_notional,
    status: r.status,
    filledQty: r.filled_qty,
    fillPrice: r.fill_price,
    filledNotional: r.filled_notional,
    fee: r.fee,
    slippageCost: r.slippage_cost,
    unfilledReason: r.unfilled_reason,
    unfilledDetail: r.unfilled_detail,
    isReplayed: r.is_replayed === 1,
    settledAt: r.settled_at,
  };
}

export interface ListOrdersOptions {
  decisionDate?: string;
  /** 只取这些状态（缺省：全部） */
  statuses?: readonly PaperOrderDto['status'][];
  /** 行数上限（默认 500，最大 2000） */
  limit?: number;
}

/** 订单列表（影子期即「目标清单」）；按 `decision_date DESC, seq ASC` */
export function listPaperOrders(
  db: Database.Database,
  userId: number,
  accountId: number,
  options: ListOrdersOptions = {},
): PaperOrderDto[] {
  getPaperAccount(db, userId, accountId); // 归属校验（跨用户 404）
  const limit = Math.min(Math.max(Number(options.limit ?? 500), 1), 2000);
  const where: string[] = ['account_id = ?', 'is_deleted = 0'];
  const params: unknown[] = [accountId];
  if (options.decisionDate) {
    where.push('decision_date = ?');
    params.push(options.decisionDate);
  }
  if (options.statuses && options.statuses.length > 0) {
    where.push(`status IN (${options.statuses.map(() => '?').join(',')})`);
    params.push(...options.statuses);
  }
  const rows = db
    .prepare(
      `SELECT * FROM paper_order WHERE ${where.join(' AND ')}
        ORDER BY decision_date DESC, seq ASC LIMIT ?`,
    )
    .all(...params, limit) as PaperOrderRow[];
  return rows.map(toOrderDto);
}

export function listPaperPositions(
  db: Database.Database,
  userId: number,
  accountId: number,
): PaperPositionDto[] {
  getPaperAccount(db, userId, accountId);
  const rows = db
    .prepare(
      `SELECT asset_code, qty, avg_cost, cost_basis, closeable_qty, last_price, last_price_date
         FROM paper_position
        WHERE account_id = ? AND is_deleted = 0 AND qty > 0
        ORDER BY asset_code`,
    )
    .all(accountId) as {
    asset_code: string;
    qty: number;
    avg_cost: number;
    cost_basis: number;
    closeable_qty: number;
    last_price: number | null;
    last_price_date: string | null;
  }[];
  return rows.map((r) => ({
    assetCode: r.asset_code,
    qty: r.qty,
    avgCost: r.avg_cost,
    costBasis: r.cost_basis,
    closeableQty: r.closeable_qty,
    lastPrice: r.last_price,
    lastPriceDate: r.last_price_date,
  }));
}

export function listPaperEquity(
  db: Database.Database,
  userId: number,
  accountId: number,
  range: { from?: string; to?: string } = {},
): PaperEquityPoint[] {
  getPaperAccount(db, userId, accountId);
  const where: string[] = ['account_id = ?', 'is_deleted = 0'];
  const params: unknown[] = [accountId];
  if (range.from) {
    where.push('trade_date >= ?');
    params.push(range.from);
  }
  if (range.to) {
    where.push('trade_date <= ?');
    params.push(range.to);
  }
  const rows = db
    .prepare(
      `SELECT trade_date, equity, cash, risk_mv, cash_mv, exposure, benchmark_close,
              benchmark_stale, drawdown_ratio, stale_symbol_count
         FROM paper_equity WHERE ${where.join(' AND ')} ORDER BY trade_date ASC`,
    )
    .all(...params) as {
    trade_date: string;
    equity: number;
    cash: number;
    risk_mv: number;
    cash_mv: number;
    exposure: number;
    benchmark_close: number | null;
    benchmark_stale: number;
    drawdown_ratio: number | null;
    stale_symbol_count: number;
  }[];
  return rows.map((r) => ({
    tradeDate: r.trade_date,
    equity: r.equity,
    cash: r.cash,
    riskMv: r.risk_mv,
    cashMv: r.cash_mv,
    exposure: r.exposure,
    benchmarkClose: r.benchmark_close,
    benchmarkStale: r.benchmark_stale === 1,
    drawdownRatio: r.drawdown_ratio,
    staleSymbolCount: r.stale_symbol_count,
  }));
}

export interface PaperShadowReport {
  /** 最近决策日（无则 null） */
  latestDecisionDate: string | null;
  latestTradeDate: string | null;
  /** 最近决策日的目标清单（含权重 / 意图金额） */
  latestTargets: PaperOrderDto[];
  days: {
    decisionDate: string;
    tradeDate: string;
    targetCount: number;
    buyIntentCount: number;
    sellIntentCount: number;
    liquidateCount: number;
  }[];
  stability: {
    comparedDays: number;
    identicalDays: number;
    changedDays: number;
    longestIdenticalRun: number;
    latestTargetSignature: string | null;
  };
  dataQuality: {
    checkedPairs: number;
    missingBarPairs: number;
    zeroVolumePairs: number;
    byDate: Record<string, { missingBar: number; zeroVolume: number }>;
  };
  orderCounts: Record<string, number>;
}

export interface PaperLedgerReport {
  equity: PaperEquityPoint[];
  positions: PaperPositionDto[];
  orderCounts: Record<string, number>;
  unfilledReasons: Record<string, number>;
  latest: {
    tradeDate: string;
    equity: number;
    cash: number;
    cashMv: number;
    exposure: number;
    /** §6.7 三项闲置现金口径 */
    cashRatio: number | null;
    cashLikeRatio: number | null;
    unfilledBuyIntentRatio: number | null;
  } | null;
}

export interface PaperReport {
  account: PaperAccountDto;
  shadow: PaperShadowReport | null;
  ledger: PaperLedgerReport | null;
}

export interface PaperReportDeps {
  /** 行情装载（单测注入，避免依赖行情库） */
  loadBars?: (
    symbols: readonly string[],
    from: string,
    to: string,
  ) => Promise<ReadonlyMap<string, readonly Bar[]>>;
}

const defaultLoadBars = async (symbols: readonly string[], from: string, to: string) =>
  getBars(symbols, from, to, { adjust: 'qfq' });

function countBy<T extends string>(items: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it] = (out[it] ?? 0) + 1;
  return out;
}

/**
 * 目标集合签名（按代码排序，保证顺序无关）
 *
 * ⚠️ `superseded` 是**已被覆盖的旧信号**，若计入签名会把「同日重跑」误判成目标变化；
 * 与 `days` 的口径保持一致，只看非 superseded 的行。
 */
function targetSignature(orders: readonly PaperOrderDto[]): string {
  return orders
    .filter((o) => o.intentKind === 'target' && o.status !== 'superseded')
    .map((o) => o.assetCode)
    .sort()
    .join(',');
}

async function buildShadowReport(
  db: Database.Database,
  accountId: number,
  range: { from?: string; to?: string },
  deps: PaperReportDeps,
): Promise<PaperShadowReport> {
  const where: string[] = ['account_id = ?', "status IN ('shadow', 'superseded')", 'is_deleted = 0'];
  const params: unknown[] = [accountId];
  if (range.from) {
    where.push('decision_date >= ?');
    params.push(range.from);
  }
  if (range.to) {
    where.push('decision_date <= ?');
    params.push(range.to);
  }
  const rows = db
    .prepare(`SELECT * FROM paper_order WHERE ${where.join(' AND ')} ORDER BY decision_date ASC, seq ASC`)
    .all(...params) as PaperOrderRow[];
  const orders = rows.map(toOrderDto);

  const byDate = new Map<string, PaperOrderDto[]>();
  for (const o of orders) {
    const list = byDate.get(o.decisionDate) ?? [];
    list.push(o);
    byDate.set(o.decisionDate, list);
  }
  const dates = [...byDate.keys()].sort();

  const days = dates.map((d) => {
    const list = byDate.get(d) ?? [];
    const live = list.filter((o) => o.status !== 'superseded');
    return {
      decisionDate: d,
      tradeDate: live[0]?.tradeDate ?? list[0]?.tradeDate ?? '',
      targetCount: live.filter((o) => o.intentKind === 'target').length,
      buyIntentCount: live.filter((o) => o.intentKind === 'target' && o.side === 'buy').length,
      sellIntentCount: live.filter((o) => o.intentKind === 'target' && o.side === 'sell').length,
      liquidateCount: live.filter((o) => o.intentKind === 'liquidate').length,
    };
  });

  // 信号稳定性：相邻决策日的目标集合是否一致
  const signatures = dates.map((d) => targetSignature(byDate.get(d) ?? []));
  let identicalDays = 0;
  let longestIdenticalRun = 0;
  let run = 0;
  for (let i = 1; i < signatures.length; i++) {
    if (signatures[i] === signatures[i - 1]) {
      identicalDays++;
      run++;
      if (run > longestIdenticalRun) longestIdenticalRun = run;
    } else {
      run = 0;
    }
  }
  if (signatures.length === 1) longestIdenticalRun = 1;

  // 数据完整性：目标标的在**决策日**是否有 bar / 是否零量停牌（一次区间查询，禁止逐标的循环）
  const liveOrders = orders.filter((o) => o.status !== 'superseded' && o.intentKind === 'target');
  const symbols = [...new Set(liveOrders.map((o) => o.assetCode))];
  const checkedPairs = liveOrders.length;
  let missingBarPairs = 0;
  let zeroVolumePairs = 0;
  const qualityByDate: Record<string, { missingBar: number; zeroVolume: number }> = {};
  for (const d of dates) qualityByDate[d] = { missingBar: 0, zeroVolume: 0 };

  if (symbols.length > 0 && liveOrders.length > 0) {
    const from = dates[0];
    const to = dates[dates.length - 1];
    const load = deps.loadBars ?? defaultLoadBars;
    const bars = await load(symbols, from, to);
    for (const o of liveOrders) {
      const bucket = (qualityByDate[o.decisionDate] ??= { missingBar: 0, zeroVolume: 0 });
      const list = bars.get(o.assetCode) ?? [];
      const bar = list.find((b) => b.date === o.decisionDate);
      if (!bar) {
        missingBarPairs++;
        bucket.missingBar++;
      } else if (!(bar.volume > 0)) {
        zeroVolumePairs++;
        bucket.zeroVolume++;
      }
    }
  }

  const latestDecisionDate = dates.length > 0 ? dates[dates.length - 1] : null;
  const latestRows = latestDecisionDate ? (byDate.get(latestDecisionDate) ?? []) : [];
  const latestTargets = latestRows.filter((o) => o.status !== 'superseded');

  return {
    latestDecisionDate,
    latestTradeDate: latestTargets[0]?.tradeDate ?? latestRows[0]?.tradeDate ?? null,
    latestTargets,
    days,
    stability: {
      comparedDays: Math.max(0, signatures.length - 1),
      identicalDays,
      changedDays: Math.max(0, signatures.length - 1) - identicalDays,
      longestIdenticalRun,
      latestTargetSignature: signatures.length > 0 ? signatures[signatures.length - 1] : null,
    },
    dataQuality: {
      checkedPairs,
      missingBarPairs,
      zeroVolumePairs,
      byDate: qualityByDate,
    },
    orderCounts: countBy(orders.map((o) => o.status)),
  };
}

function buildLedgerReport(
  db: Database.Database,
  userId: number,
  accountId: number,
  range: { from?: string; to?: string },
): PaperLedgerReport {
  const equity = listPaperEquity(db, userId, accountId, range);
  const positions = listPaperPositions(db, userId, accountId);

  const orderWhere: string[] = ['account_id = ?', 'is_deleted = 0'];
  const orderParams: unknown[] = [accountId];
  if (range.from) {
    orderWhere.push('decision_date >= ?');
    orderParams.push(range.from);
  }
  if (range.to) {
    orderWhere.push('decision_date <= ?');
    orderParams.push(range.to);
  }
  const orderRows = db
    .prepare(
      `SELECT status, unfilled_reason, side, intent_notional, filled_notional
                FROM paper_order WHERE ${orderWhere.join(' AND ')}`,
    )
    .all(...orderParams) as {
    status: string;
    unfilled_reason: string | null;
    side: 'buy' | 'sell';
    intent_notional: number;
    filled_notional: number;
  }[];

  const orderCounts = countBy(orderRows.map((r) => r.status));
  const unfilledReasons = countBy(
    orderRows.filter((r) => r.unfilled_reason !== null).map((r) => r.unfilled_reason as string),
  );

  const last = equity.length > 0 ? equity[equity.length - 1] : null;
  let unfilledBuyIntentRatio: number | null = null;
  if (last && last.equity > 0) {
    const unfilledBuy = orderRows
      .filter((r) => r.side === 'buy' && (r.status === 'unfilled' || r.status === 'pending'))
      .reduce((sum, r) => sum + Math.max(0, r.intent_notional - r.filled_notional), 0);
    unfilledBuyIntentRatio = unfilledBuy / last.equity;
  }

  return {
    equity,
    positions,
    orderCounts,
    unfilledReasons,
    latest: last
      ? {
          tradeDate: last.tradeDate,
          equity: last.equity,
          cash: last.cash,
          cashMv: last.cashMv,
          exposure: last.exposure,
          // 三项闲置现金口径（§6.7）：纯现金 / 现金类 ETF 计入 / 未成交买入意图
          cashRatio: last.equity > 0 ? last.cash / last.equity : null,
          cashLikeRatio: last.equity > 0 ? (last.cash + last.cashMv) / last.equity : null,
          unfilledBuyIntentRatio,
        }
      : null,
  };
}

/** 只读报告：影子期给信号质量，落账期给净值 / 持仓 / 订单分布 */
export async function getPaperReport(
  db: Database.Database,
  userId: number,
  accountId: number,
  range: { from?: string; to?: string } = {},
  deps: PaperReportDeps = {},
): Promise<PaperReport> {
  const account = getPaperAccount(db, userId, accountId);
  if (account.phase === 'shadow') {
    return {
      account,
      shadow: await buildShadowReport(db, accountId, range, deps),
      ledger: null,
    };
  }
  return {
    account,
    shadow: null,
    ledger: buildLedgerReport(db, userId, accountId, range),
  };
}
