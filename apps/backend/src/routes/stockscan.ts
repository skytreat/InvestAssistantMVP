// src/routes/stockscan.ts
// SDD §5.5 全市场条件选股路由
// DuckDB 查全市场当日标的 → 插件 executePlugin 条件过滤 → score 降序 LIMIT max_results

import type { FastifyInstance } from 'fastify';
import type { DailyKline } from '@invest/core';
import { queryDuckDB } from '../db/duckdb.js';
import {
  executePlugin,
  getAllPlugins,
  buildPluginContext,
  type Plugin,
  type PluginExecutionResult,
  type PluginSignal,
} from '../services/pluginEngine.js';
import { resolveLatestQuoteDate, batchGetDailyRangeByView } from '../services/marketData.js';
import { writeSystemLog, withSystemLogBuffer } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';
import { defaultMessage } from '../lib/errorMessages.js';

/** 品种类型（PRD §5.6「标的类型（股票/ETF）」） */
export type ScanAssetType = 'stock' | 'etf' | 'all';

export const ASSET_TYPES: readonly ScanAssetType[] = ['stock', 'etf', 'all'];

/**
 * 品种 → 前复权视图 白名单（T55）
 *
 * ⚠️ 表名/视图名均来自 2026-10-18 DuckDB 实测（information_schema.tables），非文档抄写：
 *   v_stock_qfq / v_stock_hfq / v_stock_bfq / v_etf_qfq / v_etf_hfq / v_etf_bfq 共 6 个 VIEW。
 *   视图内部已按 `raw_symbol_class.class` 过滤（stock → v_stock_*，etf → v_etf_*），
 *   故 asset_type 无需再 JOIN raw_symbol_class。
 *
 * 这是**唯一**允许把标识符拼进 SQL 的地方：值全部来自本文件的字面量白名单，
 * 绝不可能来自请求体（与 services/marketData.ts 的 resolveTable 同款做法）。
 * 请求体提供的 asset_type 先过 ASSET_TYPES 校验再查本表，非法值直接 400。
 */
const KLINE_VIEWS_BY_ASSET_TYPE: Readonly<Record<ScanAssetType, readonly string[]>> = {
  stock: ['v_stock_qfq'],
  etf: ['v_etf_qfq'],
  all: ['v_stock_qfq', 'v_etf_qfq'],
};

/**
 * 品种 → `raw_symbol_class.class` 白名单（2026-10-20 新增：候选池查询改走基础表）
 *
 * ⚠️ 值同样来自**字面量白名单**（由 `KLINE_VIEWS_BY_ASSET_TYPE` 的键推导），
 *   绝不可能来自请求体 —— 请求体的 asset_type 先过 ASSET_TYPES 校验。
 *
 * 📌 **为什么候选池可以改走基础表**（实测依据见 {@link buildPoolQuery} 注释）：
 *   候选池只要 `symbol / amount / name / totalmv` —— 这 4 个字段在视图里**全是未复权原值**
 *   （`amount` 来自 raw_kline_daily、`name` 来自 raw_symbol_name、`totalmv` 来自 raw_basic_daily），
 *   走视图却要把 1800 万行 raw_kline_daily 与 2100 万行 raw_adjust_factor 做哈希连接，
 *   外加一次 2100 万行的 `argmax` 聚合 —— 实测候选池查询 **685ms → 289ms**。
 */
const ASSET_CLASS_BY_VIEW: Readonly<Record<string, string>> = {
  v_stock_qfq: 'stock',
  v_etf_qfq: 'etf',
};

/** 单支候选（行情源 view + 标的基础信息） */
interface ScanCandidateRow {
  src_view: string;
  symbol: string;
  amount: number;
  name: string | null;
  totalmv: number | null;
}

