import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeAxiosInstance, httpError, okResponse, failResponse } from '../fakeAxios';

/**
 * T64 · `api/client.ts` 内部行为用例（401 → 刷新 → 重放 → 会话过期）
 *
 * 🎯 **验收点 ③：并发 401 只触发一次刷新（去重标志位）**
 *
 * ⚠️ **不能用 `vi.mock('../../src/api/client', ...)`** —— 那会把整个模块换掉，
 *   被测的内部逻辑根本不会执行。故这里替换的是 **axios 本身**：
 *   `vi.doMock('axios', ...)` 让 `axios.create()` 返回一个**可控实例**
 *   （`tests/fakeAxios.ts`），而 `src/api/client.ts` 的真实代码照常跑。
 *
 * ⚠️ **模块级状态要重置**：`client.ts` 里有模块级的「刷新进行中」promise，
 *   故每个用例前 `vi.resetModules()` + 动态 `import()` 拿一份全新模块。
 *   同理，`useUserStore` 也必须用**动态 import** 拿同一份新实例
 *   （静态 import 拿到的是 resetModules **之前**的旧实例，client.ts 就读不到用例设的值了）。
 */

/** 本次 `axios.create()` 造出来的实例（每个用例一个） */
let instances: FakeAxiosInstance[] = [];

beforeEach(() => {
  instances = [];
  vi.resetModules();
  vi.doMock('axios', () => ({
    default: {
      create: () => {
        const inst = new FakeAxiosInstance();
        instances.push(inst);
        return inst;
      },
    },
  }));
  // 每个用例从干净的窗口路径开始
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.doUnmock('axios');
});

/** 载入一份全新的 client + store + axios 替身 */
async function loadClient() {
  const mod = await import('../../src/api/client');
  const store = await import('../../src/store/user');
  const inst = instances[instances.length - 1];
  expect(inst, 'axios 替身应已被 client.ts 用来 create').toBeTruthy();
  return { mod, store, inst };
}

/** 造一个「过期 token」→ 401 的处理器 */
function unauthorizedHandler(refreshFails = false) {
  return async (cfg: { url?: string; headers?: Record<string, string> }) => {
    if (cfg.url === '/auth/refresh') {
      if (refreshFails) throw httpError(401, failResponse('UNAUTHORIZED', 'refresh token 无效或已过期'));
      return okResponse({
        token: 'new-token',
        refresh_token: 'new-refresh',
        refresh_token_expires_at: 1893456000,
        user: { id: 1, username: 'tester', role: 'user' },
      });
    }
    // 带新 token 的一律成功
    if (cfg.headers?.Authorization === 'Bearer new-token') return okResponse([]);
    throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
  };
}

