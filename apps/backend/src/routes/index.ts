import type { FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';
import { registerDataCheckRoutes } from './dataCheck.js';

/**
 * 路由注册入口
 * Phase 1: health + datacheck 占位 + market 查询
 * Phase 3: 补 trade / signal / plugin / admin
 */
export async function registerRoutes(app: FastifyInstance) {
  // 公共路由（无需鉴权）
  await registerHealthRoutes(app);

  // 以下路由需要鉴权（Phase 1 MVP 单用户先用简化 token 验证）
  // Phase 3 接入完整 JWT
  await registerDataCheckRoutes(app);
}
