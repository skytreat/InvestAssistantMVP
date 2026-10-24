import type { FastifyInstance, FastifyReply } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { getAllPlugins } from '../services/pluginEngine.js';
import { writeSystemLog } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 插件管理 API（T40）
 *
 * GET    /api/strategy/plugins            → 插件列表（含 enabled/params）
 * PUT    /api/strategy/plugins/:id/config → 保存用户参数
 * PUT    /api/strategy/plugins/:id/toggle → 启用/禁用
 *
 * ⚠️ **方法必须是 PUT**（SDD §4.4 路由清单）：
 *   三个接口都是「幂等地把资源置成某个状态」，语义上就是 PUT。
 *   ⇒ 前端必须用 `api.put(...)`；用 POST 会 **404**（Fastify 不做方法回退）。
 *   —— 本波修复的缺陷 ① 就是前端误用 POST 导致设置页的插件启停按钮「点了就 404」。
 */

/**
 * 把请求体里的 `enabled` 收口成 SQLite 可绑定的 `0` / `1`。
 *
 * 🔴 **为什么必须收口**（本波修复的缺陷 ②）：
 *   better-sqlite3 **只能绑定 number / string / bigint / Buffer / null**，
 *   传 `true` 会抛 `TypeError` ⇒ 路由若没有 try/catch 就直接 500，
 *   且响应体是 Fastify 的**默认错误体** `{statusCode,error,message}`
 *   （**缺 `code` / `timestamp`**）⇒ 违反 SDD §4.2 的统一 envelope。
 *
 * 接受的输入：`true` / `false` / `1` / `0` / `'1'` / `'0'` / `'true'` / `'false'`。
 * 其它一律返回 `null`（由调用方回 **400 `PARAM_INVALID`**，而不是 500）。
 *
 * @returns 归一化后的 `0` / `1`；无法识别时返回 `null`
 */
export function normalizeEnabledFlag(value: unknown): 0 | 1 | null {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === 1) return 1;
  if (value === 0) return 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '1' || s === 'true') return 1;
    if (s === '0' || s === 'false') return 0;
  }
  return null;
}

/**
 * 统一的 500 兜底：**保证响应体仍是 SDD §4.2 的 envelope**。
 *
 * ⚠️ 原始异常**不直接回给用户**（可能含绝对路径 / 内部结构）——
 *   细节写进 `system_log`，响应体只给一句中文（与 `routes/admin.ts` 的系统日志兜底同款口径）。
 */
function failInternal(reply: FastifyReply, action: string, err: unknown): FastifyReply {
  const detail = err instanceof Error ? err.message : String(err);
  writeSystemLog({
    logType: 'plugin_execute',
    level: 'ERROR',
    message: `插件${action}失败`,
    detail,
  });
  return reply.code(500).send(fail(500, 'INTERNAL_ERROR', `插件${action}失败，请稍后重试`));
}

export async function registerPluginRoutes(app: FastifyInstance) {
  app.get('/api/strategy/plugins', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const db = ConfigStore.getInstance().db;
      const allPlugins = getAllPlugins();

      const result = allPlugins.map((p) => {
        const cfg = db
          .prepare(`SELECT params_json, enabled FROM user_plugin_config WHERE user_id = ? AND plugin_id = ?`)
          .get(user.sub, p.id) as { params_json: string; enabled: number } | undefined;
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

      return reply.send(ok(result));
    } catch (err) {
      return failInternal(reply, '列表加载', err);
    }
  });

  app.put('/api/strategy/plugins/:id/config', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { params?: unknown };

      // ⚠️ `params` 必须是**普通对象** —— null / 数组 / 字符串都会被 `JSON.stringify`
      //   写成非预期形状（或 `undefined`），落库后 `JSON.parse` 再炸。
      if (!isPlainObject(body.params)) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'params 必须是对象'));
      }

      const db = ConfigStore.getInstance().db;
      db.prepare(
        `INSERT OR REPLACE INTO user_plugin_config (user_id, plugin_id, enabled, params_json)
       VALUES (?, ?, 1, ?)`,
      ).run(user.sub, id, JSON.stringify(body.params));

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `${user.username} 更新插件 ${id} 参数`,
      });
      return reply.send(ok(null));
    } catch (err) {
      return failInternal(reply, '参数保存', err);
    }
  });

  app.put('/api/strategy/plugins/:id/toggle', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { enabled?: unknown };

      // 🔴 参数层收口：boolean / '1' / 'true' 等一律归一成 0/1；
      //    认不出来的 → **400 PARAM_INVALID**（不是 500，更不是静默当 false）。
      const enabled = normalizeEnabledFlag(body.enabled);
      if (enabled === null) {
        return reply
          .code(400)
          .send(fail(400, 'PARAM_INVALID', 'enabled 必须是布尔值或 0/1（true/false、1/0）'));
      }

      const db = ConfigStore.getInstance().db;
      const exists = db
        .prepare(`SELECT id FROM user_plugin_config WHERE user_id = ? AND plugin_id = ?`)
        .get(user.sub, id);

      if (exists) {
        db.prepare(`UPDATE user_plugin_config SET enabled = ? WHERE user_id = ? AND plugin_id = ?`).run(
          enabled,
          user.sub,
          id,
        );
      } else {
        db.prepare(
          `INSERT INTO user_plugin_config (user_id, plugin_id, enabled, params_json) VALUES (?, ?, ?, '{}')`,
        ).run(user.sub, id, enabled);
      }

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `${user.username} ${enabled ? '启用' : '禁用'}插件 ${id}`,
      });
      return reply.send(ok(null));
    } catch (err) {
      return failInternal(reply, '启停', err);
    }
  });
}

/** 是否是「普通对象」（排除 null / 数组 / Date 等） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
