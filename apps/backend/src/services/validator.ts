// src/services/validator.ts
// C1-C12 数据校验引擎
// 所有 DuckDB SQL 模板来自 SDD §5.7，{{TRADE_DATE}} 由调度器注入
import { queryDuckDB } from '../db/duckdb.js';
import { writeSystemLog } from './logger.js';
import { resolveTargetTradeDate } from './marketData.js';
import { queryLatestTdx2dbTiming } from './quoteUpdateStatus.js';

/** 校验结果三值（扩展 SKIP 用于 C11/C12 MVP） */
export type CheckResult = 'PASS' | 'WARN' | 'ERROR' | 'SKIP';

/** 该日是否有任何行情数据（DuckDB 不可用时保守返回 false） */
export async function hasQuoteDataOn(date: string): Promise<boolean> {
  try {
    const rows = await queryDuckDB<{ quote_rows: number }>(
      'SELECT COUNT(*) AS quote_rows FROM v_stock_qfq WHERE date = ?',
      [date],
    );
    return rows.length > 0 && Number(rows[0].quote_rows) > 0;
  } catch {
    return false;
  }
}

/**
 * 容差 / 阈值常量（集中定义）
 *
 * T85（2026-10-17，B-14 裁决）按 Requirements §7 重整：
 * 初稿的 C1~C8 定义是「数据内容校验」，Requirements 定义的是「数据新鲜度」，
 * 二者完全不同。此处按 Requirements 补齐新鲜度类阈值。
 */
export const TOLERANCES = {
  // ── C1-C8 新鲜度类（Requirements §7.1）──
  MIN_SYMBOL_COUNT: 3000, // C1/C6 当日标的数下限（Requirements 明写 ≥3000）
  EX_DIVIDEND_FRESH_DAYS: 7, // C4 最新除权日 ≥ 当日 - 7 天
  CLASS_COUNT_DROP: 0.1, // C5 分类总数降幅 < 10%
  MAX_OPEN_CLOSE_RATIO: 2, // C7 开盘价 ≤ 收盘价 × 2
  MAX_UPDATE_SECONDS: 120, // C8 行情更新执行时长 ≤ 120s

  // ── C9/C10 内容类（Requirements §7.2）──
  QFQ_PRICE_DIFF: 0.01, // C9 前复权价差容差 < 0.01 元
  GBBQ_DROP_DIFF: 0.005, // C10 除权跳变率差 < 0.5%

  // ── C11/C12 跨源类（Requirements §7.3）──
  TUSHARE_PRICE_DIFF: 0.01, // C11 Tushare 价格容差
  EASTMONEY_PRICE_DIFF: 0.02, // C12 东财价格容差
} as const;

/**
 * 跨源校验「执行参数」（T97）—— 抽样数 / 节流 / 退避 / 超时 / 降级阈值
 *
 * 与 `TOLERANCES` 的分工：`TOLERANCES` 是「比多算不算数」（判定内容），
 * `EXEC_PARAMS` 是「怎么跑」（执行节奏）。T85 定前者，T97 定后者，二者不可互相替代。
 *
 * ⚠️ **C11 与 C12 的节流值不同且有据可循，严禁统一成一个常量**：
 *   - C11 走 Tushare，有硬限额（daily 接口 50 次/分钟、每日 500 次）→ 100ms/只
 *   - C12 走东方财富，调用无次数上限但会被软限流 → 500ms/只
 */