export interface StockScanResult {
  symbol: string;
  /** 证券名称（raw_symbol_name.name，无名称记录时为 null） */
  name: string | null;
  /**
   * 现价（T73 · F-S5）—— **tradeDate 当天的前复权收盘价**
   *
   * ⚠️ **口径 = 前复权价**，与候选池页（`batchGetLatestClose(..., 'qfq')`）、
   *    K 线页、Dashboard 持仓卡**完全一致** ⇒ 同一只标的在各处显示同一个「现价」，
   *    不会因复权口径不同出现两个价（项目铁律：口径漂移 = 缺陷）。
   * 无行情时为 null。
   */
  close: number | null;
  /**
   * 当日涨跌幅（T73 · F-S5，单位 %）—— `(现价 - 上一根K线收盘价) / 上一根K线收盘价 * 100`
   *
   * ⚠️ 「上一根 K 线」= 该标的自己日线序列的**倒数第二根**（与 Dashboard 的
   *    `batchGetLatestAndPrevClose` 同款口径），不用交易日历 ——
   *    停牌标的的上一根可能是多天前的那根，这是「相邻上一根」而非「上一个交易日」。
   * 无上一根 / 上一根收盘价为 0 时为 null。
   */
  changePct: number | null;
  /**
   * 当日成交额（T73 · F-S5，单位 **元**，不复权）
   *
   * ⚠️ 单位与 `min_amount`（公共过滤）**同为元** —— 成交额不受复权因子影响。
   */
  amount: number | null;
  score: number;
  signalType: PluginSignal['signalType'];
  details?: string;
  pluginId: string;
}

/** 生效的公共过滤条件（回显给调用方，便于前端确认实际口径） */
export interface AppliedScanFilters {
  assetType: ScanAssetType;
  excludeSt: boolean;
  /** null = 未按板块过滤。MVP 为「板块口径」（见 buildPoolQuery 注释） */
  industryCode: string | null;
  /** 单位：亿元；null = 未过滤 */
  marketCapMaxYi: number | null;
  minAmount: number;
}

/** 选股响应体（T89a：统一 envelope，SDD §4.2） */
export interface StockScanResponse {
  code: number;
  data: {
    totalCandidates: number; // 候选池（DuckDB 初筛后）
    total: number; // pass 插件条件的数量
    results: StockScanResult[];
    tradeDate: string;
    filters?: AppliedScanFilters;
  };
  timestamp: string;
  success: boolean;
  timeMs?: number;
  error?: string;
}

/** 市值单位换算：接口层用「亿元」，DuckDB raw_basic_daily.totalmv 存「元」 */
const YI = 100_000_000;

/**
 * 从预取日线里取「现价 / 上一根收盘价 / 当日成交额」（T73 · F-S5）
 *
 * ⚠️ **纯内存计算，不额外查 DuckDB** —— 预取结果（`batchGetDailyRangeByView`）
 *    里已经含 tradeDate 那根 K 线与它前面那根，再查一次就是重复 IO。
 *
 * ⚠️ 日线序列按 `date ASC` 排序（`buildQfqRangeSql` 的 `ORDER BY symbol, date ASC`），
 *    故「tradeDate 那根的下标 - 1」就是**紧邻的上一根**。
 *
 * @param klines 该标的的日线（按日期升序）
 * @param tradeDate 选股交易日
 */
