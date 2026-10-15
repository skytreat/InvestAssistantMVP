import type { FastifyInstance } from 'fastify';
import { queryDuckDB } from '../db/duckdb.js';
import { calculateMACD, calculateRSI } from '@invest/core';

/**
 * K 线行情数据接口（SDD F5 验收项）
 *
 * GET /api/kline/:symbol?days=120&fq=qfq
 *
 * symbol: sh600000 / sz000001 格式
 * days: 取最近 N 条日线，默认 120，范围 [10, 500]
 * fq: qfq(前复权) / raw(不复权)，默认 qfq
 *
 * 返回：klines（升序 OHLCV）+ indicators（后端算好 MACD / RSI / MA）
 *
 * 硬约束：
 * - Fastify 进程对 DuckDB 只有 SELECT 权限（AGENTS.md）
 * - 指标统一在后端计算返回——前端禁止直接 import @invest/core（AGENTS.md 跨 workspace 依赖规则）
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

/** 简单移动平均 MA */
function sma(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - j];
    result[i] = sum / period;
  }
  return result;
}

export async function registerKlineRoutes(app: FastifyInstance) {
  app.get('/api/kline/:symbol', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const { days = 120, fq = 'qfq' } = request.query as { days?: number; fq?: string };
    const limit = Math.min(Math.max(Number(days) || 120, 10), 500);
    const table = fq === 'raw' ? 'raw_kline_daily' : 'v_stock_qfq';

    // symbol 基本校验
    if (!/^(sh|sz)\d{6}$/.test(symbol)) {
      return reply.code(400).send({
        success: false,
        error: 'INVALID_SYMBOL',
        message: 'symbol 格式应为 sh600000 / sz000001',
      });
    }

    try {
      const rows = await queryDuckDB<KlineRow>(
        `SELECT date, open, high, low, close, volume, amount
         FROM ${table}
         WHERE symbol = ?
         ORDER BY date DESC
         LIMIT ?`,
        [symbol, limit]
      );

      // 反转为升序（前端画图需要从旧到新）
      const klines = rows.reverse();

      if (klines.length === 0) {
        return reply.send({
          success: true,
          data: { symbol, fq, klines: [], indicators: null },
        });
      }

      const closes = klines.map((k) => k.close);

      // 后端统一计算指标（AGENTS.md 约束：前端禁止 import @invest/core）
      const macdResult = calculateMACD(closes);
      const rsiResult = calculateRSI(closes, 14);

      return reply.send({
        success: true,
        data: {
          symbol,
          fq,
          klines,
          indicators: {
            macd: macdResult,
            rsi: rsiResult,
            ma5: sma(closes, 5),
            ma10: sma(closes, 10),
            ma20: sma(closes, 20),
          },
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err, symbol, fq, days }, 'K 线查询失败');
      return reply.code(500).send({
        success: false,
        error: 'KLINE_QUERY_FAILED',
        message: msg,
      });
    }
  });
}
