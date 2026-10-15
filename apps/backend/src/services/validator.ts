// src/services/validator.ts
// C1-C12 数据校验引擎
// 所有 DuckDB SQL 模板来自 SDD §5.7，{{TRADE_DATE}} 由调度器注入
import { queryDuckDB } from '../db/duckdb.js';
import { writeSystemLog } from './logger.js';

/** 校验结果三值（扩展 SKIP 用于 C11/C12 MVP） */
export type CheckResult = 'PASS' | 'WARN' | 'ERROR' | 'SKIP';

/** 容差常量（集中定义，方便统一调整） */
export const TOLERANCES = {
  ROW_COUNT_DEVIATION: 0.10,    // C1 行数偏离 ±10%
  QFQ_PRICE_DIFF: 0.01,         // C6 前复权价差 < 0.01 元
  VOLUME_MULTIPLIER: 200,       // C7 极端成交量倍数
  GBBQ_DROP_DIFF: 0.005,        // C8 除权跳变率差 < 0.5%
  HFQ_FACTOR_DIFF: 0.0001,      // C9 复权因子抽样容差
  TUSHARE_PRICE_DIFF: 0.01,     // C11 Tushare 价格容差
  EASTMONEY_PRICE_DIFF: 0.02,   // C12 东财价格容差
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

const C1_SQL = `
WITH today_counts AS (
    SELECT COUNT(*) AS cnt
    FROM v_stock_qfq
    WHERE date = ?::date
),
avg_history AS (
    SELECT AVG(cnt) * 0.9 AS lower_bound, AVG(cnt) * 1.1 AS upper_bound
    FROM (
        SELECT date, COUNT(*) AS cnt
        FROM v_stock_qfq
        WHERE date >= ?::date - INTERVAL 30 DAY
          AND date < ?::date
          AND date IN (SELECT date FROM raw_holidays)
        GROUP BY date
    ) hist
)
SELECT
    tc.cnt AS actual_count,
    ah.lower_bound,
    ah.upper_bound,
    CASE
        WHEN tc.cnt BETWEEN ah.lower_bound AND ah.upper_bound THEN 'PASS'
        WHEN tc.cnt > 0 THEN 'WARN'
        ELSE 'ERROR'
    END AS result
FROM today_counts tc CROSS JOIN avg_history ah
`;

interface C1Row {
  actual_count: number;
  lower_bound: number;
  upper_bound: number;
  result: CheckResult;
}

async function checkC1(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C1Row>(C1_SQL, [tradeDate, tradeDate, tradeDate]);
    const row = firstRow(rows);

    if (!row) {
      return { checkId: 'C1', result: 'ERROR', detail: '无返回行（可能 DuckDB 无数据）', durationMs: Date.now() - start };
    }

    const detail = `actual=${row.actual_count}, bounds=[${Math.round(row.lower_bound)}}, ${Math.round(row.upper_bound)}]`;
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
// C3：停牌日停牌标记一致性（MVP 仅实现 C3；C4/C5 SDD 标"略"）
// SQL 原样来自 SDD §5.7 C3
// ─────────────────────────────────────────────────────────────────

const C3_SQL = `
SELECT symbol, date,
    CASE
        WHEN volume = 0 AND close = LAG(close) OVER (PARTITION BY symbol ORDER BY date) THEN 'PASS'
        WHEN volume > 0 THEN 'WARN'
        ELSE 'ERROR'
    END AS result
FROM v_stock_qfq
WHERE date = ?::date
  AND volume = 0
`;

interface C3Row {
  symbol: string;
  result: CheckResult;
}

async function checkC3toC5(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C3Row>(C3_SQL, [tradeDate]);

    if (rows.length === 0) {
      return {
        checkId: 'C3',
        result: 'PASS',
        detail: '当日无停牌股票',
        durationMs: Date.now() - start,
      };
    }

    const warnCount = rows.filter((r) => r.result === 'WARN').length;
    const errorCount = rows.filter((r) => r.result === 'ERROR').length;
    let result: CheckResult = 'PASS';
    if (errorCount > 0) result = 'ERROR';
    else if (warnCount > 0) result = 'WARN';

    return {
      checkId: 'C3',
      result,
      detail: `停牌总数=${rows.length}, WARN=${warnCount}, ERROR=${errorCount}（C4/C5 MVP 暂略）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C3', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C6：前复权因子一致性校验
// SQL 原样来自 SDD §5.7 C6
// ─────────────────────────────────────────────────────────────────

const C6_SQL = `
WITH sampled AS (
    SELECT UNNEST(ARRAY_AGG(symbol ORDER BY random() LIMIT 50)) AS symbol
    FROM v_stock_qfq
    WHERE date = ?::date
)
SELECT v.symbol,
       v.close AS qfq_close,
       ROUND(rk.close * v.qfq_factor, 2) AS raw_close_times_factor,
       ABS(v.close - ROUND(rk.close * v.qfq_factor, 2)) AS diff,
       CASE
           WHEN ABS(v.close - ROUND(rk.close * v.qfq_factor, 2)) < 0.01 THEN 'PASS'
           ELSE 'WARN'
       END AS result
FROM sampled s
JOIN v_stock_qfq v ON s.symbol = v.symbol AND v.date = ?::date
JOIN raw_kline_daily rk ON s.symbol = rk.symbol AND rk.date = ?::date
`;

interface C6Row {
  symbol: string;
  result: CheckResult;
}

async function checkC6(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C6Row>(C6_SQL, [tradeDate, tradeDate, tradeDate]);

    if (rows.length === 0) {
      return { checkId: 'C6', result: 'WARN', detail: '抽样 50 只无返回（raw_kline_daily 可能缺数据）', durationMs: Date.now() - start };
    }

    const warnCount = rows.filter((r) => r.result === 'WARN').length;
    const result: CheckResult = warnCount > 0 ? 'WARN' : 'PASS';

    return {
      checkId: 'C6',
      result,
      detail: `抽样=${rows.length}, WARN=${warnCount}（容差<${TOLERANCES.QFQ_PRICE_DIFF}元）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C6', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C7：成交量异常
// SQL 原样来自 SDD §5.7 C7
// ─────────────────────────────────────────────────────────────────

const C7_SQL = `
WITH recent AS (
    SELECT symbol, date, volume,
        AVG(volume) OVER (
            PARTITION BY symbol
            ORDER BY date
            ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
        ) AS avg_30d
    FROM v_stock_qfq
    WHERE date BETWEEN ?::date - INTERVAL 30 DAY AND ?::date
)
SELECT symbol, date, volume, avg_30d,
    CASE
        WHEN volume = 0 THEN 'WARN'
        WHEN avg_30d > 0 AND volume > 200 * avg_30d THEN 'WARN'
        ELSE 'PASS'
    END AS result
FROM recent
WHERE date = ?::date
`;

interface C7Row {
  symbol: string;
  volume: number;
  avg_30d: number;
  result: CheckResult;
}

async function checkC7(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C7Row>(C7_SQL, [tradeDate, tradeDate, tradeDate]);

    // WARN 计数：零成交 + 极端成交
    const warnCount = rows.filter((r) => r.result === 'WARN').length;
    const result: CheckResult = warnCount > 0 ? 'WARN' : 'PASS';

    return {
      checkId: 'C7',
      result,
      detail: `今日标的=${rows.length}, 异常=${warnCount}（极端倍数>${TOLERANCES.VOLUME_MULTIPLIER}）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C7', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────
// C8：除权日价格跳变率交叉验证
// SQL 原样来自 SDD §5.7 C8
// ─────────────────────────────────────────────────────────────────

const C8_SQL = `
WITH raw AS (
    SELECT v.symbol,
           g.c1 / 10.0 AS cash_per_share,
           g.c3 / 10.0 AS stock_transfer_ratio,
           prev.close AS prev_close,
           v.close AS ex_close,
           (prev.close - v.close) / prev.close AS actual_drop,
           (g.c1 / 10.0 / prev.close) - (g.c3 / 10.0) / (1 + g.c3 / 10.0) AS theoretical_drop
    FROM v_stock_qfq v
    JOIN raw_gbbq g ON v.symbol = g.symbol
      AND g.date = ?::date
      AND g.category = 1
    JOIN v_stock_qfq prev ON v.symbol = prev.symbol
      AND prev.date = ?::date - INTERVAL 1 DAY
    WHERE v.date = ?::date
)
SELECT symbol, actual_drop, theoretical_drop,
    CASE
        WHEN ABS(actual_drop - theoretical_drop) < 0.005 THEN 'PASS'
        ELSE 'WARN'
    END AS result
FROM raw
`;

interface C8Row {
  symbol: string;
  result: CheckResult;
}

async function checkC8(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C8Row>(C8_SQL, [tradeDate, tradeDate, tradeDate]);

    if (rows.length === 0) {
      return { checkId: 'C8', result: 'PASS', detail: '当日无除权事件', durationMs: Date.now() - start };
    }

    const warnCount = rows.filter((r) => r.result === 'WARN').length;
    const result: CheckResult = warnCount > 0 ? 'WARN' : 'PASS';

    return {
      checkId: 'C8',
      result,
      detail: `除权标的=${rows.length}, 偏差=${warnCount}（容差<${(TOLERANCES.GBBQ_DROP_DIFF * 100).toFixed(1)}%）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { checkId: 'C8', result: 'ERROR', detail: `SQL 异常: ${String(err)}`, durationMs: Date.now() - start };
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
JOIN raw_adjust_factor rf ON s.symbol = rf.symbol AND rf.date = ?::date
JOIN latest_factors lf ON s.symbol = lf.symbol
JOIN v_stock_qfq v ON s.symbol = v.symbol AND v.date = ?::date
WHERE ABS(rf.hfq_factor / lf.latest_hfq - v.qfq_factor) >= 0.0001
`;

interface C9Row {
  mismatch_count: number;
  result: CheckResult;
}

async function checkC9(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const rows = await queryDuckDB<C9Row>(C9_SQL, [tradeDate, tradeDate, tradeDate]);
    const row = firstRow(rows);

    if (!row) {
      return { checkId: 'C9', result: 'PASS', detail: '抽样 100 只全部一致（无 mismatch）', durationMs: Date.now() - start };
    }

    return {
      checkId: 'C9',
      result: row.result,
      detail: `mismatch=${row.mismatch_count}/100（容差<${TOLERANCES.HFQ_FACTOR_DIFF}）`,
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
// C11：Tushare 跨源校验（MVP 简化 SKIP）
// SDD §5.7 C11 有完整 TypeScript 比对口径，但 MVP 简化
// ─────────────────────────────────────────────────────────────────

async function checkC11(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  return {
    checkId: 'C11',
    result: 'SKIP',
    detail: 'MVP 暂未接入 Tushare API',
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────
// C12：东财跨源校验（MVP 简化 SKIP）
// ─────────────────────────────────────────────────────────────────

async function checkC12(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  return {
    checkId: 'C12',
    result: 'SKIP',
    detail: 'MVP 暂未接入东财 API',
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────────
// 批量执行 C1-C12（Fastify cron 17:02 调用）
// 单条 try-catch 独立，不阻塞后续
// ─────────────────────────────────────────────────────────────────

const CHECKS: Array<(tradeDate: string) => Promise<CheckSummary>> = [
  checkC1,
  checkC2,
  checkC3toC5,
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
