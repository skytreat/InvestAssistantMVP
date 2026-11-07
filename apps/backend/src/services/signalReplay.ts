// src/services/signalReplay.ts
// F 域「区间回放」：把 [上次成功日, 最新行情日] 之间**逐日**跑一遍插件，
// 信号按各自真实交易日落库（`origin = 'replay'`）。
//
// 为什么需要它：日常链路（17:02 定时 / 手动触发）只算「最新行情日」一个日期，
// 任何一次行情中断都会让中断期间的信号**永久丢失** —— 后面补行情也补不回来。

import { executeAllPlugins, shiftTradeDate, type PluginBatchStats } from './pluginEngine.js';
import {
  persistSignals,
  resolveSignalSymbols,
  resolveLatestSignalDate,
  getTradeDate,
  SIGNAL_USER_ID,
  assignSignalGrades,
  type SignalOrigin,
} from './signalService.js';
import { listTradeDatesBetween, resolveLatestQuoteDate } from './marketData.js';
import { writeSystemLog } from './logger.js';
import { ConfigStore } from '../config/configStore.js';
import type Database from 'better-sqlite3';

/**
 * 回放预取窗口（日历天）。
 * 与内置插件 `days` 参数默认值（120）一致 ⇒ 回放期间插件命中缓存的概率与日常链路相同。
 */
export const REPLAY_PREFETCH_DAYS = 120;

/**
 * **自动起点**单次最多回放的交易日数（默认保护）。
 * 超过时只回放最近 60 个交易日，并在结果里 `truncated = true`（需要更早的请显式传 `from`）。
 */
export const DEFAULT_MAX_AUTO_TRADING_DAYS = 60;

/**
 * **显式区间**的硬上限（交易日）。
 * 超过直接拒绝（不静默截断）：一次 250 天 × 插件数 × 标的数 已接近可接受的上限，
 * 再大应该分段执行，避免把 DuckDB IO 与内存一次性拉满。
 */
export const HARD_MAX_REPLAY_TRADING_DAYS = 250;

/** 库里一条信号都没有时（库空/新装）默认回放最近 20 个交易日。 */
export const DEFAULT_EMPTY_DB_TRADING_DAYS = 20;

/**
 * 并发度固定为 **1**（按日串行）。
 * 理由：DuckDB 是文件级独占锁 + 单连接，后端对行情层只有 SELECT 权限；
 * 并发回放不会更快，只会把 50ms 的插件硬超时挤成 TIMEOUT。
 */
export const REPLAY_CONCURRENCY = 1;

/** 显式区间超过硬上限时抛出（HTTP 400 / CLI 非零退出） */
export class ReplayRangeTooLargeError extends Error {
  readonly dates: number;
  readonly hardMax: number;
  constructor(dates: number) {
    super(`回放区间过大：${dates} 个交易日 > 硬上限 ${HARD_MAX_REPLAY_TRADING_DAYS}，请分段执行`);
    this.name = 'ReplayRangeTooLargeError';
    this.dates = dates;
    this.hardMax = HARD_MAX_REPLAY_TRADING_DAYS;
  }
}

/** 回放起点是怎么定出来的（写进报告与日志，便于事后复核） */
export type ReplayStartSource = 'explicit' | 'signal_max' | 'default_window';

export interface SignalReplayOptions {
  /** 显式起点（YYYY-MM-DD）；不传则按 `MAX(trade_date)+1` 自动推导 */
  fromDate?: string;
  /** 终点（YYYY-MM-DD）；不传 = 最近行情日，再退化为自然日今天 */
  toDate?: string;
  /** 标的域；不传 = 用户的自选 ∪ 持仓（与日常链路同口径） */
  symbols?: string[];
  /** true = 只算不落库（默认 true，CLI / admin 都必须显式关闭才写） */
  dryRun?: boolean;
  userId?: number;
  prefetchDays?: number;
}

