import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../helpers';
import { FakeAxiosInstance, httpError, okResponse, failResponse } from '../fakeAxios';

/**
 * T64 · 会话过期体验（App 集成用例）
 *
 * 🎯 **验收点 ②：过期跳登录且登录后回原路径**
 *
 * 本文件跑的是**真实**的 `App.tsx` + 真实 `api/client.ts`（只把 axios 换成可控替身），
 * 因此覆盖的是「401 → 清会话 → 触发会话过期 → 跳 /login（带 from）→ 登录 → 回原路径」的**全链路**。
 *
 * ⚠️ **模块级状态必须重置**：`client.ts` 有模块级的「刷新进行中」promise，
 *   故每个用例前 `vi.resetModules()` + 动态 `import()`；
 *   `useUserStore` 也必须动态 import（否则拿到的是 resetModules 之前的旧实例）。
 */

/** 本次 `axios.create()` 造出来的实例 */
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
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.doUnmock('axios');
});

/** 载入一份全新的 App + client + store + axios 替身 */
async function loadApp() {
  const mod = await import('../../src/api/client');
  const store = await import('../../src/store/user');
  const { default: App } = await import('../../src/App');
  const inst = instances[instances.length - 1];
  expect(inst, 'axios 替身应已被 client.ts 用来 create').toBeTruthy();
  return { mod, store, App, inst };
}

/** 造一个 JWT（payload 里放 exp，单位秒） */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

/** 后端登录成功返回的会话 */
const SESSION = {
  token: 'fresh-token',
  refresh_token: 'fresh-refresh',
  refresh_token_expires_at: 1893456000,
  user: { id: 1, username: 'tester', role: 'user' },
};

describe('T64 · 会话过期 → 跳登录页（保留原路径）', () => {
  it('401 → 清会话 + 跳到 /login，location.state.from 是原路径', async () => {
    window.history.pushState({}, '', '/trade');
    const { mod, store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: 'old-token', refreshToken: null, username: 'tester', role: 'user' });

    inst.handler = async () => {
      throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
    };

    const r = renderWithRouter(<App />, { initialEntries: ['/trade'] });

    // 触发一次 401（包在 act 里：清会话 + 提示条都是 React 状态更新）
    await act(async () => {
      await mod.api.get('/holding').catch(() => undefined);
    });

    await waitFor(() => expect(r.routerPath).toBe('/login'));
    expect(r.routerState).toEqual({ from: '/trade' });
    // 会话已被清空
    expect(store.useUserStore.getState().token).toBeNull();
  });

  it('过期提示条在登录页**仍然可见**（文案取自错误码表 UNAUTHORIZED）', async () => {
    window.history.pushState({}, '', '/trade');
    const { mod, store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: 'old-token', refreshToken: null });

    inst.handler = async () => {
      throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
    };

    renderWithRouter(<App />, { initialEntries: ['/trade'] });
    await act(async () => {
      await mod.api.get('/holding').catch(() => undefined);
    });

    await waitFor(() => expect(screen.getByText(/登录已失效，请重新登录/)).toBeInTheDocument());
    // hint 也展示（PRD §5.9：登录后可返回原页面）
    expect(screen.getByText(/登录后会自动返回原页面/)).toBeInTheDocument();
    // 登录页上合规声明仍在（T95：全站所有页面常驻）
    expect(screen.getByText('本工具不构成投资建议，数据仅供参考')).toBeInTheDocument();
  });

  it('登录成功后回到原路径（/trade）', async () => {
    window.history.pushState({}, '', '/trade');
    const { mod, store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: 'old-token', refreshToken: null });

    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/login') return okResponse(SESSION);
      throw httpError(401, failResponse('UNAUTHORIZED', 'token 无效或已过期'));
    };

    const r = renderWithRouter(<App />, { initialEntries: ['/trade'] });
    await act(async () => {
      await mod.api.get('/holding').catch(() => undefined);
    });
    await waitFor(() => expect(r.routerPath).toBe('/login'));

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('用户名'), 'tester');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    // 登录成功 → 回到原路径
    await waitFor(() => expect(r.routerPath).toBe('/trade'));
    // 会话已写入（含 refresh token）
    expect(store.useUserStore.getState().token).toBe('fresh-token');
    expect(store.useUserStore.getState().refreshToken).toBe('fresh-refresh');
    // 过期提示条撤下
    expect(screen.queryByText(/登录已失效，请重新登录/)).not.toBeInTheDocument();
  });

  it('登录页上的 <main> 唯一（登录态 / 未登录态都是 1 个）', async () => {
    const { store, App, inst } = await loadApp();
    inst.handler = async () => okResponse([]);

    // 未登录 → 登录页
    store.useUserStore.setState({ token: null, refreshToken: null });
    const r1 = renderWithRouter(<App />, { initialEntries: ['/login'] });
    expect(r1.routerPath).toBe('/login');
    expect(document.querySelectorAll('main').length).toBe(1);
    r1.unmount();

    // 已登录 → 受保护壳
    store.useUserStore.setState({ token: 'tok', refreshToken: 'r', username: 'tester', role: 'user' });
    renderWithRouter(<App />, { initialEntries: ['/'] });
    expect(document.querySelectorAll('main').length).toBe(1);
    // 冲掉 Dashboard 挂载时的请求（避免 act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

describe('T64 · from 的开放重定向防护', () => {
  it('from 是外站 URL → 登录后回 /（而不是外站）', async () => {
    const { store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: null, refreshToken: null });
    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/login') return okResponse(SESSION);
      return okResponse([]);
    };

    const r = renderWithRouter(<App />, {
      initialEntries: [{ pathname: '/login', state: { from: 'https://evil.com' } }],
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('用户名'), 'tester');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(r.routerPath).toBe('/'));
    expect(r.routerPath.startsWith('http')).toBe(false);
  });

  it('from 是协议相对 URL（//evil.com）→ 登录后回 /', async () => {
    const { store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: null, refreshToken: null });
    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/login') return okResponse(SESSION);
      return okResponse([]);
    };

    const r = renderWithRouter(<App />, {
      initialEntries: [{ pathname: '/login', state: { from: '//evil.com' } }],
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('用户名'), 'tester');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(r.routerPath).toBe('/'));
  });

  it('from 是站内路径 → 登录后回该路径', async () => {
    const { store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: null, refreshToken: null });
    inst.handler = async (cfg) => {
      if (cfg.url === '/auth/login') return okResponse(SESSION);
      return okResponse([]);
    };

    const r = renderWithRouter(<App />, {
      initialEntries: [{ pathname: '/login', state: { from: '/kline?code=sh600000' } }],
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('用户名'), 'tester');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(r.routerPath).toBe('/kline?code=sh600000'));
  });
});