export function extractQuote(
  klines: DailyKline[] | undefined,
  tradeDate: string,
): { close: number | null; prevClose: number | null; amount: number | null } {
  const empty = { close: null, prevClose: null, amount: null };
  if (!klines || klines.length === 0) return empty;

  let idx = -1;
  for (let i = 0; i < klines.length; i++) {
    if (klines[i].date === tradeDate) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return empty;

  const cur = klines[idx];
  const prev = idx > 0 ? klines[idx - 1] : null;
  return {
    close: typeof cur.close === 'number' ? cur.close : null,
    prevClose: prev && typeof prev.close === 'number' ? prev.close : null,
    amount: typeof cur.amount === 'number' ? cur.amount : null,
  };
}

/** 涨跌幅（%）：`(现价 - 上一根收盘价) / 上一根收盘价 * 100`；缺上一根（或为 0）→ null */
export function computeChangePct(close: number | null, prevClose: number | null): number | null {
  if (close === null || prevClose === null || prevClose === 0) return null;
  return ((close - prevClose) / prevClose) * 100;
}

/** 全选股候选池上限（A 股全市场 ~5561，留余量；MVP 性能硬约束 ≤3s） */
const POOL_LIMIT = 5000;

interface ParsedBody {
  plugin_id?: string;
  plugin_name?: string;
  params?: Record<string, unknown>;
  min_amount?: number;
  max_results?: number;
  asset_type?: ScanAssetType;
  exclude_st?: boolean;
  industry_code?: string;
  market_cap_max?: number;
}

/**
 * 解析 + 校验公共过滤参数（T55）
 *
 * 严格校验：非法值一律 400 PARAM_INVALID，不做静默兜底（与「静默回落 = 假绿」的项目铁律一致）。
 */
export function parseScanFilters(body: ParsedBody):
  | {
      ok: true;
      value: AppliedScanFilters & { maxResults: number };
    }
  | {
      ok: false;
      message: string;
    } {
  const assetType: ScanAssetType = body.asset_type ?? 'stock';
  if (!ASSET_TYPES.includes(assetType)) {
    return { ok: false, message: 'asset_type 只能是 stock / etf / all' };
  }

  if (body.exclude_st !== undefined && typeof body.exclude_st !== 'boolean') {
    return { ok: false, message: 'exclude_st 必须是 boolean' };
  }
  const excludeSt = body.exclude_st === true;

  let marketCapMaxYi: number | null = null;
  if (body.market_cap_max !== undefined && body.market_cap_max !== null) {
    const raw = body.market_cap_max;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return { ok: false, message: 'market_cap_max 必须是 > 0 的数字（单位：亿元）' };
    }
    marketCapMaxYi = raw;
  }

  const industryCode =
    typeof body.industry_code === 'string' && body.industry_code.trim().length > 0
      ? body.industry_code.trim()
      : null;

  const minAmount =
    Number.isFinite(body.min_amount) && (body.min_amount ?? 0) > 0
      ? Math.floor(body.min_amount as number)
      : 0;
  // ⚠️ 上限 **100**（PRD §5.6「结果 ≤100 条」；实施计划 F-S3）：
  //   原为 500 ⇒ 前端虽然强制 100，但**直接打 API 仍可要 500 条** ⇒ 契约与 PRD 不符。
  const maxResults = Math.min(
    100,
    Math.max(1, Math.floor(Number.isFinite(body.max_results) ? (body.max_results as number) : 100)),
  );

  return { ok: true, value: { assetType, excludeSt, industryCode, marketCapMaxYi, minAmount, maxResults } };
}

