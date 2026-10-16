import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { getAllPlugins, builtinPlugins } from '../services/pluginEngine.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * 插件管理 API（T40）
 *
 * GET    /api/plugins            → 插件列表（含 enabled/params）
 * POST   /api/plugins/:id/config → 保存用户参数
 * POST   /api/plugins/:id/toggle → 启用/禁用
 */

export async function registerPluginRoutes(app: FastifyInstance) {
  app.get('/api/plugins', async (request, reply) => {
    const user = (request as any).user as { sub: number; username: string };
    const db = ConfigStore.getInstance().db;
    const allPlugins = getAllPlugins();

    const result = allPlugins.map((p) => {
      const cfg = db.prepare(
        `SELECT params_json, enabled FROM user_plugin_config WHERE user_id = ? AND plugin_id = ?`
      ).get(user.sub, p.id) as { params_json: string; enabled: number } | undefined;
      return {
        id: p.id,
        name: p.name,
        category: p.category,
        description: (p as any).description as string | undefined,
        paramSchema: p.paramSchema,
        enabled: cfg?.enabled ?? 1,
        params: cfg?.params_json ? JSON.parse(cfg.params_json) : {},
      };
    });

    return reply.send({ success: true, data: result });
  });

  app.post('/api/plugins/:id/config', async (request, reply) => {
    const user = (request as any).user as { sub: number; username: string };
    const { id } = request.params as { id: string };
    const { params } = request.body as { params: Record<string, unknown> };

    const db = ConfigStore.getInstance().db;
    db.prepare(
      `INSERT OR REPLACE INTO user_plugin_config (user_id, plugin_id, enabled, params_json)
       VALUES (?, ?, 1, ?)`
    ).run(user.sub, id, JSON.stringify(params));

    writeSystemLog({ logType: 'signal_generate', level: 'INFO', message: `${user.username} 更新插件 ${id} 参数` });
    return reply.send({ success: true });
  });

  app.post('/api/plugins/:id/toggle', async (request, reply) => {
    const user = (request as any).user as { sub: number; username: string };
    const { id } = request.params as { id: string };
    const { enabled } = request.body as { enabled: number };

    const db = ConfigStore.getInstance().db;
    const exists = db.prepare(
      `SELECT id FROM user_plugin_config WHERE user_id = ? AND plugin_id = ?`
    ).get(user.sub, id);

    if (exists) {
      db.prepare(`UPDATE user_plugin_config SET enabled = ? WHERE user_id = ? AND plugin_id = ?`).run(enabled, user.sub, id);
    } else {
      db.prepare(
        `INSERT INTO user_plugin_config (user_id, plugin_id, enabled, params_json) VALUES (?, ?, ?, '{}')`
      ).run(user.sub, id, enabled);
    }

    writeSystemLog({ logType: 'signal_generate', level: 'INFO', message: `${user.username} ${enabled ? '启用' : '禁用'}插件 ${id}` });
    return reply.send({ success: true });
  });
}
