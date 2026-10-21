/**
 * tests/http/cors.test.ts —— **CORS 验收**（计划 §12.7 T60 ③ / AGENTS.md 安全约束）
 *
 * ════════════════════════════════════════════════════════════════════════
 * 🔴 **判据（计划 §12.7「未完成验收项 → 归属门槛」表 T60 ③ 逐字照抄）**
 * ════════════════════════════════════════════════════════════════════════
 *   CORS：Origin=`http://evil.com` **必拒** / `http://127.0.0.1:5173` **必放行**；
 *   **须断言该测试文件确实调了 `listen()`**（放进 `integration/` 用 `inject()` 测则恒绿 = 没测）。
 *
 * ── 为什么必须在 `tests/http/` 而不是 `tests/integration/` ──
 *   `tests/integration/_helpers.ts` 的 CORS 配置是 **`origin: true`（放行任意来源）**
 *   ——那是**测试便利配置**，用它测 CORS 必然「 evil.com 也放行」的假绿。
 *   本文件用**生产配置**（`src/server.ts` 的白名单）起服务 ⇒ 测的就是真实口径。
 *
 * ── 为什么必须真 listen ──
 *   `app.inject()` 走**内存**，不经 HTTP 传输层；本文件用裸 socket + fetch 双通道验证，
 *   并用 `assertRealListen()` 断言「确实在监听」（见 _helpers.ts 的三重证明）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PRODUCTION_CORS_ORIGINS,
  assertRealListen,
  createHttpApp,
  readProductionCorsOrigins,
  type HttpTestApp,
} from './_helpers.js';

/** 恶意来源（计划指定的反例） */
const EVIL_ORIGIN = 'http://evil.com';

let http: HttpTestApp;

beforeAll(async () => {
  http = await createHttpApp({ portStart: 51200, portEnd: 51219 });
}, 30000);

afterAll(async () => {
  await http?.close();
}, 30000);

describe('CORS —— 真 listen 验收（计划 §12.7 T60 ③）', () => {
  it('前置守卫：本文件确实调用了 app.listen()（inject() 恒绿 = 没测）', async () => {
    const raw = await assertRealListen(http.app, http.port);
    // 裸 socket 拿到的必须是**真实 HTTP 响应字节**
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(raw).toContain('content-type');
  });

  it('口径守卫：测试用的白名单 == 生产 src/server.ts 的白名单', () => {
    const production = readProductionCorsOrigins();
    expect(production).toEqual([...PRODUCTION_CORS_ORIGINS]);
    expect(production).toContain('http://127.0.0.1:5173');
  });

  it('必拒：Origin=http://evil.com → 响应**不得**带 access-control-allow-origin', async () => {
    const res = await fetch(`${http.baseUrl}/api/health`, {
      headers: { Origin: EVIL_ORIGIN },
    });
    expect(res.status).toBe(200); // 服务端照常处理请求（这不是 CSRF 防护，是浏览器侧策略）
    // 🔴 关键断言：**不回显**恶意来源 ⇒ 浏览器会拦掉这次跨域读取
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('必放行：Origin=http://127.0.0.1:5173 → 回显该来源 + 允许携带凭证', async () => {
    const res = await fetch(`${http.baseUrl}/api/health`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    // 绝不能是 `*`（与 credentials: true 互斥，且等于放开全部来源）
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('必放行：Origin=http://localhost:5173 → 回显该来源', async () => {
    const res = await fetch(`${http.baseUrl}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('无 Origin 头（curl / 服务端调用）→ 不带 CORS 头，且正常 200', async () => {
    const res = await fetch(`${http.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('预检 OPTIONS：恶意来源不得拿到放行头', async () => {
    const res = await fetch(`${http.baseUrl}/api/holding`, {
      method: 'OPTIONS',
      headers: {
        Origin: EVIL_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('预检 OPTIONS：白名单来源拿到放行头 + 允许的方法', async () => {
    const res = await fetch(`${http.baseUrl}/api/holding`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    const allowMethods = res.headers.get('access-control-allow-methods') ?? '';
    expect(allowMethods.toUpperCase()).toContain('GET');
  });

  it('裸 socket 直连（不经 fetch 的连接池）同样遵守 CORS 白名单', async () => {
    const { rawHttpGet } = await import('./_helpers.js');
    const evil = await rawHttpGet(http.port, '/api/health', { Origin: EVIL_ORIGIN });
    expect(evil.toLowerCase()).not.toContain('access-control-allow-origin');

    const allowed = await rawHttpGet(http.port, '/api/health', {
      Origin: 'http://127.0.0.1:5173',
    });
    expect(allowed.toLowerCase()).toContain('access-control-allow-origin: http://127.0.0.1:5173');
  });
});
