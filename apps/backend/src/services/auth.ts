import crypto from 'node:crypto';

/**
 * 最小鉴权工具
 * - 密码哈希：pbkdf2-sha256 + 32字节salt + 310000 迭代（Node 内置，不引 bcrypt）
 * - JWT：HS256 手写签名/验证（Node 内置，不引 jsonwebtoken）
 *   格式：base64url(header).base64url(payload).base64url(signature)
 *   payload：{ sub: userId, username, role, exp }
 *   过期：1 天
 */

const PBKDF2_ITERATIONS = 310000;
const SALT_BYTES = 32;
const HASH_BYTES = 32;
const HASH_ALGO = 'sha256';

const JWT_SECRET = Buffer.from(
  process.env.JWT_SECRET ?? 'investassistant-mvp-dev-secret-change-me-in-prod-2026',
  'utf-8'
);
const JWT_TTL_SEC = 60 * 60 * 24;  // 1 天

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// --- 密码 ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, HASH_BYTES, HASH_ALGO);
  // 格式：pbkdf2$iterations$algorithm$salt_hex$hash_hex
  return `pbkdf2$${PBKDF2_ITERATIONS}$${HASH_ALGO}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const algo = parts[2];
  const salt = Buffer.from(parts[3], 'hex');
  const expected = Buffer.from(parts[4], 'hex');
  const derived = crypto.pbkdf2Sync(password, salt, iter, expected.length, algo);
  return crypto.timingSafeEqual(derived, expected);
}

// --- JWT ---

export interface JwtPayload {
  sub: number;          // user_id
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
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(signing).digest());
  return `${signing}.${sig}`;
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expectedSig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
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
