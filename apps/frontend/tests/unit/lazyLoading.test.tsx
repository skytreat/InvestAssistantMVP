import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../helpers';
// ⚠️ **类型专用导入** —— 运行时不会真的 import 该模块（`vi.resetModules()` 后要动态拿新实例）
import type * as userStoreModule from '../../src/store/user';

/**
 * T66 · 路由级代码分割（`React.lazy` + `Suspense`）用例
 *
 * 🎯 **验收点**：SDD §2.12.5「代码分割（路由级）：KLinePage / AdminPage 用 `React.lazy + Suspense`」
 *    + 计划 T66 的 ①「首屏 chunk 不含 Kline」+ ③「无死导出」。
 *
 * ── 本文件测的是「懒加载机制」，不是页面内容 ──────────────────────────────
 * 故 **K 线页 / 管理员页 / 仪表盘一律用替身**：
 * - 替身的**模块工厂被调用** == 「该页面的 chunk 被 import（下载）」→ 用来断言「谁触发了下载」；
 * - 替身内部**不渲染任何 `role="status"`** → 页面自身的加载态不会污染
 *   「Suspense fallback 是否出现」的断言。
 *
 * ⚠️ **为什么用 `vi.doMock`（而不是 `vi.mock`）**：
 *    `vi.mock` 的工厂在**模块被 import 的那一刻**执行，而 vitest 会把**已 mock 的模块**
 *    单独缓存 —— `vi.resetModules()` **清不掉它** → 工厂只在本文件第一次 import 时跑一次，
 *    计数器没法按用例断言。
 *    `vi.doMock` 每次都重新注册 → 工厂每个用例都会重新执行 → 计数器可按用例断言。
 *
 * ⚠️ **为什么每个用例都要 `vi.resetModules()` + 动态 import App**：
 *    `React.lazy` 的解析结果（`_payload._result`）会**缓存在那个 lazy 对象上**，
 *    而 lazy 对象属于 `App.tsx` 模块作用域。
 *    若整个文件共用同一份 App 模块 → **K 线页只会在本文件第一次访问时 suspend 一次**，
 *    之后所有用例都直接命中缓存 → 再也看不到 Suspense fallback。
 *    故每个用例都 `vi.resetModules()` + 动态 `import('../../src/App')`，
 *    拿到**全新的 lazy 对象** → 每个用例都能真实地「先 fallback、后页面」。
 *    （`useUserStore` 同样必须动态 import —— 否则拿到的是 resetModules **之前**的旧实例，
 *    设置的登录态 App 读不到。写法与 `sessionExpiry.test.tsx` 同款。）
 */

/* ────────────────────── 替身与计数器（vi.hoisted 提前创建） ────────────────────── */

