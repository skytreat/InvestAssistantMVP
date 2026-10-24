import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import AdminTriggerPanel from '../../src/components/AdminTriggerPanel';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

/**
 * Wave 7 · T75 ① · 管理员「手动触发」面板用例（PRD §5.7 行 269）
 *
 * 覆盖任务卡「卡 2」的验收断言：
 *
 * | 断言 | 用例 |
 * |---|---|
 * | 补跑行情更新需二次确认（确认前不发请求）| 手动补跑行情更新需二次确认 |
 * | 进度状态（已提交 / 补跑中 / 完成（通道：…））| 补跑过程显示进度状态且失败可重试 |
 * | 失败给【重试】（调用次数 = 2）| 同上 |
 * | 无原生 `alert` 残留 | 补跑过程不弹阻塞式 alert |
 */

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../../src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: postMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/admin',
}));

describe('Admin 触发面板', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue(mockResponse({ status: 'SUCCESS', method: 'tdx2db' }));
  });

  it('手动补跑行情更新需二次确认', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminTriggerPanel />);

    await user.click(screen.getByRole('button', { name: '立即补跑行情更新' }));

    // 二次确认弹窗出现（复用既有 ConfirmDialog）
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // 确认之前不得发请求
    expect(postMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认执行' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe('/admin/rerun-quotes');
  });

  it('补跑过程显示进度状态且失败可重试', async () => {
    const user = userEvent.setup();
    // 第一次补跑失败
    postMock.mockRejectedValueOnce(mockErrorResponse(500, 'INTERNAL_ERROR', 'tdx2db 通道不可用'));

    renderWithRouter(<AdminTriggerPanel />);
    await user.click(screen.getByRole('button', { name: '立即补跑行情更新' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));

    const errorBar = await screen.findByTestId('rerun-error');
    expect(errorBar).toHaveTextContent('tdx2db 通道不可用');

    // 进度轨迹：已提交 → 补跑中（失败前的两个阶段都留下了）
    const progress = screen.getByTestId('rerun-progress');
    expect(progress).toHaveTextContent('已提交');
    expect(progress).toHaveTextContent('补跑中');

    // 失败状态条带【重试】⇒ 再打一次
    await user.click(within(errorBar).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]?.[0]).toBe('/admin/rerun-quotes');
  });

  it('补跑成功时进度轨迹含「完成（通道：…）」', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminTriggerPanel />);

    await user.click(screen.getByRole('button', { name: '立即补跑行情更新' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));

    const progress = await screen.findByTestId('rerun-progress');
    await waitFor(() => expect(progress).toHaveTextContent('完成（通道：tdx2db）'));
    expect(progress).toHaveTextContent('已提交');
    expect(progress).toHaveTextContent('补跑中');
  });

  it('补跑过程不弹阻塞式 alert', async () => {
    const user = userEvent.setup();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    renderWithRouter(<AdminTriggerPanel />);
    await user.click(screen.getByRole('button', { name: '立即补跑行情更新' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    await screen.findByTestId('rerun-progress');

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('手动触发校验 / 信号同样需要二次确认', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AdminTriggerPanel />);

    await user.click(screen.getByRole('button', { name: '执行数据校验' }));
    expect(postMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe('/admin/datacheck/trigger');

    await user.click(screen.getByRole('button', { name: '执行信号生成' }));
    await user.click(screen.getByRole('button', { name: '确认执行' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]?.[0]).toBe('/admin/run-signal');
  });
});
