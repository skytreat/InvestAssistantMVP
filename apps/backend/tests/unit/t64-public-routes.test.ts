/**
 * T64 —— `/api/auth/register` 与 `/api/auth/refresh` 的**公开可达性** + **自保护**回归
 *
 * 背景（2026-10-20 实测发现）：
 *   `routes/auth.ts` 自认「当前 routes/index.ts 的 PUBLIC_ROUTES 白名单里没有 register / refresh，
 *   全局 onRequest 钩子会对它们要 Bearer token」⇒
 *   ① 「匿名 + 库里 0 用户 → 首个用户自动 admin」（SDD §4.4 的 bootstrap 路径）**不可达**
 *   ② 「access token 已过期后用 refresh 换新」（PRD §5.9「支持刷新自动续期」）**不可达**
 *
 * T64 已把这两条加入 PUBLIC_ROUTES。本测试用**真实 registerRoutes**（带全局钩子）验证：
 *   - 两条路径**确实可达**（不再被钩子 401 拦掉）
 *   - 放行**没有**造成越权：register 的角色裁决与 refresh 的 token 校验**仍然生效**
 *
 * ⚠️ 本测试用**真实** `registerRoutes`（与 `t57-auth-register.test.ts` 的「复刻实例」不同 ——
 * 那个测试刻意绕过了钩子，故**测不到**本问题）。
 *
 * ⚠️ **每个用例自给自足**（T81 的 shuffle 守卫）：`beforeEach` 清空 `user_account`，
 * 使「库里 0 用户」这一前置条件对每个用例都成立 —— 否则用例顺序会决定谁是「首用户」。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t64-public-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't64.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerRoutes } = await import('../../src/routes/index.js');

let app: FastifyInstance;

async function post(url: string, body?: unknown, headers?: Record<string, string>) {
  const res = await app.inject({
    method: 'POST',
    url,
    payload: body as never,
    headers: headers ?? {},
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** 用户名长度约束 3~32（后端 PARAM_INVALID 校验）*/
const U = {
  bootstrap: 'bootstrap-admin',
  guest: 'second-guest',
  refresh: 'refresh-user',
  refresh2: 'refresh-user-2',
  rotate: 'rotate-user',
};

beforeAll(async () => {
  app = Fastify({ logger: false });
  await registerRoutes(app);
  await app.ready();
});

/** 每个用例从「库里 0 用户」开始 —— 用例顺序不得影响谁是首用户 */
beforeEach(() => {
  const db = ConfigStore.getInstance().db;
  db.prepare('DELETE FROM user_account').run();
});

afterAll(async () => {
  await app.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
});

describe('T64 —— register / refresh 的公开可达性（真实 registerRoutes + 全局鉴权钩子）', () => {
  it('匿名注册：库里 0 用户 → 首个用户自动 admin（bootstrap 路径可达）', async () => {
    const r = await post('/api/auth/register', { username: U.bootstrap, password: 'pw-123456' });
    // 注册是「创建」语义 → 后端返 201
    expect(r.status).toBe(201);
    const data = r.body.data as { user: { role: string }; token: string; refresh_token: string };
    expect(data.user.role).toBe('admin');
    expect(typeof data.token).toBe('string');
    expect(typeof data.refresh_token).toBe('string');
  });

  it('匿名注册：库里已有用户 → 403 且**响应体是标准 envelope**', async () => {
    // 先造一个用户
    const first = await post('/api/auth/register', { username: U.bootstrap, password: 'pw-123456' });
    expect(first.status).toBe(201);

    const r = await post('/api/auth/register', { username: U.guest, password: 'pw-123456' });
    expect(r.status).toBe(403);
    // 🔴 标准信封：code / message / data===null / timestamp（SDD §4.2）
    //    T89b 起响应体**不再有** `success` 键（成功判定统一看 `code === 0`）
    expect(r.body.code).toBe('REGISTRATION_CLOSED');
    expect(r.body.message).toBeTruthy();
    expect(r.body.data).toBeNull();
    expect(r.body.timestamp).toBeTruthy();
    expect('success' in r.body).toBe(false);
  });

  it('refresh：带有效 refresh_token → 换到新 token（**自动续期路径可达**）', async () => {
    const reg = await post('/api/auth/register', { username: U.refresh, password: 'pw-123456' });
    expect(reg.status).toBe(201);
    const session = reg.body.data as { refresh_token: string; token: string };

    const r = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
    expect(r.status).toBe(200);
    const data = r.body.data as { token: string; refresh_token: string };
    expect(typeof data.token).toBe('string');
    expect(data.token.length).toBeGreaterThan(0);
    // ⚠️ **不**断言 `data.token !== session.token`：
    //   JWT 的 payload 含 `iat`/`exp`，**秒级**精度 → 同一秒内刷新签出的 token 与原 token
    //   **字节相同**（payload 完全一致）。这是 JWT 的正常行为，不是轮换失效。
    //   真正的轮换保证在 **refresh_token**（随机生成，必然不同）与「旧 refresh_token 立即失效」
    //   （见下一个用例）。
    expect(data.refresh_token).not.toBe(session.refresh_token);
  });

  it('refresh：**不带**任何 Authorization 头也能到 handler（此前被钩子 401 拦掉）', async () => {
    const reg = await post('/api/auth/register', { username: U.refresh2, password: 'pw-123456' });
    expect(reg.status).toBe(201);
    const session = reg.body.data as { refresh_token: string };

    // 无 Authorization 头 —— 钩子放行（PUBLIC_ROUTES），由 handler 自己校验 refresh_token
    const r = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
    expect(r.status).toBe(200);
  });

  it('refresh：refresh_token 非法 → 401 UNAUTHORIZED（**自保护仍生效**）', async () => {
    const r = await post('/api/auth/refresh', { refresh_token: 'not-a-real-token' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
  });

  it('refresh：refresh_token 缺失 → 400 PARAM_INVALID（**参数校验仍生效**）', async () => {
    const r = await post('/api/auth/refresh', {});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PARAM_INVALID');
  });

  it('refresh：轮换后旧 refresh_token 立即失效（**不能重复换新**）', async () => {
    const reg = await post('/api/auth/register', { username: U.rotate, password: 'pw-123456' });
    const session = reg.body.data as { refresh_token: string };

    const first = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
    expect(first.status).toBe(200);

    // 旧 refresh_token 再用一次 → 必须失败
    const second = await post('/api/auth/refresh', { refresh_token: session.refresh_token });
    expect(second.status).toBe(401);
  });

  it('放行 register/refresh **不影响**其它路由的鉴权（仍需 Bearer token）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('UNAUTHORIZED');
  });
});
