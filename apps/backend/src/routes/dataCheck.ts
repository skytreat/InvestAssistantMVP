import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from '../services/logger.js';
import { runAllChecks } from '../services/validator.js';
import { queryDuckDB } from '../db/duckdb.js';
import { resolveTargetTradeDate } from '../services/marketData.js';
import { ok, fail } from '../lib/envelope.js';
import { defaultMessage } from '../lib/errorMessages.js';

/**
 * 数据校验 API（T29 补充）
 * - GET  /api/datacheck/latest    → 最近一次 C1-C12 校验结果（结构化 summaries）
 * - POST /api/datacheck/run       → 手动触发 C1-C12 并立即返回结果
 * - GET  /api/market/latest       → 行情最新几行（需 DuckDB）
 */

export async function registerDataCheckRoutes(app: FastifyInstance) {
  // 最近一次校验结果（结构化）
  app.get('/api/admin/datacheck/result', async (request, reply) => {
    try {
      const db = ConfigStore.getInstance().db;
      // 🔴 T85b ②：校验日志记的是 **tradeDate**（可能是上一交易日），不是「今天」。
      // 原实现按 log_date = today 查 → 周末/节假日跑完校验后这里恒为空。
      // 改为取「最近一次有 datacheck 日志的日期」。
      const lastRow = db.prepare(
        `SELECT MAX(log_date) AS d FROM system_log WHERE log_type = 'datacheck'`
      ).get() as { d: string | null };
      const logDate = lastRow?.d ?? (await resolveTargetTradeDate()) ?? new Date().toISOString().slice(0, 10);
      const rows = db.prepare(
        `SELECT check_item, level, message, detail FROM system_log
         WHERE log_type = 'datacheck' AND log_date = ?
         ORDER BY id DESC`
      ).all(logDate) as Array<{ check_item: string; level: string; message: string; detail: string | null }>;

      const seen = new Set<string>();
      const summaries: Array<{ checkId: string; result: string; message: string; detail: string | null }> = [];
      for (const row of rows.reverse()) {
        if (seen.has(row.check_item)) continue;
        seen.add(row.check_item);
        summaries.push({
          checkId: row.check_item,
          result: row.level,
          message: row.message,
          detail: row.detail,
        });
      }

      return reply.send(ok(summaries));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 行情最新几行
  app.get('/api/market/latest', async (request, reply) => {
    try {
      const rows = await queryDuckDB(
        'SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 5'
      );
      return reply.send(ok(rows));
    } catch (err) {
      return reply.code(502).send(fail(502, 'DB_UNAVAILABLE', 'DuckDB 不可用（需要先在服务器上执行 tdx2db init）'));
    }
  });
}