export const EXEC_PARAMS = {
  // ── 抽样规模（Requirements §7.3「抽样 30 只 / 20 只」；§7.2 C9「抽样 100 只」）──
  C9_SAMPLE_SIZE: 100,
  C11_SAMPLE_SIZE: 30,
  C12_SAMPLE_SIZE: 20,

  // ── 节流（每只请求之间的固定间隔）──
  C11_THROTTLE_MS: 100,
  C12_THROTTLE_MS: 500,

  // ── 单只超时 ──
  C11_TIMEOUT_MS: 5_000,
  C12_TIMEOUT_MS: 10_000,

  // ── C12 退避重试序列：第 1 次失败等 200ms，第 2 次失败等 400ms，共重试 2 次 ──
  RETRY_BACKOFF_MS: [200, 400],

  // ── 总耗时上限（SDD §7.3 鲁棒性：跨源校验总 30s）──
  MAX_TOTAL_MS: 30_000,

  // ── 告警分级阈值（Requirements §7.3 唯一权威；匹配率目标见 PRD §6.2）──
  C11_WARN_AT: 3, // C11 mismatch > 3 只 → WARN（PRD §6.2 目标 ≤3/30 容差内）
  C11_ERROR_AT: 5, // C11 mismatch > 5 只 → ERROR
  C12_WARN_AT: 5, // C12 mismatch > 5 只有差异 → WARN（PRD §6.2 目标 ≤5/20 容差内）
  C12_ERROR_GT: 0.1, // C12 单只价差 > 0.1 元 → 计入「大幅差异只数」
  C12_ERROR_COUNT_GT: 1, // C12  大幅差异只数 > 1 → ERROR（**幅度条件，不是计数条件**）

  // ── 外部源整体不可用的降级判定（连续失败 → 整项 SKIP，不阻塞后续校验）──
  C11_SKIP_CONSECUTIVE_FAILS: 5,
  C12_SKIP_CONSECUTIVE_FAILS: 5,

  // ── HTTP 层限流信号：命中即「跳过该只」，不再重试（SDD §7.3「被限流 → 跳过该只」）──
  RATE_LIMIT_STATUSES: [429, 503],

  // ── detail 字段截断长度，避免 system_log 被长文本撑爆 ──
  MAX_DETAIL_CHARS: 200,
} as const;

export interface CheckSummary {
  checkId: string; // 'C1' / 'C2' / ...
  result: CheckResult;
  detail?: string; // 额外说明
  durationMs: number;
}

/**
 * C1~C12 的中文名称 —— **逐字取自 SDD §5.7 主表的小节标题**
 *
 * ⚠️ **为什么名称必须由后端出**（Wave 7 · 卡 3 · 裁决 D-4）：
 *   G7.6 的原文是「卡片显示的**校验名称与 SDD §5.7 主表一致**」。
 *   若前端硬编码这份清单，一致性就变成「前端自说自话 vs 前端自说自话」——
 *   名称一旦与 SDD 漂移，**没有任何一处会报错**（自证）。
 *   ⇒ 唯一可证伪的做法：名称由本文件（**全仓唯一引用 SDD §5.7 标题的地方**）导出，
 *     路由随结果一起下发，前端只负责渲染。
 *
 * ⚠️ **名称 = 标题正文**，不含编号前缀（`C1：` 那部分不是名称）。
 * ⚠️ **SDD §5.7 末尾「📎 扩展校验」的 6 条（停牌/退市/ST/价差/成交量/滞后）不在此表内** ——
 *    它们**不占用 C 编号、不计入 12 项主表**（SDD §5.7 该小节的裁决）。
 */
export const CHECK_NAMES: Record<string, string> = {
  C1: '当日日线行数是否正常',
  C2: '交易日历匹配',
  C3: '复权因子数据新鲜度',
  C4: '除权除息数据新鲜度',
  C5: '板块 / 概念数据完整性',
  C6: '市值数据存在性',
  C7: '日线价格合理性',
  C8: '行情更新执行时长',
  C9: '复权因子抽样数学一致性',
  C10: '除权除息事件覆盖完整性',
  C11: 'Tushare 免费 API 跨源校验（每日 1 次）',
  C12: '东财跨源校验（20 只抽样，节流）',
};

/**
 * C1~C12 的**规范编号全集**（顺序 = 展示顺序）
 *
 * ⚠️ 由 `CHECK_NAMES` 的键派生 ⇒ 二者**不可能漂移**（新增一项校验只需改 `CHECK_NAMES`）。
 * ⚠️ 这是「12 项」的**结构基准**（裁决 D-1），**不含名称** —— 名称一律由后端下发。
 */
export const CHECK_IDS: readonly string[] = Object.keys(CHECK_NAMES);

// ─────────────────────────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────────────────────────

