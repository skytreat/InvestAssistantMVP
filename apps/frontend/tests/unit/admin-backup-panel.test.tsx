import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import AdminBackupPanel from '../../src/components/AdminBackupPanel';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

/**
 * Wave 7 · T75 ② · 管理员「备份与恢复」面板用例（关闭 F-A2）
 *
 * UX-10 起恢复入口**从日常备份表拆到独立「危险恢复区」**：
 * 桌上那份「点一下就能覆盖业务库」的按钮没了，改成
 * 选文件 → 手输文件名确认 → `ConfirmDialog` 二次确认。
 *
 * | 断言 | 用例 |
 * |---|---|
 * | A1 列表行数 / 日期 / 体积 | 列表显示日期与体积 |
 * | UX-10 日常列表无恢复入口 | 备份列表行内不再渲染「恢复」按钮 |
 * | UX-10 必须手输文件名 | 文件名不匹配时「恢复此备份」禁用 |
 * | UX-10 <1MB 备份警示 | 小体积备份显示风险提示 |
 * | A2 点恢复**不发请求** | 恢复前必须二次确认且请求体带 confirm:true |
 * | A3 确认后 body = `{ confirm: true }` | 同上 |
 * | A4 取消不发请求 | 取消确认不发恢复请求 |
 * | A5 400 CONFIRM_REQUIRED → 内联错误条 | 恢复被后端拒绝时显示内联错误条 |
 * | A6 失败状态条带重试（调用次数 = 2）| 失败状态条提供重试按钮 |
 * | A11 ConfirmDialog 带 `role="dialog"` | 恢复前必须二次确认且请求体带 confirm:true |
 * | 无原生 `alert` 残留 | 全程无阻塞式 alert |
 *
 * ⚠️ **本文件不 import `pages/Admin.tsx`** —— 面板是 props 驱动、页面无关的独立组件
 *    （Wave 7 的「组件并行、接线串行」拆法要求）。
 */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: {
    get: getMock,
    post: postMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/admin',
}));

/** 备份列表假数据（字段与后端 `GET /api/admin/backups` 一致）*/
const BACKUPS = [
  {
    name: 'business.db.2026-10-20',
    size: 12 * 1024 * 1024,
    modified: '2026-10-20T03:04:05.000Z',
  },
  {
    name: 'v_stock_qfq.2026-10-20.parquet',
    size: 5 * 1024 * 1024,
    modified: '2026-10-20T03:05:05.000Z',
  },
];

/**
 * 在「危险恢复区」选中备份 → 手输文件名 → 打开二次确认
 *
 * UX-10 之后恢复入口只剩这一条路径，多个用例共用。
 */
async function armRestore(user: ReturnType<typeof userEvent.setup>, fileName: string): Promise<void> {
  await user.selectOptions(screen.getByLabelText('选择备份'), fileName);
  await user.type(screen.getByLabelText('请输入上方文件名以确认恢复'), fileName);
  await user.click(screen.getByRole('button', { name: '恢复此备份' }));
}

