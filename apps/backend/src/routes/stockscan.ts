// src/routes/stockscan.ts
// SDD §5.5 全市场条件选股路由
// DuckDB 查全市场当日标的 → 插件 executePlugin 条件过滤 → score 降序 LIMIT max_results

import type { FastifyInstance } from 'fastify';
import { queryDuckDB } from '../db/duckdb.js';
import {
  executePlugin,
  getAllPlugins,
  buildPluginContext,
  type Plugin,
  type PluginExecutionResult,
  type PluginSignal,
} from '../services/pluginEngine.js';
import { batchGetDaily, getLatestTradingDay } from '../services/marketData.js';
import { writeSystemLog } from '../services/logger.js';

export interface StockScanResult {
  symbol: string;
  score: number;
  signalType: PluginSignal['signalType'];
  details?: string;
  pluginId: string;
}

export interface StockScanResponse {
  success: boolean;
  data?: {
    totalCandidates: number;   // 候选池（DuckDB 初筛后）
    total: number;              // pass 插件条件的数量
    results: StockScanResult[];
    tradeDate: string;
  };
  timeMs?: number;
  error?: string;
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
 *   }
 *
 * 流程：
 *   1. 找到指定插件（id 优先于 name）
 *   2. 取最近交易日（避免当天非交易日 DuckDB 无数据）
 *   3. DuckDB 查当日所有标的（可带 min_amount 过滤，上限 5000）
 *   4. batchGetDaily 1 次 IN 查询拿全部标的日线
 *   5. 逐标的覆盖 params.symbol → executePlugin 执行插件
 *   6. 收集 signalType !== 'HOLD' 的结果，score = strength
 *   7. score 降序 + LIMIT max_results
 *
 * MVP 性能硬约束：全选股 ≤ 3s
 */
export async function registerStockScanRoutes(app: FastifyInstance) {
  app.post('/api/stockscan', async (request, reply) => {
    const body = (request.body ?? {}) as {
      plugin_id?: string;
      plugin_name?: string;
      params?: Record<string, unknown>;
      min_amount?: number;
      max_results?: number;
    };

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

      const userParams: Record<string, unknown> = body.params ?? {};
      const minAmount = Math.max(0, Math.floor(body.min_amount ?? 0));
      const maxResults = Math.min(500, Math.max(1, Math.floor(body.max_results ?? 100)));

      // ---- 2. 取最近交易日 ----
      // 注意：当天可能是非交易日，DuckDB v_stock_qfq 里就没有当日数据
      const latest = await getLatestTradingDay(new Date().toISOString().slice(0, 10));
      const tradeDate = latest ?? new Date().toISOString().slice(0, 10);

      // ---- 3. DuckDB 查当日全市场标的 ----
      // MVP 上限 5000（A 股全市场 ~5300，留一点余量）
      const filterSql = `
        SELECT DISTINCT symbol, amount FROM v_stock_qfq
        WHERE date = ? AND amount >= ?
        ORDER BY amount DESC
        LIMIT 5000
      `;
      const stocks = await queryDuckDB<{ symbol: string; amount: number }>(
        filterSql,
        [tradeDate, minAmount],
      );

      if (stocks.length === 0) {
        return reply.send({
          success: true,
          data: {
            totalCandidates: 0,
            total: 0,
            results: [],
            tradeDate,
          },
          timeMs: Date.now() - startTotal,
        } satisfies StockScanResponse);
      }

      // ---- 4. 1 次 IN 查询拿全部标的日线（SDD §5.3 硬约束） ----
      const symbols = stocks.map((s) => s.symbol);
      const klineMap = await batchGetDaily(symbols, tradeDate);

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
        detail: JSON.stringify({ tradeDate, minAmount, maxResults, timeMs: totalMs }),
      });

      return reply.send({
        success: true,
        data: {
          totalCandidates: scannedCount,
          total: passResults.length,
          results: limited,
          tradeDate,
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
