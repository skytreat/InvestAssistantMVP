import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from '../services/logger.js';
import { runAllChecks } from '../services/validator.js';
import { queryDuckDB } from '../db/duckdb.js';

/**
 * 数据校验 API（T29 补充）
 * - GET  /api/datacheck/latest    → 最近一次 C1-C12 校验结果（结构化 summaries）
 * - POST /api/datacheck/run       → 手动触发 C1-C12 并立即返回结果
 * - GET  /api/market/latest       → 行情最新几行（需 DuckDB）
 */

export async function registerDataCheckRoutes(app: FastifyInstance) {
  // 最近一次校验结果（结构化）
  app.get('/api/datacheck/latest', async (request, reply) => {
    try {
      const db = ConfigStore.getInstance().db;
      const today = new Date().toISOString().slice(0, 10);
      const rows = db.prepare(
        `SELECT check_item, level, message, detail FROM system_log
         WHERE log_type = 'datacheck' AND log_date = ?
         ORDER BY id DESC`
      ).all(today) as Array<{ check_item: string; level: string; message: string; detail: string | null }>;

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

      return reply.send({ success: true, data: summaries });
    } catch (err) {
      return reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 手动触发 C1-C12
  app.post('/api/datacheck/run', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    try {
      writeSystemLog({ logType: 'trigger_manual', level: 'INFO', message: `${user.username} 手动触发 C1-C12 校验` });
      const date = ((request.body as any)?.trade_date) ?? new Date().toISOString().slice(0, 10);
      const summaries = await runAllChecks(date);
      return reply.send({ success: true, data: { trade_date: date, summaries } });
    } catch (err) {
      return reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 行情最新几行
  app.get('/api/market/latest', async (request, reply) => {
    try {
      const rows = await queryDuckDB(
        'SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 5'
      );
      return reply.send({ success: true, data: rows });
    } catch (err) {
      return reply.code(502).send({
        success: false,
        error: 'DuckDB 不可用（需要先在服务器上执行 tdx2db init）',
        detail: String(err),
      });
    }
  });
}
