import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { runAllChecks } from '../services/validator.js';
import { resolveTargetTradeDate, resolveLatestQuoteDate } from '../services/marketData.js';
import { executeAllPlugins } from '../services/pluginEngine.js';
import {
  persistSignals,
  getTradeDate,
  resolveSignalSymbols,
  SIGNAL_USER_ID,
} from '../services/signalService.js';
import { writeSystemLog, readFallbackLogTail } from '../services/logger.js';
import { forceRefreshSymbolDict } from '../services/symbolDict.js';
import { ok, fail } from '../lib/envelope.js';
import { defaultMessage } from '../lib/errorMessages.js';

/**
 * 管理员 API（T29）——需要 role=admin
 * - POST /api/admin/run-datacheck   手动触发 C1-C12
 * - POST /api/admin/run-signal      手动触发插件信号生成（含持久化）
 * - GET  /api/admin/system-log      分页查询 system_log
 * - GET  /api/admin/system-log/fallback  读取降级日志文件尾部（I-13）
 * - POST /api/admin/rerun-quotes    手动触发行情更新补跑（Requirements §5.1）
 * - POST /api/admin/symbol-dict/refresh  强制刷新标的字典（名称快照补刷）
 */

/** 降级日志回读的最大行数（契约：只回读尾部 N 行，不回传整个文件）*/
const FALLBACK_TAIL_LINES = 200;
export async function registerAdminRoutes(app: FastifyInstance) {
  // 手动跑 C1-C12（需要 admin role）
  app.post('/api/admin/datacheck/trigger', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin') return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可手动触发校验'));
    try {
      writeSystemLog({
        logType: 'trigger_manual',
        level: 'INFO',
        message: `${user.username} 手动触发 C1-C12 校验`,
      });
      // 单一事实源（T85b ②）：日历口径的当前交易日
      const date = (request.body as any)?.trade_date ?? (await resolveTargetTradeDate()) ?? getTradeDate();
      const summaries = await runAllChecks(date);
      reply.send(ok({ trade_date: date, summaries }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 手动跑信号生成
  app.post('/api/admin/run-signal', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      writeSystemLog({
        logType: 'trigger_manual',
        level: 'INFO',
        message: `${user.username} 手动触发信号生成`,
      });
      // 🔴 T85b ①（I-19）：手动触发同样按**用户的自选 ∪ 持仓**生成信号（PRD M4），
      //   不再只对硬编码的 sh600000。
      const signalSymbols = resolveSignalSymbols(SIGNAL_USER_ID);
      const result = await executeAllPlugins({ symbols: signalSymbols });
      // 数据口径：信号要落在**确有行情**的那天（算指标必须有数据）
      const tradeDate =
        (request.body as any)?.trade_date ?? (await resolveLatestQuoteDate()) ?? getTradeDate();
      let totalInserted = 0,
        totalSkipped = 0;
      for (const p of result.results) {
        if (p.status !== 'SUCCESS' || p.signals.length === 0) continue;
        const persist = persistSignals(p.signals, p.pluginId, 'monitor', tradeDate);
        totalInserted += persist.inserted;
        totalSkipped += persist.skipped;
      }
      reply.send(
        ok({
          stats: result.stats,
          inserted: totalInserted,
          skipped: totalSkipped,
          trade_date: tradeDate,
        }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // system_log 分页查询
  app.get('/api/admin/system-log', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? '50', 10)));

      const db = ConfigStore.getInstance().db;
      const where: string[] = [];
      const params: any[] = [];
      if (q.log_type) {
        where.push('log_type = ?');
        params.push(q.log_type);
      }
      if (q.level) {
        where.push('level = ?');
        params.push(q.level);
      }
      // 🔴 Wave 7 卡 1 · 裁决 D-3：日期过滤是**区间**（起止两个 date 输入），不是单日等值。
      //   `log_date` 是 `YYYY-MM-DD` 定长格式 → 直接字符串比较即可（区间两端**闭区间**）。
      //   `trade_date` 是历史遗留的「单日等值」参数 → 保留，并折算成「起止同一天」的区间
      //   （语义与旧的 `log_date = ?` 完全等价，不破坏既有调用方）。
      const startDate = q.start_date ?? q.trade_date;
      const endDate = q.end_date ?? q.trade_date;
      if (startDate && endDate) {
        where.push('log_date BETWEEN ? AND ?');
        params.push(startDate, endDate);
      } else if (startDate) {
        where.push('log_date >= ?');
        params.push(startDate);
      } else if (endDate) {
        where.push('log_date <= ?');
        params.push(endDate);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const count = (
        db.prepare(`SELECT COUNT(*) AS c FROM system_log ${whereSql}`).get(...params) as { c: number }
      ).c;
      const rows = db
        .prepare(`SELECT * FROM system_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize);

      reply.send(
        ok(rows, { pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) } }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // Wave 7 卡 1 · I-13：系统日志的**降级记录**（SQLite 不可用时写入的兜底文件）
  //   - 仅 admin（与其它 admin 端点一致）
  //   - 只回读**尾部 N 行**，不回传整个文件
  //   - ⚠️ **响应体不含文件路径**（路径泄露 = 告诉攻击者去读哪个文件）
  app.get('/api/admin/system-log/fallback', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      const tail = readFallbackLogTail(FALLBACK_TAIL_LINES);
      return reply.send(ok({ exists: tail.exists, lines: tail.lines }));
    } catch (err) {
      // ⚠️ **不回传 String(err)**：fs 的错误信息里含**绝对路径**（如 EACCES: ... '/var/log/...'）
      //   → 只在服务端日志留痕，响应里只给一句中文。
      console.error('[admin] 读取降级日志失败:', err);
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', '读取降级日志失败'));
    }
  });

  // T41: 列出所有用户
  app.get('/api/admin/users', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    const db = ConfigStore.getInstance().db;
    const rows = db
      .prepare(`SELECT id, username, role, created_at FROM user_account ORDER BY id`)
      .all() as any[];
    return reply.send(ok(rows));
  });

  // T41: 升级/降级用户角色（admin 只能有1人，禁止降级自己）
  app.patch('/api/admin/role/:userId', async (request, reply) => {
    const operator = (request as any).user;
    if (operator.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    // T90：路由改名 `/api/admin/users/:id/role` → `/api/admin/role/:userId` ⇒ 参数名同步
    const targetId = Number((request.params as any).userId);
    const { role } = request.body as { role: 'user' | 'admin' };
    if (!['user', 'admin'].includes(role))
      return reply.code(400).send(fail(400, 'PARAM_INVALID', 'role 非法'));

    const db = ConfigStore.getInstance().db;

    // 禁止降级自己
    if (targetId === operator.sub && role !== 'admin') {
      return reply.code(400).send(fail(400, 'PARAM_INVALID', '禁止降级当前登录账号'));
    }

    // 目标升 admin 时，检查是否已有其他 admin（admin 只能有1人）
    if (role === 'admin') {
      const existingAdmin = db
        .prepare(`SELECT COUNT(*) AS cnt FROM user_account WHERE role = 'admin' AND id != ?`)
        .get(targetId) as { cnt: number };
      if (existingAdmin.cnt > 0) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '已有管理员，请先降级现任管理员'));
      }
    }

    db.prepare(`UPDATE user_account SET role = ? WHERE id = ?`).run(role, targetId);
    writeSystemLog({
      logType: 'trigger_manual',
      level: 'INFO',
      message: `${operator.username} 将用户 ${targetId} 角色改为 ${role}`,
    });
    return reply.send(ok(null));
  });

  // G3a: 手动触发行情更新补跑（Requirements §5.1「管理员也可手动触发补跑」）
  app.post('/api/admin/rerun-quotes', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      const { reason } = (request.body ?? {}) as { reason?: string };
      const { rerunQuoteUpdate } = await import('../services/quoteRerun.js');
      const result = await rerunQuoteUpdate(reason?.trim() || `${user.username} 手动触发`);
      // 补跑成功后重跑一次校验，让管理员直接看到最新四色结果
      let checks: unknown = null;
      if (result.status === 'SUCCESS') {
        checks = await runAllChecks((await resolveTargetTradeDate()) ?? getTradeDate());
      }
      return reply.send(ok({ ...result, checks }));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 强制刷新标的字典（部署后 / 字典快照过期时手动调用）
  app.post('/api/admin/symbol-dict/refresh', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      const rows = await forceRefreshSymbolDict();
      writeSystemLog({
        logType: 'trigger_manual',
        level: rows > 0 ? 'INFO' : 'WARN',
        message: `${user.username} 强制刷新标的字典，同步 ${rows} 行`,
      });
      return reply.send(ok({ rows }));
    } catch (err) {
      writeSystemLog({
        logType: 'trigger_manual',
        level: 'ERROR',
        message: `${user.username} 强制刷新标的字典失败`,
        detail: String(err),
      });
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T41: 手动触发备份
  app.post('/api/admin/backup', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    try {
      const { runFullBackup } = await import('../services/backup.js');
      const result = await runFullBackup();
      writeSystemLog({
        logType: 'backup',
        level: 'SUCCESS',
        message: `${user.username} 手动触发备份`,
        detail: JSON.stringify({
          sqlite: result.sqlite.success,
          duckdb: result.duckdb.success,
          duckdb_skipped: result.duckdb.skipped === true,
        }),
      });
      return reply.send(ok(result));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T41: 列出备份文件
  app.get('/api/admin/backups', async (request, reply) => {
    const user = (request as any).user;
    if (user.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));
    const { BACKUP_DIR } = await import('../services/backup.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    try {
      if (!fs.existsSync(BACKUP_DIR)) return reply.send(ok([]));
      const entries = fs
        .readdirSync(BACKUP_DIR)
        .map((name: string) => {
          const full = path.join(BACKUP_DIR, name);
          const stat = fs.statSync(full);
          return { name, size: stat.size, modified: stat.mtime.toISOString() };
        })
        .sort((a: any, b: any) => b.modified.localeCompare(a.modified));
      return reply.send(ok(entries));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T41 ⑤: 从备份恢复（二次确认 + system_log 留痕）
  app.post('/api/admin/backup/:file/restore', async (request, reply) => {
    const operator = (request as any).user;
    if (operator.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', defaultMessage('FORBIDDEN')));

    const { file } = request.params as { file: string };
    const body = (request.body ?? {}) as { confirm?: boolean };

    // 破坏性操作要求显式二次确认（AGENTS.md：减仓清仓类校验同理）
    if (body.confirm !== true) {
      return reply
        .code(400)
        .send(fail(400, 'CONFIRM_REQUIRED', '恢复备份会覆盖当前业务库，请传 { "confirm": true } 二次确认'));
    }

    const { restoreSQLiteBackup } = await import('../services/backup.js');
    const result = restoreSQLiteBackup(decodeURIComponent(file));
    if (!result.success) {
      return reply.code(400).send(fail(400, 'RESTORE_FAILED', result.error ?? '备份恢复失败'));
    }

    writeSystemLog({
      logType: 'trigger_manual',
      level: 'SUCCESS',
      message: `${operator.username} 从备份恢复 SQLite 业务库：${file}`,
      detail: `safety_backup=${result.safetyBackup ?? '无'}`,
    });

    return reply.send(ok({ file, safetyBackup: result.safetyBackup }));
  });
}