export interface ReplayDayResult {
  trade_date: string;
  /** 当日插件统计（与日常链路同一结构） */
  stats: PluginBatchStats;
  /** 当日产出信号条数（不是落库行数） */
  signals: number;
  inserted: number;
  skipped: number;
  errors: number;
  /** dry-run 时的「会写入 / 会因唯一约束跳过」预估（只读查重） */
  wouldInsert?: number;
  wouldSkip?: number;
  error?: string;
}

export interface SignalReplayResult {
  dryRun: boolean;
  startSource: ReplayStartSource;
  /** 自动推导时的参照日（`signal_max` = 库里最大信号日；`default_window` = 无） */
  startAnchor: string | null;
  fromDate: string | null;
  toDate: string;
  dates: string[];
  dayCount: number;
  /** 自动起点被 60 日上限截断 */
  truncated: boolean;
  symbols: string[];
  days: ReplayDayResult[];
  totals: {
    total: number;
    success: number;
    timeout: number;
    error: number;
    skip: number;
    noData: number;
    signals: number;
    inserted: number;
    skipped: number;
    errors: number;
  };
  elapsedMs: number;
  notes: string[];
}

function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} 必须为 YYYY-MM-DD，收到「${value}」`);
  }
}

/**
 * 解析回放区间。
 *
 * 起点口径（按优先级）：
 * 1. 显式 `fromDate`；
 * 2. `user_strategy_signal` 的 `MAX(trade_date)`（`is_deleted = 0`）—— **不含** `system_log`：
 *    - 信号表是「要被填补的产物」本身，权威且不会被备份保留期清理；
 *    - `system_log` 里混有「手动触发 + 人工传 trade_date」的噪声，不能代表覆盖进度；
 * 3. 库里一条信号都没有 → 最近 `DEFAULT_EMPTY_DB_TRADING_DAYS` 个交易日（窗口取终点前 120 日历天）。
 *
 * 日期一律来自**真实行情日**（`raw_kline_daily` 的 DISTINCT date），不按自然日/工作日推算：
 * 节假日、停市、行情停更的日子跑空只会污染口径。
 */
export async function resolveReplayRange(
  options: Pick<SignalReplayOptions, 'fromDate' | 'toDate' | 'userId'>,
): Promise<{
  startSource: ReplayStartSource;
  startAnchor: string | null;
  fromDate: string | null;
  toDate: string;
  dates: string[];
  truncated: boolean;
  notes: string[];
}> {
  const userId = options.userId ?? SIGNAL_USER_ID;
  const notes: string[] = [];

  if (options.toDate) assertDate(options.toDate, 'toDate');
  if (options.fromDate) assertDate(options.fromDate, 'fromDate');

  const toDate = options.toDate ?? (await resolveLatestQuoteDate()) ?? getTradeDate();

  // ── 显式区间：硬上限直接拒绝（不静默截断） ──
  if (options.fromDate) {
    const dates = await listTradeDatesBetween(options.fromDate, toDate);
    if (dates.length > HARD_MAX_REPLAY_TRADING_DAYS) throw new ReplayRangeTooLargeError(dates.length);
    if (dates.length === 0) notes.push('区间内没有任何行情日，回放为空');
    return {
      startSource: 'explicit',
      startAnchor: options.fromDate,
      fromDate: options.fromDate,
      toDate,
      dates,
      truncated: false,
      notes,
    };
  }

  // ── 自动起点：库里最大信号日之后 ──
  const anchor = resolveLatestSignalDate(userId);
  if (anchor) {
    if (anchor > toDate) {
      notes.push(`库内最大信号日 ${anchor} 晚于回放终点 ${toDate}，回放为空`);
      return {
        startSource: 'signal_max',
        startAnchor: anchor,
        fromDate: null,
        toDate,
        dates: [],
        truncated: false,
        notes,
      };
    }
    // 起点 = anchor 的**次一交易日**（枚举后按 `> anchor` 过滤，天然跳过节假日/停牌日）
    let dates = (await listTradeDatesBetween(anchor, toDate)).filter((d) => d > anchor);
    let truncated = false;
    if (dates.length > DEFAULT_MAX_AUTO_TRADING_DAYS) {
      dates = dates.slice(-DEFAULT_MAX_AUTO_TRADING_DAYS);
      truncated = true;
      notes.push(
        `自动起点待回放 ${dates.length}+ 个交易日超过默认上限 ${DEFAULT_MAX_AUTO_TRADING_DAYS}，已只回放最近 ${DEFAULT_MAX_AUTO_TRADING_DAYS} 个交易日（更早的请显式传 fromDate）`,
      );
    }
    if (dates.length === 0) notes.push(`库内最大信号日 ${anchor} 已覆盖到最新行情日 ${toDate}，无需回放`);
    return {
      startSource: 'signal_max',
      startAnchor: anchor,
      fromDate: dates[0] ?? null,
      toDate,
      dates,
      truncated,
      notes,
    };
  }

  // ── 库空：最近 20 个交易日 ──
  const windowFrom = shiftTradeDate(toDate, -120);
  const all = await listTradeDatesBetween(windowFrom, toDate);
  const dates = all.slice(-DEFAULT_EMPTY_DB_TRADING_DAYS);
  notes.push(`库内无任何信号，按默认窗口回放最近 ${dates.length} 个交易日`);
  return {
    startSource: 'default_window',
    startAnchor: null,
    fromDate: dates[0] ?? null,
    toDate,
    dates,
    truncated: false,
    notes,
  };
}

/** 单条信号是否已存在（dry-run 预估计数用；与唯一约束同列） */
function signalExists(
  db: Database.Database,
  userId: number,
  tradeDate: string,
  assetCode: string,
  pluginId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM user_strategy_signal
       WHERE user_id = ? AND asset_code = ? AND plugin_id = ? AND trade_date = ? LIMIT 1`,
    )
    .get(userId, assetCode, pluginId, tradeDate);
  return Boolean(row);
}