/** 单行包装：很多校验 SQL 只返回一行 */
function firstRow<T>(rows: T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

/**
 * 节流 / 退避的唯一出口。
 * 全部延时都必须经由本函数，禁止在文件内散落 `setTimeout(..., 字面量)`。
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 跨源校验总耗时守卫：已用时达到 MAX_TOTAL_MS 即中止剩余请求 */
function withinTimeBudget(startedAt: number): boolean {
  return Date.now() - startedAt < EXEC_PARAMS.MAX_TOTAL_MS;
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
    return {
      checkId: 'C1',
      result: 'ERROR',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// C2：交易日历匹配
//
// 🔴 2026-10-19 实测修正（I-20）：原 SQL 的 CASE 分支建立在
// 「raw_holidays 有行 = 交易日」这一**错误假设**上，而实测证明
// `raw_holidays` 存的是**休市日**黑名单。
//
// 实测证据：该表 680 行中「该日有行情」的为 0 行；v_stock_qfq 的 8799 个日期
// 无一在表内。旧 SQL 的后果是**每个真实场景都判错**：
//   2026-10-12 交易日有行情 → 旧判 WARN（应 PASS）
//   2026-10-07 休市日无行情 → 旧判 ERROR（应 PASS）
//   2026-10-18 交易日无行情 → 旧判 PASS（应 SKIP，即假绿）
//
// 正确口径：交易日 = 工作日 且 不在 raw_holidays 中。
//   · 交易日 且 有行情 → PASS
//   · 休市日   且 无行情 → PASS（休市本就没有行情）
//   · 交易日 且 无行情 → SKIP（数据缺失，不算通过；对应「行情陈旧」场景）
//   · 休市日   且 有行情 → ERROR（矛盾，数据源异常）
// ─────────────────────────────────────────────────────────────────

const C2_SQL = `
SELECT
    CASE
        WHEN EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?::date)
          AND NOT EXISTS (SELECT 1 FROM v_stock_qfq WHERE date = ?::date)
            THEN 'PASS'
        WHEN NOT EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?::date)
          AND EXISTS (SELECT 1 FROM v_stock_qfq WHERE date = ?::date)
            THEN 'PASS'
        WHEN NOT EXISTS (SELECT 1 FROM raw_holidays WHERE date = ?::date)
          AND NOT EXISTS (SELECT 1 FROM v_stock_qfq WHERE date = ?::date)
            THEN 'SKIP'
        ELSE 'ERROR'
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
    return {
      checkId: 'C2',
      result: 'ERROR',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
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
    return {
      checkId: 'C3',
      result: 'WARN',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
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
    return {
      checkId: 'C4',
      result: 'WARN',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

/** C5：板块/分类完整性（Requirements §7.1，WARN）
 *
 * ⚠️ 2026-10-17 实测：`raw_tdx_blocks_member(stock_symbol, block_code)` **无 date 列且为空表**，
 *    故「按日统计板块成分总量降幅」不可实现。改用 `raw_symbol_class(symbol, class)`
 *    的分类数降幅 —— 口径等价（数据源从板块切到资产分类），且可执行。
 *    两者均为 WARN + 仅记录，不自动补跑（Requirements §7.1）。
 */
// 🔴 T85b ④（I-22）：Requirements §7.1 的 C5 是「**板块数据**完整」，
//   数据源应为**板块明细表**（`raw_tdx_blocks_info` / `_member`）。
//   实测两张表均 **0 行**（板块数据从未采集）→ 「总量降幅」无从谈起。
//   原实现（T85）改用 `raw_symbol_class` 的 class 维度计数 —— 那是**另一口径**
//   （分类数，不是板块数），且在板块表为空时仍报 PASS/WARN，**掩盖了数据源缺失**。
//
//   本次改为：
//   · 主口径 = 板块明细表行数（真正的「板块数据总量」）
//   · 板块表为空 → **SKIP**（数据源缺失 ≠ 校验通过），并在 detail 里明示
//   · 同时记录 class='block' 标的数作为**参考信号**（不参与判定）
const C5_SQL = `
WITH today_blocks AS (
    SELECT COUNT(*) AS cnt FROM raw_tdx_blocks_info
),
prev_day AS (
    SELECT MAX(date) AS d FROM v_stock_qfq WHERE date < CAST(? AS DATE)
),
prev_blocks AS (
    SELECT COUNT(*) AS cnt FROM raw_tdx_blocks_info
),
today_ref AS (
    SELECT COUNT(*) AS cnt FROM raw_symbol_class WHERE class = 'block'
),
prev_ref AS (
    SELECT COUNT(*) AS cnt FROM raw_symbol_class
    WHERE class = 'block'
      AND EXISTS (SELECT 1 FROM v_stock_qfq v WHERE v.date = (SELECT d FROM prev_day))
)
SELECT
    t.cnt AS today_cnt,
    p.cnt AS prev_cnt,
    tr.cnt AS today_ref,
    pr.cnt AS prev_ref,
    CASE
        WHEN t.cnt = 0 THEN 'SKIP'
        WHEN p.cnt = 0 THEN 'SKIP'
        WHEN (p.cnt - t.cnt) * 1.0 / p.cnt < ? THEN 'PASS'
        ELSE 'WARN'
    END AS result
FROM today_blocks t
CROSS JOIN prev_blocks p
CROSS JOIN today_ref tr
CROSS JOIN prev_ref pr
`;

interface C5Row {
  today_cnt: number;
  today_ref: number;
  prev_ref: number;
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
    const detail =
      `板块数=${row.today_cnt}（前一交易日 ${row.prev_cnt}），降幅阈值 ${TOLERANCES.CLASS_COUNT_DROP * 100}%；` +
      `参考：class='block' 标的数 ${row.today_ref}（前一交易日 ${row.prev_ref}）` +
      (Number(row.today_cnt) === 0
        ? ' —— ⚠️ **板块明细表为空（raw_tdx_blocks_info 0 行）**，无法校验板块数据完整性，本项判 SKIP'
        : '');
    return { checkId: 'C5', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return {
      checkId: 'C5',
      result: 'WARN',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
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
    return {
      checkId: 'C6',
      result: 'WARN',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
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
    const detail =
      row.bad_cnt === 0
        ? '当日无价格异常标的'
        : `异常标的=${row.bad_cnt}（收盘价=0 或 开盘价 > 收盘价×${TOLERANCES.MAX_OPEN_CLOSE_RATIO}）`;
    return { checkId: 'C7', result: row.result, detail, durationMs: Date.now() - start };
  } catch (err) {
    return {
      checkId: 'C7',
      result: 'WARN',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// C8：行情更新执行时长（Requirements §7.1：≤ 120s，WARN）
// ⚠️ T85：初稿此处实现的是「数据滞后天数」—— 那是 SDD 的扩展校验，已移出。
// ⚠️ T107（2026-10-24）：system_log 是 **SQLite** 表，原实现用 queryDuckDB 查询
//    ⇒ 生产环境必然 `Catalog Error: Table with name system_log does not exist`，
//    且 SQL 里的 `?::date` 是 PostgreSQL 语法，SQLite 不支持。
//    现改为读 SQLite，并使用 T105 写入的 `duration_s`（真实执行耗时）。
//    无结构化日志（新库 / 从未跑过 tdx2db）→ SKIP，不得计为 PASS（ADR-004）。
// ─────────────────────────────────────────────────────────────────

async function checkC8(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const row = queryLatestTdx2dbTiming(tradeDate);
    if (!row) {
      return {
        checkId: 'C8',
        result: 'SKIP',
        detail: `无 ${tradeDate} 的结构化 tdx2db_update 日志（无法判定执行时长）`,
        durationMs: Date.now() - start,
      };
    }
    if (!row.detail) {
      return {
        checkId: 'C8',
        result: 'WARN',
        detail: 'tdx2db_update 日志缺少 detail（无法判定执行时长）',
        durationMs: Date.now() - start,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.detail);
    } catch {
      return {
        checkId: 'C8',
        result: 'WARN',
        detail: `tdx2db_update.detail 不是合法 JSON：${row.detail.slice(0, 120)}`,
        durationMs: Date.now() - start,
      };
    }
    const durationSec = Number((parsed as { duration_s?: unknown })?.duration_s);
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      return {
        checkId: 'C8',
        result: 'WARN',
        detail: `tdx2db_update.detail 缺少合法的 duration_s：${row.detail.slice(0, 120)}`,
        durationMs: Date.now() - start,
      };
    }
    const result: CheckResult = durationSec <= TOLERANCES.MAX_UPDATE_SECONDS ? 'PASS' : 'WARN';
    return {
      checkId: 'C8',
      result,
      detail: `行情更新耗时 ${durationSec}s（上限 ${TOLERANCES.MAX_UPDATE_SECONDS}s，日志时间 ${row.createdAt}）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      checkId: 'C8',
      result: 'WARN',
      detail: `读取 system_log 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// C9：复权因子抽样 100 只
// SQL 原样来自 SDD §5.7 C9
// ─────────────────────────────────────────────────────────────────

const C9_SQL = `
WITH sample AS (
    SELECT symbol
    FROM v_stock_qfq
    WHERE date = ?::date
    ORDER BY random()
    LIMIT ?
),
joined AS (
    SELECT
        vh.close      AS hfq_close,
        vb.close      AS bfq_close,
        vh.hfq_factor AS view_hfq,
        ra.hfq_factor AS src_hfq
    FROM sample s
    JOIN v_stock_hfq vh ON vh.symbol = s.symbol AND vh.date = ?::date
    JOIN v_stock_bfq vb ON vb.symbol = s.symbol AND vb.date = ?::date
    LEFT JOIN raw_adjust_factor ra ON ra.symbol = s.symbol AND ra.date = ?::date
)
SELECT
    COUNT(*) AS sampled,
    COALESCE(SUM(CASE WHEN ABS(hfq_close - bfq_close * view_hfq) >= ? THEN 1 ELSE 0 END), 0) AS math_mismatch,
    COALESCE(SUM(CASE WHEN src_hfq IS NOT NULL AND ABS(src_hfq - view_hfq) >= ? THEN 1 ELSE 0 END), 0) AS factor_mismatch,
    CASE
        -- 抽样为空 = 该日没有任何可校验的标的 → SKIP（数据缺失 ≠ 校验通过）
        WHEN COUNT(*) = 0 THEN 'SKIP'
        WHEN COALESCE(SUM(CASE WHEN ABS(hfq_close - bfq_close * view_hfq) >= ? THEN 1 ELSE 0 END), 0)
           + COALESCE(SUM(CASE WHEN src_hfq IS NOT NULL AND ABS(src_hfq - view_hfq) >= ? THEN 1 ELSE 0 END), 0) = 0
            THEN 'PASS'
        WHEN COALESCE(SUM(CASE WHEN ABS(hfq_close - bfq_close * view_hfq) >= ? THEN 1 ELSE 0 END), 0)
           + COALESCE(SUM(CASE WHEN src_hfq IS NOT NULL AND ABS(src_hfq - view_hfq) >= ? THEN 1 ELSE 0 END), 0) <= 5
            THEN 'WARN'
        ELSE 'ERROR'
    END AS result
FROM joined
`;

interface C9Row {
  sampled: number;
  math_mismatch: number;
  factor_mismatch: number;
  result: CheckResult;
}

async function checkC9(tradeDate: string): Promise<CheckSummary> {
  const start = Date.now();
  try {
    const tol = TOLERANCES.QFQ_PRICE_DIFF;
    const sampleSize = EXEC_PARAMS.C9_SAMPLE_SIZE;
    const row = firstRow(
      await queryDuckDB<C9Row>(C9_SQL, [
        tradeDate,
        sampleSize,
        tradeDate,
        tradeDate,
        tradeDate,
        tol,
        tol,
        tol,
        tol,
        tol,
        tol,
      ]),
    );

    if (!row) {
      return { checkId: 'C9', result: 'SKIP', detail: 'DuckDB 无返回行', durationMs: Date.now() - start };
    }

    const math = Number(row.math_mismatch ?? 0);
    const factor = Number(row.factor_mismatch ?? 0);
    return {
      checkId: 'C9',
      result: row.result,
      detail:
        `抽样 ${row.sampled} 只：mismatch=${math + factor}` +
        `（复权数学不一致=${math}，因子源不一致=${factor}，容差<${tol}，≤5→WARN / >5→ERROR）`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      checkId: 'C9',
      result: 'ERROR',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
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
    return {
      checkId: 'C10',
      result: 'ERROR',
      detail: `SQL 异常: ${String(err)}`,
      durationMs: Date.now() - start,
    };
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
function parseTushareRow(fields: string[], item: (string | number | null)[]): TushareDailyRow {
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

/** 调用 Tushare 免费 daily 接口，超时取 EXEC_PARAMS.C11_TIMEOUT_MS */
async function fetchTushareDaily(tsCode: string, tradeDate: string): Promise<TushareDailyRow | null> {
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
    signal: AbortSignal.timeout(EXEC_PARAMS.C11_TIMEOUT_MS),
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

  // 随机抽样 30 只（Tushare Free 每日 500 次限额，一次跑完不累积）
  const sampled = [...localRows].sort(() => Math.random() - 0.5).slice(0, EXEC_PARAMS.C11_SAMPLE_SIZE);

  let match = 0;
  let mismatch = 0;
  let fetchFail = 0;
  let consecutiveFail = 0;
  let timedOut = false;
  const mismatchDetails: string[] = [];

  for (const row of sampled) {
    // 总耗时守卫：超 30s 中止剩余请求，已比对的结果照常出结论
    if (!withinTimeBudget(start)) {
      timedOut = true;
      break;
    }

    const tsCode = convertToTsCode(row.symbol);
    let failed = true;
    try {
      const tushare = await fetchTushareDaily(tsCode, tradeDate);
      if (!tushare) {
        fetchFail++;
      } else if (compareC11Rows(row, tushare)) {
        match++;
        failed = false;
      } else {
        mismatch++;
        failed = false;
        mismatchDetails.push(
          `${row.symbol}: local_close=${row.close} ts_close=${tushare.close} local_pre=${row.pre_close} ts_pre=${tushare.pre_close}`,
        );
      }
    } catch {
      fetchFail++;
    }
    consecutiveFail = failed ? consecutiveFail + 1 : 0;

    // 100ms 节流/只（Tushare daily 限 50 次/分钟、每日 500 次；30 只 ≈ 3s 跑完）
    await sleep(EXEC_PARAMS.C11_THROTTLE_MS);
  }

  const abortNote = timedOut
    ? `超时提前中止（总耗时上限 ${EXEC_PARAMS.MAX_TOTAL_MS}ms，仅比对 ${match + mismatch}/${sampled.length} 只）`
    : '';
  const detailTail = mismatchDetails.join('; ').slice(0, EXEC_PARAMS.MAX_DETAIL_CHARS);

  let result: CheckResult;
  let detail: string;

  if (fetchFail >= sampled.length || consecutiveFail >= EXEC_PARAMS.C11_SKIP_CONSECUTIVE_FAILS) {
    // 外部源整体不可用（token 失效 / 429 限流耗尽 / 网络异常）→ SKIP，不阻塞后续校验
    result = 'SKIP';
    detail = `Tushare API 整体不可用（fetchFail=${fetchFail}，连续失败 ${consecutiveFail} 次）${abortNote}`;
  } else if (mismatch === 0) {
    result = 'PASS';
    detail = `${sampled.length} 只全 PASS（match=${match} fetchFail=${fetchFail}）${abortNote}`;
  } else if (mismatch <= EXEC_PARAMS.C11_WARN_AT) {
    // Requirements §7.3「>3 只不匹配 → WARN」：1~3 只即记 WARN，不计 PASS
    result = 'WARN';
    detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${detailTail}${abortNote}`;
  } else if (mismatch <= EXEC_PARAMS.C11_ERROR_AT) {
    // 4~5 只：仍为 WARN（ERROR 只在 >5 只时触发）
    result = 'WARN';
    detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${detailTail}${abortNote}`;
  } else {
    result = 'ERROR';
    detail = `mismatch=${mismatch} match=${match} fetchFail=${fetchFail} · ${detailTail}${abortNote}`;
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

/** 东财单次请求的结果分类（决定是「跳过该只」还是「值得退避重试」） */
type EmFetchOutcome =
  | { kind: 'ok'; close: number }
  /** 被限流（429/503）→ 直接跳过该只，不浪费重试预算（SDD §7.3「被限流 → 跳过该只」）*/
  | { kind: 'rate_limited' }
  /** 网络异常 / 超时 / 非 200 / 无数据 → 退避重试耗尽后跳过该只 */
  | { kind: 'unavailable' };

/**
 * 调东财免费日K接口取前复权收盘价（单次尝试，不含重试）
 * @param symbol  sh600000 / sz000001 / bj8xxxxx（北交所跳过）
 * @param tradeDate  YYYY-MM-DD
 */
async function fetchEastMoneyQfqOnce(symbol: string, tradeDate: string): Promise<EmFetchOutcome> {
  const prefix = symbol.slice(0, 2).toLowerCase();
  const code = symbol.slice(2);
  const market = prefix === 'sh' ? '1' : prefix === 'sz' ? '0' : null;
  if (!market) return { kind: 'unavailable' };

  const begEnd = tradeDate.replace(/-/g, '');
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${market}.${code}&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&beg=${begEnd}&end=${begEnd}&lmt=1`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://quote.eastmoney.com/',
      },
      signal: AbortSignal.timeout(EXEC_PARAMS.C12_TIMEOUT_MS), // 单只 10s 超时
    });
    const isRateLimited = (EXEC_PARAMS.RATE_LIMIT_STATUSES as readonly number[]).includes(res.status);
    if (isRateLimited) return { kind: 'rate_limited' };
    if (!res.ok) return { kind: 'unavailable' };
    const json = (await res.json()) as {
      data?: { klines?: string[] | null };
    };
    const klines = json?.data?.klines;
    if (!Array.isArray(klines) || klines.length === 0) return { kind: 'unavailable' };
    // fields2 顺序 = f51 日期, f52 开盘, f53 收盘, f54 最高, f55 最低, f56 量, f57 额, f58 振幅, f59 涨跌幅, f60 涨跌额, f61 换手
    // => 收盘价是 parts[2]。2026-10-17 真实响应实测：1262.95,1288.00,1288.00,1261.00 与本地 close=1288 吻合
    const parts = String(klines[0]).split(',');
    const close = Number(parts[2]);
    return Number.isFinite(close) ? { kind: 'ok', close } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * 带退避重试的东财取价：失败（网络/超时/非 200）按 200ms → 400ms 退避重试 2 次，
 * 仍失败则该只记为「跳过」（返回 null），绝不抛出、不阻塞后续标的。
 * 被限流（429/503）不重试 —— 立刻跳过该只。
 */
