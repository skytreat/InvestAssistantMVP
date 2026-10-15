/**
 * auth.test.ts — Phase 3 SDD §12.3 单元测试
 *
 * 覆盖 src/services/auth.ts：
 *   hashPassword / verifyPassword / signToken / verifyToken / extractToken
 */
import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  extractToken,
} from '../../src/services/auth.js';

describe('auth — hashPassword + verifyPassword', () => {
  it('正常密码：hashPassword 返回 bcrypt $2b$12$ 前缀，verifyPassword 校验通过', () => {
    const hash = hashPassword('hello');
    expect(hash.startsWith('$2b$12$')).toBe(true);
    expect(verifyPassword('hello', hash)).toBe(true);
  });

  it('错误密码：verifyPassword 返回 false', () => {
    const hash = hashPassword('hello');
    expect(verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('auth — signToken + verifyToken', () => {
  it('token 签发：返回三段 JWT', () => {
    const token = signToken({ sub: 1, username: 'admin', role: 'admin' });
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });

  it('token 验证：payload.sub / username 正确', () => {
    const token = signToken({ sub: 1, username: 'admin', role: 'admin' });
    const payload = verifyToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(1);
    expect(payload!.username).toBe('admin');
    expect(payload!.role).toBe('admin');
  });

  it('过期 token：verifyToken 返回 null', () => {
    // 手动构造一个已过期的 JWT（payload.exp = 1 秒前）
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = signToken({ sub: 1, username: 'admin', role: 'admin' });
    // 用过期 payload 替换原 payload（保留原始签名）
    const parts = expiredToken.split('.');
    const expiredPayloadObj = {
      sub: 1, username: 'admin', role: 'admin',
      iat: now - 86400 - 100,
      exp: now - 1,  // 已过期
    };
    // 复用 auth.ts 里的 b64url / b64urlDecode？这里直接用 crypto 手动拼接
    // 更简单：截掉原 payload 段，手动改 exp 后重新签名
    const b64url = (buf: Buffer) =>
      buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const crypto = require('node:crypto');
    const secret = Buffer.from(
      process.env.JWT_SECRET ?? 'investassistant-mvp-dev-secret-change-me-in-prod-2026',
      'utf-8'
    );
    const newPayloadB64 = b64url(Buffer.from(JSON.stringify(expiredPayloadObj)));
    const headerB64 = parts[0];
    const signing = `${headerB64}.${newPayloadB64}`;
    const sig = b64url(crypto.createHmac('sha256', secret).update(signing).digest());
    const token = `${signing}.${sig}`;
    expect(verifyToken(token)).toBeNull();
  });

  it('篡改 token：改第三段一个字符，verifyToken 返回 null', () => {
    const token = signToken({ sub: 1, username: 'admin', role: 'admin' });
    const chars = token.split('');
    // 改最后一个字符
    const last = chars.length - 1;
    chars[last] = chars[last] === 'A' ? 'B' : 'A';
    const tampered = chars.join('');
    expect(verifyToken(tampered)).toBeNull();
  });
});

describe('auth — extractToken', () => {
  it('无 Authorization header：返回 null', () => {
    expect(extractToken(undefined)).toBeNull();
    expect(extractToken(null as any)).toBeNull();
    expect(extractToken('')).toBeNull();
  });

  it('Bearer x：返回 "x"', () => {
    expect(extractToken('Bearer x')).toBe('x');
    expect(extractToken('  Bearer   abc  ')).toBe('abc');
  });
});