describe('T64 · Token 临近过期的轻量提示（PRD §5.9）', () => {
  it('剩余不足 1 天 → 显示提示条', async () => {
    const { store, App, inst } = await loadApp();
    inst.handler = async () => okResponse([]);
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1 小时后过期
    store.useUserStore.setState({ token: makeJwt({ exp }), refreshToken: 'r', username: 't', role: 'user' });

    renderWithRouter(<App />, { initialEntries: ['/'] });

    expect(screen.getByText('登录凭证即将过期，请尽快重新登录')).toBeInTheDocument();
    // 冲掉 Dashboard 挂载时的请求（避免 act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('剩余超过 1 天 → 不显示提示条', async () => {
    const { store, App, inst } = await loadApp();
    inst.handler = async () => okResponse([]);
    const exp = Math.floor(Date.now() / 1000) + 10 * 24 * 3600; // 10 天后过期
    store.useUserStore.setState({ token: makeJwt({ exp }), refreshToken: 'r', username: 't', role: 'user' });

    renderWithRouter(<App />, { initialEntries: ['/'] });

    expect(screen.queryByText('登录凭证即将过期，请尽快重新登录')).not.toBeInTheDocument();
    // 冲掉 Dashboard 挂载时的请求（避免 act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('token 不是 JWT（解不出 exp）→ 静默，不显示提示条', async () => {
    const { store, App, inst } = await loadApp();
    inst.handler = async () => okResponse([]);
    store.useUserStore.setState({ token: 'not-a-jwt', refreshToken: 'r', username: 't', role: 'user' });

    renderWithRouter(<App />, { initialEntries: ['/'] });

    expect(screen.queryByText('登录凭证即将过期，请尽快重新登录')).not.toBeInTheDocument();
    // 冲掉 Dashboard 挂载时的请求（避免 act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

describe('T64 · 页面错误文案统一走错误码表', () => {
  it('响应无 message 只有 code → 页面显示码表里的中文文案（不是裸码）', async () => {
    const { store, App, inst } = await loadApp();
    store.useUserStore.setState({ token: 'tok', refreshToken: 'r', username: 't', role: 'user' });

    // 4xx + body 里只有 code，没有 message
    inst.handler = async () => {
      throw httpError(503, {
        code: 'EXTERNAL_SOURCE_UNAVAILABLE',
        data: null,
        timestamp: '2026-10-20T00:00:00.000Z',
        success: false,
        error: 'EXTERNAL_SOURCE_UNAVAILABLE',
      });
    };

    renderWithRouter(<App />, { initialEntries: ['/'] });

    await waitFor(() => expect(screen.getAllByText('外部行情源暂不可用').length).toBeGreaterThan(0));
    expect(screen.queryByText('EXTERNAL_SOURCE_UNAVAILABLE')).not.toBeInTheDocument();
    // 冲掉 Dashboard 挂载时的其余请求（避免 act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
