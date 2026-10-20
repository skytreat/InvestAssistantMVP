import type { FastifyInstance } from 'fastify';
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
import { ok, fail } from '../lib/envelope.js';

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
 *      + signals（该标的近 20 条信号，**升序**，与 klines 同方向）
 */

interface KlineRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
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
    if (!/^(sh|sz)\d{6}$/.test(symbol)) {
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

      const rows = await queryDuckDB<KlineRow>(
        `SELECT date, open, high, low, close, volume, amount
         FROM ${view}
         WHERE symbol = ?
         ORDER BY date DESC
         LIMIT ?`,
        [symbol, limit],
      );

      // 反转为升序（前端画图需要从旧到新）
      const klines = rows.reverse();

      if (klines.length === 0) {
        return reply.send(ok({ symbol, fq, symbolClass, klines: [], indicators: null }));
      }

      const closes = klines.map((k) => k.close);

      // 后端统一计算指标（AGENTS.md 约束：前端禁止 import @invest/core）
      const macdResult = calculateMACD(closes, macdFast, macdSlow, macdSignal);
      const rsiResult = calculateRSI(closes, rsiPeriod);

      // 查询该标的的近 N 条策略信号：先取最近 20 条，再按 trade_date 升序返回（与 klines 同序）
      const db = ConfigStore.getInstance().db;
      const signals = db
        .prepare(
          `SELECT trade_date, direction, label, strength, plugin_id
         FROM (
           SELECT trade_date, direction, label, strength, plugin_id
           FROM user_strategy_signal
           WHERE asset_code = ? AND is_deleted = 0
           ORDER BY trade_date DESC
           LIMIT ${SIGNAL_LIMIT}
         )
         ORDER BY trade_date ASC`,
        )
        .all(symbol) as Array<{
        trade_date: string;
        direction: string;
        label: string;
        strength: number | null;
        plugin_id: string;
      }>;

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
        }),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err, symbol, fq, days }, 'K 线查询失败');
      return reply.code(500).send(fail(500, 'KLINE_QUERY_FAILED', msg));
    }
  });
}
