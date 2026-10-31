import type { FastifyInstance, FastifyRequest } from 'fastify';
import { queryDuckDB } from '../db/duckdb.js';
import {
  calculateMACD,
  calculateRSI,
  calculateSMA,
  RSI_DEFAULT_PERIOD,
  MACD_DEFAULT_FAST_PERIOD,
  MACD_DEFAULT_SLOW_PERIOD,
  MACD_DEFAULT_SIGNAL_PERIOD,
} from '@invest/core';
import { ConfigStore } from '../config/configStore.js';
import type { JwtPayload } from '../services/auth.js';
import { ok, fail } from '../lib/envelope.js';
import { writeSystemLog } from '../services/logger.js';
import {
  attachAdjustedPrices,
  deriveTradeMarkers,
  filterMarkersToWindow,
  loadKlineTradeMarkers,
  type KlineTradeMarker,
} from '../services/klineTrades.js';

/**
 * K 线行情数据接口（SDD F5 验收项）
 *
 * GET /api/kline/:symbol
 *   ?days=120
 *   &fq=qfq|bfq|hfq|raw          四值白名单，非法值 → 400（**禁止静默回落 qfq**）
 *   &rsi_period=14
 *   &macd_fast=12&macd_slow=26&macd_signal=9
 *
 * symbol: sh600000 / sz000001 格式
 * days: 取最近 N 条日线，默认 120，范围 [10, 500]
 *
 * 返回：klines（**升序** OHLCV）+ indicators（后端算好 MA5/10/20/60 + MACD / RSI）
 *      + signals（**当前用户**该标的近 20 条信号，**升序**，与 klines 同方向）
 *
 * ⚠️ **`signals[]` 按 `user_id` 隔离**（P1 越权修复）：
 *   本路由原先只按 `asset_code` 过滤信号 ⇒ **多用户部署时会下发别人的信号**
 *   （连别人的 `metrics_json` 指标明细一起）⇒ 越权读取。
 *   现补 `AND user_id = ?`，`user_id` **取自 JWT（`request.user.sub`）**，
 *   **绝不信请求参数**（伪造 `?user_id=` 无效）。
 *
 * ⚠️ **信号集合口径 = 「最近 20 条，按 trade_date 升序排列」**：
 *   与 `GET /api/signal`（`routes/signal.ts`）**同口径** —— 两个端点用同一套
 *   「窗口取最近 N 条 + 输出升序 + `created_at / id` 确定性 tie-break」的 SQL 形状，
 *   故同一用户 + 同一标的 + 同一条数时返回**完全相同的行集合**。
 *
 * ⚠️ **信号指标明细 `metrics_json`**（信号指标明细）：
 *   - **形态 = 原始 JSON 文本**（SQLite TEXT 列，由 `signalService.serializeMetrics` 写入），
 *     与 `GET /api/signal`（`SELECT *`）的下发形态**逐字节一致** ⇒ 两个端点口径统一。
 *   - 为何下发**文本**而非解析后的对象：解析属于**展示层**职责，
 *     前端已有 `parseMetricsJson()`（`apps/frontend/src/indicators/chartBars.ts`），
 *     两端共用同一套解析口径；后端解析反而会让两个端点的字段类型**分叉**，
 *     且遇到历史脏数据（非 JSON 文本）时会把整个端点打成 500。
 *   - **收益**：K 线页 hover tooltip 展示指标明细（F-K8 / T70 ③）**不再需要**额外发
 *     `GET /api/signal?asset_code=` 补取 ⇒ 少一次网络往返（PRD §5.2「零网络请求」）。
 */

/**
 * 带鉴权载荷的 request
 *
 * 全局 `onRequest` 钩子（`routes/index.ts`）把 JWT payload 挂在 `request.user` 上。
 * 本路由**不在**公共路由白名单内 ⇒ 钩子必然已注入 user。
 * 但类型上 request.user 是可选的，故这里显式声明并在 handler 里**fail closed**。
 */
type AuthedRequest = FastifyRequest & { user: JwtPayload };

interface KlineRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  /**
   * 复权因子（仅 qfq/hfq 查询时附带）：
   * - qfq 视图取 `qfq_factor`
   * - hfq 视图取 `hfq_factor`
   * - bfq / raw 视图没有对应因子列（bfq 直接不乘）
   *
   * ⚠️ 字段名以 `docs/tdx2db_schema.md` + 实测 DESCRIBE 为准：
   *    `v_*_hfq` **没有** `qfq_factor`，不能统一按 qfq_factor 取。
   */
  adj_factor?: number | null;
}

