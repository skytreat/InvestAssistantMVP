import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * user_asset_rel CRUD —— **自选（watch）部分**
 *
 * 🔴 T92：候选池（candidate）的路由归属已收敛到 `routes/candidate.ts`
 *   （T50 的基准价固化 + price_mode + 「只打标记不建关联」的 promote）。
 *   本文件此前用 `_crud(app, 'candidate')` **重复注册**了同一批
 *   `/api/candidate*` 路径 → 与 `routes/candidate.ts` 冲突，且行为是旧版
 *   「promote 直接 INSERT 建 watch 关联」，违反 PRD S5 / SDD §12.3 B6。
 *   → candidate 的 CRUD 与 promote **全部移出本文件**。
 *
 * ⚠️ 同时移除了 `POST /api/watch/:asset_code/promote`（自选 → 候选的反向迁移）：
 *   · SDD §4.4 **无此路由**（只有 `POST /api/candidate/:id/migrate`）
 *   · 无任何调用方（前端未使用，测试未覆盖）
 *   · schema 里没有能表达「自选降级为候选」的标记位
 *     （`migrated_from_candidate` 语义是「由候选迁来」，用在自选行上会讲错故事）
 *   ⇒ 移除并登记为偏差（T92 保守原则：两个方向都不自动建关联）
 *
 * - POST   /api/watch          新增自选
 * - DELETE /api/watch/:asset   软删自选
 * - GET    /api/watch          列出自选
 *
 * UNIQUE(user_id, asset_code, rel_type) 保证 watch/hold/candidate 可独立共存
 */
function _crud(app: FastifyInstance, relType: 'watch') {
  // GET —— 列表
  app.get(`/api/${relType}`, async (request, reply) => {
    const user = (request as any).user;
    const db = ConfigStore.getInstance().db;
    const rows = db.prepare(
      'SELECT * FROM user_asset_rel WHERE user_id = ? AND rel_type = ? AND is_deleted = 0 ORDER BY created_at DESC'
    ).all(user.sub, relType);
    reply.send({ success: true, data: rows });
  });

  // POST —— 新增
  app.post(`/api/${relType}`, async (request, reply) => {
    const user = (request as any).user;
    const body = request.body as { asset_code?: string };
    if (!body?.asset_code) return reply.code(400).send({ success: false, error: 'asset_code 必填' });
    const db = ConfigStore.getInstance().db;
    try {
      const info = db.prepare(
        `INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, ?)`
      ).run(user.sub, body.asset_code, relType);
      reply.code(201).send({ success: true, data: { id: info.lastInsertRowid } });
    } catch (err: any) {
      if (String(err).includes('UNIQUE')) {
        return reply.code(409).send({ success: false, error: 'DUPLICATE', message: `${body.asset_code} 已在 ${relType} 列表` });
      }
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // DELETE —— 软删除
  app.delete(`/api/${relType}/:asset_code`, async (request, reply) => {
    const user = (request as any).user;
    const asset = (request.params as any).asset_code as string;
    const db = ConfigStore.getInstance().db;
    const info = db.prepare(
      `UPDATE user_asset_rel SET is_deleted = 1
       WHERE user_id = ? AND asset_code = ? AND rel_type = ? AND is_deleted = 0`
    ).run(user.sub, asset, relType);
    if (info.changes === 0) return reply.code(404).send({ success: false, error: 'NOT_FOUND' });
    reply.send({ success: true, data: null });
  });

}

export async function registerWatchRoutes(app: FastifyInstance) {
  _crud(app, 'watch');
}
