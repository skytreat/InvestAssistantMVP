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
import { resolveLatestQuoteDate } from '../services/marketData.js';
import { writeSystemLog } from '../services/logger.js';

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

export interface StockScanResponse {
  success: boolean;
  data?: {
    totalCandidates: number;   // 候选池（DuckDB 初筛后）
    total: number;              // pass 插件条件的数量
    results: StockScanResult[];
    tradeDate: string;
    filters?: AppliedScanFilters;
  };
  timeMs?: number;
  error?: string;
}

/** 市值单位换算：接口层用「亿元」，DuckDB raw_basic_daily.totalmv 存「元」 */
const YI = 100_000_000;

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
export function parseScanFilters(body: ParsedBody): {
  ok: true;
  value: AppliedScanFilters & { maxResults: number };
} | {
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

  const minAmount = Number.isFinite(body.min_amount) && (body.min_amount ?? 0) > 0
    ? Math.floor(body.min_amount as number)
    : 0;
  const maxResults = Math.min(
    500,
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

    const conditions: string[] = [`k.date = ${bind(tradeDate)}`, `k.amount >= ${bind(filters.minAmount)}`];
    if (filters.excludeSt) {
      conditions.push(
        `COALESCE(n.name, '') NOT LIKE 'ST%'`,
        `COALESCE(n.name, '') NOT LIKE '*ST%'`,
      );
    }

    if (filters.industryCode !== null) {
      conditions.push(
        `EXISTS (SELECT 1 FROM raw_tdx_blocks_member bm
                 WHERE bm.stock_symbol = k.symbol AND bm.block_code = ${bind(filters.industryCode)})`,
      );
    }

    if (filters.marketCapMaxYi !== null) {
      conditions.push(`(b.totalmv IS NULL OR b.totalmv <= ${bind(filters.marketCapMaxYi * YI)})`);
    }

    const sql = `
      SELECT ${srcViewPlaceholder} AS src_view, k.symbol, k.amount, n.name, b.totalmv
      FROM ${view} k
      LEFT JOIN raw_symbol_name n ON n.symbol = k.symbol
      LEFT JOIN raw_basic_daily b ON b.symbol = k.symbol AND b.date = k.date
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

    const startTotal = Date.now();

    try {
      // ---- 1. 参数解析 ----
      const allPlugins: Plugin[] = getAllPlugins();
      const plugin: Plugin | undefined = body.plugin_id
        ? allPlugins.find((p) => p.id === body.plugin_id)
        : allPlugins.find((p) => p.name === body.plugin_name);

      if (!plugin) {
        return reply.code(400).send({ success: false, error: 'PLUGIN_NOT_FOUND' });
      }

      const parsed = parseScanFilters(body);
      if (!parsed.ok) {
        return reply.code(400).send({ success: false, error: 'PARAM_INVALID', message: parsed.message });
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
        return reply.send({
          success: true,
          data: {
            totalCandidates: 0,
            total: 0,
            results: [],
            tradeDate,
            filters,
          },
          timeMs: Date.now() - startTotal,
        } satisfies StockScanResponse);
      }

      // ---- 4. IN 查询拿全部候选日线（SDD §5.3 硬约束） ----
      const klineMap = await loadCandidateDaily(stocks, tradeDate);

      // ---- 5. 构建共享 PluginContext + 逐标的执行 ----
      // 复用同一个 ctx 实例（行情查询函数无状态）
      const ctx = buildPluginContext();

      const passResults: StockScanResult[] = [];
      let scannedCount = 0;
      let timeoutCount = 0;
      let errorCount = 0;

      for (const stock of stocks) {
        // 跳过 DuckDB 里没日线的（理论上 batchGetDaily 查的就是这批，但保险起见）
        if (!klineMap.has(stock.symbol)) continue;

        scannedCount++;

        try {
          // 覆盖 symbol 参数（用户 params 里可能也传了 symbol，这里强制覆盖）
          const perSymbolParams: Record<string, unknown> = {
            ...userParams,
            symbol: stock.symbol,
          };

          const execResult: PluginExecutionResult = await executePlugin(
            plugin,
            perSymbolParams,
            ctx,
          );

          if (execResult.status === 'TIMEOUT') {
            timeoutCount++;
            continue;
          }
          if (execResult.status === 'ERROR') {
            errorCount++;
            continue;
          }

          // SUCCESS / SKIP：只收集非 HOLD 的信号
          for (const sig of execResult.signals) {
            if (sig.signalType === 'HOLD') continue;
            passResults.push({
              symbol: stock.symbol,
              name: nameBySymbol.get(stock.symbol) ?? null,
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

      // ---- 6. score 降序 + LIMIT ----
      passResults.sort((a, b) => b.score - a.score);
      const limited = passResults.slice(0, maxResults);

      const totalMs = Date.now() - startTotal;

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `条件选股完成: plugin=${plugin.name} scanned=${scannedCount} pass=${passResults.length} returned=${limited.length} timeout=${timeoutCount} error=${errorCount}`,
        detail: JSON.stringify({ tradeDate, ...filters, maxResults, timeMs: totalMs }),
      });

      return reply.send({
        success: true,
        data: {
          totalCandidates: scannedCount,
          total: passResults.length,
          results: limited,
          tradeDate,
          filters,
        },
        timeMs: totalMs,
      } satisfies StockScanResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'signal_generate',
        level: 'ERROR',
        message: `条件选股失败: ${msg}`,
        detail: msg,
      });
      return reply.code(500).send({
        success: false,
        error: msg,
      } satisfies StockScanResponse);
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
    reply.send({ success: true, data: plugins });
  });
}