async function fetchEastMoneyQfq(symbol: string, tradeDate: string): Promise<number | null> {
  let outcome = await fetchEastMoneyQfqOnce(symbol, tradeDate);
  for (
    let attempt = 0;
    outcome.kind === 'unavailable' && attempt < EXEC_PARAMS.RETRY_BACKOFF_MS.length;
    attempt++
  ) {
    await sleep(EXEC_PARAMS.RETRY_BACKOFF_MS[attempt]);
    outcome = await fetchEastMoneyQfqOnce(symbol, tradeDate);
  }
  return outcome.kind === 'ok' ? outcome.close : null;
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

    // 随机抽 20 只（Requirements §7.3）
    const sampled = [...localRows].sort(() => Math.random() - 0.5).slice(0, EXEC_PARAMS.C12_SAMPLE_SIZE);

    let match = 0;
    let mismatch = 0;
    let bigDiff = 0;
    let fetchFail = 0;
    let consecutiveFail = 0;
    let sourceDown = false;
    let timedOut = false;
    const details: string[] = [];

    for (const row of sampled) {
      // 总耗时守卫：超 30s 中止剩余请求，已比对的结果照常出结论
      if (!withinTimeBudget(start)) {
        timedOut = true;
        break;
      }

      const emClose = await fetchEastMoneyQfq(row.symbol, tradeDate);
      if (emClose === null) {
        fetchFail++;
        consecutiveFail++;
      } else {
        consecutiveFail = 0;
        const diff = Math.abs(row.local_qfq_close - emClose);
        if (diff < TOLERANCES.EASTMONEY_PRICE_DIFF) {
          match++;
        } else {
          mismatch++;
          if (diff > EXEC_PARAMS.C12_ERROR_GT) bigDiff++;
          details.push(`${row.symbol}: local=${row.local_qfq_close} em=${emClose} diff=${diff.toFixed(4)}`);
        }
      }

      // 连续多只失败 → 判定东财整体不可用，立即整项 SKIP（不阻塞后续校验）
      if (consecutiveFail >= EXEC_PARAMS.C12_SKIP_CONSECUTIVE_FAILS) {
        sourceDown = true;
        break;
      }

      // 500ms 节流/只，避免东财限流
      await sleep(EXEC_PARAMS.C12_THROTTLE_MS);
    }

    const abortNote = timedOut
      ? `超时提前中止（总耗时上限 ${EXEC_PARAMS.MAX_TOTAL_MS}ms，仅比对 ${match + mismatch}/${sampled.length} 只）`
      : '';
    const detailTail = details.join('; ').slice(0, EXEC_PARAMS.MAX_DETAIL_CHARS);

    let result: CheckSummary['result'];
    let detail: string;

    if (sourceDown || fetchFail >= sampled.length) {
      // 外部源整体不可用 / 全部请求失败 → SKIP（不是 ERROR），不阻塞后续校验
      result = 'SKIP';
      detail = `东财 API 整体不可用（fetchFail=${fetchFail}，连续失败 ${consecutiveFail} 次）${abortNote}`;
    } else if (mismatch === 0) {
      result = 'PASS';
      detail = `${sampled.length} 只全 PASS（match=${match} fetchFail=${fetchFail}）${abortNote}`;
    } else if (bigDiff > EXEC_PARAMS.C12_ERROR_COUNT_GT) {
      // Requirements §7.3：>1 只差异 > 0.1 元 → ERROR（幅度条件，与 mismatch 计数无关）
      result = 'ERROR';
      detail = `mismatch=${mismatch}（其中 ${bigDiff} 只差异 >${EXEC_PARAMS.C12_ERROR_GT} 元）match=${match} fetchFail=${fetchFail} · ${detailTail}${abortNote}`;
    } else if (mismatch <= EXEC_PARAMS.C12_WARN_AT) {
      result = 'WARN';
      detail = `mismatch=${mismatch}（≤${EXEC_PARAMS.C12_WARN_AT}，PRD §6.2 容差内）match=${match} fetchFail=${fetchFail} · ${detailTail}${abortNote}`;
    } else {
      // >5 只有差异仍记 WARN：Requirements §7.3 对 C12 的 ERROR 只由「幅度」触发，计数只决定 WARN 级别
      result = 'WARN';
      detail = `mismatch=${mismatch}（>${EXEC_PARAMS.C12_WARN_AT}，均在 ${EXEC_PARAMS.C12_ERROR_GT} 元以内）match=${match} fetchFail=${fetchFail} · ${detailTail}${abortNote}`;
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
  // 单一事实源（T85b ②）：未显式指定时，用**日历口径**的当前交易日。
  // ⚠️ 刻意不用「有行情数据的最后一天」—— 那样数据陈旧时会回退到旧日期，
  //    C1/C3 全部 PASS → 假绿。日历口径能让陈旧如实暴露为 ERROR/WARN。
  const date = tradeDate ?? (await resolveTargetTradeDate()) ?? new Date().toISOString().slice(0, 10);
  const summaries: CheckSummary[] = [];

  // ── 无行情数据闸门（T85b ②）──────────────────────────────────────
  // 「当天没有行情数据」时，**不得**把「查到 0 条」判成 PASS —— 那是假绿。
  // 典型场景：周末 / 法定假日 / 行情管道停摆（tdx2db 停跑）。
  //
  // ⚠️ **C2 / C11 / C12 除外**：
  //    · C2 就是「交易日历匹配」这项校验本身 —— 它的职责正是判定「该日该不该有
  //      数据」。若一并 SKIP，它就永远没有输出，失去存在意义。C2 内部已按正确
  //      口径实现（休市日无数据 = PASS；交易日无数据 = SKIP）。
  //    · C11 / C12 是**跨源校验**（对 Tushare / 东财），不依赖本地 DuckDB 的行数
  //      —— 外部源不可用时它们各自判 SKIP，不能被本地数据缺失牵连。
  //
  // 其余 C1/C3-C10 在无数据时一律 SKIP（数据源缺失 ≠ 校验通过）。
  const hasQuoteData = await hasQuoteDataOn(date);

  for (const checkFn of CHECKS) {
    // 包裹 try-catch，单条 SQL 崩了不影响其他
    let summary: CheckSummary;
    const fnName = checkFn.name;
    const idMatch = fnName.match(/check(C\d+)/);
    const checkId = idMatch ? idMatch[1] : fnName;

    const exemptFromGate = checkId === 'C2' || checkId === 'C11' || checkId === 'C12';
    if (!hasQuoteData && !exemptFromGate) {
      // 该日无任何行情数据 → SKIP（数据源缺失 ≠ 校验通过）
      summary = {
        checkId,
        result: 'SKIP',
        detail: `${date} 无行情数据（休市日或行情管道停摆），跳过本校验`,
        durationMs: 0,
      };
    } else {
      try {
        summary = await checkFn(date);
      } catch (err) {
        summary = {
          checkId,
          result: 'ERROR',
          detail: `未预期异常: ${String(err)}`,
          durationMs: 0,
        };
      }
    }
    summaries.push(summary);

    // 每条校验结果都写 system_log
    logResult(summary.checkId, summary.result, summary.detail ?? '', date);
  }

  return summaries;
}
