import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../helpers';
import AdminGuard from '../../src/components/AdminGuard';
import { useUserStore } from '../../src/store/user';

/**
 * T98 —— AdminGuard 回归用例
 *
 * 覆盖 SDD §2.12.2 的 AdminGuard 契约 + **I-12 的核心不变量**：
 * 🔴 **非 admin 时不得发出任何 admin API 请求** —— 这是 AdminGuard 存在的全部理由
 *    （普通用户可进 Admin 页、仅靠后端 403 兜底 = 真实越权入口，见 plan §13.2 I-12）。
 *
 * 「不得发请求」怎么证明？—— 因为守卫**不渲染 children**，
 * children 里的 `useEffect` 不执行 → `api.get` 调用次数必须是 **0**。
 */

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../../src/api/client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

/** 被守卫保护的子组件：挂载即请求（模拟 Admin 页的 useEffect） */
function Protected({ label = '受保护内容' }: { label?: string }) {
  React.useEffect(() => {
    getMock('/admin/system-log');
  }, []);
  return <div>{label}</div>;
}

function setSession(token: string | null, role: 'user' | 'admin' | null) {
  const { login, logout } = useUserStore.getState();
  if (token) login(token, 'tester', role ?? 'user');
  else logout();
}

describe('T98 AdminGuard', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue({ data: { success: true, data: [] } });
    setSession(null, null);
  });

  it('未登录（无 token）→ 重定向到 /login，且不渲染被保护内容', () => {
    const r = renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)));
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(r.routerPath).toBe('/login');
  });

  it('已登录但非 admin（role=user）→ 重定向到 /（仪表盘），不渲染被保护内容', () => {
    setSession('tok-user', 'user');
    const r = renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)));
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(r.routerPath).toBe('/');
  });

  it('🔴 I-12：非 admin 时**不得发出任何 admin API 请求**', () => {
    setSession('tok-user', 'user');
    renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)));
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('🔴 I-12：未登录时同样不得发出任何 admin API 请求', () => {
    renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)));
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('role=admin → 渲染被保护内容，且停留在当前页', () => {
    setSession('tok-admin', 'admin');
    const r = renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)), {
      initialEntries: ['/admin'],
    });
    expect(screen.getByText('受保护内容')).toBeInTheDocument();
    expect(r.routerPath).toBe('/admin');
  });

  it('role=admin → 被保护组件的 useEffect 正常执行（请求照常发出）', () => {
    setSession('tok-admin', 'admin');
    renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)), {
      initialEntries: ['/admin'],
    });
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('/admin/system-log');
  });

  it('role 为 null（登录态未恢复）→ 按非 admin 处理，重定向到 /', () => {
    // zustand persist 未恢复出 role 的场景：token 在但 role 未知 → 不得当成 admin
    setSession('tok-x', null);
    const r = renderWithRouter(React.createElement(AdminGuard, null, React.createElement(Protected)));
    expect(screen.queryByText('受保护内容')).not.toBeInTheDocument();
    expect(r.routerPath).toBe('/');
    expect(getMock).not.toHaveBeenCalled();
  });
});
