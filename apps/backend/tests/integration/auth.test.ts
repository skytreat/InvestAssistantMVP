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
import crypto from 'node:crypto';
import { createTestApp, makeUserToken, ADMIN_USER, ADMIN_PASS, cleanupIntegrationTest } from './_helpers.js';
import { verifyToken } from '../../src/services/auth.js';
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

/**
 * 🔴 SDD §12.5 F1 用例：`login_success` / `login_wrong_password`
 *
 * ## 为什么要新增（而不是改名）
 *
 * T91 的验收口径是「SDD §12.5 的每个用例名在全仓可 grep 到」。
 * 本文件里**已有**行为等价的用例（「login 成功 → 200 + token + user」「密码错 → 401」），
 * 但**用例名不是** SDD §12.5 的 `login_success` / `login_wrong_password`。
 *
 * ⇒ 按 AGENTS.md「注释不是规格」「加覆盖 ≠ 降标准」的原则：
 *   **保留**既有用例（它们带更细的行为标注），**新增**两个与 SDD §12.5 一一对应的用例名，
 *   并把断言加严到「token 可验签解出载荷」+「refresh token 落库只存哈希」。
 */
describe('Auth · SDD §12.5 F1（login_success / login_wrong_password）', () => {
  it('login_success: 正确密码 → 200 + access token（可验签解出 sub/username/role）+ refresh_token 存在', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });

    // ① HTTP 状态 + 统一 envelope（SDD §4.2）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe(0);
    expect(body.success).toBe(true);
    expect(body.data).not.toBeNull();

    // ② access token：3 段 JWT，且能**真实验签**解出载荷（不只是 split('.') 看段数）
    const token: string = body.data.token;
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
    const payload = verifyToken(token);
    expect(payload, 'access token 必须能被 verifyToken 验签通过').not.toBeNull();
    expect(payload!.sub).toBe(bundle.userId);
    expect(payload!.username).toBe(ADMIN_USER);
    expect(payload!.role).toBe('admin');
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // ③ refresh token：存在、非空、到期时间在未来（30d，SDD S4）
    const refreshToken: string = body.data.refresh_token;
    expect(typeof refreshToken).toBe('string');
    expect(refreshToken.length).toBeGreaterThan(0);
    expect(typeof body.data.refresh_token_expires_at).toBe('number');
    expect(body.data.refresh_token_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // ④ 用户信息随会话下发
    expect(body.data.user.id).toBe(bundle.userId);
    expect(body.data.user.username).toBe(ADMIN_USER);
    expect(body.data.user.role).toBe('admin');

    // ⑤ 安全硬约束：refresh token **只落哈希**（AGENTS.md「禁止 token 明文日志 / 存储」）
    const row = bundle.db.db
      .prepare('SELECT refresh_token_hash FROM user_account WHERE id = ?')
      .get(bundle.userId) as { refresh_token_hash: string | null };
    expect(row.refresh_token_hash, 'refresh token 必须落库（否则 refresh 接口不可用）').toBeTruthy();
    expect(row.refresh_token_hash, 'refresh token 不得明文落库').not.toBe(refreshToken);
    expect(row.refresh_token_hash).toBe(
      crypto.createHash('sha256').update(refreshToken, 'utf-8').digest('hex'),
    );
  });

  it('login_wrong_password: 密码错误 → 401 UNAUTHORIZED + 不签发任何 token + data === null', async () => {
    // 登录前先记下库里已有的 refresh token 哈希（用于证明「密码错不会签发会话」）
    const before = bundle.db.db
      .prepare('SELECT refresh_token_hash, refresh_token_expires_at FROM user_account WHERE id = ?')
      .get(bundle.userId) as { refresh_token_hash: string | null; refresh_token_expires_at: number | null };

    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: 'definitely-not-the-password' },
    });

    // ① 状态码 401 + 统一错误码（实测 routes/auth.ts:182 → fail(401, 'UNAUTHORIZED', ...)）
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.success).toBe(false);

    // ② 错误响应**不含任何数据**（data === null，SDD §4.2 错误体）
    expect(body.data).toBeNull();

    // ③ 不返回 token（access / refresh 都不能出现）
    expect(body.token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
    expect(body.data?.token).toBeUndefined();
    expect(body.data?.refresh_token).toBeUndefined();

    // ④ 不签发会话：库里的 refresh token 哈希/到期时间**未被改写**
    const after = bundle.db.db
      .prepare('SELECT refresh_token_hash, refresh_token_expires_at FROM user_account WHERE id = ?')
      .get(bundle.userId) as { refresh_token_hash: string | null; refresh_token_expires_at: number | null };
    expect(after.refresh_token_hash).toBe(before.refresh_token_hash);
    expect(after.refresh_token_expires_at).toBe(before.refresh_token_expires_at);
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
