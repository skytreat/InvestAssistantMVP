import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * user_asset_rel CRUD（watch / hold / candidate 三种 rel_type 独立共存，AGENTS.md 硬约束）
 * - POST   /api/watch          新增自选
 * - DELETE /api/watch/:asset   删除自选
 * - GET    /api/watch          列出自选
 * - POST   /api/candidate      新增候选
 * - DELETE /api/candidate/:asset
 * - GET    /api/candidate
 * - POST   /api/candidate/:asset/promote  候选迁移到自选（Requirements §6.3，SDD 候选跟踪池）
 *
 * UNIQUE(user_id, asset_code, rel_type) 保证 watch/hold/candidate 可独立共存
 */
function _crud(app: FastifyInstance, relType: 'watch' | 'candidate') {
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

  // 候选 → 自选迁移（候选跟踪池命中后升级为自选）
  // 幂等：已在自选里返回 alreadyWatched，不报错；候选记录保留（migrated 标记 +1）
  app.post(`/api/${relType}/:asset_code/promote`, async (request, reply) => {
    const user = (request as any).user;
    const asset = (request.params as any).asset_code as string;
    if (!/^(sh|sz)\d{6}$/.test(asset)) {
      return reply.code(400).send({ success: false, error: 'INVALID_SYMBOL', message: 'symbol 格式应为 sh600000 / sz000001' });
    }
    const fromType = relType === 'candidate' ? 'candidate' : 'watch';
    const toType = relType === 'candidate' ? 'watch' : 'candidate';
    const db = ConfigStore.getInstance().db;

    try {
      const migrate = db.transaction(() => {
        // 已存在（含软删）→ 恢复 + 标记迁移
        const existing = db.prepare(
          'SELECT id, is_deleted FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = ?'
        ).get(user.sub, asset, toType) as { id: number; is_deleted: number } | undefined;

        if (existing) {
          db.prepare('UPDATE user_asset_rel SET is_deleted = 0, migrated_from_candidate = 1 WHERE id = ?')
            .run(existing.id);
          return { alreadyExisted: true, restored: existing.is_deleted === 1 };
        }

        db.prepare(
          `INSERT INTO user_asset_rel (user_id, asset_code, rel_type, migrated_from_candidate)
           VALUES (?, ?, ?, 1)`
        ).run(user.sub, asset, toType);
        return { alreadyExisted: false, restored: false };
      });

      const info = migrate();

      writeSystemLog({
        logType: 'trade', level: 'INFO',
        message: `${user.username} ${asset} 从 ${fromType} 迁移到 ${toType}`,
        detail: JSON.stringify(info),
      });

      return reply.send({ success: true, data: { asset_code: asset, from: fromType, to: toType, ...info } });
    } catch (err: any) {
      return reply.code(500).send({ success: false, error: String(err) });
    }
  });
}

export async function registerWatchRoutes(app: FastifyInstance) {
  _crud(app, 'watch');
  _crud(app, 'candidate');
}
