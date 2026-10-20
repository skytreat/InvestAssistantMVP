import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { hashPassword, verifyPassword, signToken } from '../services/auth.js';
import { writeSystemLog } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * Auth routes —— Phase 3 T25 前置依赖 + T57（register / refresh）
 *
 * 公开路由（无需鉴权，SDD §4.4 鉴权列 =「否」）：
 *   POST /api/auth/login    → { token, refresh_token, user }
 *   POST /api/auth/register → 首个用户自动 admin；其后仅 admin 可建号且强制 role='user'
 *   POST /api/auth/refresh  → refresh token（30d）换新的 access + **轮换后的** refresh
 *   POST /api/auth/seed     → 创建用户。⚠️ 公开路由，admin 角色仅"系统第一个用户"
 *                            可获得（库中已有用户时请求 admin → 403 ADMIN_ALREADY_EXISTS），
 *                            后续管理员变动走 PATCH /api/admin/users/:id/role
 *
 * ⚠️ **当前 routes/index.ts 的 PUBLIC_ROUTES 白名单里没有 register / refresh**，
 *    全局 onRequest 钩子会对它们要 Bearer token（无 token → 401 NO_TOKEN）。
 *    因此「匿名注册首个用户」与「access 过期后用 refresh 换新」这两条路径**当前不可达**，
 *    需在 index.ts 的 PUBLIC_ROUTES 补这两项才能打通（不在本次改动范围内，见汇报）。
 */

/** access token 由 services/auth.ts 签发，TTL 7d（SDD S4）；refresh 30d（SDD §4.4 / S4） */
const REFRESH_TTL_SEC = 30 * 24 * 60 * 24;

/** 与 DDL 的 CHECK(length(username) >= 3 AND length(username) <= 32) 对齐（configStore.ts:17） */
const USERNAME_MIN_LEN = 3;
const USERNAME_MAX_LEN = 32;

/** refresh token 落库的新列（幂等 ALTER，见 ensureRefreshTokenColumns） */
const REFRESH_COLUMNS: Record<string, string> = {
  refresh_token_hash: 'TEXT',
  refresh_token_expires_at: 'INTEGER',
  refresh_token_rotated_at: 'TEXT',
};

interface AuthenticatedUser {
  sub: number;
  username: string;
  role: 'user' | 'admin';
}

interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
}

/** 全局 onRequest 钩子把 JWT payload 挂在 request.user 上；未鉴权路由上不存在 */
function currentUser(request: FastifyRequest): AuthenticatedUser | null {
  const user = (request as FastifyRequest & { user?: AuthenticatedUser }).user;
  return user ?? null;
}

/**
 * 幂等补齐 user_account 的 refresh token 列（T57）
 *
 * AGENTS.md「DDL 变更判据」：**只加列 → ALTER TABLE ADD COLUMN**（先 PRAGMA table_info 判存在）。
 * 三列全部可空、无 CHECK / 无 UNIQUE，因此**不需要**走幂等表重建
 * （重建要改 configStore.ts，而 configStore.ts 不在本次可改范围内）。
 * 失败只记日志不阻塞启动 —— 与 configStore 里 _ensureTradeRecordReviewColumns 同款处理。
 */
