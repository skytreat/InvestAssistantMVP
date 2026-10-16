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
 * - POST /api/admin/rerun-quotes    手动触发行情更新补跑（Requirements §5.1）
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

  // T41: 列出所有用户
  app.get('/api/admin/users', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const db = ConfigStore.getInstance().db;
    const rows = db.prepare(`SELECT id, username, role, created_at FROM user_account ORDER BY id`).all() as any[];
    return reply.send({ success: true, data: rows });
  });

  // T41: 升级/降级用户角色（admin 只能有1人，禁止降级自己）
  app.patch('/api/admin/users/:id/role', async (request, reply) => {
    const operator = (request as any).user;
    if (operator.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const targetId = Number((request.params as any).id);
    const { role } = request.body as { role: 'user' | 'admin' };
    if (!['user', 'admin'].includes(role)) return reply.code(400).send({ success: false, error: 'role 非法' });

    const db = ConfigStore.getInstance().db;

    // 禁止降级自己
    if (targetId === operator.sub && role !== 'admin') {
      return reply.code(400).send({ success: false, error: '禁止降级当前登录账号' });
    }

    // 目标升 admin 时，检查是否已有其他 admin（admin 只能有1人）
    if (role === 'admin') {
      const existingAdmin = db.prepare(`SELECT COUNT(*) AS cnt FROM user_account WHERE role = 'admin' AND id != ?`).get(targetId) as { cnt: number };
      if (existingAdmin.cnt > 0) {
        return reply.code(400).send({ success: false, error: '已有管理员，请先降级现任管理员' });
      }
    }

    db.prepare(`UPDATE user_account SET role = ? WHERE id = ?`).run(role, targetId);
    writeSystemLog({
      logType: 'trigger_manual', level: 'INFO',
      message: `${operator.username} 将用户 ${targetId} 角色改为 ${role}`,
    });
    return reply.send({ success: true });
  });

  // G3a: 手动触发行情更新补跑（Requirements §5.1「管理员也可手动触发补跑」）
  app.post('/api/admin/rerun-quotes', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    try {
      const { reason } = (request.body ?? {}) as { reason?: string };
      const { rerunQuoteUpdate } = await import('../services/quoteRerun.js');
      const result = await rerunQuoteUpdate(reason?.trim() || `${user.username} 手动触发`);
      // 补跑成功后重跑一次校验，让管理员直接看到最新四色结果
      let checks: unknown = null;
      if (result.status === 'SUCCESS') {
        checks = await runAllChecks(getTradeDate());
      }
      return reply.send({ success: true, data: { ...result, checks } });
    } catch (err) {
      return reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // T41: 手动触发备份
  app.post('/api/admin/backup', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    try {
      const { runFullBackup } = await import('../services/backup.js');
      const result = await runFullBackup();
      writeSystemLog({
        logType: 'backup', level: 'SUCCESS',
        message: `${user.username} 手动触发备份`,
        detail: JSON.stringify({ sqlite: result.sqlite.success, duckdb: result.duckdb.success }),
      });
      return reply.send({ success: true, data: result });
    } catch (err) {
      return reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // T41: 列出备份文件
  app.get('/api/admin/backups', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });
    const { BACKUP_DIR } = await import('../services/backup.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    try {
      if (!fs.existsSync(BACKUP_DIR)) return reply.send({ success: true, data: [] });
      const entries = fs.readdirSync(BACKUP_DIR).map((name: string) => {
        const full = path.join(BACKUP_DIR, name);
        const stat = fs.statSync(full);
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      }).sort((a: any, b: any) => b.modified.localeCompare(a.modified));
      return reply.send({ success: true, data: entries });
    } catch (err) {
      return reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // T41 ⑤: 从备份恢复（二次确认 + system_log 留痕）
  app.post('/api/admin/backup/:file/restore', async (request, reply) => {
    const operator = (request as any).user;
    if (operator.role !== 'admin') return reply.code(403).send({ success: false, error: 'FORBIDDEN' });

    const { file } = request.params as { file: string };
    const body = (request.body ?? {}) as { confirm?: boolean };

    // 破坏性操作要求显式二次确认（AGENTS.md：减仓清仓类校验同理）
    if (body.confirm !== true) {
      return reply.code(400).send({
        success: false,
        error: 'CONFIRM_REQUIRED',
        message: '恢复备份会覆盖当前业务库，请传 { "confirm": true } 二次确认',
      });
    }

    const { restoreSQLiteBackup } = await import('../services/backup.js');
    const result = restoreSQLiteBackup(decodeURIComponent(file));
    if (!result.success) {
      return reply.code(400).send({ success: false, error: 'RESTORE_FAILED', message: result.error });
    }

    writeSystemLog({
      logType: 'trigger_manual', level: 'SUCCESS',
      message: `${operator.username} 从备份恢复 SQLite 业务库：${file}`,
      detail: `safety_backup=${result.safetyBackup ?? '无'}`,
    });

    return reply.send({
      success: true,
      data: { file, safetyBackup: result.safetyBackup },
    });
  });
}
