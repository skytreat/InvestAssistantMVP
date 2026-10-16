import { queryDuckDB } from '../db/duckdb.js';
import type { DailyKline } from '@invest/core';

/** 带 symbol 的原始行（DuckDB SELECT 出来的结构） */
type DailyKlineRow = DailyKline & { symbol: string };

/** 复权类型：qfq 前复权 / bfq 不复权 / hfq 后复权 */
export type AdjustPeriod = 'qfq' | 'bfq' | 'hfq';

function resolveTable(period: AdjustPeriod): string {
  switch (period) {
    case 'qfq': return 'v_stock_qfq';
    case 'hfq': return 'v_stock_hfq';
    case 'bfq':
    default:    return 'v_stock_bfq';
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
    [symbol, date]
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
    [symbol, fromDate, toDate]
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
    [date, ...symbols]
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
    [fromDate, toDate, ...symbols]
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
    [...symbols]
  );

  for (const row of rows) {
    result.set(row.symbol, { date: toDateString(row.date), close: row.close });
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

/**
 * 查询某天是不是交易日（raw_holidays 有 date 列 = 交易日）
 *
 * SDD D2 实测：raw_holidays **只有一个 date 列**（没有 is_trading_day）
 * 有行 = 交易日；没行 = 非交易日
 */
export async function isTradingDay(date: string): Promise<boolean> {
  try {
    const rows = await queryDuckDB<{ count: number }>(
      'SELECT COUNT(*) AS count FROM raw_holidays WHERE date = ?',
      [date]
    );
    return rows.length > 0 && rows[0].count > 0;
  } catch {
    return false;
  }
}

/**
 * 获取指定日期及之前最近的交易日（往前回溯找）
 * 返回找到的交易日，如果全部非交易日返回 null
 */
export async function getLatestTradingDay(date: string): Promise<string | null> {
  try {
    const rows = await queryDuckDB<{ date: unknown }>(
      `SELECT date FROM raw_holidays WHERE date <= ? ORDER BY date DESC LIMIT 1`,
      [date]
    );
    if (rows.length === 0) return null;
    const val = rows[0].date;
    if (val === null || val === undefined) return null;
    return toDateString(val);
  } catch {
    return null;
  }
}
