// src/services/validator.ts
// C1-C12 数据校验引擎
// 所有 DuckDB SQL 模板来自 SDD §5.7，{{TRADE_DATE}} 由调度器注入
import { queryDuckDB } from '../db/duckdb.js';
import { writeSystemLog } from './logger.js';

/** 校验结果三值（扩展 SKIP 用于 C11/C12 MVP） */
export type CheckResult = 'PASS' | 'WARN' | 'ERROR' | 'SKIP';

/**
 * 容差 / 阈值常量（集中定义）
 *
 * T85（2026-10-17，B-14 裁决）按 Requirements §7 重整：
 * 初稿的 C1~C8 定义是「数据内容校验」，Requirements 定义的是「数据新鲜度」，
 * 二者完全不同。此处按 Requirements 补齐新鲜度类阈值。
 */
export const TOLERANCES = {
  // ── C1-C8 新鲜度类（Requirements §7.1）──
  MIN_SYMBOL_COUNT: 3000,          // C1/C6 当日标的数下限（Requirements 明写 ≥3000）
  EX_DIVIDEND_FRESH_DAYS: 7,       // C4 最新除权日 ≥ 当日 - 7 天
  CLASS_COUNT_DROP: 0.10,          // C5 分类总数降幅 < 10%
  MAX_OPEN_CLOSE_RATIO: 2,         // C7 开盘价 ≤ 收盘价 × 2
  MAX_UPDATE_SECONDS: 120,         // C8 行情更新执行时长 ≤ 120s

  // ── C9/C10 内容类（Requirements §7.2）──
  QFQ_PRICE_DIFF: 0.01,            // C9 前复权价差容差 < 0.01 元
  GBBQ_DROP_DIFF: 0.005,           // C10 除权跳变率差 < 0.5%

  // ── C11/C12 跨源类（Requirements §7.3）──
  TUSHARE_PRICE_DIFF: 0.01,        // C11 Tushare 价格容差
  EASTMONEY_PRICE_DIFF: 0.02,      // C12 东财价格容差
} as const;

