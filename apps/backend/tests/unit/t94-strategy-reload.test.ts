/**
 * T94 — POST /api/strategy/reload（+ /api/strategy/plugins/reload 别名）
 *
 * 覆盖 src/routes/strategy.ts：
 *   - 仅 admin（无 token / 普通用户 → 403 FORBIDDEN）
 *   - 目录不存在 → loaded:0（不是 500）
 *   - 单文件加载失败（语法错误 / 沙盒禁止 process、require）不影响其余插件，错误单列
 *   - reloadPluginsFromDir 对合法插件返回完整摘要（id/name/version/author/category）
 *
 * 底层 services/pluginEngine.ts 的三条硬约束在此以真实文件验证：
 *   目录固定 + 仅 .js、单文件 try/catch 隔离、沙盒内 process/require 为 undefined。
 *
 * SQLite 隔离：loadPluginsFromDir 每次加载会写 system_log（经 ConfigStore）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const TMP_SQLITE_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t94-db-'));
const TMP_PLUGIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t94-plugins-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_SQLITE_DIR, 't94.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const {
  registerStrategyRoutes,
  reloadPluginsFromDir,
} = await import('../../src/routes/strategy.js');
const { signToken, verifyToken, extractToken } = await import('../../src/services/auth.js');

afterAll(() => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try { rmSync(TMP_SQLITE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(TMP_PLUGIN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function tokenFor(sub: number, username: string, role: 'user' | 'admin'): string {
  return signToken({ sub, username, role });
}

/**
 * 复刻 index.ts 的鉴权钩子语义（挂 request.user），strategy 路由自行做 admin 判定
 *
 * ⚠️ 必须是 **async**：Fastify v5 的 hook runner 只在 hook 返回 thenable
 *    （或使用 3 参数 done 回调）时才继续。同步 hook 会让请求永远挂起，
 *    表现为 app.inject() 永不 resolve（测试以 15s timeout 收场）。
 *    生产代码 apps/backend/src/routes/index.ts:29 用的就是 async 形式。
 */
function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const token = extractToken(request.headers.authorization);
    if (!token) return;
    const payload = verifyToken(token);
    if (payload) {
      (request as typeof request & { user?: unknown }).user = payload;
    }
  });
  return app;
}

/**
 * 一个满足契约的合法插件（对象 literal 形式，沙盒内可执行）
 *
 * ⚠️ 必须写 `return ({...})` 而不是 `({...})`：
 * createPluginSandbox 把源码包成 `return (function () { <source> })();`，
 * 裸 `({...})` 在函数体里会被解析成**块语句**（`(` 后紧跟 `{`），
 * IIFE 返回 undefined → 报「插件必须导出一个对象」。
 * 由 r.loaded === 1 兜底。
 */
const VALID_PLUGIN_JS = `return ({
  id: 't94_valid_plugin',
  name: 'T94 合法测试插件',
  category: 'monitor',
  version: '1.0.0',
  author: 't94-test',
  execute: async () => ({ signalType: 'HOLD', strength: 0, detail: 'ok' }),
})`;

function writePlugin(file: string, content: string): void {
  writeFileSync(path.join(TMP_PLUGIN_DIR, file), content, 'utf-8');
}