const { klineChunk, adminChunk, getMock, postMock } = vi.hoisted(() => ({
  /** K 线页 chunk 被 import（下载）的次数 */
  klineChunk: vi.fn(),
  /** 管理员页 chunk 被 import（下载）的次数 */
  adminChunk: vi.fn(),
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

/* ────────────────────────────── 小工具 ────────────────────────────── */

/** 载入一份全新的 App + store（`vi.resetModules()` 之后） */
async function loadApp() {
  const storeMod = await import('../../src/store/user');
  const { default: App } = await import('../../src/App');
  return { App, store: storeMod.useUserStore };
}

/** 设置登录态 */
function setSession(store: typeof userStoreModule.useUserStore, role: 'user' | 'admin') {
  store.setState({
    token: `tok-${role}`,
    refreshToken: null,
    username: 'tester',
    role,
  });
}

/** 取出所有发往 admin 接口的请求（用于断言「零 admin 请求」） */
function adminCalls(): unknown[][] {
  return [...getMock.mock.calls, ...postMock.mock.calls].filter(([url]) => String(url).startsWith('/admin'));
}

beforeEach(() => {
  vi.resetModules();

  /* ── 页面替身：模块工厂被调用 == 该页面的 chunk 被下载 ── */
  vi.doMock('../../src/pages/Kline', () => {
    klineChunk();
    return {
      default: function KlineStub() {
        return <div>【K线页面内容】</div>;
      },
    };
  });

  vi.doMock('../../src/pages/Admin', () => {
    adminChunk();
    return {
      default: function AdminStub() {
        // 模拟真实 Admin 页：挂载即发一个 admin 接口请求
        React.useEffect(() => {
          getMock('/admin/system-log');
        }, []);
        return <div>【管理员页面内容】</div>;
      },
    };
  });

  vi.doMock('../../src/pages/Dashboard', () => ({
    default: function DashboardStub() {
      return <div>【仪表盘内容】</div>;
    },
  }));

  /**
   * api/client 替身
   *
   * ⚠️ `App.tsx` 还会 import `onSessionExpired` —— 必须一并提供，
   *    否则 `App` 的 `useEffect` 会炸（少一个导出 → `undefined is not a function`）。
   */
  vi.doMock('../../src/api/client', () => ({
    api: { get: getMock, post: postMock },
    onSessionExpired: () => () => {
      /* 退订函数 */
    },
  }));

  klineChunk.mockClear();
  adminChunk.mockClear();
  getMock.mockClear();
  postMock.mockClear();
  getMock.mockResolvedValue({ data: { code: 0, data: [], success: true } });
  postMock.mockResolvedValue({ data: { code: 0, data: null, success: true } });
});

/* ────────────────────────────── 用例 ────────────────────────────── */

describe('T66 · React.lazy 代码分割', () => {
  it('访问 /kline → 先出现 Spinner（role="status"），chunk 落地后渲染出 K 线页', async () => {
    const { App, store } = await loadApp();
    setSession(store, 'user');
    renderWithRouter(<App />, { initialEntries: ['/kline'] });

    // 🔑 首帧：lazy chunk 还没下载完 → Suspense fallback = <Spinner />
    //    动态 import 必然异步（microtask + 模块转换），故首帧必定是 fallback。
    expect(screen.getByRole('status')).toBeInTheDocument();

    // chunk 落地 → 页面内容出现，fallback 消失
    expect(await screen.findByText('【K线页面内容】')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // K 线页 chunk 确实被下载了（且只下载了一次）
    expect(klineChunk).toHaveBeenCalledTimes(1);
  });

  it('访问 /admin（role=admin）→ 先出现 Spinner，随后渲染出管理员页', async () => {
    const { App, store } = await loadApp();
    setSession(store, 'admin');
    renderWithRouter(<App />, { initialEntries: ['/admin'] });

    expect(screen.getByRole('status')).toBeInTheDocument();

    expect(await screen.findByText('【管理员页面内容】')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(adminChunk).toHaveBeenCalledTimes(1);
  });

  it('🔴 访问 /admin（role=user）→ 不下载 Admin chunk、不渲染 Admin 页、零 admin 请求', async () => {
    const { App, store } = await loadApp();
    setSession(store, 'user');
    const r = renderWithRouter(<App />, { initialEntries: ['/admin'] });

    // 非 admin → AdminGuard 把路由弹回仪表盘
    await waitFor(() => expect(r.routerPath).toBe('/'));

    // 🔴 chunk **没有**被下载（这正是「lazy 不得成为信息泄露面」的关键）
    expect(adminChunk).not.toHaveBeenCalled();
    // 管理员页内容没有渲染
    expect(screen.queryByText('【管理员页面内容】')).not.toBeInTheDocument();
    // 零 admin 接口请求（与 adminGuard.test.tsx 的 I-12 用例同款口径）
    expect(adminCalls()).toHaveLength(0);
  });

  it('🔴 未登录访问 /admin → 同样不下载 Admin chunk、不发 admin 请求', async () => {
    const { App } = await loadApp();
    const r = renderWithRouter(<App />, { initialEntries: ['/admin'] });

    await waitFor(() => expect(r.routerPath).toBe('/login'));

    expect(adminChunk).not.toHaveBeenCalled();
    expect(adminCalls()).toHaveLength(0);
  });

  it('访问普通页面（/）→ 不出现任何 Spinner（Suspense 边界不误伤静态路由）', async () => {
    const { App, store } = await loadApp();
    setSession(store, 'user');
    renderWithRouter(<App />, { initialEntries: ['/'] });

    expect(await screen.findByText('【仪表盘内容】')).toBeInTheDocument();

    // 仪表盘是静态 import → 永远不会 suspend → 页面上不该有任何 role="status"
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // 也没有顺手把懒页面下载下来
    expect(klineChunk).not.toHaveBeenCalled();
    expect(adminChunk).not.toHaveBeenCalled();
  });

  it('懒加载期间导航栏与合规声明仍在场（Suspense 边界只包主内容区，不整页闪烁）', async () => {
    const { App, store } = await loadApp();
    setSession(store, 'user');
    renderWithRouter(<App />, { initialEntries: ['/kline'] });

    // fallback 出现时，导航栏 / 页脚仍在 DOM 里
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('InvestAssistant')).toBeInTheDocument();
    expect(screen.getByText('本工具不构成投资建议，数据仅供参考')).toBeInTheDocument();

    await screen.findByText('【K线页面内容】');
  });

  it('K 线页与管理员页的 chunk 互不影响：访问 /kline 不会下载 Admin chunk', async () => {
    const { App, store } = await loadApp();
    setSession(store, 'admin');
    renderWithRouter(<App />, { initialEntries: ['/kline'] });

    await screen.findByText('【K线页面内容】');

    expect(klineChunk).toHaveBeenCalledTimes(1);
    expect(adminChunk).not.toHaveBeenCalled();
  });

  it('懒加载落到的是**真模块**（不是替身）：真实 K 线页能挂载', async () => {
    // 本用例不 mock K 线页 —— 验证 `React.lazy` 的动态 import 真的拉起了 `src/pages/Kline.tsx`
    vi.doUnmock('../../src/pages/Kline');

    // 真实 K 线页挂载后会拉 /kline 接口 —— 返回一个**结构合法但没有数据**的响应
    // （空 klines → 页面走「空态」分支 → 不会触发 canvas 绘制，jsdom 无 2D context 也不炸）
    getMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/kline/')) {
        return {
          data: {
            code: 0,
            success: true,
            data: { klines: [], indicators: null, signals: [] },
          },
        };
      }
      return { data: { code: 0, data: [], success: true } };
    });

    const { App, store } = await loadApp();
    setSession(store, 'user');
    renderWithRouter(<App />, { initialEntries: ['/kline'] });

    // 真实页面的「代码：」label（替身里没有这个节点）
    expect(await screen.findByLabelText('代码：')).toBeInTheDocument();
    expect(screen.queryByText('【K线页面内容】')).not.toBeInTheDocument();
  });
});