/**
 * 构造候选池 SQL（T55）
 *
 * 实测依据（2026-10-18 `data/quotes.duckdb`，information_schema.columns）：
 *   raw_symbol_name(symbol, name, class)          → 补 name；symbol 实测唯一（8726/8726），LEFT JOIN 不会放大行数
 *   raw_basic_daily(date, symbol, close, preclose, change_pct, amplitude, turnover, floatmv, totalmv)
 *                                                 → totalmv 过滤；JOIN 条件含 date
 *   raw_tdx_blocks_member(stock_symbol, block_code) → 板块成分（**注意成分股列名是 stock_symbol，不是 symbol**）
 *
 * 🔴 **2026-10-20 改为直查基础表（不再 FROM 视图）** —— PE2「选股 ≤3s」的关键一步之一：
 *   候选池需要的 4 个字段（symbol / amount / name / totalmv）在 `v_stock_qfq` 里**全是未复权原值**，
 *   而视图会把 1800 万行 raw_kline_daily 与 2100 万行 raw_adjust_factor 做哈希连接，
 *   外加一次 2100 万行的 `argmax(hfq_factor, date)` 聚合（实测 ~300ms，与标的数无关）。
 *   实测（同库同参数）：
 *     · 走视图 `FROM v_stock_qfq`           → **685ms**
 *     · 直查 `FROM raw_kline_daily` + class → **289ms**
 *   **等价性已实测核对**（2026-10-20，`/opt/invol/quotes.duckdb`）：
 *     两种写法返回的 5000 个 symbol 集合**完全一致**、amount 逐条相等、ETF 分支同样一致
 *     （2026-10-21 复核：股票 5000/5000、ETF 2074/2074，symbol 集合、amount、name 逐条相等）。
 *   ⚠️ 视图**仍用于取复权日线** —— 但预取走的是 `marketData.buildQfqRangeSql` 的
 *     **显式前复权 SQL**（口径与视图逐条一致，由 t55 的「复权口径」用例守住），
 *     目的是省掉视图里两个用不上的 JOIN（raw_symbol_class / raw_basic_daily）。
 *
 * ⚠️ ST 标记：`raw_symbol_class` 实测**只有 (symbol, class) 两列，没有 is_st / is_listing**
 *   （SDD §3.3 那张表把 is_st/is_listing 列进去了，与实测不符）。
 *   故 `exclude_st` 改为按 `raw_symbol_name.name` 的 ST/*ST 前缀判定 —— 这是 A 股 ST 的实际标记方式，
 *   实测 2026-10-12 v_stock_qfq 池内 198 只被排除（5561 → 5363）。
 *   COALESCE 兜底：没有名称记录的标的（实测 585 只股票无 name）按「非 ST」放行，不误杀。
 *
 * ⚠️ 行业口径（MVP 标注为「板块口径」）：`raw_tdx_blocks_info` / `raw_tdx_blocks_member`
 *   **实测均为 0 行**（未采集板块数据），故 block_type（行业/概念/地区）无法甄别 ——
 *   本实现只按 block_code 等值过滤，不假装能区分行业与概念。
 *   数据为空时任何 industry_code 都返回 0 条，属数据缺失而非 SQL 错误。
 *
 * ⚠️ 市值 NULL 放行：`market_cap_max` 只过滤「已知且超限」的标的；
 *   实测 ETF 的 raw_basic_daily.totalmv 多为 0（非 NULL），故该过滤对 ETF 基本不起作用。
 *
 * 🔴 **2026-10-21：`market_cap_max` 未传时不再 JOIN raw_basic_daily**（实测省 ~120ms）
 *   raw_basic_daily 有 1800 万行，而 totalmv 只服务于「按市值过滤」这一个条件；
 *   不需要过滤时整段 JOIN 可以省掉，候选池口径不变（totalmv 恒为 NULL）。
 *
 * SQL 拼接边界：仅 `view`（字面量白名单）拼进标识符；所有用户输入一律走 `?` 预编译参数。
 */
