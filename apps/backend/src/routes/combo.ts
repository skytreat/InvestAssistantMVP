/**
 * 组合策略配置 API（T133 / PA-07）
 *
 * GET    /api/strategy/combos              → 组合列表（默认只返回启用的；`?include_disabled=1` 全量）
 * GET    /api/strategy/combos/:id          → 单个组合
 * POST   /api/strategy/combos              → 新建
 * PUT    /api/strategy/combos/:id          → 更新（改名 / 适用品种 / 冷却 / 条件）
 * PUT    /api/strategy/combos/:id/toggle   → 启停（`enabled` 收口 true/false/1/0）
 * DELETE /api/strategy/combos/:id          → 软删（`is_deleted=1`，历史信号不动）
 *
 * 口径（方案 §6 / §7）：
 * - D1：只做 AND —— 请求体里的 `combineOp` / `period` **不接收**（固定 'AND' / 'daily'）；
 * - D4：本路由只改配置，**不触碰 `user_strategy_signal`**（历史不可变）；
 * - 条件白名单 = 未停用的 monitor 且非风险/组合级插件；参数在这里就用插件 `paramSchema`
 *   + 跨字段约束校验，并把**校验后的完整参数**（含默认值）落库 ⇒ 回放可复现。
 *
 * 错误码：`PARAM_INVALID`(400) / `NOT_FOUND`(404) / `INTERNAL_ERROR`(500)。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import {
  COMBO_ASSET_SCOPES,
  ComboInputError,
  createCombo,
  deleteCombo,
  getCombo,
  listCombos,
  toggleCombo,
  updateCombo,
  type ComboAssetScope,
  type ComboConditionInput,
} from '../services/comboRepo.js';
import { getAllPlugins, validatePluginParams, type Plugin } from '../services/pluginEngine.js';
import { isAllowedComboCondition } from '../services/comboStrategy.js';
import { writeSystemLog } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';
import { normalizeEnabledFlag } from './plugin.js';

interface ComboRequestBody {
  name?: unknown;
  assetScope?: unknown;
  cooldownBars?: unknown;
  conditions?: unknown;
  enabled?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failInternal(reply: FastifyReply, action: string, err: unknown): FastifyReply {
  const detail = err instanceof Error ? err.message : String(err);
  writeSystemLog({ logType: 'signal_generate', level: 'ERROR', message: `组合策略${action}失败`, detail });
  return reply.code(500).send(fail(500, 'INTERNAL_ERROR', `组合策略${action}失败，请稍后重试`));
}

/**
 * 校验并规整条件数组
 *
 * - 每个条件必须是「存在 + 白名单内」的插件（risk / requiresPositions 一律拒绝）；
 * - 参数走 `validatePluginParams`（单字段范围 + 跨字段约束），**落库值含默认值**；
 * - 停用条件（`enabled=false`）同样校验参数（重新启用时不能带坏参数）。
 */
function parseConditions(raw: unknown): ComboConditionInput[] {
  if (!Array.isArray(raw)) {
    throw new ComboInputError('conditions 必须是数组');
  }
  if (raw.length < 2) {
    throw new ComboInputError('组合至少需要 2 个条件');
  }

  const plugins = new Map(getAllPlugins().map((plugin) => [plugin.id, plugin]));
  const seen = new Set<string>();

  return raw.map((item, index) => {
    const label = `第 ${index + 1} 个条件`;
    if (!isPlainObject(item)) {
      throw new ComboInputError(`${label}必须是对象`);
    }
    const pluginId = item.pluginId;
    if (typeof pluginId !== 'string' || pluginId.trim() === '') {
      throw new ComboInputError(`${label}缺少 pluginId`);
    }
    if (seen.has(pluginId)) {
      throw new ComboInputError(`条件 pluginId 重复：${pluginId}`);
    }
    seen.add(pluginId);

    const plugin: Plugin | undefined = plugins.get(pluginId);
    if (!plugin) {
      throw new ComboInputError(`条件插件不存在：${pluginId}`);
    }
    if (!isAllowedComboCondition(plugin)) {
      throw new ComboInputError(`条件插件「${pluginId}」不允许：只允许未停用的 monitor 且非风险/组合级插件`);
    }

    let enabled = true;
    if (item.enabled !== undefined) {
      const flag = normalizeEnabledFlag(item.enabled);
      if (flag === null) {
        throw new ComboInputError(`条件「${pluginId}」的 enabled 必须是布尔值或 0/1`);
      }
      enabled = flag === 1;
    }

    const rawParams = item.params ?? {};
    if (!isPlainObject(rawParams)) {
      throw new ComboInputError(`条件「${pluginId}」的 params 必须是对象`);
    }
    let params: Record<string, unknown>;
    try {
      params = validatePluginParams(plugin, rawParams);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ComboInputError(`条件「${pluginId}」参数非法：${message}`);
    }

    return { pluginId, enabled, params };
  });
}

