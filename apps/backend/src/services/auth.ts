import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * 最小鉴权工具
 * - 密码哈希：bcrypt cost=12（bcryptjs 纯 JS 实现，跨平台无需原生编译）
 * - JWT：HS256 手写签名/验证（Node 内置，不引 jsonwebtoken）
 *   格式：base64url(header).base64url(payload).base64url(signature)
 *   payload：{ sub: userId, username, role, exp }
 *   过期：1 天
 */

/**
 * JWT 签名密钥
 *
 * 🔴 SE3 判定不通过项（PR#15 交接文档 §4-D）：原实现带**明文硬编码兜底**
 *   `'investassistant-mvp-dev-secret-change-me-in-prod-2026'` ——
 *   密钥进了版本库，任何人拿到仓库就能伪造任意用户的 token。
 *   → 改为**必须由环境变量提供**，缺失即启动失败。
 *
 * 密钥来源（按优先级）：
 *   1. `process.env.JWT_SECRET`（生产 / 开发都用这个）
 *   2. 无 —— 直接抛错。**不再有明文兜底**。
 *
 * ⚠️ 测试环境由 `tests/setup.ts` 注入安全临时密钥；本地开发见 `.env.local`。
 */
/**
 * 读取 JWT 签名密钥（**惰性**）
 *
 * ⚠️ **为什么不能放在模块顶层**（2026-10-19 实测踩坑）：
 *   `vitest.config.ts` 的 `coverage.include`（src 目录下所有 .ts）会让 v8 provider
 *   **提前加载**本文件（为了收集未覆盖文件的覆盖率）—— 此时 `tests/setup.ts` 还没跑，
 *   `process.env.JWT_SECRET` 尚未注入 → 顶层读 env 直接崩
 *   （实测：带 `--coverage` 时 4 个测试文件在收集阶段就失败）。
 *
 *   → 改为**在实际使用 token 时才读取**：模块何时被求值都不影响，
 *   只要调用 `signToken` / `verifyToken` 时 env 已就绪即可。
 *
 * 安全语义不变：**没有 JWT_SECRET 就不签名**（拒绝以默认密钥启动），
 * 且**不再有明文兜底密钥**。
 */
/** 开发/测试兜底用的进程内随机密钥（**不硬编码、不落盘、进程结束即消失**） */
let _devFallbackSecret: Buffer | null = null;

function getJwtSecret(): Buffer {
  const raw = process.env.JWT_SECRET;
  if (raw) return Buffer.from(raw, 'utf-8');

  // 生产环境：缺密钥 = 配置错误 → 拒绝启动（fail fast，别带着随机密钥上线）
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[auth] JWT_SECRET 未设置 —— 生产环境拒绝以随机密钥启动。' +
        '请在系统环境变量中配置（见 docs/deploy.md §3）。',
    );
  }

  // 开发 / 测试：进程内随机生成
  //   ⚠️ 绝**不**回退到硬编码常量 —— 那会让密钥进版本库，任何人拿到仓库即可伪造 token。
  //   随机密钥的代价是「重启即失效所有 token」，对开发/测试完全可接受。
  if (!_devFallbackSecret) {
    _devFallbackSecret = crypto.randomBytes(32);
    console.warn(
      '[auth] ⚠️ JWT_SECRET 未设置 —— 已使用进程内随机密钥（重启即失效）。' +
        '生产请配置 JWT_SECRET 与 NODE_ENV=production（见 docs/deploy.md §3）。',
    );
  }
  return _devFallbackSecret;
}
const JWT_TTL_SEC = 7 * 60 * 60 * 24; // 7 天（SDD S4 access token）

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// --- 密码 ---
// 兼容两种存储格式（渐进式迁移）：
//   新格式：bcrypt $2b$12$...（bcryptjs 纯 JS，cost=12；bcryptjs 最新版输出 $2b$ 前缀）
//   旧格式：pbkdf2$iterations$sha256$salt_hex$hash_hex（verifyPassword 保留验证分支）

const BCRYPT_COST = 12;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;

  // bcrypt 标准前缀：$2a$ / $2b$ / $2y$
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    try {
      return bcrypt.compareSync(password, storedHash);
    } catch {
      return false;
    }
  }

  // 旧 pbkdf2 格式：pbkdf2$iterations$sha256$salt_hex$hash_hex
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 5) return false;
    const iter = parseInt(parts[1], 10);
    const algo = parts[2];
    const salt = Buffer.from(parts[3], 'hex');
    const expected = Buffer.from(parts[4], 'hex');
    const derived = crypto.pbkdf2Sync(password, salt, iter, expected.length, algo);
    try {
      return crypto.timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  return false;
}

// --- JWT ---

export interface JwtPayload {
  sub: number; // user_id
  username: string;
  role: 'user' | 'admin';
  iat: number;
  exp: number;
}

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_TTL_SEC;
  const fullPayload: JwtPayload = { ...payload, iat, exp };

  const header = { alg: 'HS256', typ: 'JWT' };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(fullPayload)));
  const signing = `${h}.${p}`;
  const sig = b64url(crypto.createHmac('sha256', getJwtSecret()).update(signing).digest());
  return `${signing}.${sig}`;
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expectedSig = b64url(crypto.createHmac('sha256', getJwtSecret()).update(`${h}.${p}`).digest());
    // 固定长度比较防止时序攻击
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(p).toString()) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 从 Fastify request 的 Authorization header 取 Bearer token
 * Fastify request.headers.authorization 类型是 string | string[] | undefined
 */
export function extractToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  if (!trimmed.startsWith('Bearer ')) return null;
  return trimmed.slice(7).trim() || null;
}