export function buildPoolQuery(
  tradeDate: string,
  filters: AppliedScanFilters,
): { sql: string; params: unknown[] } {
  // ⚠️ 每个 UNION 分支自带一套 params：视图标记占位符排在最前，WHERE 条件紧随其后。
  //    （曾经把 conditions 的参数集中绑定、视图标记后绑定，导致参数与占位符错位 → DuckDB
  //      "Unimplemented type for cast (INTEGER -> DATE)"；asset_type=all 时更是直接报
  //      "Values were not provided for parameters 5,6"。两处都由单测守住。）
  const branches = KLINE_VIEWS_BY_ASSET_TYPE[filters.assetType].map((view) => {
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return '?';
    };

    // src_view 占位符在 SQL 中出现最早，必须最先绑定：
    // 若在模板字符串里才求值，params 顺序会与 ? 出现顺序错位，
    // 导致 k.date = ? 收到整数 → "Unimplemented type for cast (INTEGER -> DATE)"。
    const srcViewPlaceholder = bind(view);

    // 品种过滤：class 值来自字面量白名单（ASSET_CLASS_BY_VIEW），**不是**用户输入
    const assetClass = ASSET_CLASS_BY_VIEW[view];
    if (assetClass === undefined) {
      // 🔴 白名单外的视图 → 绝不用 'undefined' 拼进 SQL（会静默查不到任何标的）
      throw new Error(`buildPoolQuery: 未登记品种的视图 "${view}"`);
    }

    const conditions: string[] = [`k.date = ${bind(tradeDate)}`, `k.amount >= ${bind(filters.minAmount)}`];
    if (filters.excludeSt) {
      conditions.push(`COALESCE(n.name, '') NOT LIKE 'ST%'`, `COALESCE(n.name, '') NOT LIKE '*ST%'`);
    }

    if (filters.industryCode !== null) {
      conditions.push(
        `EXISTS (SELECT 1 FROM raw_tdx_blocks_member bm
                 WHERE bm.stock_symbol = k.symbol AND bm.block_code = ${bind(filters.industryCode)})`,
      );
    }

    // 🔴 2026-10-21：市值上限**没传**时**不 JOIN raw_basic_daily**（实测省 ~120ms）
    //   raw_basic_daily 有 1800 万行，LEFT JOIN 它只为拿 totalmv；
    //   而 totalmv 只在「按市值过滤」时才用得上 → 不需要过滤时整段 JOIN 可以省掉。
    //   实测（同库同参数，5000 候选）：带 JOIN 343~364ms → 不带 JOIN 207~241ms。
    //   ⚠️ 口径不变：不带 JOIN 时 totalmv 一律为 NULL（与「无市值记录」同义，见下方注释）。
    const needTotalMv = filters.marketCapMaxYi !== null;
    if (filters.marketCapMaxYi !== null) {
      conditions.push(`(b.totalmv IS NULL OR b.totalmv <= ${bind(filters.marketCapMaxYi * YI)})`);
    }

    const sql = `
      SELECT ${srcViewPlaceholder} AS src_view, k.symbol, k.amount, n.name, ${
        needTotalMv ? 'b.totalmv' : 'NULL'
      } AS totalmv
      FROM raw_kline_daily k
      INNER JOIN raw_symbol_class sc ON sc.symbol = k.symbol AND sc."class" = '${assetClass}'
      LEFT JOIN raw_symbol_name n ON n.symbol = k.symbol${
        needTotalMv
          ? `
      LEFT JOIN raw_basic_daily b ON b.symbol = k.symbol AND b.date = k.date`
          : ''
      }
      WHERE ${conditions.join(' AND ')}`;

    return { sql, params };
  });

  const sql = `${branches.map((b) => b.sql).join('\n    UNION ALL\n')}
    ORDER BY amount DESC
    LIMIT ${POOL_LIMIT}`;

  return { sql, params: branches.flatMap((b) => b.params) };
}

/**
 * 1 次 IN 查询拿回全部候选的日线（SDD §5.3 硬约束：禁止逐标的循环查 DuckDB）
 *
 * 按「产出该候选的 view」分组，每个 view 发一条大 IN 查询（asset_type=all 时最多 2 条，
 * 而非 2×5000 个占位符）。
 *
 * ⚠️ **选股路由已不再调用本函数**（2026-10-20，PE2 ≤3s 改造）：
 *   路由原先用它取「tradeDate 当天的日线」，但只用到「该 symbol 当日有没有日线」
 *   这一个布尔信息 —— 区间预取（`batchGetDailyRangeByView`）的结果里已经包含
 *   tradeDate 那根，路由改为直接从预取里挑，**省掉一整轮查询**（实测 ~1.1s）。
 *   本函数保留：它是「按 view 分组做单日批量查询」的通用能力，且有单测直接覆盖。
 */