/**
 * 区间回放主入口。
 *
 * 🔴 幂等由**数据库**保证：`user_strategy_signal` 有 `UNIQUE(user_id, asset_code, plugin_id, trade_date)`，
 *    写入走 `INSERT OR IGNORE` ⇒ 重复回放只累加 `skipped`，不会产生重复行（不依赖调用方自觉）。
 *
 * 🔴 无前视由 **IO 层**保证：每日的 `executeAllPlugins({ asOfDate: T })` 把预取窗口的终点
 *    （含缓存未命中的回落查询）锁在 T，插件读不到 T 之后的行情。
 */
export async function replaySignals(options: SignalReplayOptions = {}): Promise<SignalReplayResult> {
  const startedAt = Date.now();
  const userId = options.userId ?? SIGNAL_USER_ID;
  const dryRun = options.dryRun ?? true;
  const prefetchDays = options.prefetchDays ?? REPLAY_PREFETCH_DAYS;
  const origin: SignalOrigin = 'replay';

  const db = ConfigStore.getInstance().db;
  const range = await resolveReplayRange({ ...options, userId });
  const symbols = options.symbols?.length ? options.symbols : resolveSignalSymbols(userId);

  const days: ReplayDayResult[] = [];
  const notes = [...range.notes];

  if (range.dates.length === 0) {
    notes.push('无待回放交易日');
  }
  if (symbols.length === 0) {
    notes.push('标的域为空（用户无自选/持仓），未执行任何插件');
  }

  for (const tradeDate of range.dates) {
    if (symbols.length === 0) break;
    const day: ReplayDayResult = {
      trade_date: tradeDate,
      stats: { total: 0, success: 0, timeout: 0, error: 0, skip: 0, noData: 0, positionUnavailable: 0 },
      signals: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
    };
    try {
      // 并发度 = REPLAY_CONCURRENCY(1)：按日串行，单日内部仍是「1 次批量取数 → N 插件共享」
      const result = await executeAllPlugins({ symbols, asOfDate: tradeDate, prefetchDays });
      day.stats = result.stats;
      day.signals = result.signals.length;

      if (dryRun) {
        let wouldInsert = 0;
        let wouldSkip = 0;
        for (const pluginResult of result.results) {
          if (pluginResult.status !== 'SUCCESS') continue;
          for (const s of pluginResult.signals) {
            const exists = signalExists(db, userId, tradeDate, s.symbol, pluginResult.pluginId);
            if (exists) wouldSkip += 1;
            else wouldInsert += 1;
          }
        }
        day.wouldInsert = wouldInsert;
        day.wouldSkip = wouldSkip;
      } else {
        // 每日一个事务（persistSignals 内部 db.transaction），不把整个区间攒在内存里
        for (const pluginResult of result.results) {
          if (pluginResult.status !== 'SUCCESS' || pluginResult.signals.length === 0) continue;
          const persist = persistSignals(
            pluginResult.signals,
            pluginResult.pluginId,
            'monitor',
            tradeDate,
            userId,
            origin,
          );
          day.inserted += persist.inserted;
          day.skipped += persist.skipped;
          day.errors += persist.errors;
        }
        // F1：回放落库后回填分级（只写 grade / expires_at，不改变回放产生的信号集合）
        try {
          await assignSignalGrades(tradeDate, userId);
        } catch (gradeErr: unknown) {
          notes.push(`${tradeDate} 信号分级失败：${String(gradeErr)}`);
        }
      }
    } catch (err) {
      day.error = String(err instanceof Error ? err.message : err);
      notes.push(`${tradeDate} 回放失败：${day.error}`);
    }
    days.push(day);
  }

  const totals = days.reduce(
    (acc, d) => {
      acc.total += d.stats.total;
      acc.success += d.stats.success;
      acc.timeout += d.stats.timeout;
      acc.error += d.stats.error;
      acc.skip += d.stats.skip;
      acc.noData += d.stats.noData;
      acc.signals += d.signals;
      acc.inserted += d.inserted;
      acc.skipped += d.skipped;
      acc.errors += d.errors;
      return acc;
    },
    {
      total: 0,
      success: 0,
      timeout: 0,
      error: 0,
      skip: 0,
      noData: 0,
      signals: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
    },
  );

  const elapsedMs = Date.now() - startedAt;
  const failedDays = days.filter((d) => d.error).length;
  const dryRunInsert = days.reduce((s, d) => s + (d.wouldInsert ?? 0), 0);
  const dryRunSkip = days.reduce((s, d) => s + (d.wouldSkip ?? 0), 0);

  writeSystemLog({
    logType: 'signal_generate',
    level: failedDays > 0 ? 'WARN' : 'SUCCESS',
    message:
      `信号区间回放${dryRun ? '（dry-run）' : ''}完成: ` +
      `days=${days.length} signals=${totals.signals} ` +
      (dryRun
        ? `wouldInsert=${dryRunInsert} wouldSkip=${dryRunSkip} `
        : `inserted=${totals.inserted} skipped=${totals.skipped} `) +
      `start=${range.startSource} elapsedMs=${elapsedMs}`,
    detail: JSON.stringify({
      dryRun,
      startSource: range.startSource,
      startAnchor: range.startAnchor,
      fromDate: range.fromDate,
      toDate: range.toDate,
      dates: range.dates,
      truncated: range.truncated,
      totals,
      elapsedMs,
      notes,
    }),
  });

  return {
    dryRun,
    startSource: range.startSource,
    startAnchor: range.startAnchor,
    fromDate: range.fromDate,
    toDate: range.toDate,
    dates: range.dates,
    dayCount: range.dates.length,
    truncated: range.truncated,
    symbols,
    days,
    totals,
    elapsedMs,
    notes,
  };
}