/** fq 四值白名单 —— 视图/表名见 {@link FQ_VIEWS_BY_CLASS} */
const FQ_VALUES = ['qfq', 'bfq', 'hfq', 'raw'] as const;
type Fq = (typeof FQ_VALUES)[number];

const DEFAULT_FQ: Fq = 'qfq';

/**
 * 复权口径 → DuckDB 视图/表。
 *
 * ⚠️ ETF **必须**走 `v_etf_*`：`v_stock_*` 视图 INNER JOIN `raw_symbol_class` 且
 * `class = 'stock'`，ETF 标的在其中一行都没有（实测 sh500001 在 v_stock_qfq 0 行、
 * v_etf_qfq 3532 行）。硬编码 v_stock_* 会让所有 ETF K 线 404/空图。
 *
 * 其余 class（index / unknown / block / bstock）在两个视图族里都没有数据，
 * 落到 stock 组只是保持既有行为（返回空 klines）。
 */
const FQ_VIEWS_BY_CLASS: Record<string, Record<Fq, string>> = {
  stock: {
    qfq: 'v_stock_qfq',
    bfq: 'v_stock_bfq',
    hfq: 'v_stock_hfq',
    raw: 'raw_kline_daily',
  },
  etf: {
    qfq: 'v_etf_qfq',
    bfq: 'v_etf_bfq',
    hfq: 'v_etf_hfq',
    raw: 'raw_kline_daily',
  },
};

/**
 * 信号窗口条数（**最近 N 条**，输出按 trade_date 升序）
 *
 * ⚠️ 与 `GET /api/signal` 的默认 `page_size=20` **同值** ⇒ 两个端点
 *    「同一用户 + 同一标的」时返回**同一个行集合**。
 */
const SIGNAL_LIMIT = 20;

/** query 参数的取值范围；与 pluginEngine 的 paramSchema 保持同口径 */
const PERIOD_RANGE = {
  rsiPeriod: { min: 2, max: 100 },
  macdFast: { min: 2, max: 30 },
  macdSlow: { min: 10, max: 60 },
  macdSignal: { min: 2, max: 20 },
} as const;

function isFq(value: unknown): value is Fq {
  return typeof value === 'string' && (FQ_VALUES as readonly string[]).includes(value);
}

/**
 * 解析整数 query 参数。缺省 / 非数字 → null（调用方用默认值）。
 * 有值但越界 → 返回 'INVALID'，由调用方回 400（**不静默夹取**）。
 */
function parseBoundedInt(raw: unknown, min: number, max: number): number | null | 'INVALID' {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return 'INVALID';
  return n;
}