export async function loadCandidateDaily(
  rows: ScanCandidateRow[],
  tradeDate: string,
): Promise<Map<string, DailyKline>> {
  const symbolsByView = new Map<string, string[]>();
  for (const row of rows) {
    const list = symbolsByView.get(row.src_view);
    if (list) list.push(row.symbol);
    else symbolsByView.set(row.src_view, [row.symbol]);
  }

  const result = new Map<string, DailyKline>();
  for (const [view, symbols] of symbolsByView) {
    const placeholders = symbols.map(() => '?').join(', ');
    const klines = await queryDuckDB<{ symbol: string } & DailyKline>(
      `SELECT symbol, date, open, high, low, close, volume, amount
       FROM ${view}
       WHERE date = ? AND symbol IN (${placeholders})`,
      [tradeDate, ...symbols],
    );
    for (const k of klines) {
      const { symbol, ...daily } = k;
      result.set(symbol, daily);
    }
  }
  return result;
}

/**
 * POST /api/stockscan
 *
 * SDD §5.5 全市场条件选股
 *
 * Request body:
 *   {
 *     plugin_id?: string,       // 插件 id（优先）
 *     plugin_name?: string,     // 或插件 name
 *     params?: Record<string, unknown>,  // 插件参数（MVP 会覆盖内置 symbol 字段）
 *     min_amount?: number,      // 最低成交额过滤（默认 0）
 *     max_results?: number,     // 返回上限（默认 100）
 *     -- T55 公共过滤 --
 *     asset_type?: 'stock'|'etf'|'all',  // 默认 stock
 *     exclude_st?: boolean,     // 默认 false（SDD §3.3 声称的 is_st 列实测不存在，按名称前缀判定）
 *     industry_code?: string,   // raw_tdx_blocks_member.block_code（MVP「板块口径」）
 *     market_cap_max?: number,  // 总市值上限，单位「亿元」
 *   }
 *
 * 流程：
 *   1. 找到指定插件（id 优先于 name）
 *   2. 取最近交易日（避免当天非交易日 DuckDB 无数据）
 *   3. DuckDB 1 次查当日全市场标的（叠加品种 / ST / 市值 / 板块过滤，上限 5000）
 *   4. 按 view 分组 1 次 IN 查询拿全部候选日线
 *   5. 逐标的覆盖 params.symbol → executePlugin 执行插件
 *   6. 收集 signalType !== 'HOLD' 的结果，score = strength
 *   7. score 降序 + LIMIT max_results
 *
 * MVP 性能硬约束：全选股 ≤ 3s
 */