describe('T94 — reloadPluginsFromDir 纯函数行为（临时目录，默认参数之外）', () => {
  it('空目录 → loaded:0 / plugins:[] / errors:[]', () => {
    const empty = mkdtempSync(path.join(TMP_PLUGIN_DIR, 'empty-'));
    try {
      const r = reloadPluginsFromDir(empty);
      expect(r.loaded).toBe(0);
      expect(r.plugins).toEqual([]);
      expect(r.errors).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('目录不存在 → loaded:0 且不抛错（Windows 无 /opt/invol 路径，默认参数同理）', () => {
    const r = reloadPluginsFromDir(path.join(TMP_PLUGIN_DIR, 'no-such-dir'));
    expect(r.loaded).toBe(0);
    expect(r.plugins).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('语法错误的 .js 不拖垮其余插件，错误单列到 errors', () => {
    writePlugin('aaa_valid.js', VALID_PLUGIN_JS);
    writePlugin('zzz_syntax_error.js', 'this is not javascript {{{');
    try {
      const r = reloadPluginsFromDir(TMP_PLUGIN_DIR);
      expect(r.loaded).toBe(1);
      expect(r.plugins).toHaveLength(1);
      expect(r.plugins[0].id).toBe('t94_valid_plugin');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].file).toBe('zzz_syntax_error.js');
      expect(r.errors[0].error.length).toBeGreaterThan(0);
    } finally {
      rmSync(path.join(TMP_PLUGIN_DIR, 'aaa_valid.js'), { force: true });
      rmSync(path.join(TMP_PLUGIN_DIR, 'zzz_syntax_error.js'), { force: true });
    }
  });

  it('沙盒内 process 为 undefined：访问 process.env 的插件加载失败但不抛未捕获异常', () => {
    writePlugin('aaa_valid.js', VALID_PLUGIN_JS);
    writePlugin('env_leak.js', `
      const token = process.env.TUSHARE_TOKEN;
      return ({ id: 'env_leak', name: 'x', category: 'monitor', execute: async () => ({}) });
    `);
    try {
      const r = reloadPluginsFromDir(TMP_PLUGIN_DIR);
      expect(r.loaded).toBe(1);
      const envErr = r.errors.find((e) => e.file === 'env_leak.js');
      expect(envErr).toBeDefined();
      expect(envErr!.error.length).toBeGreaterThan(0);
    } finally {
      rmSync(path.join(TMP_PLUGIN_DIR, 'aaa_valid.js'), { force: true });
      rmSync(path.join(TMP_PLUGIN_DIR, 'env_leak.js'), { force: true });
    }
  });

  it('沙盒内 require 为 undefined：require("fs") 的插件加载失败', () => {
    writePlugin('require_fs.js', `
      const fs = require('fs');
      return ({ id: 'require_fs', name: 'x', category: 'monitor', execute: async () => ({}) });
    `);
    try {
      const r = reloadPluginsFromDir(TMP_PLUGIN_DIR);
      expect(r.loaded).toBe(0);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].file).toBe('require_fs.js');
    } finally {
      rmSync(path.join(TMP_PLUGIN_DIR, 'require_fs.js'), { force: true });
    }
  });

  it('合法插件摘要字段完整（id/name/version/author/category）', () => {
    writePlugin('aaa_valid.js', VALID_PLUGIN_JS);
    try {
      const r = reloadPluginsFromDir(TMP_PLUGIN_DIR);
      expect(r.plugins[0]).toEqual({
        id: 't94_valid_plugin',
        name: 'T94 合法测试插件',
        version: '1.0.0',
        author: 't94-test',
        category: 'monitor',
      });
    } finally {
      rmSync(path.join(TMP_PLUGIN_DIR, 'aaa_valid.js'), { force: true });
    }
  });

  it('非法文件名（.ts / 大写 / 路径穿越）被跳过，不进 errors 也不算加载', () => {
    writePlugin('good_one.js', VALID_PLUGIN_JS);
    writePlugin('evil.TS', 'not js');
    writePlugin('UPPER.JS', 'not js');
    try {
      const r = reloadPluginsFromDir(TMP_PLUGIN_DIR);
      expect(r.loaded).toBe(1);
      expect(r.errors).toEqual([]);
      expect(r.plugins[0].id).toBe('t94_valid_plugin');
    } finally {
      for (const f of ['good_one.js', 'evil.TS', 'UPPER.JS']) {
        rmSync(path.join(TMP_PLUGIN_DIR, f), { force: true });
      }
    }
  });

  it('子目录不被当作插件加载', () => {
    mkdirSync(path.join(TMP_PLUGIN_DIR, 'subdir.js'), { recursive: true });
    try {
      const r = reloadPluginsFromDir(TMP_PLUGIN_DIR);
      expect(r.loaded).toBe(0);
      expect(r.errors).toEqual([]);
    } finally {
      rmSync(path.join(TMP_PLUGIN_DIR, 'subdir.js'), { recursive: true, force: true });
    }
  });
});

describe('T94 — POST /api/strategy/reload 路由（app.inject，不占端口）', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = makeApp();
    await registerStrategyRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('无 token → 403 FORBIDDEN', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/strategy/reload' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('普通用户 token → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategy/reload',
      headers: { authorization: `Bearer ${tokenFor(2, 'normal_user', 'user')}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('伪造签名 token → 403（钩子验签失败，不挂 user）', async () => {
    const forged = tokenFor(1, 'admin', 'admin').slice(0, -3) + 'AAA';
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategy/reload',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin token → 200，返回 loaded/plugins/errors 结构（目录不存在时 loaded:0 而非 500）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategy/reload',
      headers: { authorization: `Bearer ${tokenFor(1, 'the_admin', 'admin')}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: { dir: string; loaded: number; plugins: unknown[]; errors: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data.loaded).toBe('number');
    expect(Array.isArray(body.data.plugins)).toBe(true);
    expect(Array.isArray(body.data.errors)).toBe(true);
    // 生产目录 /opt/invol/plugins/strategies 在 Windows 测试机不存在 → loaded:0
    expect(body.data.loaded).toBe(0);
  });

  it('别名 /api/strategy/plugins/reload 与主路由行为一致', async () => {
    const mainRes = await app.inject({
      method: 'POST',
      url: '/api/strategy/reload',
      headers: { authorization: `Bearer ${tokenFor(1, 'the_admin', 'admin')}` },
    });
    const aliasRes = await app.inject({
      method: 'POST',
      url: '/api/strategy/plugins/reload',
      headers: { authorization: `Bearer ${tokenFor(1, 'the_admin', 'admin')}` },
    });
    expect(aliasRes.statusCode).toBe(mainRes.statusCode);
    // ⚠️ T89a：响应体新增 `timestamp`（SDD §4.2）→ 两次调用时间戳不同，
    //    不能整体 deep-equal；只比对**业务字段**（data / code / success）。
    const a = aliasRes.json();
    const m = mainRes.json();
    expect(a.code).toBe(m.code);
    expect(a.success).toBe(m.success);
    expect(a.data).toEqual(m.data);
  });
});
