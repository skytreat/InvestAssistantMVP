/**
 * T57 鉴权补 register + refresh
 *
 * 覆盖 src/routes/auth.ts：
 *   - resolveRegisterRole 越权矩阵（纯函数，6 组合）
 *   - POST /api/auth/register（首个用户 admin / 其后仅 admin 建号 / 强制 role=user）
 *   - POST /api/auth/refresh（access 7d + refresh 30d 双 token；轮换后旧 refresh 立即失效）
 *
 * 测试用 Fastify 实例复刻 routes/index.ts 鉴权钩子的「挂 request.user」语义，
 * 但**刻意放行 register / refresh**：auth.ts:18-22 已注明 index.ts 的 PUBLIC_ROUTES
 * 当前未放行这两个路径（index.ts 不在本任务可改范围），不放开则匿名注册用例
 * 无法触达路由内部的角色裁决逻辑。
 *
 * SQLite 隔离：register/refresh 会经 issueSession / writeSystemLog 打开 ConfigStore，
 * 用 mkdtempSync 覆盖 SQLITE_DB_PATH（与 t55 测试同款范式）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t57-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't57.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const {
  registerAuthRoutes,
  resolveRegisterRole,
} = await import('../../src/routes/auth.js');
const { signToken, verifyToken, extractToken } = await import('../../src/services/auth.js');

afterAll(() => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface SessionShape {
  token: string;
  refresh_token: string;
  refresh_token_expires_at: number;
  user: { id: number; username: string; role: 'user' | 'admin' };
}

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  // ⚠️ 必须是 async：Fastify v5 的 hook runner 只在 hook 返回 thenable
  //    （或使用 3 参数 done 回调）时才继续；同步 hook 会让请求永远挂起，
  //    表现为 app.inject() 永不 resolve。生产代码 routes/index.ts:29 同款。
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

async function freshApp(): Promise<FastifyInstance> {
  const app = makeApp();
  await registerAuthRoutes(app);
  await app.ready();
  return app;
}

function tokenFor(sub: number, username: string, role: 'user' | 'admin'): string {
  return signToken({ sub, username, role });
}

async function registerRaw(
  app: FastifyInstance,
  body: { username?: string; password?: string; role?: string },
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: body });
  return { status: res.statusCode, body: res.json() };
}

/**
 * 造一个已注册用户，返回 register 的原始响应。
 *
 * ⚠️ `token` 参数不可省：本测试文件里 ConfigStore 是单例、SQLITE_DB_PATH 指向
 * 同一个临时库，所以前一个 describe 注册的用户对后一个 describe 可见 ——
 * 库已有用户后**匿名注册会被正确地拒绝（403 REGISTRATION_CLOSED）**。
 * 因此需要「建号」的用例必须带 admin token 走「admin 建号」路径。
 */
async function registerUser(
  username: string,
  password = 'pw-default-123',
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = await freshApp();
  try {
    return await registerRaw(app, { username, password }, token);
  } finally {
    await app.close();
  }
}

/** 首个注册用户即 admin；此处用它造一个可建号的 admin token。 */
function bootstrapAdminToken(): string {
  return tokenFor(1, 'alice_admin', 'admin');
}

// ── T81：以下三个用例的前提与「同文件其它用例是否跑过」相关，
//    打乱用例顺序时会互相打架（bootstrap 用例要求库空、403 用例要求库非空、
//    409 用例要求同名用户已存在）→ 各自自带前置，不依赖执行顺序。
/** 清空 user_account（本用例要求「库空」） */
function resetUserTable(): void {
  ConfigStore.getInstance().db.prepare('DELETE FROM user_account').run();
}

/** 保证库里至少有一个用户（匿名注册在库非空时返回 403 REGISTRATION_CLOSED） */
function ensureUserExists(username: string): void {
  ConfigStore.getInstance().db
    .prepare(`INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, 'dummy-hash', 'admin')`)
    .run(username);
}