describe('Admin 备份面板', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue(mockResponse(BACKUPS));
    postMock.mockResolvedValue(
      mockResponse({ sqlite: { success: true, size: 1024 }, duckdb: { success: true, size: 2048 } }),
    );
  });

  it('列表显示日期与体积', async () => {
    renderWithRouter(<AdminBackupPanel />);

    const rows = await screen.findAllByTestId('backup-row');
    // A1：行数 = 后端返回的备份条数
    expect(rows).toHaveLength(BACKUPS.length);

    // 文件名 + 可读体积（12 MB / 5 MB）
    expect(rows[0]).toHaveTextContent('business.db.2026-10-20');
    expect(rows[0]).toHaveTextContent('12.0 MB');
    expect(rows[1]).toHaveTextContent('v_stock_qfq.2026-10-20.parquet');
    expect(rows[1]).toHaveTextContent('5.0 MB');

    // 日期：只断言「形如 YYYY-MM-DD」，不写死时区（避免跨时区假红）
    expect(rows[0]).toHaveTextContent(/\d{4}-\d{2}-\d{2}/);
  });

  it('UX-10：日常备份列表不再内联「恢复」，恢复入口只在危险恢复区', async () => {
    renderWithRouter(<AdminBackupPanel />);

    const rows = await screen.findAllByTestId('backup-row');
    for (const row of rows) {
      expect(within(row).queryByRole('button', { name: '恢复' })).toBeNull();
    }

    expect(screen.getByTestId('admin-restore-zone')).toBeInTheDocument();
    expect(screen.getByText('危险恢复区')).toBeInTheDocument();
    expect(screen.getByLabelText('选择备份')).toBeInTheDocument();
    // 未选中文件时还没有「恢复此备份」按钮（必须先选）
    expect(screen.queryByRole('button', { name: '恢复此备份' })).toBeNull();
  });

  it('UX-10：文件名不匹配时「恢复此备份」禁用（不会误触覆盖业务库）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');

    await user.selectOptions(screen.getByLabelText('选择备份'), 'business.db.2026-10-20');

    // 未输入 → 禁用
    expect(screen.getByRole('button', { name: '恢复此备份' })).toBeDisabled();

    // 输入错误名字 → 仍禁用
    await user.type(screen.getByLabelText('请输入上方文件名以确认恢复'), 'business.db.2026-10-19');
    expect(screen.getByRole('button', { name: '恢复此备份' })).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('UX-10：<1MB 的备份显示体积异常警示', async () => {
    getMock.mockResolvedValue(
      mockResponse([
        {
          name: 'business.db.2026-10-01',
          size: 200 * 1024,
          modified: '2026-10-01T03:04:05.000Z',
        },
      ]),
    );
    const user = userEvent.setup();
    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');

    await user.selectOptions(screen.getByLabelText('选择备份'), 'business.db.2026-10-01');
    expect(screen.getByTestId('restore-small-warning')).toHaveTextContent('不足 1MB');
    expect(screen.getByTestId('restore-pick-info')).toHaveTextContent('200.0 KB');
  });

  it('恢复前必须二次确认且请求体带 confirm:true', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminBackupPanel />);

    await screen.findAllByTestId('backup-row');
    await armRestore(user, 'business.db.2026-10-20');

    // A11：复用的是既有 ConfirmDialog（带 role=dialog），不是自造的裸遮罩
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('备份时间');
    expect(screen.getByRole('dialog')).toHaveTextContent('12.0 MB');

    // A2：确认之前**不得**发出恢复请求
    expect(postMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认恢复' }));

    // A3：确认后才发请求，且 body 必须是 `{ confirm: true }`（深比较）
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe('/admin/backup/business.db.2026-10-20/restore');
    expect(postMock.mock.calls[0]?.[1]).toEqual({ confirm: true });
  });

  it('取消确认不发恢复请求', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminBackupPanel />);

    await screen.findAllByTestId('backup-row');
    await armRestore(user, 'business.db.2026-10-20');
    await user.click(screen.getByRole('button', { name: '取消' }));

    // A4：取消后既不发请求，也不留弹窗
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('DuckDB 关闭（skipped）→ 显示「已跳过（配置关闭）」而非成功/失败', async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValueOnce(
      mockResponse({
        sqlite: { success: true, size: 1024 },
        duckdb: { success: true, skipped: true },
      }),
    );

    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');

    await user.click(screen.getByRole('button', { name: '立即备份' }));

    const notice = await screen.findByTestId('backup-notice');
    expect(notice).toHaveTextContent('业务库 成功');
    expect(notice).toHaveTextContent('行情库 已跳过（配置关闭）');
    expect(notice).not.toHaveTextContent('行情库 成功');
    expect(notice).not.toHaveTextContent('行情库 失败');
  });

  it('失败状态条提供重试按钮', async () => {
    const user = userEvent.setup();
    // 第一次备份失败（磁盘满），之后成功
    postMock.mockRejectedValueOnce(mockErrorResponse(500, 'INTERNAL_ERROR', '磁盘已满'));

    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');

    await user.click(screen.getByRole('button', { name: '立即备份' }));

    const errorBar = await screen.findByTestId('backup-error');
    expect(errorBar).toHaveTextContent('磁盘已满');

    // A6：失败状态条带【重试】，点它再打一次 `POST /api/admin/backup`
    await user.click(within(errorBar).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[0]?.[0]).toBe('/admin/backup');
    expect(postMock.mock.calls[1]?.[0]).toBe('/admin/backup');
    await screen.findByTestId('backup-notice');
  });

  it('全程无阻塞式 alert（DOM 中无 dialog 弹窗）', async () => {
    const user = userEvent.setup();
    // jsdom 的 window.alert 默认是「未实现」桩；这里替换成 spy 才能真正断言「没被调用」
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');

    // 备份
    await user.click(screen.getByRole('button', { name: '立即备份' }));
    await screen.findByTestId('backup-notice');

    // 恢复
    // ⚠️ 备份成功后会刷新列表（DOM 被替换）⇒ 危险区选择框同样重新挂载，重新选一次即可
    await armRestore(user, 'business.db.2026-10-20');
    await user.click(screen.getByRole('button', { name: '确认恢复' }));
    await screen.findByTestId('restore-notice');

    // 🔴 阻塞式弹窗已被页面内状态条取代
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('恢复被后端拒绝（400 CONFIRM_REQUIRED）→ 内联错误条，不弹窗', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValueOnce(
      mockErrorResponse(
        400,
        'CONFIRM_REQUIRED',
        '恢复备份会覆盖当前业务库，请传 { "confirm": true } 二次确认',
      ),
    );

    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');
    await armRestore(user, 'business.db.2026-10-20');
    await user.click(screen.getByRole('button', { name: '确认恢复' }));

    // A5：错误落成内联错误条
    const errorBar = await screen.findByTestId('restore-error');
    expect(errorBar).toHaveTextContent('二次确认');
    // 不再有弹窗残留
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('恢复失败的状态条也带重试按钮（重试会重新走二次确认）', async () => {
    const user = userEvent.setup();
    postMock.mockRejectedValueOnce(mockErrorResponse(400, 'RESTORE_FAILED', '备份文件不存在'));

    renderWithRouter(<AdminBackupPanel />);
    await screen.findAllByTestId('backup-row');
    await armRestore(user, 'business.db.2026-10-20');
    await user.click(screen.getByRole('button', { name: '确认恢复' }));

    const errorBar = await screen.findByTestId('restore-error');
    expect(errorBar).toHaveTextContent('备份文件不存在');

    // 恢复是破坏性操作 ⇒ 重试**重新弹确认框**，不静默重发
    await user.click(within(errorBar).getByRole('button', { name: '重试' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('UX-10：不可恢复的文件（parquet / 安全备份）不出现在恢复下拉', async () => {
    getMock.mockResolvedValue(
      mockResponse([
        ...BACKUPS,
        {
          name: 'business.db.2026-10-19.pre-restore-1760000000000',
          size: 1024,
          modified: '2026-10-19T03:04:05.000Z',
        },
      ]),
    );
    renderWithRouter(<AdminBackupPanel />);

    const rows = await screen.findAllByTestId('backup-row');
    expect(rows).toHaveLength(3);

    // 恢复下拉里只有符合后端白名单的 sqlite 备份
    const select = screen.getByLabelText('选择备份') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['', 'business.db.2026-10-20']);
  });
});