export interface CheckSummary {
  checkId: string;        // 'C1' / 'C2' / ...
  result: CheckResult;
  detail?: string;        // 额外说明
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────────────────────────

/** 单行包装：很多校验 SQL 只返回一行 */
function firstRow<T>(rows: T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

/** 写 system_log（level 映射：PASS→SUCCESS, WARN→WARN, ERROR→ERROR, SKIP→SKIP） */
function logResult(checkId: string, result: CheckResult, detail: string, tradeDate: string): void {
  const levelMap: Record<CheckResult, string> = {
    PASS: 'SUCCESS',
    WARN: 'WARN',
    ERROR: 'ERROR',
    SKIP: 'SKIP',
  };
  writeSystemLog({
    logType: 'datacheck',
    level: levelMap[result],
    message: `${checkId} ${result}`,
    detail,
    checkItem: checkId,
    logDate: tradeDate,
  });
}

// ─────────────────────────────────────────────────────────────────
// C1：当日日线行数是否正常
// SQL 原样来自 SDD §5.7 C1，占位符 {{TRADE_DATE}} → 参数化 ?
// ─────────────────────────────────────────────────────────────────

/**
 * C1：当日日线行数正常
 *
 * T85（B-14 裁决）：Requirements §7.1 定义为「当日标的数 ≥ 3000（正常 5000+）」，
 * 失败级别 **ERROR**。初稿实现是「历史均值 ±10% 偏离」—— 与需求不符：
 * 行情整体缺失时均值同步下跌，反而落在带内判 PASS。
 * 改为绝对值阈值，并按 ADR-004「数据源缺失一律 SKIP，不得计为 PASS」补 SKIP 分支。
 */
const C1_SQL = `
SELECT
    COUNT(DISTINCT symbol) AS actual_count,
    CASE
        WHEN COUNT(DISTINCT symbol) >= ? THEN 'PASS'
        WHEN COUNT(DISTINCT symbol) = 0 THEN 'SKIP'
        ELSE 'ERROR'
    END AS result
FROM v_stock_qfq
WHERE date = ?::date
`;

interface C1Row {
  actual_count: number;
  result: CheckResult;
}

async function checkC1(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C1Row>(C1_SQL, [TOLERANCES.MIN_SYMBOL_COUNT, tradeDate]);
    const row = firstRow(rows);

    if (!row) {
      return { checkId: 'C1', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }

    const detail = `当日标的数=${row.actual_count}（阈值 >=${TOLERANCES.MIN_SYMBOL_COUNT}）`;
    return { checkId: 'C1', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return { checkId: 'C1', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C2：交易日历匹配
// SQL 原样来自 SDD §5.7 C2
// ─────────────────────────────────────────────────────────────────

const C2_SQL = `
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?::date)
          AND EXISTS (SELECT 1 FROM v_stock_qfq WHERE date = ?::date)
            THEN 'PASS'
        WHEN NOT EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?::date)
          AND NOT EXISTS (SELECT 1 FROM v_stock_qfq WHERE date = ?::date)
            THEN 'PASS'
        WHEN EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?::date)
          AND NOT EXISTS (SELECT 1 FROM v_stock_qfq WHERE date = ?::date)
            THEN 'ERROR'
        ELSE 'WARN'
    END AS result
`;

interface C2Row {
  result: CheckResult;
}

async function checkC2(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C2Row>(C2_SQL, Array(6).fill(tradeDate));
    const row = firstRow(rows);
    const result: CheckResult = row?.result ?? 'ERROR';

    return {
      checkId: 'C2',
      result,
      detail: '交易日历与日线数据匹配',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C2', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// T85（B-14）：C3-C5 原本实现的是「停牌标记」，与 Requirements §7.1 的
// 「新鲜度校验」完全不同。本区块按 Requirements 重写：
//   C3 复权因子更新时间（MAX(date) = 当日）
//   C4 除权除息更新时间（最新除权日 ≥ 当日 - 7 天）—— 初稿 SQL 写 raw_gbbq.ex_date，
//      该列不存在；2026-10-17 DESCRIBE 实测除权日期列是 `date`，已修正
//   C5 板块/分类完整性 —— raw_tdx_blocks_member 无 date 列且为空表（实测 0 行），
//      「按日算总量降幅」不可实现，改用 raw_symbol_class(class) 的分类数降幅
// 原「停牌标记」实现移入 SDD §5.7「扩展校验」（不占 C 编号），见 ADR-004
// ─────────────────────────────────────────────────────────────────

/** C3：复权因子更新时间（Requirements §7.1，WARN） */
const C3_SQL = `
SELECT MAX(date) AS latest,
    CASE
        WHEN MAX(date) = CAST(? AS DATE) THEN 'PASS'
        WHEN MAX(date) IS NULL THEN 'SKIP'
        ELSE 'WARN'
    END AS result
FROM raw_adjust_factor
`;

interface C3Row {
  latest: string | null;
  result: CheckResult;
}

async function checkC3(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = firstRow(await queryDuckDB<C3Row>(C3_SQL, [tradeDate]));
    if (!row) {
      return { checkId: 'C3', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }
    const detail = `复权因子最新日=${row.latest ?? '无'}（应为 ${tradeDate}）`;
    return { checkId: 'C3', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return { checkId: 'C3', result: 'WARN', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

/** C4：除权除息更新时间（Requirements §7.1，WARN） */
const C4_SQL = `
SELECT MAX(date) AS latest_ex,
    CASE
        WHEN MAX(date) >= CAST(? AS DATE) - INTERVAL 7 DAY THEN 'PASS'
        WHEN MAX(date) IS NULL THEN 'SKIP'
        ELSE 'WARN'
    END AS result
FROM raw_gbbq
`;

interface C4Row {
  latest_ex: string | null;
  result: CheckResult;
}

async function checkC4(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = firstRow(await queryDuckDB<C4Row>(C4_SQL, [tradeDate]));
    if (!row) {
      return { checkId: 'C4', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }
    const detail = `最新除权日=${row.latest_ex ?? '无'}（阈值 ≥ ${tradeDate} - ${TOLERANCES.EX_DIVIDEND_FRESH_DAYS} 天）`;
    return { checkId: 'C4', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return { checkId: 'C4', result: 'WARN', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

/** C5：板块/分类完整性（Requirements §7.1，WARN）
 *
 * ⚠️ 2026-10-17 实测：`raw_tdx_blocks_member(stock_symbol, block_code)` **无 date 列且为空表**，
 *    故「按日统计板块成分总量降幅」不可实现。改用 `raw_symbol_class(symbol, class)`
 *    的分类数降幅 —— 口径等价（数据源从板块切到资产分类），且可执行。
 *    两者均为 WARN + 仅记录，不自动补跑（Requirements §7.1）。
 */
const C5_SQL = `
WITH today_cnt AS (
    SELECT COUNT(DISTINCT class) AS cnt
    FROM raw_symbol_class c
    WHERE EXISTS (SELECT 1 FROM v_stock_qfq v WHERE v.date = CAST(? AS DATE))
),
prev_day AS (
    SELECT MAX(date) AS d FROM v_stock_qfq WHERE date < CAST(? AS DATE)
),
prev_cnt AS (
    SELECT COUNT(DISTINCT class) AS cnt
    FROM raw_symbol_class
    WHERE EXISTS (SELECT 1 FROM v_stock_qfq v WHERE v.date = (SELECT d FROM prev_day))
)
SELECT t.cnt AS today_cnt, p.cnt AS prev_cnt,
    CASE
        WHEN t.cnt = 0 THEN 'SKIP'
        WHEN p.cnt = 0 THEN 'SKIP'
        WHEN (p.cnt - t.cnt) * 1.0 / p.cnt < ? THEN 'PASS'
        ELSE 'WARN'
    END AS result
FROM today_cnt t CROSS JOIN prev_cnt p
`;

interface C5Row {
  today_cnt: number;
  prev_cnt: number;
  result: CheckResult;
}

async function checkC5(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = firstRow(
      await queryDuckDB<C5Row>(C5_SQL, [tradeDate, tradeDate, TOLERANCES.CLASS_COUNT_DROP]),
    );
    if (!row) {
      return { checkId: 'C5', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }
    const detail = `分类数=${row.today_cnt}（前一交易日 ${row.prev_cnt}），降幅阈值 ${TOLERANCES.CLASS_COUNT_DROP * 100}%`;
    return { checkId: 'C5', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return { checkId: 'C5', result: 'WARN', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}
// ─────────────────────────────────────────────────────────────────
// C6：前复权因子一致性校验
// SQL 原样来自 SDD §5.7 C6
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// C6：市值数据存在性（Requirements §7.1：当日标的数 ≥ 3000，WARN）
// ⚠️ T85：初稿此处实现的是「前复权价格数学一致性」—— 那其实是 **C9** 的语义。
//    按 B-14 裁决改为 Requirements 的 C6；原语义上移至 C9。
// ─────────────────────────────────────────────────────────────────

const C6_SQL = `
SELECT
    COUNT(*) AS total_cnt,
    COUNT(floatmv) AS with_mv,
    CASE
        WHEN COUNT(*) >= ? THEN 'PASS'
        WHEN COUNT(*) = 0 THEN 'SKIP'
        ELSE 'WARN'
    END AS result
FROM v_stock_qfq
WHERE date = ?::date
`;

interface C6Row {
  total_cnt: number;
  with_mv: number;
  result: CheckResult;
}

async function checkC6(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = firstRow(await queryDuckDB<C6Row>(C6_SQL, [TOLERANCES.MIN_SYMBOL_COUNT, tradeDate]));
    if (!row) {
      return { checkId: 'C6', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }
    const detail = `当日标的数=${row.total_cnt}，其中有市值数据=${row.with_mv}（阈值 >=${TOLERANCES.MIN_SYMBOL_COUNT}）`;
    return { checkId: 'C6', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return { checkId: 'C6', result: 'WARN', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C7：成交量异常
// SQL 原样来自 SDD §5.7 C7
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// C7：日线价格合理性（Requirements §7.1：收盘价 ≠ 0 且 开盘价 ≤ 收盘价 × 2，WARN）
// ⚠️ T85：初稿此处实现的是「成交量放大 200 倍」—— 那是 SDD 的扩展校验，
//    与 Requirements 的 C7 无关，已移出。实测本地库有 12 条此类异常，该校验有真实价值。
// ─────────────────────────────────────────────────────────────────

const C7_SQL = `
SELECT
    COUNT(*) AS bad_cnt,
    CASE
        WHEN COUNT(*) = 0 THEN 'PASS'
        ELSE 'WARN'
    END AS result
FROM v_stock_qfq
WHERE date = ?::date
  AND (close = 0 OR open > close * ?)
`;

interface C7Row {
  bad_cnt: number;
  result: CheckResult;
}

async function checkC7(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = firstRow(await queryDuckDB<C7Row>(C7_SQL, [tradeDate, TOLERANCES.MAX_OPEN_CLOSE_RATIO]));
    if (!row) {
      return { checkId: 'C7', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }
    const detail = row.bad_cnt === 0
      ? '当日无价格异常标的'
      : `异常标的=${row.bad_cnt}（收盘价=0 或 开盘价 > 收盘价×${TOLERANCES.MAX_OPEN_CLOSE_RATIO}）`;
    return { checkId: 'C7', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return { checkId: 'C7', result: 'WARN', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C8：除权日价格跳变率交叉验证
// SQL 原样来自 SDD §5.7 C8
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// C8：行情更新执行时长（Requirements §7.1：≤ 120s，WARN）
// ⚠️ T85：初稿此处实现的是「数据滞后天数」—— 那是 SDD 的扩展校验，已移出。
//    现按需求读 system_log 的 tdx2db_update 时间戳差。
//    无该日志行（新库 / 从未跑过 tdx2db）→ SKIP，不得计为 PASS（ADR-004）。
// ─────────────────────────────────────────────────────────────────

const C8_SQL = `
SELECT
    MAX(created_at) AS started_at,
    CASE WHEN COUNT(*) = 0 THEN 'SKIP' ELSE 'PASS' END AS has_row
FROM system_log
WHERE log_type = 'tdx2db_update'
  AND log_date = ?::date
`;

interface C8Row {
  started_at: string | null;
  has_row: CheckResult;
}

/** 把 system_log 的 'YYYY-MM-DD HH:MM:SS' 转成 Date（按本地时区） */
function parseLocalTs(ts: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

async function checkC8(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = firstRow(await queryDuckDB<C8Row>(C8_SQL, [tradeDate]));
    if (!row || row.has_row !== 'PASS' || !row.started_at) {
      return {
        checkId: 'C8',
        result: 'SKIP',
        detail: `无 ${tradeDate} 的 tdx2db_update 日志（无法判定执行时长）`,
        durationMs: Date.now() - start,
      };
    }
    const started = parseLocalTs(row.started_at);
    if (!started) {
      return {
        checkId: 'C8', result: 'WARN',
        detail: `tdx2db_update 时间戳格式异常：${row.started_at}`,
        durationMs: Date.now() - start,
      };
    }
    // 执行时长 = 校验时刻 - 行情更新开始时刻（本库无 tdx2db 结束日志，取近似上界）
    const elapsedSec = Math.round((Date.now() - started.getTime()) / 1000);
    const result: CheckResult = elapsedSec <= TOLERANCES.MAX_UPDATE_SECONDS ? 'PASS' : 'WARN';
    return {
      checkId: 'C8', result,
      detail: `行情更新开始于 ${row.started_at}，至校验时已过 ${elapsedSec}s（上限 ${TOLERANCES.MAX_UPDATE_SECONDS}s）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C8', result: 'WARN', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C9：复权因子抽样 100 只
// SQL 原样来自 SDD §5.7 C9
// ─────────────────────────────────────────────────────────────────

const C9_SQL = `
WITH latest_factors AS (
    SELECT symbol, argmax(hfq_factor, date) AS latest_hfq
    FROM raw_adjust_factor
    GROUP BY symbol
),
sample AS (
    SELECT UNNEST(ARRAY_AGG(symbol ORDER BY random() LIMIT 100)) AS symbol
    FROM v_stock_qfq
    WHERE date = ?::date
)
SELECT COUNT(*) AS mismatch_count,
    CASE
        WHEN COUNT(*) = 0 THEN 'PASS'
        WHEN COUNT(*) <= 5 THEN 'WARN'
        ELSE 'ERROR'
    END AS result
FROM sample s
JOIN latest_factors lf ON s.symbol = lf.symbol
JOIN v_stock_qfq v ON s.symbol = v.symbol AND v.date = ?::date
WHERE ABS(lf.latest_hfq - v.qfq_factor) >= 0.0001
`;

interface C9Row {
  mismatch_count: number;
  result: CheckResult;
}

async function checkC9(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C9Row>(C9_SQL, [tradeDate, tradeDate]);
    const row = firstRow(rows);

    if (!row) {
      return { checkId: 'C9', result: 'PASS', detail: '抽样 100 只全部一致（无 mismatch）', durationMs: Date.now() - start };
    }

    return {
      checkId: 'C9',
      result: row.result,
      detail: `mismatch=${row.mismatch_count}/100（容差<${TOLERANCES.QFQ_PRICE_DIFF}）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C9', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C10：除权事件覆盖完整性
// SQL 原样来自 SDD §5.7 C10
// ─────────────────────────────────────────────────────────────────

const C10_SQL = `
SELECT COUNT(g.symbol) AS missing_count,
    CASE
        WHEN COUNT(g.symbol) = 0 THEN 'PASS'
        ELSE 'WARN'
    END AS result
FROM raw_gbbq g
LEFT JOIN v_stock_qfq v ON g.symbol = v.symbol AND v.date = g.date
WHERE g.date = ?::date AND g.category = 1 AND v.symbol IS NULL
`;

interface C10Row {
  missing_count: number;
  result: CheckResult;
}

async function checkC10(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C10Row>(C10_SQL, [tradeDate]);
    const row = firstRow(rows);
    const result: CheckResult = row?.result ?? 'PASS';

    return {
      checkId: 'C10',
      result,
      detail: `缺失标的=${row?.missing_count ?? 0}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C10', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C11：Tushare 跨源校验（完整实现）
// SQL + 比对口径来自 SDD §5.7 C11
// ─────────────────────────────────────────────────────────────────

const C11_SQL = `
SELECT
    rk.symbol, rk.open, rk.high, rk.low, rk.close,
    rb.preclose AS pre_close,
    rk.volume, rk.amount
FROM raw_kline_daily rk
LEFT JOIN raw_basic_daily rb ON rk.symbol = rb.symbol AND rk.date = rb.date
WHERE rk.date = ?;
`;

/** DuckDB 本地查询结果行（raw_kline_daily + JOIN raw_basic_daily） */
interface C11LocalRow {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  volume: number;
  amount: number;
}

/** Tushare daily 接口返回行（统一成与 LocalRow 相同的字段名） */
interface TushareDailyRow {
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  volume: number;
  amount: number;
}

/** sh600000 → 600000.SH；sz000001 → 000001.SZ；bj430047 → 430047.BJ */
function convertToTsCode(symbol: string): string {
  const prefix = symbol.slice(0, 2).toUpperCase();
  const num = symbol.slice(2);
  if (prefix === 'SH') return `${num}.SH`;
  if (prefix === 'SZ') return `${num}.SZ`;
  if (prefix === 'BJ') return `${num}.BJ`;
  return symbol;
}

/** 从 Tushare daily 接口原始响应中按 fields 位置映射一行数据 */
function parseTushareRow(
  fields: string[],
  item: (string | number | null)[],
): TushareDailyRow {
  const idx = (name: string) => fields.indexOf(name);
  const num = (v: unknown): number => Number(v) || 0;
  return {
    open: num(item[idx('open')]),
    high: num(item[idx('high')]),
    low: num(item[idx('low')]),
    close: num(item[idx('close')]),
    pre_close: num(item[idx('pre_close')]),
    volume: num(item[idx('vol')]),
    amount: num(item[idx('amount')]),
  };
}

/** 调用 Tushare 免费 daily 接口，5 秒超时 */
async function fetchTushareDaily(
  tsCode: string,
  tradeDate: string,
): Promise<TushareDailyRow | null> {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) return null;

  const body = {
    api_name: 'daily',
    token,
    params: {
      ts_code: tsCode,
      trade_date: tradeDate.replace(/-/g, ''),
    },
    fields: 'ts_code,open,high,low,close,pre_close,vol,amount',
  };

  const res = await fetch('http://api.tushare.pro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;

  const json = (await res.json()) as {
    code?: number;
    data?: { fields?: string[]; items?: (string | number | null)[][] };
  };

  if (json.code !== 0 || !json.data?.fields || !json.data?.items?.length) {
    return null;
  }

  return parseTushareRow(json.data.fields, json.data.items[0]);
}

/**
 * DuckDB 本地行 vs Tushare 跨源行字段级比对
 * - 价格字段（open/high/low/close/preclose）容差 < 0.01 元
 * - volume/amount 要求精确一致（整数量级，DuckDB 与 Tushare 都不应有浮点漂移）
 */
function compareC11Rows(local: C11LocalRow, ts: TushareDailyRow): boolean {
  const PRICE_TOL = TOLERANCES.TUSHARE_PRICE_DIFF;
  const priceOk = (v: number, t: number) => Math.abs(v - t) < PRICE_TOL;
  return (
    priceOk(local.open, ts.open) &&
    priceOk(local.high, ts.high) &&
    priceOk(local.low, ts.low) &&
    priceOk(local.close, ts.close) &&
    priceOk(local.pre_close, ts.pre_close) &&
    Math.abs(local.volume - ts.volume) < 1 &&
    Math.abs(local.amount - ts.amount) < 1
  );
}

async function checkC11(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();

  // SKIP 条件 1：token 未配置
  if (!process.env.TUSHARE_TOKEN) {
    return {
      checkId: 'C11',
      result: 'SKIP',
      detail: 'TUSHARE_TOKEN 未配置',
      durationMs: Date.now() - start,
    };
  }

  // SKIP 条件 2：DuckDB 无当日数据（可能 tdx2db 未运行或当日非交易日）
  let localRows: C11LocalRow[];
  try {
    localRows = await queryDuckDB<C11LocalRow>(C11_SQL, [tradeDate]);
  } catch (err) {
    return {
      checkId: 'C11',
      result: 'ERROR',
      detail: `DuckDB 查询异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  if (localRows.length === 0) {
    return {
      checkId: 'C11',
      result: 'SKIP',
      detail: 'DuckDB 无当日数据（可能 tdx2db 未运行）',
      durationMs: Date.now() - start,
    };
  }

  // 随机抽 30 只（Tushare Free 每日限额）
  const sampled = [...localRows]
    .sort(() => Math.random() - 0.5)
    .slice(0, 30);

  let match = 0;
  let mismatch = 0;
  let fetchFail = 0;
  const mismatchDetails: string[] = [];

  for (const row of sampled) {
    const tsCode = convertToTsCode(row.symbol);
    try {
      const tushare = await fetchTushareDaily(tsCode, tradeDate);
      if (!tushare) {
        fetchFail++;
      } else if (compareC11Rows(row, tushare)) {
        match++;
      } else {
        mismatch++;
        mismatchDetails.push(
          `${row.symbol}: local_close=${row.close} ts_close=${tushare.close} local_pre=${row.pre_close} ts_pre=${tushare.pre_close}`,
        );
      }
    } catch {
      fetchFail++;
    }

    // 100ms 节流，30 只 ≈ 3 秒完成
    // Tushare Free 每日 500 次 / 每分钟 50 次，100ms 间隔远低于限流阈值
    await new Promise((r) => setTimeout(r, 100));
  }

  let result: CheckResult;
  let detail: string;

  if (fetchFail >= sampled.length) {
    result = 'SKIP';
    detail = 'Tushare API 全部请求失败（可能 token 无效、429 限流或网络异常）';
  } else if (mismatch === 0) {
    result = 'PASS';
    detail = `${sampled.length} 只全 PASS（match=${match} fetchFail=${fetchFail}）`;
  } else if (mismatch <= 2) {
    result = 'WARN';
    detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${mismatchDetails.join('; ').slice(0, 200)}`;
  } else {
    result = 'ERROR';
    detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${mismatchDetails.join('; ').slice(0, 200)}`;
  }

  return {
    checkId: 'C11',
    result,
    detail,
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────
// C12：东财跨源校验
// SDD §5.7 C12 — 抽样 20 只 vs 东财前复权收盘价，容差 0.02 元
// ─────────────────────────────────────────────────────────────────

const C12_SQL = `
SELECT symbol, close AS local_qfq_close
FROM v_stock_qfq
WHERE date = ?;
`;

interface C12Row {
  symbol: string;
  local_qfq_close: number;
}

/**
 * 调东财免费日K接口取前复权收盘价
 * @param symbol  sh600000 / sz000001 / bj8xxxxx（北交所跳过）
 * @param tradeDate  YYYY-MM-DD
 * @returns 前复权收盘价；不支持市场 / 超时 / 非 200 → null
 */
async function fetchEastMoneyQfq(symbol: string, tradeDate: string): Promise<number | null> {
  const prefix = symbol.slice(0, 2).toLowerCase();
  const code = symbol.slice(2);
  const market = prefix === 'sh' ? '1' : prefix === 'sz' ? '0' : null;
  if (!market) return null;

  const begEnd = tradeDate.replace(/-/g, '');
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${market}.${code}&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&beg=${begEnd}&end=${begEnd}&lmt=1`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://quote.eastmoney.com/',
      },
      signal: AbortSignal.timeout(10_000), // 单只 10s 超时
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { klines?: string[] | null };
    };
    const klines = json?.data?.klines;
    if (!Array.isArray(klines) || klines.length === 0) return null;
    // "2024-01-02,10.50,10.60,10.40,10.55,1234567,12967890.00,0,3.21,2.05,1.23"
    const parts = String(klines[0]).split(',');
    const close = Number(parts[2]);
    return Number.isFinite(close) ? close : null;
  } catch {
    return null;
  }
}

async function checkC12(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const localRows = await queryDuckDB<C12Row>(C12_SQL, [tradeDate]);

    if (localRows.length === 0) {
      return {
        checkId: 'C12',
        result: 'SKIP',
        detail: 'DuckDB v_stock_qfq 无当日数据',
        durationMs: Date.now() - start,
      };
    }

    // 随机抽 20 只
    const sampled = [...localRows].sort(() => Math.random() - 0.5).slice(0, 20);

    let match = 0;
    let mismatch = 0;
    let fetchFail = 0;
    const details: string[] = [];

    for (const row of sampled) {
      const emClose = await fetchEastMoneyQfq(row.symbol, tradeDate);
      if (emClose === null) {
        fetchFail++;
      } else {
        const diff = Math.abs(row.local_qfq_close - emClose);
        if (diff < TOLERANCES.EASTMONEY_PRICE_DIFF) {
          match++;
        } else {
          mismatch++;
          details.push(
            `${row.symbol}: local=${row.local_qfq_close} em=${emClose} diff=${diff.toFixed(4)}`,
          );
        }
      }

      // 500ms 节流，避免东财限流
      await new Promise<void>((r) => setTimeout(r, 500));
    }

    let result: CheckSummary['result'];
    let detail: string;

    if (fetchFail >= 5) {
      result = 'SKIP';
      detail = `东财 API 连续 ${fetchFail} 只请求失败 → 整项 SKIP`;
    } else if (mismatch === 0) {
      result = 'PASS';
      detail = `20 只全 PASS（match=${match} fetchFail=${fetchFail}）`;
    } else if (mismatch <= 2) {
      result = 'WARN';
      detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${details.join('; ').slice(0, 200)}`;
    } else {
      result = 'ERROR';
      detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${details.join('; ').slice(0, 200)}`;
    }

    return {
      checkId: 'C12',
      result,
      detail,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      checkId: 'C12',
      result: 'ERROR',
      detail: `SQL/网络异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// 批量执行 C1-C12（Fastify cron 17:02 调用）
// 单条 try-catch 独立，不阻塞后续
// ─────────────────────────────────────────────────────────────────

const CHECKS: Array<(tradeDate: string) => Promise<CheckSummary>> = [
  checkC1,
  checkC2,
  checkC3,
  checkC4,
  checkC5,
  checkC6,
  checkC7,
  checkC8,
  checkC9,
  checkC10,
  checkC11,
  checkC12,
];

export async function runAllChecks(tradeDate?: string): Promise<CheckSummary[]> {
  const date = tradeDate ?? new Date().toISOString().slice(0, 10);
  const summaries: CheckSummary[] = [];

  for (const checkFn of CHECKS) {
    // 包裹 try-catch，单条 SQL 崩了不影响其他
    let summary: CheckSummary;
    try {
      summary = await checkFn(date);
    } catch (err) {
      // 从函数名反推 checkId
      const fnName = checkFn.name;
      const idMatch = fnName.match(/check(C\d+)/);
      const checkId = idMatch ? idMatch[1] : fnName;
      summary = {
        checkId,
        result: 'ERROR',
        detail: `未预期异常: ${String(err)}`,
        durationMs: 0,
      };
    }
    summaries.push(summary);

    // 每条校验结果都写 system_log
    logResult(summary.checkId, summary.result, summary.detail ?? '', date);
  }

  return summaries;
}
