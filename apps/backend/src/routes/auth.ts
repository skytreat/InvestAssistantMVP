import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { hashPassword, verifyPassword, signToken } from '../services/auth.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * Auth routes —— Phase 3 T25 前置依赖
 *
 * 公开路由（无需鉴权）：
 *   POST /api/auth/login   → { token, user: { id, username, role } }
 *   POST /api/auth/seed    → 创建用户。⚠️ 公开路由，admin 角色仅"系统第一个用户"
 *                           可获得（库中已有用户时请求 admin → 403 ADMIN_ALREADY_EXISTS），
 *                           后续管理员变动走 PATCH /api/admin/users/:id/role
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request, reply) => {
    try {
      const body = request.body as { username?: string; password?: string };
      if (!body?.username || !body?.password) {
        return reply.code(400).send({ success: false, error: '用户名和密码不能为空' });
      }
      const db = ConfigStore.getInstance().db;
      const row = db.prepare(
        'SELECT id, username, password_hash, role FROM user_account WHERE username = ?'
      ).get(body.username) as { id: number; username: string; password_hash: string; role: 'user' | 'admin' } | undefined;

      if (!row || !verifyPassword(body.password, row.password_hash)) {
        return reply.code(401).send({ success: false, error: '用户名或密码错误' });
      }
      const token = signToken({ sub: row.id, username: row.username, role: row.role });
      reply.send({
        success: true,
        data: { token, user: { id: row.id, username: row.username, role: row.role } },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  app.post('/api/auth/seed', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { username?: string; password?: string; role?: 'user' | 'admin' };
      const username = body.username ?? 'admin';
      const requestedRole = body.role ?? 'admin';

      // P1-3 Seed 硬编码密码加固：
      // - production 强制 body.password 必填，禁止默认 'admin123'
      // - 开发环境保留默认值方便本地调试
      const isProd = process.env.NODE_ENV === 'production';
      let password: string;
      if (body.password?.trim()) {
        password = body.password.trim();
      } else if (isProd) {
        return reply.code(400).send({ success: false, error: 'SEED_PASSWORD_REQUIRED', message: '生产环境必须显式提供初始密码，禁止硬编码默认值' });
      } else {
        password = 'admin123';  // 仅开发环境兜底
      }

      if (requestedRole !== 'user' && requestedRole !== 'admin') {
        return reply.code(400).send({ success: false, error: 'role 只能是 user 或 admin' });
      }

      const db = ConfigStore.getInstance().db;

      if (requestedRole === 'admin') {
        const userCount = (db.prepare('SELECT COUNT(*) AS c FROM user_account').get() as { c: number }).c;
        if (userCount > 0) {
          // 安全硬约束：本路由是公开路由（bootstrap 用），一旦库里有用户，
          // 任何能访问 8080 的人都能自建 admin 账号 = 权限全面失守。
          // 因此 admin 只允许"系统里的第一个用户"拿到。
          return reply.code(403).send({
            success: false,
            error: 'ADMIN_ALREADY_EXISTS',
            message: `系统已有 ${userCount} 个用户，不允许再创建 admin。已有 admin 请用 PATCH /api/admin/users/:id/role 转让。`,
          });
        }
      }

      const existing = db.prepare('SELECT id FROM user_account WHERE username = ?').get(username);
      if (existing) {
        return reply.code(409).send({ success: false, error: `用户 ${username} 已存在` });
      }
      const role = requestedRole;
      const hash = hashPassword(password);
      const info = db.prepare(
        'INSERT INTO user_account (username, password_hash, role) VALUES (?, ?, ?)'
      ).run(username, hash, role);
      writeSystemLog({
        logType: 'startup', level: 'INFO',
        message: `创建用户 ${username}`,
        detail: `role=${role}`,
      });
      const token = signToken({ sub: Number(info.lastInsertRowid), username, role });
      reply.code(201).send({
        success: true,
        data: { user: { id: info.lastInsertRowid, username, role }, token },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });
}