export async function registerKlineRoutes(app: FastifyInstance) {
  app.get('/api/quote/:symbol/kline', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };

    /**
     * 🔴 **fail closed**：`user_id` 只从 JWT 取（`request.user.sub`），
     *    **绝不信请求参数**（伪造 `?user_id=` 无效）。
     *    全局 `onRequest` 钩子（`routes/index.ts`）对本路由必然已注入 user，
     *    这里的分支只是**类型收窄 + 防御性兜底** ——
     *    万一钩子被移除，也必须「拒绝服务」而不是「退化成不带 user 过滤的越权查询」。
     */
    const user = (request as AuthedRequest).user;
    if (!user) {
      return reply.code(401).send(fail(401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <jwt>'));
    }

    const query = request.query as {
      days?: number;
      fq?: string;
      rsi_period?: number;
      macd_fast?: number;
      macd_slow?: number;
      macd_signal?: number;
    };
    const { days = 120, fq = DEFAULT_FQ } = query;

    // symbol 基本校验
    // ⚠️ **必须接受 `bj` 前缀**（2026-10-20 实测）：
    //   真实行情库的 symbol 前缀有**三种** —— `sh` 5958 只 / `sz` 5876 只 / **`bj` 615 只（北交所）**。
    //   旧正则 `/^(sh|sz)\d{6}$/` 把全部 615 只北交所标的挡在门外 ⇒ **K 线页对北交所完全不可用**（400）。
    //   ⚠️ 北交所标的的 class 是 `stock` ⇒ 放行后走 `v_stock_*` 视图即可取到数据。
    //   （实施计划 T70 卡里写的 `bd000` 是笔误 —— 库里的真实前缀是 `bj`。）
    if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) {
      return reply.code(400).send(fail(400, 'SYMBOL_NOT_FOUND', 'symbol 格式应为 sh600000 / sz000001'));
    }

    // fq 白名单：非法值直接 400，绝不静默回落 qfq（否则用户以为在看别的复权口径）
    if (!isFq(fq)) {
      return reply
        .code(400)
        .send(fail(400, 'PARAM_INVALID', `fq 仅支持 ${FQ_VALUES.join(' / ')}，收到 "${String(fq)}"`));
    }

    const periodInputs: Array<{
      name: string;
      raw: unknown;
      fallback: number;
      range: { readonly min: number; readonly max: number };
    }> = [
      {
        name: 'rsi_period',
        raw: query.rsi_period,
        fallback: RSI_DEFAULT_PERIOD,
        range: PERIOD_RANGE.rsiPeriod,
      },
      {
        name: 'macd_fast',
        raw: query.macd_fast,
        fallback: MACD_DEFAULT_FAST_PERIOD,
        range: PERIOD_RANGE.macdFast,
      },
      {
        name: 'macd_slow',
        raw: query.macd_slow,
        fallback: MACD_DEFAULT_SLOW_PERIOD,
        range: PERIOD_RANGE.macdSlow,
      },
      {
        name: 'macd_signal',
        raw: query.macd_signal,
        fallback: MACD_DEFAULT_SIGNAL_PERIOD,
        range: PERIOD_RANGE.macdSignal,
      },
    ];

    const resolvedPeriods: number[] = [];
    for (const p of periodInputs) {
      const parsed = parseBoundedInt(p.raw, p.range.min, p.range.max);
      if (parsed === 'INVALID') {
        return reply
          .code(400)
          .send(
            fail(400, 'PARAM_INVALID', `${p.name} 取值非法（需为 ${p.range.min}~${p.range.max} 的整数）`),
          );
      }
      resolvedPeriods.push(parsed === null ? p.fallback : parsed);
    }
    const [rsiPeriod, macdFast, macdSlow, macdSignal] = resolvedPeriods as [number, number, number, number];

    const limit = Math.min(Math.max(Number(days) || 120, 10), 500);

    try {
      // 复权视图按标的类别路由（ETF 不能走 v_stock_*）
      const classRows = await queryDuckDB<{ class: string }>(
        'SELECT class FROM raw_symbol_class WHERE symbol = ?',
        [symbol],
      );
      const symbolClass = classRows[0]?.class ?? 'stock';
      const views = FQ_VIEWS_BY_CLASS[symbolClass] ?? FQ_VIEWS_BY_CLASS.stock;
      const view = views[fq];

      /**
       * 复权因子必须与价格来自**同一视图 / 同一复权口径**：
       * - qfq：`qfq_factor`（= hfq_factor / latest_hfq）
       * - hfq：`hfq_factor`
       * - bfq / raw：不需要因子（adj_price = price）
       *
       * ⚠️ `raw_kline_daily` 没有这些列；`v_*_hfq` 没有 `qfq_factor`，
       *    故不能无条件 `SELECT qfq_factor`。
       */
      const factorExpr =
        fq === 'qfq' ? ', qfq_factor AS adj_factor' : fq === 'hfq' ? ', hfq_factor AS adj_factor' : '';
      const rows = await queryDuckDB<KlineRow>(
        `SELECT date, open, high, low, close, volume, amount${factorExpr}
         FROM ${view}
         WHERE symbol = ?
         ORDER BY date DESC
         LIMIT ?`,
        [symbol, limit],
      );

      // 反转为升序（前端画图需要从旧到新）
      const klines = rows.reverse();

      if (klines.length === 0) {
        // ⚠️ **形状一致性**：无论有没有 klines，响应里**必须有 `signals` 键**
        //    （空集合时为 `[]`）⇒ 前端不必写 `Array.isArray(body.data.signals)` 兜底。
        return reply.send(
          ok({ symbol, fq, symbolClass, klines: [], indicators: null, signals: [], trades: [] }),
        );
      }

      const closes = klines.map((k) => k.close);

      // 后端统一计算指标（AGENTS.md 约束：前端禁止 import @invest/core）
      const macdResult = calculateMACD(closes, macdFast, macdSlow, macdSignal);
      const rsiResult = calculateRSI(closes, rsiPeriod);

      // 查询**当前用户**该标的的近 N 条策略信号：先取最近 20 条，再按 trade_date 升序返回（与 klines 同序）
      //
      // ⚠️ `metrics_json` 是 **SQLite TEXT 列**（原始 JSON 文本）⇒ 原样下发，**不在后端解析**。
      //    与 `GET /api/signal`（`SELECT *`）同形态 ⇒ 两个端点口径统一（前端同一个 parseMetricsJson 即可）。
      // 🔴 `user_id = ?` —— **必须按用户隔离**（P1 越权修复）：参数绑定 JWT 的 `sub`，
      //    **绝不信请求参数**（伪造 `?user_id=` 无效）。
      // ⚠️ 窗口取「最近 N 条」（内层 DESC）+ 输出「升序」（外层 ASC），
      //    `created_at / id` 作确定性 tie-break ⇒ 与 `GET /api/signal` 的窗口口径**逐条一致**。
      const db = ConfigStore.getInstance().db;
      const signals = db
        .prepare(
          `SELECT trade_date, direction, label, strength, plugin_id, metrics_json
           FROM (
             SELECT trade_date, direction, label, strength, plugin_id, metrics_json, created_at, id
             FROM user_strategy_signal
             WHERE user_id = ? AND asset_code = ? AND is_deleted = 0
             ORDER BY trade_date DESC, created_at DESC, id DESC
             LIMIT ?
           )
           ORDER BY trade_date ASC, created_at ASC, id ASC`,
        )
        .all(user.sub, symbol, SIGNAL_LIMIT) as Array<{
        trade_date: string;
        direction: string;
        label: string;
        strength: number | null;
        plugin_id: string;
        /** 原始 JSON 文本；无指标时为 null（库里的 NULL，不是字符串 'null'）*/
        metrics_json: string | null;
      }>;

      /**
       * T152：当前用户在该标的上的交易标记。
       *
       * 🔴 **全历史回放**再筛窗口 —— 不能只回放窗口内记录，否则窗口首日买入会被
       *    误判成「建仓」（实际早已持仓）。回放口径与 `calcPosition` 一致：
       *    该用户该标的的跨券商合并持仓。
       *
       * ⚠️ **降级**：交易查询失败不能拖垮 K 线主数据（用户仍要看行情）。
       *    失败时 `trades: []` + `system_log` WARN，外层仍返回 200。
       */
      let trades: KlineTradeMarker[] = [];
      try {
        const allRows = loadKlineTradeMarkers(user.sub, symbol);
        const allMarkers = deriveTradeMarkers(allRows);
        if (klines.length === 0) {
          // 无 K 线（无数据）时跳过窗口筛选与复权价
          trades = [];
        } else {
          const startDate = klines[0].date;
          const endDate = klines[klines.length - 1].date;
          const windowed = filterMarkersToWindow(allMarkers, startDate, endDate);
          const adjusted = attachAdjustedPrices(
            windowed,
            fq,
            klines.map((k) => ({ date: k.date, factor: k.adj_factor })),
          );
          trades = adjusted.trades;

          if (adjusted.missingFactorDates.length > 0) {
            app.log.warn(
              { symbol, fq, dates: adjusted.missingFactorDates },
              'K 线交易标记复权因子缺失，已回退成交价',
            );
            writeSystemLog({
              logType: 'trade',
              level: 'WARN',
              message: 'K 线交易标记复权因子缺失，已回退成交价',
              detail: `symbol=${symbol} fq=${fq} dates=${adjusted.missingFactorDates.join(',')}`,
            });
          }
        }
      } catch (tradeErr: unknown) {
        const msg = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
        app.log.warn({ err: tradeErr, symbol }, 'K 线交易标记查询失败，已降级为空');
        writeSystemLog({
          logType: 'trade',
          level: 'WARN',
          message: 'K 线交易标记查询失败，已降级为空',
          detail: `symbol=${symbol} error=${msg}`,
        });
        trades = [];
      }

      return reply.send(
        ok({
          symbol,
          fq,
          symbolClass,
          klines,
          indicators: {
            macd: macdResult,
            rsi: rsiResult,
            ma5: calculateSMA(closes, 5),
            ma10: calculateSMA(closes, 10),
            ma20: calculateSMA(closes, 20),
            ma60: calculateSMA(closes, 60),
            params: {
              rsiPeriod,
              macdFast,
              macdSlow,
              macdSignal,
            },
          },
          signals,
          trades,
        }),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err, symbol, fq, days }, 'K 线查询失败');
      return reply.code(500).send(fail(500, 'KLINE_QUERY_FAILED', msg));
    }
  });
}
