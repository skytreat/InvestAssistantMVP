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
import { fail } from '../lib/envelope.js';

/**
 * 路由注册入口
 *
 * 鉴权策略：
 *   - 公共路由（无需 Bearer token）：/api/health、/api/auth/login、/api/auth/register、
 *     /api/auth/refresh、/api/auth/seed、/api/market/latest
 *   - 其余 /api/* 都必须带 Authorization: Bearer <jwt>
 *   - admin 路由额外校验 role=admin（在路由 handler 内部显式 return 403）
 */

/**
 * 公共路由白名单
 *
 * 🔴 **T64 补入 `/api/auth/register` 与 `/api/auth/refresh`**（2026-10-20）
 *
 * 这两条路径此前**被全局 onRequest 钩子挡住 → 功能不可达**（`routes/auth.ts` 自认此事，
 * 且 `tests/unit/t57-auth-register.test.ts` 只能靠「刻意放行」的复刻实例来测路由内部逻辑）。
 *
 * | 路由 | 此前为何不可达 | 放行后由谁防护 |
 * |---|---|---|
 * | `POST /api/auth/register` | 「匿名 + 库里 0 用户 → 首个用户自动 admin」这条 SDD §4.4 的 bootstrap 路径要求**匿名**调用 → 被钩子 401 | 路由**自身**的 `resolveRegisterRole`：匿名 + 已有用户 → **403 ADMIN_ALREADY_EXISTS / FORBIDDEN**；匿名 + 0 用户 → admin；普通用户 → 强制 role=user |
 * | `POST /api/auth/refresh` | 「access token 已过期后用 refresh 换新」要求**不带有效 access token** → 被钩子 401 | 路由**自身**校验 refresh_token：查库 hash + 有效期 + 轮换，非法 → **401 UNAUTHORIZED** |
 *
 * ⚠️ **两条路由都是自保护的**（鉴权逻辑在 handler 内部，不依赖全局钩子），
 * 故放行**不会**造成越权 —— 反而是把「已实现但触达不到」的功能接通。
 *
 * ⚠️ 与 PRD §5.9「过期后自动跳转登录页…**支持刷新自动续期**」直接相关：
 * 不放行 refresh，前端在 access token 过期后**只能**降级为「会话过期 → 重新登录」，
 * 「自动续期」永远走不通。
 */
const PUBLIC_ROUTES = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/seed',
  '/api/market/latest',
]);

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
