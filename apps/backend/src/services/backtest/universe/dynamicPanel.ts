/**
 * 全市场行情面板装载（M3）—— `--universe dynamic` 的数据基础
 *
 * M2 的 CLI 遇到 `--universe dynamic` 直接报错（只装了固定池那 115 只）；
 * 动态时点池的候选来自**全市场 ETF**，策略打分要在任意候选上取序列，
 * 故必须把「区间内全部 ETF」的日线一次性载进内存（proposal §10 / §3.1）。
 *
 * 硬约束（AGENTS.md「DuckDB 行情层」）：
 *   - **只读**（`src/db/duckdb.ts` 的 instance 以 `access_mode: 'READ_ONLY'` 创建）；
 *   - **一次区间 SQL 取全市场**，禁止逐标的循环查询（3 条 SQL 封顶：qfq / bfq / 指数）；
 *   - 口径不另算：qfq 走 `v_etf_qfq`、bfq 走 `v_etf_bfq`（与 M1 `marketPanel.getBars` 同一族视图，
 *     复权由 tdx2db 的视图 DDL 决定）；
 *   - 指数在库里**没有 `v_index_*` 视图**（只有 `v_stock_*` / `v_etf_*`，实测见
 *     `docs/tdx2db_schema_dump.sql`）⇒ 指数走 `raw_kline_daily` ∩ `class='index'`，
 *     `preclose` 由同序列 `lag(close)` 补（`raw_basic_daily` 无指数行，实测 2908 行 preclose 全 NULL）。
 *
 * 规模（**真库实测 2026-11-06**，区间 2023-01-01 ~ 2025-12-31）：
 *   - `v_etf_qfq` / `v_etf_bfq` 各 **1,017,704 行**、**1894 只** ETF（区间内有 bar 的并集；
 *     单日只数 1161（2023-01-03）→ 1797（2025-12-31），区间内新上市/退市的标的都计入并集）；
 *   - `barCount` = **2,038,316**（两轨 2×1,017,704 + 四指数 4×727）；
 *   - 装载耗时 **5.6s**；`heapUsed` 实测 **≈ 700 MB**（2M 根 bar × 每根一个对象）。
 *     ⚠️ 不是「几十 MB」—— 动态池要覆盖全市场，这个量级是必然代价；
 *     M4 做长区间寻优时应换列存（或只保留持有过的标的的 exec 轨）。
 */
import { queryDuckDBColumnar } from '../../../db/duckdb.js';
import type { Bar } from '../types.js';

/** 复权口径 → ETF 视图（与 `marketPanel.VIEW_BY_ADJUST` 同源，这里只取两条轨） */
const QFQ_VIEW = 'v_etf_qfq';
const BFQ_VIEW = 'v_etf_bfq';

export interface PanelLoadOptions {
  start: string;
  end: string;
  /**
   * 额外必须装载的标的（固定池 / 防御 ETF / 用户 `--symbol` / 基准）
   *
   * ⚠️ 全市场 SQL 已经覆盖**所有 `class='etf'`** 的标的，故当前实现不为它单独再发查询
   * （避免逐标的查询）。换言之：本字段里的代码必须是 ETF（否则不会出现在面板里 ——
   * 与 M2 `getBars` 的既有语义一致，`v_etf_*` 视图只放行 `class='etf'`）。
   */
  extraSymbols?: readonly string[];
  /** 需要指数行情的代码（走弱期用 `WEAK_PERIOD_INDEXES` 四只） */
  indexCodes?: readonly string[];
}

