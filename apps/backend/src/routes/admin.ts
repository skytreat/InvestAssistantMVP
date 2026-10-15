import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { runAllChecks } from '../services/validator.js';
import { executeAllPlugins } from '../services/pluginEngine.js';
import { persistSignals, getTradeDate } from '../services/signalService.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * 管理员 API（T29）——需要 role=admin
 * - POST /api/admin/run-datacheck   手动触发 C1-C12
 * - POST /api/admin/run-signal      手动触发插件信号生成（含持久化）
 * - GET  /api/admin/system-log      分页查询 system_log
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  // 手动跑 C1-C12（需要 admin role）
  app.post('/api/admin/run-datacheck', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN', message: '仅 admin 可手动触发校验' });
    try {
      writeSystemLog({ logType: 'trigger_manual', level: 'INFO', message: `${user.username} 手动触发 C1-C12 校验` });
      const date = (request.body as any)?.trade_date ?? getTradeDate();
      const summaries = await runAllChecks(date);
      reply.send({ success: true, data: { trade_date: date, summaries } });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 手动跑信号生成
  app.post('/api/admin/run-signal', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    try {
      writeSystemLog({ logType: 'trigger_manual', level: 'INFO', message: `${user.username} 手动触发信号生成` });
      const result = await executeAllPlugins();
      const tradeDate = (request.body as any)?.trade_date ?? getTradeDate();
      let totalInserted = 0, totalSkipped = 0;
      for (const p of result.results) {
        if (p.status !== 'SUCCESS' || p.signals.length === 0) continue;
        const persist = persistSignals(p.signals, p.pluginId, 'monitor', tradeDate);
        totalInserted += persist.inserted;
        totalSkipped += persist.skipped;
      }
      reply.send({
        success: true,
        data: {
          stats: result.stats,
          inserted: totalInserted,
          skipped: totalSkipped,
          trade_date: tradeDate,
        },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // system_log 分页查询
  app.get('/api/admin/system-log', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    try {
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? '50', 10)));

      const db = ConfigStore.getInstance().db;
      const where: string[] = [];
      const params: any[] = [];
      if (q.log_type) { where.push('log_type = ?'); params.push(q.log_type); }
      if (q.level) { where.push('level = ?'); params.push(q.level); }
      if (q.trade_date) { where.push('log_date = ?'); params.push(q.trade_date); }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const count = (db.prepare(`SELECT COUNT(*) AS c FROM system_log ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(
        `SELECT * FROM system_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
      ).all(...params, pageSize, (page - 1) * pageSize);

      reply.send({
        success: true, data: rows,
        pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });
}
