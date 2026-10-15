import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { queryDuckDB } from '../db/duckdb.js';

/**
 * 数据校验相关 API
 * - 手动触发数据校验
 * - 查询最近校验结果
 */
export async function registerDataCheckRoutes(app: FastifyInstance) {
  app.get('/api/datacheck/latest', async (request, reply) => {
    try {
      const db = ConfigStore.getInstance().db;
      const rows = db.prepare(
        'SELECT * FROM system_log WHERE log_type = ? ORDER BY id DESC LIMIT 50'
      ).all('datacheck');
      reply.send({ success: true, data: rows });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  app.post('/api/datacheck/run', async (request, reply) => {
    // MVP Phase 1 占位：Phase 2 T16-T19 实现完整 C1-C12 校验
    reply.send({
      success: true,
      message: 'DataCheck 占位接口——Phase 2 T16-T19 实现 C1-C12',
      triggeredAt: new Date().toISOString(),
    });
  });

  app.get('/api/market/latest', async (request, reply) => {
    try {
      // MVP 占位：读 v_stock_qfq 最新几行
      const rows = await queryDuckDB(
        'SELECT symbol, date, close FROM v_stock_qfq ORDER BY date DESC LIMIT 5'
      );
      reply.send({ success: true, data: rows });
    } catch (err) {
      reply.code(502).send({
        success: false,
        error: 'DuckDB 不可用（需要先在服务器上执行 tdx2db init）',
        detail: String(err),
      });
    }
  });
}