export interface UniversePanel {
  /** 前复权（策略打分用） */
  signalBars: Map<string, Bar[]>;
  /** 不复权 + preclose（成交 / 涨跌停 / 估值用） */
  execBars: Map<string, Bar[]>;
  /** 指数（前复权口径；指数无复权因子，即原始点位） */
  indexBars: Map<string, Bar[]>;
  /** 实际取到 bar 的标的（升序；不含只出现在 `extraSymbols` 里但库中无 bar 的代码） */
  symbols: string[];
  /** 面板 bar 总数（signalBars + execBars + indexBars 的 bar 之和） */
  barCount: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 参数校验（纯函数，**不碰 DB** —— 单测用无效参数即可在无行情库环境覆盖） */
export function validatePanelOptions(opts: PanelLoadOptions): void {
  if (!DATE_RE.test(opts.start))
    throw new Error(`loadUniversePanel: start 必须是 YYYY-MM-DD（收到 ${opts.start}）`);
  if (!DATE_RE.test(opts.end))
    throw new Error(`loadUniversePanel: end 必须是 YYYY-MM-DD（收到 ${opts.end}）`);
  if (opts.start > opts.end) {
    throw new Error(`loadUniversePanel: start 不能晚于 end（${opts.start} > ${opts.end}）`);
  }
}

/** 列主序结果 → `Map<symbol, Bar[]>`（每只按 date 升序，SQL 的 ORDER BY 保证） */
function toBarMap(res: Awaited<ReturnType<typeof queryDuckDBColumnar>>): Map<string, Bar[]> {
  const symCol = res.column('symbol') as string[];
  const dateCol = res.column('date') as string[];
  const openCol = res.column('open') as number[];
  const highCol = res.column('high') as number[];
  const lowCol = res.column('low') as number[];
  const closeCol = res.column('close') as number[];
  const precloseCol = res.column('preclose') as number[];
  const volumeCol = res.column('volume') as number[];
  const amountCol = res.column('amount') as number[];

  const out = new Map<string, Bar[]>();
  for (let i = 0; i < symCol.length; i++) {
    const bar: Bar = {
      date: dateCol[i],
      open: openCol[i],
      high: highCol[i],
      low: lowCol[i],
      close: closeCol[i],
      preclose: precloseCol[i],
      volume: volumeCol[i],
      amount: amountCol[i],
    };
    const list = out.get(symCol[i]);
    if (list) list.push(bar);
    else out.set(symCol[i], [bar]);
  }
  return out;
}

/** 区间内**全部 ETF** 的日线（一条 SQL；视图已内联 `class='etf'` 过滤） */
async function loadEtfBars(view: string, start: string, end: string): Promise<Map<string, Bar[]>> {
  const res = await queryDuckDBColumnar(
    `SELECT symbol, date, open, high, low, close, preclose, volume, amount
       FROM ${view}
      WHERE date BETWEEN ? AND ?
      ORDER BY symbol, date ASC`,
    [start, end],
  );
  return toBarMap(res);
}

/**
 * 指数日线（一条 SQL）
 *
 * 指数没有复权因子（实测 `raw_adjust_factor` 对四只指数 0 行）⇒ 原始点位即前复权序列。
 * `preclose` 用 `lag(close)` 补：区间首根的 preclose 退化为自身收盘（已知小偏差，
 * 策略只用 `indexSeries` 的收盘序列，不读这根 preclose）。
 */
async function loadIndexBars(
  codes: readonly string[],
  start: string,
  end: string,
): Promise<Map<string, Bar[]>> {
  if (codes.length === 0) return new Map();
  const placeholders = codes.map(() => '?').join(', ');
  const res = await queryDuckDBColumnar(
    `WITH idx_bars AS (
       SELECT k.symbol AS symbol, k.date AS date, k.open AS open, k.high AS high, k.low AS low,
              k."close" AS close, k.volume AS volume, k.amount AS amount
         FROM raw_kline_daily k
         INNER JOIN raw_symbol_class c ON c.symbol = k.symbol AND c."class" = 'index'
        WHERE k.symbol IN (${placeholders}) AND k.date BETWEEN ? AND ?
     )
     SELECT symbol, date, open, high, low, close,
            COALESCE(lag(close) OVER (PARTITION BY symbol ORDER BY date), close) AS preclose,
            volume, amount
       FROM idx_bars
      ORDER BY symbol, date ASC`,
    [...codes, start, end],
  );
  return toBarMap(res);
}

/**
 * 装载全市场面板（signal / exec / index 三轨）
 *
 * @param opts 区间 + 额外标的 + 指数代码（见 {@link PanelLoadOptions}）
 * @returns 三轨 bar 映射 + 标的清单 + bar 总数
 *
 * ⚠️ **异步**：`src/db/duckdb.ts` 只有异步连接（`@duckdb/node-api` 无同步查询 API），
 *   故返回 Promise；调用方（CLI）必须 `await`。
 */
export async function loadUniversePanel(opts: PanelLoadOptions): Promise<UniversePanel> {
  validatePanelOptions(opts);

  const [signalBars, execBars, indexBars] = await Promise.all([
    loadEtfBars(QFQ_VIEW, opts.start, opts.end),
    loadEtfBars(BFQ_VIEW, opts.start, opts.end),
    loadIndexBars(opts.indexCodes ?? [], opts.start, opts.end),
  ]);

  const symbols = [...new Set([...signalBars.keys(), ...execBars.keys()])].sort();
  let barCount = 0;
  for (const bars of signalBars.values()) barCount += bars.length;
  for (const bars of execBars.values()) barCount += bars.length;
  for (const bars of indexBars.values()) barCount += bars.length;

  return { signalBars, execBars, indexBars, symbols, barCount };
}
