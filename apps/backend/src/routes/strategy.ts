// src/routes/strategy.ts
// T94（B-13 裁决：属 MVP）—— POST /api/strategy/reload 热加载自定义插件
//
// SDD §4.4:1383 是路由命名的唯一权威：`POST /api/strategy/reload`，鉴权「是（仅 admin）」。
// 另注册 `/api/strategy/plugins/reload` 别名，与 `/api/strategy/plugins`、`/api/strategy/plugins/:id/config`
// 归为同一族；两者行为完全一致（SDD 里没有的路径不留残路由，故别名只做兼容不做弃用标记）。
//
// 底层能力（services/pluginEngine.ts）本就已实装，本任务只补 HTTP 入口：
//   - PLUGIN_ALLOWED_PATH（/opt/invol/plugins/strategies，AGENTS.md 口径，非 SDD §5.3 的 /opt/invest/）
//   - loadPluginsFromDir()：目录不存在 → 返回 []；单文件失败 try/catch 隔离，不影响其他插件
//   - createPluginSandbox()：Proxy 屏蔽 globalThis，global/process/require/fetch 等置 undefined
//
// ⚠️ 该引擎**没有插件缓存**：getAllPlugins() 每次都重新读目录，所以 reload 的语义就是
// 「立刻重新扫描目录」，无需清缓存（也无缓存可清）。

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PLUGIN_ALLOWED_PATH,
  createPluginSandbox,
  loadPluginsFromDir,
  type Plugin,
} from '../services/pluginEngine.js';
import { writeSystemLog } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 与 pluginEngine.ts:584 的 PLUGIN_FILENAME_RE 同款正则。
 *
 * ⚠️ 这是**只读用途**的复刻（决定哪些文件进「加载失败明细」），不参与任何安全判定：
 * 真正的路径/文件名安全过滤在 loadPluginsFromDir 内部（正则 + statSync + resolved 前缀校验）。
 * 这里必须与引擎保持一致，否则「引擎跳过但我报成加载失败」的错误明细会出现噪音。
 */
const PLUGIN_FILENAME_RE = /^[a-z0-9_-]+\.js$/;

export interface ReloadPluginSummary {
  id: string;
  name: string;
  version: string;
  author: string;
  category: 'monitor' | 'filter';
}

export interface ReloadFailedEntry {
  file: string;
  error: string;
}

export interface ReloadResult {
  /** 磁盘插件目录（AGENTS.md 口径） */
  dir: string;
  /** 成功加载的插件数（目录不存在 = 0） */
  loaded: number;
  plugins: ReloadPluginSummary[];
  /** 单个插件加载失败明细；不影响其余插件加载 */
  errors: ReloadFailedEntry[];
}

interface AuthenticatedUser {
  sub: number;
  username: string;
  role: 'user' | 'admin';
}

function currentUser(request: FastifyRequest): AuthenticatedUser | null {
  const user = (request as FastifyRequest & { user?: AuthenticatedUser }).user;
  return user ?? null;
}

function summarize(plugin: Plugin): ReloadPluginSummary {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    author: plugin.author,
    category: plugin.category,
  };
}

/**
 * 重新扫描插件目录并归集每个文件的加载结果。
 *
 * 抽成独立函数（非仅 handler 内部逻辑）是为了让「语法错误文件不拖垮其他插件」
 * 「沙盒里 process/require 为 undefined」这些用例能在临时目录上直接验证
 * —— 生产路径 PLUGIN_ALLOWED_PATH 是 Linux 绝对路径，在开发机（Windows）上不存在。
 */
export function reloadPluginsFromDir(dirPath: string = PLUGIN_ALLOWED_PATH): ReloadResult {
  const plugins = loadPluginsFromDir(dirPath).map(summarize);
  const loadedIds = new Set(plugins.map((p) => p.id));

  // loadPluginsFromDir 对失败文件只 console.error，不回传原因；
  // 这里对「合法文件名但没出现在加载结果里」的文件重跑一次沙盒创建，把异常原因单列出来。
  const errors: ReloadFailedEntry[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return { dir: dirPath, loaded: plugins.length, plugins, errors };
  }

  for (const file of entries) {
    if (!PLUGIN_FILENAME_RE.test(file)) continue;
    const filePath = path.join(dirPath, file);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    try {
      const plugin = createPluginSandbox(fs.readFileSync(filePath, 'utf-8'));
      if (loadedIds.has(plugin.id)) continue;
      errors.push({ file, error: `插件 id「${plugin.id}」与已加载插件冲突` });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { dir: dirPath, loaded: plugins.length, plugins, errors };
}

/**
 * POST /api/strategy/reload（+ 别名 /api/strategy/plugins/reload）
 *
 * 仅 admin。返回 { loaded, plugins, errors, dir }。
 * 目录不存在 → loaded:0 + errors:[]（不是 500）。
 */
export async function registerStrategyRoutes(app: FastifyInstance) {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentUser(request);
    if (!user || user.role !== 'admin') {
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可热加载插件'));
    }

    try {
      const result = reloadPluginsFromDir();
      writeSystemLog({
        logType: 'plugin_execute',
        level: result.errors.length > 0 ? 'WARN' : 'INFO',
        message: `${user.username} 热加载插件: loaded=${result.loaded} failed=${result.errors.length}`,
        detail: JSON.stringify({ dir: result.dir, errors: result.errors }),
      });
      return reply.code(200).send(ok(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `热加载插件失败: ${msg}`,
      });
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', msg));
    }
  };

  app.post('/api/strategy/reload', handler);
  app.post('/api/strategy/plugins/reload', handler);
}