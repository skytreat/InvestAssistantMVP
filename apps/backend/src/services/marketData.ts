import { queryDuckDB } from '../db/duckdb.js';
import type { DailyKline } from '@invest/core';

/** 带 symbol 的原始行（DuckDB SELECT 出来的结构） */
type DailyKlineRow = DailyKline & { symbol: string };

/** 复权类型：qfq 前复权 / bfq 不复权 / hfq 后复权 */
export type AdjustPeriod = 'qfq' | 'bfq' | 'hfq';

function resolveTable(period: AdjustPeriod): string {
  switch (period) {
    case 'qfq':
      return 'v_stock_qfq';
    case 'hfq':
      return 'v_stock_hfq';
    case 'bfq':
    default:
      return 'v_stock_bfq';
  }
}

/**
 * 单标的单日期日线
 * 用于插件引擎查询和校验
 */
export async function getDailyBySymbol(
  symbol: string,
  date: string,
  period: AdjustPeriod = 'qfq',
): Promise<DailyKline | null> {
  const tableName = resolveTable(period);

  const rows = await queryDuckDB<DailyKline>(
    `SELECT date, open, high, low, close, volume, amount
     FROM ${tableName}
     WHERE symbol = ? AND date = ?`,
    [symbol, date],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 单标的日期区间日线
 * fromDate/toDate 格式 YYYY-MM-DD
 */
export async function getDailyRange(
  symbol: string,
  fromDate: string,
  toDate: string,
  period: AdjustPeriod = 'qfq',
): Promise<DailyKline[]> {
  const tableName = resolveTable(period);

  return await queryDuckDB<DailyKline>(
    `SELECT date, open, high, low, close, volume, amount
     FROM ${tableName}
     WHERE symbol = ? AND date BETWEEN ? AND ?
     ORDER BY date ASC`,
    [symbol, fromDate, toDate],
  );
}

/**
 * 批量多标的单日期日线（**1 次 IN 查询**）
 *
 * SDD §5.3 硬约束：插件和校验共用入口，一次拿全，禁止逐标的循环查 DuckDB。
 * IN 查询 100 标的 DuckDB 秒级响应，MVP 不需要分批。
 */
export async function batchGetDaily(
  symbols: string[],
  date: string,
  period: AdjustPeriod = 'qfq',
): Promise<Map<string, DailyKline>> {
  const result = new Map<string, DailyKline>();
  if (symbols.length === 0) {
    return result;
  }

  const tableName = resolveTable(period);
  const placeholders = symbols.map(() => '?').join(', ');

  const rows = await queryDuckDB<DailyKlineRow>(
    `SELECT symbol, date, open, high, low, close, volume, amount
     FROM ${tableName}
     WHERE date = ? AND symbol IN (${placeholders})`,
    [date, ...symbols],
  );

  for (const row of rows) {
    const { symbol, date: d, open, high, low, close, volume, amount } = row;
    result.set(symbol, { date: d, open, high, low, close, volume, amount });
  }

  return result;
}

/**
 * 批量多标的日期区间日线（**1 次查询**，大 IN + BETWEEN）
 *
 * 返回结构：Map<symbol, DailyKline[]>
 */
export async function batchGetDailyRange(
  symbols: string[],
  fromDate: string,
  toDate: string,
  period: AdjustPeriod = 'qfq',
): Promise<Map<string, DailyKline[]>> {
  const result = new Map<string, DailyKline[]>();
  if (symbols.length === 0) {
    return result;
  }

  const tableName = resolveTable(period);
  const placeholders = symbols.map(() => '?').join(', ');

  const rows = await queryDuckDB<DailyKlineRow>(
    `SELECT symbol, date, open, high, low, close, volume, amount
     FROM ${tableName}
     WHERE date BETWEEN ? AND ? AND symbol IN (${placeholders})
     ORDER BY symbol, date ASC`,
    [fromDate, toDate, ...symbols],
  );

  for (const row of rows) {
    const { symbol, date: d, open, high, low, close, volume, amount } = row;
    const list = result.get(symbol);
    if (list) {
      list.push({ date: d, open, high, low, close, volume, amount });
    } else {
      result.set(symbol, [{ date: d, open, high, low, close, volume, amount }]);
    }
  }

  return result;
}

/**
 * 按 view 分组的批量区间取日线（**每个 view 1 次 IN 查询**）
 *
 * 🔴 T85b ①：选股路径的候选可能来自多个 view（`v_stock_qfq` / `v_etf_qfq`），
 *   而 {@link batchGetDailyRange} 只支持单 view。��这里按 view 分组各发 1 条
 *   IN 查询 —— 总量 = view 数（≤2），**不是 symbol 数**。
 *
 * @param symbolsByView view 名 → 该 view 下的 symbol 列表
 */
export async function batchGetDailyRangeByView(
  symbolsByView: Map<string, string[]>,
  fromDate: string,
  toDate: string,
): Promise<Map<string, DailyKline[]>> {
  const result = new Map<string, DailyKline[]>();
  for (const [view, symbols] of symbolsByView) {
    if (symbols.length === 0) continue;
    const placeholders = symbols.map(() => '?').join(', ');
    const rows = await queryDuckDB<DailyKlineRow>(
      `SELECT symbol, date, open, high, low, close, volume, amount
       FROM ${view}
       WHERE date BETWEEN ? AND ? AND symbol IN (${placeholders})
       ORDER BY symbol, date ASC`,
      [fromDate, toDate, ...symbols],
    );
    for (const row of rows) {
      const { symbol, date: d, open, high, low, close, volume, amount } = row;
      const list = result.get(symbol);
      if (list) {
        list.push({ date: d, open, high, low, close, volume, amount });
      } else {
        result.set(symbol, [{ date: d, open, high, low, close, volume, amount }]);
      }
    }
  }
  return result;
}

/**
 * 批量取多个标的的最新收盘价（**1 次查询**，T33 仪表盘持仓卡用）
 *
 * 用窗口函数 ROW_NUMBER 取每个 symbol 最新一条，避免"先按日期定位再 IN 查"两次往返。
 * 返回 Map<symbol, { date, close }>，没有行情的标的不出现在结果里。
 */
export async function batchGetLatestClose(
  symbols: string[],
  period: AdjustPeriod = 'qfq',
): Promise<Map<string, { date: string; close: number }>> {
  const result = new Map<string, { date: string; close: number }>();
  if (symbols.length === 0) return result;

  const tableName = resolveTable(period);
  const placeholders = symbols.map(() => '?').join(', ');

  const rows = await queryDuckDB<{ symbol: string; date: unknown; close: number }>(
    `SELECT symbol, date, close FROM (
       SELECT symbol, date, close,
              ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
       FROM ${tableName}
       WHERE symbol IN (${placeholders})
     ) WHERE rn = 1`,
    [...symbols],
  );

  for (const row of rows) {
    result.set(row.symbol, { date: toDateString(row.date), close: row.close });
  }

  return result;
}

/**
 * 批量取多个标的的**最新收盘价 + 昨收**（**1 次查询**，T67 Dashboard 持仓卡用）
 *
 * 与 {@link batchGetLatestClose} 同源（同一张 view、同一个窗口函数），
 * 只是把 `rn = 1` 放宽到 `rn <= 2` —— **一次扫描同时拿到「最新」与「上一交易日」**。
 * ⚠️ 不做成两个函数各查一次：`v_stock_qfq` 是实时计算视图（实测扫 5 只标的 ≈ 2.5s），
 *   两次查询 = 两次全量扫描 → `/api/holding` 首屏延迟翻倍。
 *
 * ── 昨收口径（**不用交易日历**）──
 *   昨收 = 该标的自己日线序列的**倒数第二条**（rn = 2）。
 *   理由：仓库里同时存在两种「上一交易日」口径 ——
 *     · 日历口径 `resolveTargetTradeDate()`（工作日 + 不在 `raw_holidays` 休市黑名单）
 *     · 数据口径 `resolveLatestQuoteDate()`（最近**有行情**的那天）
 *   两者在「行情管道停摆 / 标的停牌」时会分叉，而 Dashboard 的日涨跌需要的是
 *   「**紧邻上一根 K 线**的收盘价」—— 那正是 rn = 2，无需另立日历口径。
 *   ⚠️ 实测（2026-10-20，本机真库）：`v_stock_qfq` 的 (symbol, date) **无扇出** ——
 *     5 只标的共 23974 行 = 23974 个不同 (symbol, date)；
 *     `GROUP BY symbol, date HAVING COUNT(*) > 1` 返回 0 行
 *     → rn = 2 就是真正的上一交易日收盘价，不是重复行。
 *
 * ⚠️ 只有 1 条日线的标的 → 无昨收 → `prevClose = null`（前端降级为「无对比」）。
 * ⚠️ 停牌标的：rn 1 / rn 2 是它**自己**的最近两条，可能不是全市场最近两个交易日。
 */
export interface LatestAndPrevClose {
  /** 最新一根 K 线的日期 */
  date: string;
  /** 最新一根 K 线的收盘价 */
  close: number;
  /** 上一根 K 线的日期（无上一根时为 null） */
  prevDate: string | null;
  /** 上一根 K 线的收盘价（无上一根时为 null） */
  prevClose: number | null;
}

export async function batchGetLatestAndPrevClose(
  symbols: string[],
  period: AdjustPeriod = 'qfq',
): Promise<Map<string, LatestAndPrevClose>> {
  const bySymbol = new Map<string, LatestAndPrevClose>();
  if (symbols.length === 0) return bySymbol;

  const tableName = resolveTable(period);
  const placeholders = symbols.map(() => '?').join(', ');

  const rows = await queryDuckDB<{ symbol: string; date: unknown; close: number; rn: number }>(
    `SELECT symbol, date, close, rn FROM (
       SELECT symbol, date, close,
              ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
       FROM ${tableName}
       WHERE symbol IN (${placeholders})
     ) WHERE rn <= 2`,
    [...symbols],
  );

  // ⚠️ SQL 不保证行序（rn=2 可能先于 rn=1 返回）→ 先收集再定型
  for (const row of rows) {
    const d = toDateString(row.date);
    const cur = bySymbol.get(row.symbol) ?? {
      date: '',
      close: 0,
      prevDate: null,
      prevClose: null,
    };
    if (row.rn === 1) {
      cur.date = d;
      cur.close = row.close;
    } else if (row.rn === 2) {
      cur.prevDate = d;
      cur.prevClose = row.close;
    }
    bySymbol.set(row.symbol, cur);
  }

  return bySymbol;
}

/**
 * 批量取标的**中文名称**（**1 次 IN 查询**，T67 Dashboard 持仓卡用）
 *
 * ── 数据源实测（2026-10-20，`/opt/invol/quotes.duckdb`）──
 *   `DESCRIBE raw_symbol_name` → `(symbol VARCHAR, name VARCHAR, class VARCHAR)`
 *   8726 行；`symbol` **无重复**（`GROUP BY symbol HAVING COUNT(*)>1` → 0 行）
 *   → 单值键，IN 查询不会扇出成多行。
 *   `name` 列**无 NULL / 空串**（实测 0 行）。
 *
 * ⚠️ **覆盖约 70%，缺失是常态**：全市场 12449 只（`raw_symbol_class` 行数），
 *   `raw_symbol_name` 只有 8726 只 → **约 3700 只标的名查不到**。
 *   ⇒ 调用方必须容忍「查不到」（`Map` 里没有该 key），前端回退显示代码。
 *
 * ⚠️ **symbol 格式与业务层 asset_code 完全一致**（`sh600000` / `sz000001` / `bj920000`）
 *   —— 与 `raw_symbol_name.symbol` 精确匹配，无需转换。
 */
export async function batchGetSymbolNames(symbols: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = Array.from(new Set(symbols.filter((s) => typeof s === 'string' && s.length > 0)));
  if (unique.length === 0) return result;

  // ⚠️ 只拼占位符（个数由数组长度决定），真实值一律走绑定参数 —— 禁止把代码拼进 SQL 文本
  const placeholders = unique.map(() => '?').join(', ');
  const rows = await queryDuckDB<{ symbol: string; name: string }>(
    `SELECT symbol, name FROM raw_symbol_name WHERE symbol IN (${placeholders})`,
    [...unique],
  );

  for (const row of rows) {
    // 空名等同「没查到」→ 不进 Map（调用方取不到即为 null）
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (name.length > 0) result.set(row.symbol, name);
  }

  return result;
}

/**
 * DuckDB 的 DATE 列在不同驱动下可能是 string / number(epoch days) / {days: number}
 * 统一转成 YYYY-MM-DD 字符串
 */
export function toDateString(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const epoch = new Date(1970, 0, 1);
    epoch.setDate(epoch.getDate() + value);
    return epoch.toISOString().slice(0, 10);
  }
  if (value && typeof value === 'object' && 'days' in value) {
    const epoch = new Date(1970, 0, 1);
    epoch.setDate(epoch.getDate() + (value as { days: number }).days);
    return epoch.toISOString().slice(0, 10);
  }
  return String(value);
}

// ─────────────────────────────────────────────────────────────────
// 交易日历（口径以实测为准，见下方「raw_holidays 语义更正」）
// ─────────────────────────────────────────────────────────────────

/**
 * 🔴 `raw_holidays` 语义更正（2026-10-19 实测，I-20）
 *
 * **该表存的是「休市日」黑名单，不是交易日。** 原实现的注释「有行 = 交易日」是错的。
 *
 * 实测证据（`/opt/invol/quotes.duckdb`）：
 * - 表内 680 行，范围 1991-01-01 ~ 2030-10-07
 * - 其中「该日 `v_stock_qfq` 有行情」的行数 = **0** → 全是休市日
 * - `v_stock_qfq` 的 8799 个不同日期，**没有一个**在该表里
 * - 2026-10-01 ~ 10-07（国庆）全部在表内且**无行情**；10-08/09/12 不在表内且**有行情**
 *
 * 且该表**只含工作日休市日**（周末不在表内）→ 判定交易日需同时排除周末。
 */

/** 日历口径的「休市日」判定：该日是否在 raw_holidays 黑名单中 */
async function isHolidayListed(date: string): Promise<boolean> {
  const rows = await queryDuckDB<{ count: number }>(
    'SELECT COUNT(*) AS count FROM raw_holidays WHERE date = ?',
    [date],
  );
  return rows.length > 0 && Number(rows[0].count) > 0;
}

/** 该日是否为工作日（周一~周五）—— 纯本地计算，不查库 */
function isWeekday(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * 查询某天是不是交易日
 *
 * 口径（2026-10-19 实测修正）：**工作日 且 不在 `raw_holidays` 休市黑名单中**。
 *
 * ⚠️ 这是**日历口径**，与「当天有没有行情数据」正交 —— 行情管道停摆时，
 * 某个交易日依然会被判为交易日（正确：那样才能暴露数据陈旧，而不是掩盖它）。
 */
export async function isTradingDay(date: string): Promise<boolean> {
  if (!isWeekday(date)) return false;
  try {
    return !(await isHolidayListed(date));
  } catch {
    return false;
  }
}

/**
 * 日历口径的最近交易日（≤ referenceDate）
 *
 * 只依赖 `raw_holidays` + 工作日判定，**不依赖行情数据是否到位** ——
 * 这样数据陈旧时校验会如实报错，而不是把 tradeDate 回退到「有数据的最后一天」造成假绿。
 *
 * @param referenceDate 参考日，默认今天（UTC）
 * @returns YYYY-MM-DD；往前 30 天内无交易日则返回 null
 */
export async function resolveTargetTradeDate(referenceDate?: string): Promise<string | null> {
  const ref = referenceDate ?? new Date().toISOString().slice(0, 10);
  try {
    // ⚠️ **必须显式 ::DATE**（2026-10-19 实测踩坑）：
    //   `generate_series(DATE, DATE, INTERVAL 1 DAY)` 返回的是 **TIMESTAMP**，
    //   `MAX(timestamp)` 的驱动层值是 `{micros: BigInt}` —— `normalizeValue` 不认这个形态
    //   → 序列化直接炸（`TypeError: Do not know how to serialize a BigInt`）。
    //   cast 成 DATE 后驱动返回 `{days}`，才能被 normalizeValue 正确归一。
    const rows = await queryDuckDB<{ d: unknown }>(
      `SELECT MAX(candidate)::DATE AS d FROM (
         SELECT g::DATE AS candidate
         FROM generate_series(CAST(? AS DATE) - INTERVAL 30 DAY, CAST(? AS DATE), INTERVAL 1 DAY) AS t(g)
         WHERE EXTRACT(ISODOW FROM g) BETWEEN 1 AND 5
           AND NOT EXISTS (SELECT 1 FROM raw_holidays WHERE date = g)
       ) s`,
      [ref, ref],
    );
    if (rows.length === 0) return null;
    const val = rows[0].d;
    if (val === null || val === undefined) return null;
    return toDateString(val);
  } catch {
    return null;
  }
}

/**
 * 数据口径的最近有行情日期（≤ referenceDate）
 *
 * 与 {@link resolveTargetTradeDate} 的区别：**看数据有没有到位**，不判断日历。
 * 用于「查行情」的场合（选股 / 最新价 / 批量取日线）—— 必须落在真有数据的那天，
 * 否则查出来是 0 行。
 *
 * ⚠️ 与 `resolveTargetTradeDate` 的差值即为**行情陈旧度**（可用于告警）。
 */
export async function resolveLatestQuoteDate(referenceDate?: string): Promise<string | null> {
  const ref = referenceDate ?? new Date().toISOString().slice(0, 10);
  // ⚠️ **性能**（2026-10-19 实测）：`v_stock_qfq` / `v_etf_qfq` 是**实时计算的视图**，
  //   对它们做 `MAX(date)` 要扫 1800 万 + 300 万行 → 实测 **14148ms**。
  //   底层 `raw_kline_daily` 同样语义（市场全量日线）只要 **6ms**。
  //   → 主路径走底层表；表不可用时回退到视图（慢但正确）。
  let fastVal: unknown = null;
  try {
    const fast = await queryDuckDB<{ d: unknown }>(
      'SELECT MAX(date) AS d FROM raw_kline_daily WHERE date <= ?',
      [ref],
    );
    fastVal = fast[0]?.d;
  } catch {
    fastVal = null; // 快速路径不可用 → 走视图兜底
  }
  if (fastVal !== null && fastVal !== undefined) {
    return toDateString(fastVal);
  }

  // 回退：视图（raw_kline_daily 缺失或为空时）
  try {
    const rows = await queryDuckDB<{ d: unknown }>(
      `SELECT MAX(d) AS d FROM (
         SELECT MAX(date) AS d FROM v_stock_qfq WHERE date <= ?
         UNION ALL
         SELECT MAX(date) AS d FROM v_etf_qfq WHERE date <= ?
       ) s`,
      [ref, ref],
    );
    if (rows.length === 0) return null;
    const val = rows[0].d;
    if (val === null || val === undefined) return null;
    return toDateString(val);
  } catch {
    return null;
  }
}

/**
 * @deprecated 旧名，语义已修正为「最近有行情的交易日」。
 * 保留是为了不打断既有 import；新代码请用 {@link resolveTargetTradeDate}
 * （日历口径）或 {@link resolveLatestQuoteDate}（数据口径），别再用这个含糊的名字。
 */
export async function getLatestTradingDay(date: string): Promise<string | null> {
  return resolveLatestQuoteDate(date);
}