function parseAssetScope(raw: unknown): ComboAssetScope {
  if (raw === undefined || raw === null) return 'all';
  if (typeof raw !== 'string' || !(COMBO_ASSET_SCOPES as readonly string[]).includes(raw)) {
    throw new ComboInputError(`未知适用品种：${String(raw)}`);
  }
  return raw as ComboAssetScope;
}

function parseCooldownBars(raw: unknown): number {
  if (raw === undefined || raw === null) return 3;
  if (typeof raw !== 'number') {
    throw new ComboInputError('cooldownBars 必须是数字');
  }
  return raw;
}

function parseName(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new ComboInputError('组合名称不能为空');
    return undefined;
  }
  if (typeof raw !== 'string') throw new ComboInputError('组合名称必须是字符串');
  return raw;
}

export async function registerComboRoutes(app: FastifyInstance) {
  app.get('/api/strategy/combos', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const query = (request.query ?? {}) as { include_disabled?: string };
      const includeDisabled =
        typeof query.include_disabled === 'string' &&
        (query.include_disabled === '1' || query.include_disabled.toLowerCase() === 'true');
      const db = ConfigStore.getInstance().db;
      return reply.send(ok(listCombos(db, user.sub, { includeDisabled })));
    } catch (err) {
      return failInternal(reply, '列表加载', err);
    }
  });

  app.get('/api/strategy/combos/:id', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const { id } = request.params as { id: string };
      const combo = getCombo(ConfigStore.getInstance().db, user.sub, id);
      if (!combo) {
        return reply.code(404).send(fail(404, 'NOT_FOUND', '组合不存在或已删除'));
      }
      return reply.send(ok(combo));
    } catch (err) {
      return failInternal(reply, '详情读取', err);
    }
  });

  app.post('/api/strategy/combos', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const body = (request.body ?? {}) as ComboRequestBody;
      const name = parseName(body.name, true) as string;
      const db = ConfigStore.getInstance().db;

      const created = createCombo(db, {
        userId: user.sub,
        name,
        assetScope: parseAssetScope(body.assetScope),
        cooldownBars: parseCooldownBars(body.cooldownBars),
        conditions: parseConditions(body.conditions),
      });

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `${user.username} 新建组合策略「${created.name}」(${created.id})：条件 ${created.conditions.length} 个`,
      });
      return reply.send(ok(created));
    } catch (err) {
      if (err instanceof ComboInputError) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', err.message));
      }
      return failInternal(reply, '新建', err);
    }
  });

  app.put('/api/strategy/combos/:id', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as ComboRequestBody;
      const db = ConfigStore.getInstance().db;

      const patch: Parameters<typeof updateCombo>[3] = {};
      const name = parseName(body.name, false);
      if (name !== undefined) patch.name = name;
      if (body.assetScope !== undefined) patch.assetScope = parseAssetScope(body.assetScope);
      if (body.cooldownBars !== undefined) patch.cooldownBars = parseCooldownBars(body.cooldownBars);
      if (body.conditions !== undefined) patch.conditions = parseConditions(body.conditions);

      const updated = updateCombo(db, user.sub, id, patch);
      if (!updated) {
        return reply.code(404).send(fail(404, 'NOT_FOUND', '组合不存在或已删除'));
      }

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `${user.username} 更新组合策略「${updated.name}」(${updated.id})：config_version=${updated.configVersion}`,
      });
      return reply.send(ok(updated));
    } catch (err) {
      if (err instanceof ComboInputError) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', err.message));
      }
      return failInternal(reply, '更新', err);
    }
  });

  app.put('/api/strategy/combos/:id/toggle', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { enabled?: unknown };

      const enabled = normalizeEnabledFlag(body.enabled);
      if (enabled === null) {
        return reply
          .code(400)
          .send(fail(400, 'PARAM_INVALID', 'enabled 必须是布尔值或 0/1（true/false、1/0）'));
      }

      const updated = toggleCombo(ConfigStore.getInstance().db, user.sub, id, enabled === 1);
      if (!updated) {
        return reply.code(404).send(fail(404, 'NOT_FOUND', '组合不存在或已删除'));
      }

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `${user.username} ${enabled ? '启用' : '停用'}组合策略「${updated.name}」(${updated.id})`,
      });
      return reply.send(ok(updated));
    } catch (err) {
      return failInternal(reply, '启停', err);
    }
  });

  app.delete('/api/strategy/combos/:id', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number; username: string };
      const { id } = request.params as { id: string };
      const deleted = deleteCombo(ConfigStore.getInstance().db, user.sub, id);
      if (!deleted) {
        return reply.code(404).send(fail(404, 'NOT_FOUND', '组合不存在或已删除'));
      }

      writeSystemLog({
        logType: 'signal_generate',
        level: 'INFO',
        message: `${user.username} 删除组合策略 ${id}（软删，历史信号保留）`,
      });
      return reply.send(ok(null));
    } catch (err) {
      return failInternal(reply, '删除', err);
    }
  });
}
