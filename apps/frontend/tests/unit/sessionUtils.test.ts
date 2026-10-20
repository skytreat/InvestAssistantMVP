import { describe, it, expect } from 'vitest';
import { decodeJwtExp, isTokenExpiringSoon, TOKEN_EXPIRY_WARN_SECONDS } from '../../src/utils/jwt';
import { safeInternalPath } from '../../src/utils/path';

/**
 * T64 · 会话工具函数用例
 *
 * 覆盖两块纯逻辑：
 * 1. `utils/jwt.ts` —— JWT `exp` 解码 + 「剩余不足 1 天」判定（PRD §5.9 轻量提示）
 * 2. `utils/path.ts` —— 站内路径校验（登录后回原路径的**开放重定向防护**）
 */

/** 造一个 JWT（payload 里放 exp，单位秒） */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

describe('T64 · decodeJwtExp', () => {
  it('解出 exp（秒级 unix 时间戳）', () => {
    expect(decodeJwtExp(makeJwt({ exp: 1893456000 }))).toBe(1893456000);
  });

  it('payload 里有中文也能解（base64url → UTF-8）', () => {
    expect(decodeJwtExp(makeJwt({ exp: 1893456000, name: '张三' }))).toBe(1893456000);
  });

  it('不是 JWT（没有点）→ null', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeNull();
  });

  it('payload 不是合法 base64 → null（静默，不抛错）', () => {
    expect(decodeJwtExp('a.!!!not-base64!!!.c')).toBeNull();
  });

  it('payload 不是合法 JSON → null', () => {
    const notJson = Buffer.from('not json at all').toString('base64url');
    expect(decodeJwtExp(`a.${notJson}.c`)).toBeNull();
  });

  it('没有 exp / exp 不是数字 → null', () => {
    expect(decodeJwtExp(makeJwt({ sub: 1 }))).toBeNull();
    expect(decodeJwtExp(makeJwt({ exp: 'soon' }))).toBeNull();
    expect(decodeJwtExp(makeJwt({ exp: Number.NaN }))).toBeNull();
  });

  it('token 为空 → null', () => {
    expect(decodeJwtExp(null)).toBeNull();
    expect(decodeJwtExp('')).toBeNull();
    expect(decodeJwtExp(undefined)).toBeNull();
  });
});

describe('T64 · isTokenExpiringSoon（剩余 < 1 天）', () => {
  const nowSec = 1_800_000_000;
  const nowMs = nowSec * 1000;

  it('阈值 = 1 天', () => {
    expect(TOKEN_EXPIRY_WARN_SECONDS).toBe(24 * 60 * 60);
  });

  it('剩余 1 小时 → 提示', () => {
    expect(isTokenExpiringSoon(makeJwt({ exp: nowSec + 3600 }), nowMs)).toBe(true);
  });

  it('剩余 10 天 → 不提示', () => {
    expect(isTokenExpiringSoon(makeJwt({ exp: nowSec + 10 * 86400 }), nowMs)).toBe(false);
  });

  it('已过期（剩余为负）→ 不提示（过期交给 401 流程）', () => {
    expect(isTokenExpiringSoon(makeJwt({ exp: nowSec - 10 }), nowMs)).toBe(false);
  });

  it('解不出 exp → 不提示（静默）', () => {
    expect(isTokenExpiringSoon('not-a-jwt', nowMs)).toBe(false);
    expect(isTokenExpiringSoon(null, nowMs)).toBe(false);
  });
});

describe('T64 · safeInternalPath（开放重定向防护）', () => {
  it('站内绝对路径 → 原样放行', () => {
    expect(safeInternalPath('/trade')).toBe('/trade');
    expect(safeInternalPath('/kline?code=sh600000')).toBe('/kline?code=sh600000');
    expect(safeInternalPath('/review')).toBe('/review');
  });

  it('外站 URL → 拒绝', () => {
    expect(safeInternalPath('https://evil.com')).toBeNull();
    expect(safeInternalPath('http://evil.com/x')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
  });

  it('协议相对 URL（//host）与反斜杠变体（/\\host）→ 拒绝', () => {
    expect(safeInternalPath('//evil.com')).toBeNull();
    expect(safeInternalPath('/\\evil.com')).toBeNull();
  });

  it('相对路径 → 拒绝', () => {
    expect(safeInternalPath('trade')).toBeNull();
    expect(safeInternalPath('./trade')).toBeNull();
  });

  it('含控制字符 → 拒绝', () => {
    expect(safeInternalPath('/tra\nde')).toBeNull();
    expect(safeInternalPath('/tra\rde')).toBeNull();
    expect(safeInternalPath('/tra\tde')).toBeNull();
  });

  it('空串 / 非字符串 → 拒绝', () => {
    expect(safeInternalPath('')).toBeNull();
    expect(safeInternalPath('   ')).toBeNull();
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath(123)).toBeNull();
    expect(safeInternalPath({ from: '/trade' })).toBeNull();
  });
});