describe('T64 · 401 → 刷新 → 重放（去重）', () => {
  it('并发 401 只触发**一次**刷新（去重标志位）', async () => {
    const { mod, store, inst } = await loadClient();
    store.useUserStore.setState({
      token: 'old-token',
      refreshToken: 'old-refresh',
      username: 'tester',
      role: 'user',
    });

    let refreshCalls = 0;
    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/refresh') {
        refreshCalls += 1;
        // 拉长刷新耗时：让 3 个并发 401 都落在同一个 in-flight promise 上
        await new Promise((r) => setTimeout(r, 20));
        return okResponse({
          token: 'new-token',
          refresh_token: 'new-refresh',
          user: { id: 1, username: 'tester', role: 'user' },
        });
      }
      if (cfg.headers?.Authorization === 'Bearer new-token') return okResponse([]);
      throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
    };

    const results = await Promise.allSettled([
      mod.api.get('/holding'),
      mod.api.get('/asset-stat/latest'),
      mod.api.get('/signal'),
    ]);

    // ① 刷新端点只被调用 1 次
    expect(refreshCalls).toBe(1);
    expect(inst.calls.filter((c) => c.url === '/auth/refresh').length).toBe(1);
    // ② 三个原请求都重放成功
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // ③ 每个原请求「首发 + 重放」各 1 次
    for (const url of ['/holding', '/asset-stat/latest', '/signal']) {
      expect(inst.calls.filter((c) => c.url === url).length, `${url} 应重放 1 次`).toBe(2);
    }
    // ④ 重放带的是**新** token
    const replay = inst.calls.filter((c) => c.url === '/holding')[1];
    expect(replay.headers?.Authorization).toBe('Bearer new-token');
    // ⑤ store 换成了新的一对 token
    expect(store.useUserStore.getState().token).toBe('new-token');
    expect(store.useUserStore.getState().refreshToken).toBe('new-refresh');
  });

  it('刷新成功后原请求被重放 1 次，且带新 Authorization', async () => {
    const { mod, store, inst } = await loadClient();
    store.useUserStore.setState({ token: 'old-token', refreshToken: 'old-refresh' });
    inst.handler = unauthorizedHandler();

    const res = (await mod.api.get('/holding')) as { data: { data: unknown[] } };
    expect(res.data.data).toEqual([]);

    const calls = inst.calls.filter((c) => c.url === '/holding');
    expect(calls.length).toBe(2);
    expect(calls[0].headers?.Authorization).toBe('Bearer old-token');
    expect(calls[1].headers?.Authorization).toBe('Bearer new-token');
  });

  it('刷新失败 → 清会话 + 触发「会话过期」', async () => {
    const { mod, store, inst } = await loadClient();
    store.useUserStore.setState({ token: 'old-token', refreshToken: 'old-refresh' });

    const expired: string[] = [];
    mod.onSessionExpired((from) => expired.push(from));

    inst.handler = unauthorizedHandler(true);

    await expect(mod.api.get('/holding')).rejects.toBeTruthy();

    // 会话被清空
    expect(store.useUserStore.getState().token).toBeNull();
    expect(store.useUserStore.getState().refreshToken).toBeNull();
    // 「会话过期」被触发，且带上当前路径
    expect(expired.length).toBe(1);
    expect(expired[0]).toBe('/');
  });

  it('无 refresh_token → 不发刷新请求，直接清会话 + 触发「会话过期」', async () => {
    const { mod, store, inst } = await loadClient();
    store.useUserStore.setState({ token: 'old-token', refreshToken: null });

    const expired: string[] = [];
    mod.onSessionExpired((from) => expired.push(from));

    inst.handler = unauthorizedHandler();

    await expect(mod.api.get('/holding')).rejects.toBeTruthy();

    expect(inst.calls.filter((c) => c.url === '/auth/refresh').length).toBe(0);
    expect(store.useUserStore.getState().token).toBeNull();
    expect(expired.length).toBe(1);
  });

  it('刷新请求自身 401 → 不递归（刷新端点只被调用 1 次）', async () => {
    const { mod, store, inst } = await loadClient();
    store.useUserStore.setState({ token: 'old-token', refreshToken: 'old-refresh' });

    const expired: string[] = [];
    mod.onSessionExpired((from) => expired.push(from));

    let refreshCalls = 0;
    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/refresh') {
        refreshCalls += 1;
        throw httpError(401, failResponse('UNAUTHORIZED', 'refresh token 无效或已过期'));
      }
      throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
    };

    await expect(mod.api.get('/holding')).rejects.toBeTruthy();

    expect(refreshCalls).toBe(1);
    expect(expired.length).toBe(1);
  });

  it('重放后仍 401 → 不再重放（_retry 标记生效，不会死循环），且不清会话', async () => {
    const { mod, store, inst } = await loadClient();
    store.useUserStore.setState({ token: 'old-token', refreshToken: 'old-refresh' });

    const expired: string[] = [];
    mod.onSessionExpired((from) => expired.push(from));

    // 刷新成功，但业务接口**一直** 401
    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/refresh') {
        return okResponse({ token: 'new-token', refresh_token: 'new-refresh', user: { id: 1 } });
      }
      throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
    };

    await expect(mod.api.get('/holding')).rejects.toBeTruthy();

    // 只重放 1 次（不会无限循环），刷新也只发生 1 次
    expect(inst.calls.filter((c) => c.url === '/holding').length).toBe(2);
    expect(inst.calls.filter((c) => c.url === '/auth/refresh').length).toBe(1);
    // 口径：会话**刚刷新成功** → 不清会话、不触发「会话过期」（错误原样抛给页面）
    expect(store.useUserStore.getState().token).toBe('new-token');
    expect(expired.length).toBe(0);
  });
});

describe('T64 · 会话过期 pub/sub', () => {
  it('onSessionExpired 返回取消订阅函数；退订后不再收到通知', async () => {
    const { mod } = await loadClient();
    const seen: string[] = [];
    const off = mod.onSessionExpired((from) => seen.push(from));

    mod.emitSessionExpired('/trade');
    expect(seen).toEqual(['/trade']);

    off();
    mod.emitSessionExpired('/signals');
    expect(seen).toEqual(['/trade']);
  });

  it('一个订阅者抛异常不影响其它订阅者', async () => {
    const { mod } = await loadClient();
    const seen: string[] = [];
    mod.onSessionExpired(() => {
      throw new Error('boom');
    });
    mod.onSessionExpired((from) => seen.push(from));

    expect(() => mod.emitSessionExpired('/kline')).not.toThrow();
    expect(seen).toEqual(['/kline']);
  });

  it('currentPath 取 window.location 的路径 + query', async () => {
    const { mod } = await loadClient();
    window.history.pushState({}, '', '/trade?tab=1');
    expect(mod.currentPath()).toBe('/trade?tab=1');
  });
});

describe('T64 · 统一错误映射（api/client.ts 出口处补 message）', () => {
  it('响应无 message 但有 code → 出口处补成码表里的中文文案', async () => {
    const { mod, inst } = await loadClient();
    inst.handler = async () => {
      throw httpError(409, {
        code: 'HOLDING_INSUFFICIENT',
        data: null,
        timestamp: '2026-10-20T00:00:00.000Z',
        success: false,
        error: 'HOLDING_INSUFFICIENT',
      });
    };

    try {
      await mod.api.post('/trade');
      expect.unreachable('应当抛错');
    } catch (err) {
      const body = (err as { response: { data: { message: string } } }).response.data;
      expect(body.message).toBe('持仓不足，无法减仓或清仓');
      expect(body.message).not.toBe('HOLDING_INSUFFICIENT');
    }
  });

  it('后端已给 message 时**不覆盖**（保持后端文案优先）', async () => {
    const { mod, inst } = await loadClient();
    inst.handler = async () => {
      throw httpError(400, failResponse('PARAM_INVALID', '后端自定义文案'));
    };

    try {
      await mod.api.post('/trade');
      expect.unreachable('应当抛错');
    } catch (err) {
      const body = (err as { response: { data: { message: string } } }).response.data;
      expect(body.message).toBe('后端自定义文案');
    }
  });
});
