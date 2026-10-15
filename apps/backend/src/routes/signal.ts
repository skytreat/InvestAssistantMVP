import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';

/**
 * 策略信号查询 API（T28）
 * GET /api/signals?trade_date=2026-10-15&plugin_id=rsi_oversold&direction=buy&page=1&page_size=20
 */
export async function registerSignalRoutes(app: FastifyInstance) {
  app.get('/api/signals', async (request, reply) => {
    try {
      const user = (request as any).user;
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? '20', 10)));

      const db = ConfigStore.getInstance().db;
      const where = ['user_id = ?', 'is_deleted = 0'];
      const params: any[] = [user.sub];

      if (q.trade_date) {
        where.push('trade_date = ?');
        params.push(q.trade_date);
      }
      if (q.plugin_id) {
        where.push('plugin_id = ?');
        params.push(q.plugin_id);
      }
      if (q.direction) {
        where.push('direction = ?');
        params.push(q.direction);
      }

      const whereSql = 'WHERE ' + where.join(' AND ');
      const count = (db.prepare(`SELECT COUNT(*) AS c FROM user_strategy_signal ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(
        `SELECT * FROM user_strategy_signal ${whereSql} ORDER BY trade_date DESC, created_at DESC LIMIT ? OFFSET ?`
      ).all(...params, pageSize, (page - 1) * pageSize);

      reply.send({
        success: true,
        data: rows,
        pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });
}