export function ensureRefreshTokenColumns(db: ConfigStore['db']): void {
  try {
    const cols = (db.prepare('PRAGMA table_info(user_account)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    const missing = Object.keys(REFRESH_COLUMNS).filter((c) => !cols.includes(c));
    if (missing.length === 0) return;

    for (const col of missing) {
      db.exec(`ALTER TABLE user_account ADD COLUMN ${col} ${REFRESH_COLUMNS[col]}`);
    }
    console.log(`[auth] user_account 补齐列 ${missing.join(', ')}`);
  } catch (err) {
    console.error('[auth] refresh token 列补齐失败（不阻塞启动）:', err);
  }
}

function newRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 只存哈希，绝不落明文（AGENTS.md 安全约束：禁止 token 明文日志 / 存储） */
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

/** 定长比较防时序攻击 */
function equalHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 签发一对 token：access（7d，services/auth.ts）+ refresh（30d，落库哈希）
 *
 * 单活跃会话模型：同一用户再次登录会覆盖上一枚 refresh token（上一枚立即失效）。
 * MVP 桌面单用户场景可接受，换来的是「一个用户最多一枚有效 refresh」这条好审计的性质。
 */
function issueSession(db: ConfigStore['db'], user: { id: number; username: string; role: 'user' | 'admin' }) {
  const refreshToken = newRefreshToken();
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TTL_SEC;

  db.prepare(
    `UPDATE user_account
        SET refresh_token_hash = ?, refresh_token_expires_at = ?, refresh_token_rotated_at = ?
      WHERE id = ?`,
  ).run(hashRefreshToken(refreshToken), expiresAt, new Date().toISOString(), user.id);

  return {
    token: signToken({ sub: user.id, username: user.username, role: user.role }),
    refresh_token: refreshToken,
    refresh_token_expires_at: expiresAt,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

/**
 * 注册角色裁决（纯函数，便于单测覆盖越权矩阵）
 *
 * SDD §4.4「首个注册自动 admin」+ plan T57「其后仅 admin 可建号或强制 role='user'」：
 *   - 匿名 + 库里 0 用户   → admin（唯一 bootstrap 路径）
 *   - 匿名 + 库里已有用户 → 403（bootstrap 已关闭）
 *   - 普通用户调用        → 403（无论请求什么角色）
 *   - admin 调用 + 请求 admin → 403（管理员转让走 PATCH /api/admin/users/:id/role，注册入口不造 admin）
 *   - admin 调用 + 请求 user  → 强制 user
 */
export function resolveRegisterRole(input: {
  callerRole: 'user' | 'admin' | null;
  userCount: number;
  requestedRole: 'user' | 'admin';
}): { ok: true; role: 'user' | 'admin' } | { ok: false; status: 403; error: string; message: string } {
  const { callerRole, userCount, requestedRole } = input;

  if (callerRole === null) {
    if (userCount === 0) return { ok: true, role: 'admin' };
    return {
      ok: false,
      status: 403,
      error: 'REGISTRATION_CLOSED',
      message: `系统已有 ${userCount} 个用户，匿名注册入口已关闭。后续建号请用 admin 登录后调用本接口。`,
    };
  }

  if (callerRole !== 'admin') {
    return { ok: false, status: 403, error: 'FORBIDDEN', message: '仅 admin 可创建账号' };
  }

  if (requestedRole === 'admin') {
    return {
      ok: false,
      status: 403,
      error: 'ADMIN_ALREADY_EXISTS',
      message: '注册入口不允许创建 admin。已有 admin 请用 PATCH /api/admin/users/:id/role 转让。',
    };
  }

  return { ok: true, role: 'user' };
}

export async function registerAuthRoutes(app: FastifyInstance) {
  ensureRefreshTokenColumns(ConfigStore.getInstance().db);

  app.post('/api/auth/login', async (request, reply) => {
    try {
      const body = request.body as { username?: string; password?: string };
      if (!body?.username || !body?.password) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '用户名和密码不能为空'));
      }
      const db = ConfigStore.getInstance().db;
      const row = db
        .prepare('SELECT id, username, password_hash, role FROM user_account WHERE username = ?')
        .get(body.username) as AccountRow | undefined;

      if (!row || !verifyPassword(body.password, row.password_hash)) {
        return reply.code(401).send(fail(401, 'UNAUTHORIZED', '用户名或密码错误'));
      }
      const session = issueSession(db, row);
      reply.send(ok(session));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * POST /api/auth/register（T57）
   *
   * body: { username, password, role? }
   *   - 首个用户（匿名 + 库空）→ 自动 admin
   *   - 其后：仅 admin 可建号，且强制 role='user'
   */
  app.post('/api/auth/register', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { username?: string; password?: string; role?: string };
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password.trim() : '';
      const requestedRole = body.role ?? 'user';

      if (username.length < USERNAME_MIN_LEN || username.length > USERNAME_MAX_LEN) {
        return reply
          .code(400)
          .send(fail(400, 'PARAM_INVALID', `username 长度需在 ${USERNAME_MIN_LEN}~${USERNAME_MAX_LEN} 之间`));
      }
      if (password.length === 0) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '密码不能为空'));
      }
      if (requestedRole !== 'user' && requestedRole !== 'admin') {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'role 只能是 user 或 admin'));
      }

      const db = ConfigStore.getInstance().db;
      const caller = currentUser(request);

      const existing = db.prepare('SELECT id FROM user_account WHERE username = ?').get(username);
      if (existing) {
        return reply.code(409).send(fail(409, 'INTERNAL_ERROR', `用户 ${username} 已存在`));
      }

      // 角色裁决 + INSERT 放进同一个事务，避免「判定首用户」与「插入」之间的竞态
      const createUser = db.transaction((): { id: number; role: 'user' | 'admin' } => {
        const userCount = (db.prepare('SELECT COUNT(*) AS c FROM user_account').get() as { c: number }).c;
        const outcome = resolveRegisterRole({
          callerRole: caller?.role ?? null,
          userCount,
          requestedRole: requestedRole as 'user' | 'admin',
        });
        if (!outcome.ok) {
          // 借 throw 把裁决结果带出事务（better-sqlite3 事务体会自动 ROLLBACK）
          throw new RegisterRejected(outcome);
        }
        const info = db
          .prepare('INSERT INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
          .run(username, hashPassword(password), outcome.role);
        return { id: Number(info.lastInsertRowid), role: outcome.role };
      });

      let created: { id: number; role: 'user' | 'admin' };
      try {
        created = createUser();
      } catch (err) {
        if (err instanceof RegisterRejected) {
          return reply.code(err.outcome.status).send({
            success: false,
            error: err.outcome.error,
            message: err.outcome.message,
          });
        }
        throw err;
      }

      writeSystemLog({
        logType: 'startup',
        level: 'INFO',
        message: `注册用户 ${username}`,
        detail: `role=${created.role} by=${caller ? caller.username : 'anonymous'}`,
      });

      const session = issueSession(db, { id: created.id, username, role: created.role });
      return reply.code(201).send(ok(session));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * POST /api/auth/refresh（T57）
   *
   * body: { refresh_token }（兼容 camelCase 的 refreshToken）
   * 校验通过 → 换新的 access（7d）+ **轮换**后的 refresh（30d）
   * 轮换是单条 UPDATE 覆盖同一行 → 旧 refresh 立即失效（不需要额外的黑名单表）
   */
  app.post('/api/auth/refresh', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { refresh_token?: string; refreshToken?: string };
      const presented = (body.refresh_token ?? body.refreshToken ?? '').trim();
      if (presented.length === 0) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'refresh_token 不能为空'));
      }

      const db = ConfigStore.getInstance().db;
      const presentedHash = hashRefreshToken(presented);
      const row = db
        .prepare(
          `SELECT id, username, role, refresh_token_hash, refresh_token_expires_at
           FROM user_account WHERE refresh_token_hash = ?`,
        )
        .get(presentedHash) as
        | {
            id: number;
            username: string;
            role: 'user' | 'admin';
            refresh_token_hash: string | null;
            refresh_token_expires_at: number | null;
          }
        | undefined;

      const invalid = () => reply.code(401).send(fail(401, 'UNAUTHORIZED', 'refresh token 无效或已过期'));

      if (!row) return invalid();
      if (!row.refresh_token_hash || !equalHex(row.refresh_token_hash, presentedHash)) return invalid();
      if (
        typeof row.refresh_token_expires_at !== 'number' ||
        row.refresh_token_expires_at < Math.floor(Date.now() / 1000)
      ) {
        return invalid();
      }

      // 轮换：单条 UPDATE 覆盖 → 旧 token 立即失效
      const session = issueSession(db, { id: row.id, username: row.username, role: row.role });
      const stillSame = db.prepare('SELECT refresh_token_hash FROM user_account WHERE id = ?').get(row.id) as
        { refresh_token_hash: string | null } | undefined;
      if (!stillSame?.refresh_token_hash || equalHex(stillSame.refresh_token_hash, presentedHash)) {
        return reply.code(500).send(fail(500, 'INTERNAL_ERROR', 'refresh token 轮换失败'));
      }

      return reply.send(ok(session));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  app.post('/api/auth/seed', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { username?: string; password?: string; role?: 'user' | 'admin' };
      const username = body.username ?? 'admin';
      const requestedRole = body.role ?? 'admin';

      // P1-3 Seed 硬编码密码加固：
      // - production 强制 body.password 必填，禁止默认 'admin123'
      // - 开发环境保留默认值方便本地调试
      const isProd = process.env.NODE_ENV === 'production';
      let password: string;
      if (body.password?.trim()) {
        password = body.password.trim();
      } else if (isProd) {
        return reply
          .code(400)
          .send(fail(400, 'SEED_PASSWORD_REQUIRED', '生产环境必须显式提供初始密码，禁止硬编码默认值'));
      } else {
        password = 'admin123'; // 仅开发环境兜底
      }

      if (requestedRole !== 'user' && requestedRole !== 'admin') {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'role 只能是 user 或 admin'));
      }

      const db = ConfigStore.getInstance().db;

      if (requestedRole === 'admin') {
        const userCount = (db.prepare('SELECT COUNT(*) AS c FROM user_account').get() as { c: number }).c;
        if (userCount > 0) {
          // 安全硬约束：本路由是公开路由（bootstrap 用），一旦库里有用户，
          // 任何能访问 8080 的人都能自建 admin 账号 = 权限全面失守。
          // 因此 admin 只允许"系统里的第一个用户"拿到。
          return reply
            .code(403)
            .send(
              fail(
                403,
                'ADMIN_ALREADY_EXISTS',
                `系统已有 ${userCount} 个用户，不允许再创建 admin。已有 admin 请用 PATCH /api/admin/users/:id/role 转让。`,
              ),
            );
        }
      }

      const existing = db.prepare('SELECT id FROM user_account WHERE username = ?').get(username);
      if (existing) {
        return reply.code(409).send(fail(409, 'INTERNAL_ERROR', `用户 ${username} 已存在`));
      }
      const role = requestedRole;
      const hash = hashPassword(password);
      const info = db
        .prepare('INSERT INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
        .run(username, hash, role);
      writeSystemLog({
        logType: 'startup',
        level: 'INFO',
        message: `创建用户 ${username}`,
        detail: `role=${role}`,
      });
      const token = signToken({ sub: Number(info.lastInsertRowid), username, role });
      reply.code(201).send(ok({ user: { id: info.lastInsertRowid, username, role }, token }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}

/** 事务内抛出、把「角色裁决拒绝」带出 db.transaction 闭包（better-sqlite3 会自动 ROLLBACK） */
class RegisterRejected extends Error {
  constructor(public readonly outcome: { status: 403; error: string; message: string }) {
    super(outcome.message);
    this.name = 'RegisterRejected';
  }
}
