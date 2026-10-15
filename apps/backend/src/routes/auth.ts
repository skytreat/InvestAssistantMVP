import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { hashPassword, verifyPassword, signToken } from '../services/auth.js';

/**
 * Auth routes —— Phase 3 T25 前置依赖
 *
 * 公开路由（无需鉴权）：
 *   POST /api/auth/login   → { token, user: { id, username, role } }
 *   POST /api/auth/seed    → 初始化首个 admin 用户（幂等，已存在则报错）
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
        token,
        user: { id: row.id, username: row.username, role: row.role },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  app.post('/api/auth/seed', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { username?: string; password?: string; role?: 'user' | 'admin' };
      const username = body.username ?? 'admin';
      const password = body.password ?? 'admin123';
      const role = body.role ?? 'admin';
      if (role !== 'user' && role !== 'admin') {
        return reply.code(400).send({ success: false, error: 'role 只能是 user 或 admin' });
      }

      const db = ConfigStore.getInstance().db;
      const existing = db.prepare('SELECT id FROM user_account WHERE username = ?').get(username);
      if (existing) {
        return reply.code(409).send({ success: false, error: `用户 ${username} 已存在` });
      }
      const hash = hashPassword(password);
      const info = db.prepare(
        'INSERT INTO user_account (username, password_hash, role) VALUES (?, ?, ?)'
      ).run(username, hash, role);
      const token = signToken({ sub: Number(info.lastInsertRowid), username, role });
      reply.code(201).send({
        success: true,
        user: { id: info.lastInsertRowid, username, role },
        token,
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });
}
