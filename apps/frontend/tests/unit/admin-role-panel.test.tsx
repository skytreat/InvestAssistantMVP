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
 * | A7 已有 admin 时升级按钮禁用 | 已有管理员时升级按钮禁用 |
 * | A8 自己那一行降级按钮禁用 + 文案 | 不能降级当前登录账号（按钮禁用）|
 * | A9 二次确认后才 `PATCH`（body = `{role:'admin'}`）| 角色变更需二次确认后才发请求 |
 * | 后端 400 → 内联错误条 | 后端拒绝时显示后端原文案 |
 *
 * ⚠️ **为什么「升级」用例的假数据里没有 admin**
 *
 * 后端 `routes/admin.ts` 的两条约束叠在一起：
 * - 「目标升 admin 时，检查是否已有**其他** admin」⇒ 操作者本人是 admin 时，
 *   给别人升 admin **必然** 400；
 * - 「禁止降级自己」⇒ 操作者也不能先把自己降下去。
 *
 * ⇒ 「库里已有 admin 时升级按钮禁用」不是前端保守，而是**后端的真实约束**。
 *   要让「升级」这条路径可达，假数据里必须**没有 admin 行**（此时才满足
 *   「除目标之外无 admin」），本用例据此构造。
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

  it('已有管理员时升级按钮禁用', async () => {
    renderWithRouter(<AdminRolePanel />);

    const rows = await screen.findAllByTestId('role-row');
    expect(rows).toHaveLength(2);

    const aliceRow = rows[1];
    const promote = within(aliceRow).getByRole('button', { name: '升级为管理员' });
    // A7：库中已有 admin ⇒ 升级按钮禁用
    expect(promote).toBeDisabled();
    // 文案与后端 400 文案口径一致
    expect(within(aliceRow).getByTestId('role-hint')).toHaveTextContent('已有管理员，请先降级现任管理员');
  });

  it('不能降级当前登录账号（按钮禁用）', async () => {
    renderWithRouter(<AdminRolePanel />);

    const rows = await screen.findAllByTestId('role-row');
    const selfRow = rows[0];
    expect(selfRow).toHaveTextContent('admin');

    const demote = within(selfRow).getByRole('button', { name: '降级为普通用户' });
    // A8：当前登录账号那一行的降级按钮禁用
    expect(demote).toBeDisabled();
    expect(within(selfRow).getByTestId('role-hint')).toHaveTextContent('不能降级当前登录账号');
  });

  it('角色变更需二次确认后才发请求', async () => {
    const user = userEvent.setup();
    // 库里没有 admin ⇒ 升级按钮可用
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    const promote = within(rows[0]).getByRole('button', { name: '升级为管理员' });
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

    await user.click(within(rows[0]).getByRole('button', { name: '升级为管理员' }));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('后端拒绝（400 PARAM_INVALID）→ 内联错误条显示后端原文案', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));
    patchMock.mockRejectedValueOnce(
      mockErrorResponse(400, 'PARAM_INVALID', '已有管理员，请先降级现任管理员'),
    );

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    await user.click(within(rows[0]).getByRole('button', { name: '升级为管理员' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));

    const errorBar = await screen.findByTestId('role-error');
    expect(errorBar).toHaveTextContent('已有管理员，请先降级现任管理员');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('角色变更成功后刷新列表并给出内联提示', async () => {
    const user = userEvent.setup();
    getMock.mockResolvedValue(mockResponse(USERS_WITHOUT_ADMIN));

    renderWithRouter(<AdminRolePanel />);
    const rows = await screen.findAllByTestId('role-row');

    await user.click(within(rows[0]).getByRole('button', { name: '升级为管理员' }));
    await user.click(screen.getByRole('button', { name: '确认变更' }));

    const notice = await screen.findByTestId('role-notice');
    expect(notice).toHaveTextContent('alice');
    expect(notice).toHaveTextContent('管理员');
  });
});