async function refreshRaw(
  app: FastifyInstance,
  refreshToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    payload: { refresh_token: refreshToken },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('T57 — resolveRegisterRole 越权矩阵（纯函数）', () => {
  it('匿名 + 库空 → admin（bootstrap 唯一路径）', () => {
    const r = resolveRegisterRole({ callerRole: null, userCount: 0, requestedRole: 'admin' });
    expect(r).toEqual({ ok: true, role: 'admin' });
  });

  it('匿名 + 库空 + 请求 user → 仍给 admin（首用户必须是管理员）', () => {
    const r = resolveRegisterRole({ callerRole: null, userCount: 0, requestedRole: 'user' });
    expect(r).toEqual({ ok: true, role: 'admin' });
  });

  it('匿名 + 库已有用户 → 403 REGISTRATION_CLOSED', () => {
    const r = resolveRegisterRole({ callerRole: null, userCount: 1, requestedRole: 'user' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.error).toBe('REGISTRATION_CLOSED');
  });

  it('普通用户调用 → 403 FORBIDDEN（无论请求什么角色）', () => {
    for (const requestedRole of ['user', 'admin'] as const) {
      const r = resolveRegisterRole({ callerRole: 'user', userCount: 1, requestedRole });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.status).toBe(403);
      expect(r.error).toBe('FORBIDDEN');
    }
  });

  it('admin 请求 admin → 403 ADMIN_ALREADY_EXISTS（转让走 PATCH role 接口）', () => {
    const r = resolveRegisterRole({ callerRole: 'admin', userCount: 1, requestedRole: 'admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.error).toBe('ADMIN_ALREADY_EXISTS');
  });

  it('admin 请求 user → 强制 user', () => {
    const r = resolveRegisterRole({ callerRole: 'admin', userCount: 1, requestedRole: 'user' });
    expect(r).toEqual({ ok: true, role: 'user' });
  });
});


describe('T57 — POST /api/auth/register 路由级越权用例', () => {
let app: FastifyInstance;
beforeAll(async () => {     app =
await freshApp();
});
afterAll(async () => {
await app.close();
});
 it('空库匿名注册首个用户 → 201 且 role=admin', async () => {
 // T81：本用例的前提是「库空」，自己清库，不依赖其它用例的执行顺序
 resetUserTable();
 const { status, body } =
 await registerRaw(app, { username: 'alice_admin', password: 'pw-alice-1'
 });
 expect(status).toBe(201);
 expect(body.success).toBe(true);
 const data = body.data as SessionShape;
 expect(data.user.role).toBe('admin');
 expect(typeof data.token).toBe('string');
 expect(typeof data.refresh_token).toBe('string');
 });
 it('库已有用户后匿名注册 → 403 REGISTRATION_CLOSED', async () => {
 // T81：自己保证「库非空」，不依赖 bootstrap 用例跑过
 ensureUserExists('t57_seed_user');
 const { status, body } =
 await registerRaw(app, { username: 'mallory', password: 'pw-mallory-1'
 });
 expect(status).toBe(403);
 expect(body.error).toBe('REGISTRATION_CLOSED');
 });
it('普通用户 token 注册 → 403 FORBIDDEN', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const created =
await registerRaw(app, { username: 'bob_user', password: 'pw-bob-123' }, adminToken);
expect(created.status).toBe(201);
const userToken = tokenFor((created.body.data as SessionShape).user.id, 'bob_user', 'user');
const { status, body } =
await registerRaw(app, { username: 'mallory2', password: 'pw-mallory2' }, userToken);
expect(status).toBe(403);
expect(body.error).toBe('FORBIDDEN');
});
it('admin token 请求 admin → 403 ADMIN_ALREADY_EXISTS', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const { status, body } =
await registerRaw(       app,       { username: 'mallory3', password: 'pw-mallory3', role: 'admin' },       adminToken,     );
expect(status).toBe(403);
expect(body.error).toBe('ADMIN_ALREADY_EXISTS');
});
it('admin token 请求 user → 201 且 role 被强制为 user', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const { status, body } =
await registerRaw(       app,       { username: 'carol_user', password: 'pw-carol-12', role: 'user' },       adminToken,     );
expect(status).toBe(201);
expect((body.data as SessionShape).user.role).toBe('user');
});
it('admin token 请求 user 但传 role=admin → 仍 403（注册入口不造 admin）', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const { status, body } =
await registerRaw(       app,       { username: 'mallory4', password: 'pw-mallory4', role: 'admin' },       adminToken,     );
expect(status).toBe(403);
expect(body.error).toBe('ADMIN_ALREADY_EXISTS');
});
it('用户名 < 3 字符 / > 32 字符 → 400 PARAM_INVALID', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const short =
await registerRaw(app, { username: 'ab', password: 'pw-short-1' }, adminToken);
expect(short.status).toBe(400);
expect(short.body.error).toBe('PARAM_INVALID');
const long =
await registerRaw(app, { username: 'x'.repeat(33), password: 'pw-long-12' }, adminToken);
expect(long.status).toBe(400);
expect(long.body.error).toBe('PARAM_INVALID');
});
it('空密码 → 400 PARAM_INVALID', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const { status, body } =
await registerRaw(app, { username: 'mallory5', password: '  ' }, adminToken);
expect(status).toBe(400);
expect(body.error).toBe('PARAM_INVALID');
});
 it('重复用户名 → 409', async () => {
 const adminToken = tokenFor(1, 'alice_admin', 'admin');
 // T81：自带前置 —— 先建一个同名用户再重试，不依赖 bootstrap 用例跑过
 const seeded = await registerRaw(app, { username: 'dup_user_t57', password: 'pw-dup-seed-1' }, adminToken);
 expect(seeded.status).toBe(201);
 const { status } =
 await registerRaw(app, { username: 'dup_user_t57', password: 'pw-dup-1234' }, adminToken);
 expect(status).toBe(409);
 });
