import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import AdminRolePanel from '../../src/components/AdminRolePanel';
import { useUserStore } from '../../src/store/user';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

/**
 * Wave 7 · T75 ③ · 管理员「角色管理」面板用例（关闭 F-A3）
 *
 * 覆盖任务卡「卡 2」的验收断言：
 *
 * | 断言 | 用例 |
 * |---|---|
 * | UX-08 已有 admin 时提供「转移管理员」入口（不再死锁）| 已有管理员时提供可用的「转移管理员」入口 |
 * | A8 自己那一行降级按钮禁用 + 指向「转移管理员」的文案 | 不能降级当前登录账号（按钮禁用）|
 * | A9 二次确认后才 `PATCH`（body = `{role:'admin'}`）| 角色变更需二次确认后才发请求 |
 * | UX-08 转移确认文案 + 成功后会话角色降为 user | 转移管理员：确认文案含「你将失去管理员权限」，成功后自己变为普通用户 |
 * | 后端 400 → 内联错误条 | 后端拒绝时显示后端原文案 |
 *
 * ⚠️ **为什么「直接升级」用例的假数据里没有 admin**
 *
 * `role='admin'` 的语义是：库里已有 admin 时走**原子转移**（升目标 + 降自己）；
 * 库里没有 admin 时才是普通「升级」。要单独验证后者，假数据必须**没有 admin 行**。
 */

const { getMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: {
    get: getMock,
    post: vi.fn(),
    patch: patchMock,
    put: vi.fn(),
    delete: vi.fn(),
  },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/admin',
}));

/** 假数据 A：库中已有 admin（当前登录账号就是它）*/
const USERS_WITH_ADMIN = [
  { id: 1, username: 'admin', role: 'admin', created_at: '2026-09-01 10:00:00' },
  { id: 2, username: 'alice', role: 'user', created_at: '2026-10-01 10:00:00' },
];

/** 假数据 B：库里没有 admin（此时「升级」路径才可达）*/
const USERS_WITHOUT_ADMIN = [
  { id: 2, username: 'alice', role: 'user', created_at: '2026-10-01 10:00:00' },
  { id: 3, username: 'bob', role: 'user', created_at: '2026-10-02 10:00:00' },
];

describe('Admin 角色面板', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    getMock.mockResolvedValue(mockResponse(USERS_WITH_ADMIN));
    patchMock.mockResolvedValue(mockResponse(null));
    // 当前登录账号 = admin
    useUserStore.setState({
      token: 'tok-admin',
      username: 'admin',
      role: 'admin',
      refreshToken: null,
    });
  });

  it('已有管理员时提供可用的「转移管理员」入口（不再死锁）', async () => {
    renderWithRouter(<AdminRolePanel />);

    const rows = await screen.findAllByTestId('role-row');
    expect(rows).toHaveLength(2);

    const aliceRow = rows[1];
    // UX-08：库里已有 admin ⇒ 其他用户可以「转移管理员」，不再禁用
    const transfer = within(aliceRow).getByRole('button', { name: /转移管理员给 alice/ });
    expect(transfer).toBeEnabled();
    expect(transfer).toHaveTextContent('转移管理员');
  });

  it('不能降级当前登录账号（按钮禁用，文案指向「转移管理员」）', async () => {
    renderWithRouter(<AdminRolePanel />);

    const rows = await screen.findAllByTestId('role-row');
    const selfRow = rows[0];
    expect(selfRow).toHaveTextContent('admin');

    const demote = within(selfRow).getByRole('button', { name: '降级为普通用户' });
    // A8：当前登录账号那一行的降级按钮禁用
    expect(demote).toBeDisabled();
    // UX-08：提示必须给出可执行的出口（旧文案「不能降级当前登录账号」是死锁的一半）
    expect(within(selfRow).getByTestId('role-hint')).toHaveTextContent('转移管理员');
  });

  it('转移管理员：确认文案说明「你将失去管理员权限」，成功后自己变为普通用户', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    await user.click(within(rows[1]).getByRole('button', { name: /转移管理员给 alice/ }));

    // 二次确认弹窗：明确告知当前账号会失去管理员权限
    expect(screen.getByRole('dialog')).toHaveTextContent('你将失去管理员权限');
    expect(patchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认转移' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[0]).toBe('/admin/role/2');
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ role: 'admin' });

    const notice = await screen.findByTestId('role-notice');
    expect(notice).toHaveTextContent('已将管理员转移给「alice」');
    // 会话角色同步为 user（AdminGuard 据此立即收回管理员页）
    expect(useUserStore.getState().role).toBe('user');
  });

  it('角色变更需二次确认后才发请求', async () => {
    const user = userEvent.setup();
    // 库里没有 admin ⇒ 升级按钮可用
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    const promote = within(rows[0]).getByRole('button', { name: /升级 alice 为管理员/ });
    expect(promote).toBeEnabled();

    await user.click(promote);

    // 二次确认弹窗出现，且**尚未**发出请求
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认变更' }));

    // A9：确认后才 PATCH，body 为 `{ role: 'admin' }`
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[0]).toBe('/admin/role/2');
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ role: 'admin' });
  });

  it('取消确认不发角色变更请求', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    await user.click(within(rows[0]).getByRole('button', { name: /升级 alice 为管理员/ }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('后端拒绝（400 PARAM_INVALID）→ 内联错误条显示后端原文案', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));
    patchMock.mockRejectedValueOnce(
      mockErrorResponse(400, 'PARAM_INVALID', '该操作会使管理员数量不为 1，已整体回滚'),
    );

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    await user.click(within(rows[0]).getByRole('button', { name: /升级 alice 为管理员/ }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));

    const errorBar = await screen.findByTestId('role-error');
    expect(errorBar).toHaveTextContent('该操作会使管理员数量不为 1，已整体回滚');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('角色变更成功后刷新列表并给出内联提示', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    await user.click(within(rows[0]).getByRole('button', { name: /升级 alice 为管理员/ }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));

    const notice = await screen.findByTestId('role-notice');
    expect(notice).toHaveTextContent('alice');
    expect(notice).toHaveTextContent('管理员');
  });
});
