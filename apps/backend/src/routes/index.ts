import type { FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';
import { registerDataCheckRoutes } from './dataCheck.js';
import { registerAuthRoutes } from './auth.js';
import { registerTradeRoutes } from './trade.js';
import { extractToken, verifyToken } from '../services/auth.js';

/**
 * 路由注册入口
 * Phase 3: 接入最小 JWT 鉴权 + trade + signal（T27-T28）+ admin（T29）
 *
 * 鉴权策略：
 *   - 公共路由（无需 Bearer token）：/api/health、/api/auth/login、/api/auth/seed
 *   - 其余 /api/* 都必须带 Authorization: Bearer <jwt>
 */

// 公共路由前缀白名单（onRequest hook 跳过这些）
// Phase 1 遗留：/api/market/latest 是占位接口，smoke-m1 直接测它能通
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', '/api/auth/seed', '/api/market/latest']);

export async function registerRoutes(app: FastifyInstance) {
  // request.user 注入（onRequest hook 在所有 handler 之前跑）
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;  // 非 /api/* 跳过

    // 白名单
    if (PUBLIC_ROUTES.has(url)) return;

    const token = extractToken((request.headers as any).authorization);
    if (!token) {
      reply.code(401).send({ success: false, error: 'NO_TOKEN', message: '缺少 Authorization: Bearer <jwt>' });
      return reply.hijack();
    }
    const payload = verifyToken(token);
    if (!payload) {
      reply.code(401).send({ success: false, error: 'INVALID_TOKEN', message: 'token 无效或已过期' });
      return reply.hijack();
    }
    // 注入到 request 对象（路由 handler 里通过 (request as any).user 取）
    (request as any).user = payload;
  });

  // --- 公共路由 ---
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);

  // --- 需要鉴权 ---
  await registerDataCheckRoutes(app);
  await registerTradeRoutes(app);
}