it('非法 role 值 → 400 PARAM_INVALID', async () => {
const adminToken = tokenFor(1, 'alice_admin', 'admin');
const { status, body } =
await registerRaw(       app,       { username: 'mallory6', password: 'pw-mallory6', role: 'superadmin' },       adminToken,     );
expect(status).toBe(400);
expect(body.error).toBe('PARAM_INVALID');
});
});
describe('T57 — POST /api/auth/refresh 双 token + 轮换', () => {
let app: FastifyInstance;
beforeAll(async () => {     app =
await freshApp();
});
afterAll(async () => {
await app.close();
});
it('refresh token 落库为哈希（不是明文），且 refresh 成功签发新 access + 新 refresh', async () => {
const created =
await registerUser('dave_refresh', 'pw-default-123', bootstrapAdminToken());
expect(created.status).toBe(201);
const session = created.body.data as SessionShape;
const db = ConfigStore.getInstance().db;
const row = db.prepare(       'SELECT refresh_token_hash, refresh_token_expires_at FROM user_account WHERE username = ?',     ).get('dave_refresh') as { refresh_token_hash: string | null; refresh_token_expires_at: number | null };
expect(row.refresh_token_hash).not.toBeNull();
expect(row.refresh_token_hash).not.toBe(session.refresh_token); // 禁止明文落库
expect(row.refresh_token_expires_at).toBe(session.refresh_token_expires_at);
const { status, body } =
await refreshRaw(app, session.refresh_token);
expect(status).toBe(200);
expect(body.success).toBe(true);
const rotated = body.data as SessionShape;      // 新 access token 有效（7d，由 services/auth.ts 签发）
const payload = verifyToken(rotated.token);
expect(payload).not.toBeNull();
expect(payload!.username).toBe('dave_refresh');     // 新 refresh token 与旧的不同
expect(rotated.refresh_token).not.toBe(session.refresh_token);
expect(rotated.refresh_token_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
});
it('轮换：旧 refresh token 立即失效 → 再调 refresh 返回 401', async () => {
const created =
await registerRaw(app, { username: 'erin_rotate2', password: 'pw-erin2-xx' }, bootstrapAdminToken()
);
const session = (created.body as { data: SessionShape
}).data;
const first =
await refreshRaw(app, session.refresh_token);
expect(first.status).toBe(200);      // 旧 token 立即失效（轮换语义的核心断言）
const second =
await refreshRaw(app, session.refresh_token);
expect(second.status).toBe(401);
expect(second.body.error).toBe('UNAUTHORIZED');      // 库里存的是轮换后的新 hash，旧 hash 已不存在
const crypto =
await import('node:crypto');
const db = ConfigStore.getInstance().db;
const row = db.prepare('SELECT refresh_token_hash FROM user_account WHERE username = ?').get('erin_rotate2') as       | { refresh_token_hash: string | null }       | undefined;
expect(row?.refresh_token_hash).toBeTruthy();
const oldHash = crypto.createHash('sha256').update(session.refresh_token, 'utf-8').digest('hex');
expect(row!.refresh_token_hash).not.toBe(oldHash);
});
it('轮换后的新 refresh token 可继续换（新 token 仍有效）', async () => {
const created =
await registerRaw(app, { username: 'frank_chain', password: 'pw-frank-xx1' }, bootstrapAdminToken()
);
const session = (created.body as { data: SessionShape
}).data;
const first =
await refreshRaw(app, session.refresh_token);
expect(first.status).toBe(200);
const rotated = (first.body as { data: SessionShape
}).data;
const second =
await refreshRaw(app, rotated.refresh_token);
expect(second.status).toBe(200);
const rotated2 = (second.body as { data: SessionShape
}).data;
expect(rotated2.refresh_token).not.toBe(rotated.refresh_token);
});
it('不存在的 refresh token → 401 UNAUTHORIZED', async () => {
const { status, body } =
await refreshRaw(app, 'totally-made-up-token-value');
expect(status).toBe(401);
expect(body.error).toBe('UNAUTHORIZED');
});
it('篡改 refresh token → 401', async () => {
const created =
await registerRaw(app, { username: 'grace_tamper', password: 'pw-grace-xx1' }, bootstrapAdminToken()
);
const session = (created.body as { data: SessionShape
}).data;
const tampered = `${session.refresh_token.slice(0, -2)}XY`;
const { status } =
await refreshRaw(app, tampered);
expect(status).toBe(401);
});
it('空 refresh_token → 400 PARAM_INVALID', async () => {
const { status, body } =
await refreshRaw(app, '   ');
expect(status).toBe(400);
expect(body.error).toBe('PARAM_INVALID');
});
it('过期的 refresh token（手工回拨 expires_at）→ 401', async () => {
const created =
await registerRaw(app, { username: 'heidi_expired', password: 'pw-heidi-xx1' }, bootstrapAdminToken()
);
const session = (created.body as { data: SessionShape
}).data;
const db = ConfigStore.getInstance().db;     db.prepare('UPDATE user_account SET refresh_token_expires_at = ? WHERE username = ?')       .run(Math.floor(Date.now() / 1000) - 1, 'heidi_expired');
const { status, body } =
await refreshRaw(app, session.refresh_token);
expect(status).toBe(401);
expect(body.error).toBe('UNAUTHORIZED');
});
it('同一用户再次登录覆盖旧 refresh（单活跃会话）：旧 token 立即失效', async () => {
const created =
await registerRaw(app, { username: 'ivan_single', password: 'pw-ivan-xxx1' }, bootstrapAdminToken()
);
const firstSession = (created.body as { data: SessionShape
}).data;      // login 也会走 issueSession → 覆盖同一行的 refresh_token_hash
const loginRes =
await app.inject({       method: 'POST',       url: '/api/auth/login',       payload: { username: 'ivan_single', password: 'pw-ivan-xxx1' },
});
expect(loginRes.statusCode).toBe(200);
const secondSession = (loginRes.json() as { data: SessionShape
}).data;
expect(secondSession.refresh_token).toBeTruthy();      // 第一枚 refresh 不再有效（库里已被第二枚覆盖）
const stale =
await refreshRaw(app, firstSession.refresh_token);
expect(stale.status).toBe(401);      // 当前有效的那枚仍可换
const live =
await refreshRaw(app, secondSession.refresh_token);
expect(live.status).toBe(200);
});
});
describe('T57 — refresh 列幂等补齐（ensureRefreshTokenColumns 经 registerAuthRoutes 触发）', () => {
it('新库启动后 user_account 具备三个 refresh 列（无 DEFAULT / 无 CHECK，不需表重建）', async () => {
const app =
await freshApp();
try {
const db = ConfigStore.getInstance().db;
const cols = (db.prepare('PRAGMA table_info(user_account)').all() as { name: string }[])         .map((c) => c.name);       for (const col of ['refresh_token_hash', 'refresh_token_expires_at', 'refresh_token_rotated_at']) {
expect(cols).toContain(col);
}
} finally {
await app.close();
}
});
});
