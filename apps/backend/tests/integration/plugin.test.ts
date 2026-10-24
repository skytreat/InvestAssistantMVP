/**
 * plugin.test.ts —— 插件管理路由的契约测试（Wave 8 缺陷修复）
 *
 * 覆盖本波挖出的两个真实缺陷：
 *
 * - **① 方法不匹配**：前端设置页曾用 `POST /api/strategy/plugins/:id/toggle`，
 *   而后端只注册了 `PUT` ⇒ Fastify **不做方法回退** ⇒ **必然 404**。
 *   ⇒ 本文件断言「只有 PUT 命中，POST 是 404」，把方法写进契约。
 *
 * - **② boolean 绑定炸库**：`PUT .../toggle` 收 `{ enabled: true }` 时
 *   better-sqlite3 不能绑定 boolean ⇒ 500 + **非 envelope** 响应体。
 *   ⇒ 本文件断言：boolean / 数字 / 字符串都能正常落库；
 *   认不出来的取值 → **400 `PARAM_INVALID`**（不是 500），
 *   且**任何**错误响应都仍是 SDD §4.2 的统一 envelope（有 `code` / `message` / `timestamp` / `data:null`）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, cleanupIntegrationTest, type TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;

/** 随便挑一个插件 id（内置插件恒存在，与磁盘插件目录无关） */
let pluginId = '';

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

/** 取库里某插件的 enabled 值 */
function storedEnabled(id: string): number | undefined {
  const row = bundle.db.db
    .prepare('SELECT enabled FROM user_plugin_config WHERE user_id = ? AND plugin_id = ?')
    .get(bundle.userId, id) as { enabled: number } | undefined;
  return row?.enabled;
}

/** 断言响应体是 SDD §4.2 的统一错误 envelope */
function expectFailEnvelope(body: Record<string, unknown>, status: number, code: string): void {
  expect(body.code, `错误体 code 应为 ${code}`).toBe(code);
  expect(body.error).toBe(code);
  expect(body.data).toBeNull();
  expect(typeof body.message).toBe('string');
  expect((body.message as string).length).toBeGreaterThan(0);
  expect(typeof body.timestamp).toBe('string');
  expect('success' in body, '响应体不得有 success 键（T89b 契约）').toBe(false);
  expect(status).toBeGreaterThanOrEqual(400);
}

beforeAll(async () => {
  bundle = await createTestApp();
  const list = await bundle.app.inject({
    method: 'GET',
    url: '/api/strategy/plugins',
    headers: authHeader(),
  });
  const plugins = JSON.parse(list.body).data as Array<{ id: string }>;
  pluginId = plugins[0]?.id ?? 'rsi_oversold';
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('插件 toggle · ① 方法必须是 PUT（POST 必然 404）', () => {
  it('POST /api/strategy/plugins/:id/toggle → 404（后端只注册 PUT）', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: `/api/strategy/plugins/${pluginId}/toggle`,
      headers: authHeader(),
      payload: { enabled: 0 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/strategy/plugins/:id/config → 404（同款方法不匹配）', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: `/api/strategy/plugins/${pluginId}/config`,
      headers: authHeader(),
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/strategy/plugins/:id/toggle → 200（前端设置页走的就是这条路）', async () => {
    const res = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${pluginId}/toggle`,
      headers: authHeader(),
      payload: { enabled: 0 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect('success' in body).toBe(false);
  });
});

describe('插件 toggle · ② enabled 参数收口（boolean 不再 500）', () => {
  it('{ enabled: true } → 200 且落库为 1（此前 better-sqlite3 绑定 boolean 直接炸）', async () => {
    const res = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${pluginId}/toggle`,
      headers: authHeader(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    expect(storedEnabled(pluginId)).toBe(1);
  });

  it('{ enabled: false } → 200 且落库为 0', async () => {
    const res = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${pluginId}/toggle`,
      headers: authHeader(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(storedEnabled(pluginId)).toBe(0);
  });

  it('{ enabled: 1 } / { enabled: 0 } → 200（数字是原本就支持的形态）', async () => {
    for (const [payload, expected] of [
      [{ enabled: 1 }, 1],
      [{ enabled: 0 }, 0],
    ] as const) {
      const res = await bundle.app.inject({
        method: 'PUT',
        url: `/api/strategy/plugins/${pluginId}/toggle`,
        headers: authHeader(),
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(storedEnabled(pluginId)).toBe(expected);
    }
  });

  it('非法 enabled → 400 PARAM_INVALID（不是 500），且响应体仍是统一 envelope', async () => {
    for (const bad of [{ enabled: 'yes' }, { enabled: 2 }, {}]) {
      const res = await bundle.app.inject({
        method: 'PUT',
        url: `/api/strategy/plugins/${pluginId}/toggle`,
        headers: authHeader(),
        payload: bad,
      });
      expect(res.statusCode, `${JSON.stringify(bad)} 应回 400`).toBe(400);
      expectFailEnvelope(JSON.parse(res.body), res.statusCode, 'PARAM_INVALID');
    }
  });

  it('完全没有 body → 400 PARAM_INVALID（不是 500 的解构异常）', async () => {
    const res = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${pluginId}/toggle`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expectFailEnvelope(JSON.parse(res.body), res.statusCode, 'PARAM_INVALID');
  });
});

describe('插件 config · params 校验与 envelope', () => {
  it('{ params: {} } → 200', async () => {
    const res = await bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${pluginId}/config`,
      headers: authHeader(),
      payload: { params: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
  });

  it('params 不是对象 → 400 PARAM_INVALID（统一 envelope）', async () => {
    for (const bad of [{ params: 'oops' }, { params: [] }, { params: null }, {}]) {
      const res = await bundle.app.inject({
        method: 'PUT',
        url: `/api/strategy/plugins/${pluginId}/config`,
        headers: authHeader(),
        payload: bad,
      });
      expect(res.statusCode, `${JSON.stringify(bad)} 应回 400`).toBe(400);
      expectFailEnvelope(JSON.parse(res.body), res.statusCode, 'PARAM_INVALID');
    }
  });
});
