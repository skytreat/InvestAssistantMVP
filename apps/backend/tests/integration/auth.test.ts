/**
 * auth.test.ts — API 集成测试（鉴权链路）
 *
 * 覆盖 SDD §12.4 auth 类：
 *   - login 200 / 401 密码错 / 401 用户不存在 / 400 缺字段
 *   - seed 201 新建 / 409 已存在
 *   - 无 token → 401 NO_TOKEN
 *   - 垃圾 token → 401 INVALID_TOKEN
 *   - 非 admin 走 admin 路由 → 403 FORBIDDEN
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, makeUserToken, ADMIN_USER, ADMIN_PASS, cleanupIntegrationTest } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
let userToken: string; // role=user（非 admin）

beforeAll(async () => {
  bundle = await createTestApp();
  // 在 user_account 里造一条普通用户（直接 INSERT 绕开 seed 的 409）
  const adminHash = bundle.db.db
    .prepare('SELECT password_hash FROM user_account WHERE username = ?')
    .get(ADMIN_USER) as { password_hash: string };
  bundle.db.db
    .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
    .run('int_normal', adminHash.password_hash, 'user');
  const row = bundle.db.db.prepare('SELECT id FROM user_account WHERE username = ?').get('int_normal') as {
    id: number;
  };
  userToken = makeUserToken(row.id, 'int_normal');
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
  cleanupIntegrationTest();
});

describe('Auth · login', () => {
  it('login 成功 → 200 + token + user', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.token).toBe('string');
    expect(body.data.token.split('.').length).toBe(3); // JWT 三段
    expect(body.data.user.username).toBe(ADMIN_USER);
    expect(body.data.user.role).toBe('admin');
  });

  it('密码错 → 401', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: 'wrong-pass' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).success).toBe(false);
  });

  it('用户不存在 → 401', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nope_not_exists', password: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('缺 username → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('缺 password → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Auth · seed', () => {
  it('新建用户 → 201 + token', async () => {
    const uniqueName = `seed_${Date.now()}`; // 唯一化避免残留污染
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: uniqueName, password: 'pwd', role: 'user' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.username).toBe(uniqueName);
    expect(body.data.token.split('.').length).toBe(3);
  });

  it('重复用户名 → 409', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: ADMIN_USER, password: 'x', role: 'user' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('role 非法 → 400', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: 'bad_role', password: 'x', role: 'super' as any },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Auth · /api/auth/seed 越权防护', () => {
  // 回归测试：seed 是公开路由（PUBLIC_ROUTES），曾经 role 默认 'admin'，
  // 导致任何能访问 8080 的人都能自建管理员账号。现在库中已有用户时拒绝 admin。
  it('库中已有用户时请求 role=admin → 403 ADMIN_ALREADY_EXISTS', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: `sneak_admin_${Date.now()}`, password: 'x1234567', role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ADMIN_ALREADY_EXISTS');
    expect(body.success).toBe(false);
  });

  it('不传 role（默认 admin）→ 同样 403，不会静默建成管理员', async () => {
    const name = `sneak_default_${Date.now()}`;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: name, password: 'x1234567' },
    });
    expect(res.statusCode).toBe(403);
    // 该用户根本没被创建
    const row = bundle.db.db.prepare('SELECT id FROM user_account WHERE username = ?').get(name);
    expect(row).toBeUndefined();
  });

  it('显式 role=user → 201 正常放行', async () => {
    const name = `plain_user_${Date.now()}`;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: name, password: 'x1234567', role: 'user' },
    });
    expect(res.statusCode).toBe(201);
    const row = bundle.db.db.prepare('SELECT role FROM user_account WHERE username = ?').get(name) as {
      role: string;
    };
    expect(row.role).toBe('user');
  });
});

describe('Auth · 鉴权 hook', () => {
  it('保护路由无 token → 401 NO_TOKEN', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/trade' });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('UNAUTHORIZED');
  });

  it('垃圾 token → 401 INVALID_TOKEN', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/trade',
      headers: { authorization: 'Bearer garbage.garbage.garbage' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('UNAUTHORIZED');
  });

  it('非法前缀（不带 Bearer）→ 401 NO_TOKEN', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/trade',
      headers: { authorization: bundle.adminToken }, // 没有 "Bearer " 前缀
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Auth · admin 路由权限', () => {
  it('非 admin 访问 /api/admin/* → 403 FORBIDDEN', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('FORBIDDEN');
  });

  it('admin 访问 /api/admin/* → 不返回 403（可能业务错但权限放行）', async () => {
    // DuckDB 可能慢，只测不被 403 拒绝
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(res.statusCode).not.toBe(403);
    // 更严格：期望 200 或 500（DuckDB 不存在），但不能是 403
    expect([200, 500]).toContain(res.statusCode);
  }, 30000);
});
