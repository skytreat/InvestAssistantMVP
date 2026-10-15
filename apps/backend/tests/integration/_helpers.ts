/**
 * _helpers.ts — 集成测试共享 bootstrap
 *
 * 复用 smoke-m3 的 setup 但不 listen 端口（只用 app.inject()），
 * 避免 singleFork 模式下多个 Fastify 实例绑端口 EADDRINUSE。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ConfigStore } from '../../src/config/configStore.js';
import { registerRoutes } from '../../src/routes/index.js';
import { hashPassword, signToken } from '../../src/services/auth.js';

export interface TestAppBundle {
  app: Awaited<ReturnType<typeof Fastify>>;
  db: ConfigStore;
  adminToken: string;
  userId: number;
}

export const ADMIN_USER = 'int_admin';
export const ADMIN_PASS = 'int_admin123';
export const NORMAL_USER = 'int_user';
export const NORMAL_PASS = 'int_user123';

/**
 * 每次调用返回一个全新的 Fastify 实例（无 listen），
 * 但共享 ConfigStore 单例（singleFork 模式下必然如此）。
 * 调用方负责 afterAll 里 app.close()。
 */
export async function createTestApp(): Promise<TestAppBundle> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await registerRoutes(app);

  const db = ConfigStore.getInstance();

  // seed admin（幂等）
  db.db.prepare(
    'INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)'
  ).run(ADMIN_USER, hashPassword(ADMIN_PASS), 'admin');

  // login 拿 JWT（比直接 signToken 更接近真实链路）
  const loginRes = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  const body = JSON.parse(loginRes.body);
  const adminToken: string = body.data.token;
  const userId: number = body.data.user.id;

  return { app, db, adminToken, userId };
}

/** 给普通用户（非 admin）造个 token（直接 sign，不经过 seed 路由的 409 检查） */
export function makeUserToken(userId: number, username: string): string {
  return signToken({ sub: userId, username, role: 'user' });
}
