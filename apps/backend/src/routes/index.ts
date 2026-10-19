import type { FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';
import { registerDataCheckRoutes } from './dataCheck.js';
import { registerAuthRoutes } from './auth.js';
import { registerTradeRoutes } from './trade.js';
import { registerSignalRoutes } from './signal.js';
import { registerAdminRoutes } from './admin.js';
import { registerWatchRoutes } from './watch.js';
import { registerCandidateRoutes } from './candidate.js';
import { registerBatchCandidateRoutes } from './candidates.js';
import { registerKlineRoutes } from './kline.js';
import { registerStockScanRoutes } from './stockscan.js';
import { registerSymbolSearchRoutes } from './symbolSearch.js';
import { registerAssetStatRoutes } from './assetStat.js';
import { registerReviewRoutes } from './review.js';
import { registerPluginRoutes } from './plugin.js';
import { registerStrategyRoutes } from './strategy.js';
import { extractToken, verifyToken } from '../services/auth.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 路由注册入口
 *
 * 鉴权策略：
 *   - 公共路由（无需 Bearer token）：/api/health、/api/auth/login、/api/auth/seed、/api/market/latest
 *   - 其余 /api/* 都必须带 Authorization: Bearer <jwt>
 *   - admin 路由额外校验 role=admin（在路由 handler 内部显式 return 403）
 */

const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', '/api/auth/seed', '/api/market/latest']);

export async function registerRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;
    if (PUBLIC_ROUTES.has(url)) return;

    const token = extractToken((request.headers as any).authorization);
    if (!token) {
      reply.code(401).send(fail(401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <jwt>'));
      return reply.hijack();
    }
    const payload = verifyToken(token);
    if (!payload) {
      reply.code(401).send(fail(401, 'UNAUTHORIZED', 'token 无效或已过期'));
      return reply.hijack();
    }
    (request as any).user = payload;
  });

  // --- 公共路由 ---
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);

  // --- 需要鉴权 ---
  await registerDataCheckRoutes(app);
  await registerTradeRoutes(app);
  await registerSignalRoutes(app);
  await registerAdminRoutes(app);
  await registerWatchRoutes(app);
  // T92：候选池路由归属收敛到 candidate.ts / candidates.ts（此前未注册 → 整块功能不可达）
  await registerCandidateRoutes(app);
  await registerBatchCandidateRoutes(app);
  await registerKlineRoutes(app);
  await registerStockScanRoutes(app);
  await registerSymbolSearchRoutes(app);
  await registerAssetStatRoutes(app);
  await registerReviewRoutes(app);
  await registerPluginRoutes(app);
  // 🔴 T94 的 reload 路由此前**从未被注册**（PR#15 实现了 handler 但漏了接线）
  //    → SDD §4.4:1383 的 `POST /api/strategy/reload` 实测 404。本波补上。
  await registerStrategyRoutes(app);
}