export async function registerStockScanRoutes(app: FastifyInstance) {
  app.post('/api/stockscan', async (request, reply) => {
    const body = (request.body ?? {}) as ParsedBody;

    // ⚠️ 用 hrtime（纳秒精度）而不是 Date.now()（毫秒精度）：
    //   PE2/F7 的门槛是 3.0s，毫秒精度在边界上无法判定；hrtime 还能防系统时钟跳变。
    const startTotal = process.hrtime.bigint();
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startTotal) / 1e6;

    try {
      // ---- 1. 参数解析 ----
      const allPlugins: Plugin[] = getAllPlugins();
      const plugin: Plugin | undefined = body.plugin_id
        ? allPlugins.find((p) => p.id === body.plugin_id)
        : allPlugins.find((p) => p.name === body.plugin_name);

      if (!plugin) {
        return reply.code(400).send(fail(400, 'PLUGIN_NOT_FOUND', defaultMessage('PLUGIN_NOT_FOUND')));
      }

      const parsed = parseScanFilters(body);
      if (!parsed.ok) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', parsed.message));
      }
      const { maxResults, ...filters } = parsed.value;

      const userParams: Record<string, unknown> = body.params ?? {};

      // ---- 2. 取最近有行情数据的交易日 ----
      // 🔴 T85b ②（I-20）：原实现用 `getLatestTradingDay()`，而那个函数查的是
      // `raw_holidays`（**休市日**黑名单）→ 返回最近一个**休市日**（实测 2026-10-07），
      // 按该日查 v_stock_qfq 必然 0 行 → totalCandidates 恒为 0（G6.3 第二根因）。
      // 查行情必须落在**确有数据**的那天 → 用数据口径的 resolveLatestQuoteDate。
      const latest = await resolveLatestQuoteDate(new Date().toISOString().slice(0, 10));
      const tradeDate = latest ?? new Date().toISOString().slice(0, 10);

      // ---- 3. DuckDB 查当日候选池（叠加公共过滤） ----
      const { sql: filterSql, params } = buildPoolQuery(tradeDate, filters);
      const stocks = await queryDuckDB<ScanCandidateRow>(filterSql, params);
      const nameBySymbol = new Map(stocks.map((s) => [s.symbol, s.name]));

      if (stocks.length === 0) {
        return reply.send(
          ok({
            totalCandidates: 0,
            total: 0,
            results: [],
            tradeDate,
            filters,
          }),
        );
      }

      // ---- 4. 预取区间日线 + 构建共享 PluginContext（SDD §5.3 硬约束） ----
      // 🔴 T85b ①：此前 ctx.getDailyKlines() **每只标的单独查一次 DuckDB**
      //   （5000 只 = 5000 次查询）→ 实测选股 15s+（PE2 要求 ≤3s）。
      //   改为：按 view 分组各 1 次 IN 查询**批量**取回区间日线灌进 context，
      //   插件执行时命中内存缓存，不再逐只打库。
      // days 取「用户传入值 ?? 插件 paramSchema 的 days 默认值」
      const daysField = (plugin.paramSchema ?? []).find((f) => f.key === 'days');
      const scanDays = Math.max(1, Number(userParams.days ?? daysField?.default ?? 120));
      const prefetchEnd = new Date().toISOString().slice(0, 10);
      const prefetchStartRaw = new Date(Date.now() - scanDays * 86_400_000).toISOString().slice(0, 10);
      // ⚠️ 预取窗口**必须覆盖 tradeDate**（2026-10-20 新增）：
      //   「当日有无日线」的判定改为从预取结果里挑 tradeDate 那根，
      //   若窗口起点晚于 tradeDate（行情管道停摆超过 scanDays），
      //   判定会失真（把有数据的标的误判为无数据）→ 故窗口起点取 min(窗口起点, tradeDate)。
      const prefetchStart = prefetchStartRaw < tradeDate ? prefetchStartRaw : tradeDate;
      const symbolsByView = new Map<string, string[]>();
      for (const row of stocks) {
        const list = symbolsByView.get(row.src_view);
        if (list) list.push(row.symbol);
        else symbolsByView.set(row.src_view, [row.symbol]);
      }
      const prefetchKlines = await batchGetDailyRangeByView(symbolsByView, prefetchStart, prefetchEnd);
      const prefetch = { klines: prefetchKlines, windowDays: scanDays };
      // 复用同一个 ctx 实例（行情查询函数无状态）
      const ctx = buildPluginContext(prefetch);

      // 🔴 2026-10-20：**去掉冗余的第 2 次 IN 查询**（loadCandidateDaily）
      //   原实现先用 1 次单日 IN 查询取回 5000 根「当日日线」，但路由只用到
      //   「该 symbol 当日有没有日线」这一个布尔信息 —— 而预取结果里已经包含
      //   tradeDate 那根（窗口已保证覆盖 tradeDate），故直接从预取里挑即可。
      //   实测省掉一整轮「视图 + 5000 参数 IN 查询」≈ **1.1s**（PE2 ≤3s 的关键一步）。
      //   口径等价性：两者都取自同一张视图、同一 tradeDate、同一 symbol 集合。
      const symbolsWithTradeDateKline = new Set<string>();
      for (const [symbol, klines] of prefetchKlines) {
        for (const k of klines) {
          if (k.date === tradeDate) {
            symbolsWithTradeDateKline.add(symbol);
            break;
          }
        }
      }

      // T73 · F-S5：现价 / 涨跌幅 / 成交额 —— **从同一份预取结果里取，不额外查库**
      //   （预取已经含 tradeDate 那根与它前面那根；再查一次就是重复 IO，
      //     而 PE2「选股 ≤3s」对每次额外查询都很敏感）。
      const quoteBySymbol = new Map<
        string,
        { close: number | null; prevClose: number | null; amount: number | null }
      >();
      for (const [symbol, klines] of prefetchKlines) {
        quoteBySymbol.set(symbol, extractQuote(klines, tradeDate));
      }

      const passResults: StockScanResult[] = [];
      let scannedCount = 0;
      let timeoutCount = 0;
      let errorCount = 0;

      // 🔴 2026-10-20：批量缓冲日志（选股一次请求会产生 5000 条 plugin_execute 日志，
      //   逐条 auto-commit 实测 ~1.0s）→ 缓冲后单事务落库（实测 ~20ms）。
      //   WARN/ERROR 仍立即落库（诊断信息不能丢）。
      //   ⚠️ 缓冲作用域 = 本次请求（AsyncLocalStorage），并发请求互不串台。
      await withSystemLogBuffer(async () => {
        for (const stock of stocks) {
          // 跳过 DuckDB 里没日线的（理论上预取查的就是这批，但保险起见）
          if (!symbolsWithTradeDateKline.has(stock.symbol)) continue;

          scannedCount++;

          try {
            // 覆盖 symbol 参数（用户 params 里可能也传了 symbol，这里强制覆盖）
            const perSymbolParams: Record<string, unknown> = {
              ...userParams,
              symbol: stock.symbol,
            };

            const execResult: PluginExecutionResult = await executePlugin(plugin, perSymbolParams, ctx);

            if (execResult.status === 'TIMEOUT') {
              timeoutCount++;
              continue;
            }
            if (execResult.status === 'ERROR') {
              errorCount++;
              continue;
            }

            // SUCCESS / SKIP：只收集非 HOLD 的信号
            const quote = quoteBySymbol.get(stock.symbol) ?? {
              close: null,
              prevClose: null,
              amount: null,
            };
            for (const sig of execResult.signals) {
              if (sig.signalType === 'HOLD') continue;
              passResults.push({
                symbol: stock.symbol,
                name: nameBySymbol.get(stock.symbol) ?? null,
                // T73 · F-S5：结果表补「现价 / 涨跌幅 / 成交额」
                close: quote.close,
                changePct: computeChangePct(quote.close, quote.prevClose),
                amount: quote.amount,
                score: sig.strength ?? 0,
                signalType: sig.signalType,
                details: sig.detail,
                pluginId: plugin.id,
              });
            }
          } catch {
            // 单标的任何异常 → 跳过，不阻塞其他标的
            errorCount++;
          }
        }
      });

      // ---- 6. score 降序 + LIMIT ----
      passResults.sort((a, b) => b.score - a.score);
      const limited = passResults.slice(0, maxResults);

      const totalMs = elapsedMs();

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `条件选股完成: plugin=${plugin.name} scanned=${scannedCount} pass=${passResults.length} returned=${limited.length} timeout=${timeoutCount} error=${errorCount}`,
        detail: JSON.stringify({ tradeDate, ...filters, maxResults, timeMs: totalMs }),
      });

      return reply.send(
        ok(
          {
            totalCandidates: scannedCount,
            total: passResults.length,
            results: limited,
            tradeDate,
            filters,
          },
          // 顶层 timeMs：本次选股的服务端耗时（hrtime 计时，SDD §4.2 envelope 的扩展字段）
          { timeMs: Math.round(totalMs) },
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'signal_generate',
        level: 'ERROR',
        message: `条件选股失败: ${msg}`,
        detail: msg,
      });
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', msg));
    }
  });

  // GET /api/stockscan/plugins — 列出所有可用插件（供前端下拉选择）
  app.get('/api/stockscan/plugins', async (_request, reply) => {
    const plugins = getAllPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      paramSchema: p.paramSchema,
    }));
    reply.send(ok(plugins));
  });
}
