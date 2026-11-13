import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, render, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import WatchButton from '../../src/components/WatchButton';
import { useWatchStore } from '../../src/store/watch';
import { mockResponse } from '../helpers';

/**
 * 自选按钮 + 共享 store（`store/watch.ts` / `components/WatchButton.tsx`）
 *
 * 覆盖：
 * - 未自选 → 「加自选」→ `POST /api/watch` → 按钮变「已自选 ✓」
 * - 已自选 → 点击 → `DELETE /api/watch/:code` → 按钮变「加自选」
 * - 标的代码为空 → 不渲染按钮
 * - `GET /api/watch` 决定初始态（懒加载）
 */

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/kline',
}));

/** 重置 store（用例间互不串扰：它是模块级单例） */
function resetStore(codes: string[] = []) {
  useWatchStore.setState({ codes, loaded: true, loading: false, pendingCode: null, message: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(mockResponse([]));
  postMock.mockResolvedValue(mockResponse({ id: 1 }));
  deleteMock.mockResolvedValue(mockResponse(null));
});

afterEach(() => {
  cleanup();
  resetStore();
});

describe('WatchButton + useWatchStore', () => {
  it('未自选：点「加自选」→ POST /api/watch，按钮变「已自选 ✓」', async () => {
    const user = userEvent.setup();
    resetStore([]);
    render(<WatchButton assetCode="sh600519" />);

    const button = screen.getByTestId('watch-toggle');
    expect(button).toHaveTextContent('加自选');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    await user.click(button);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe('/watch');
    expect(postMock.mock.calls[0]?.[1]).toEqual({ asset_code: 'sh600519' });

    await waitFor(() => expect(button).toHaveTextContent('已自选'));
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('已自选：点「已自选 ✓」→ DELETE /api/watch/:code，按钮变「加自选」', async () => {
    const user = userEvent.setup();
    resetStore(['sh600519']);
    render(<WatchButton assetCode="sh600519" />);

    const button = screen.getByTestId('watch-toggle');
    expect(button).toHaveTextContent('已自选');

    await user.click(button);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock.mock.calls[0]?.[0]).toBe('/watch/sh600519');

    await waitFor(() => expect(button).toHaveTextContent('加自选'));
  });

  it('标的代码为空：不渲染按钮', () => {
    resetStore([]);
    const { container } = render(<WatchButton assetCode="   " />);
    expect(container).toBeEmptyDOMElement();
  });

  it('409 DUPLICATE（已在自选）：视为成功并同步本地态（不报错）', async () => {
    const user = userEvent.setup();
    resetStore([]);
    postMock.mockRejectedValue({ response: { status: 409 }, message: 'sh600519 已在 watch 列表' });
    render(<WatchButton assetCode="sh600519" />);

    await user.click(screen.getByTestId('watch-toggle'));
    await waitFor(() => expect(useWatchStore.getState().codes).toContain('sh600519'));
    expect(useWatchStore.getState().message).toContain('已在自选');
  });

  it('5xx / 网络失败：只提示、**不改**本地 codes（避免「本地以为加了、服务端其实没有」的幻读）', async () => {
    const user = userEvent.setup();
    resetStore([]);
    postMock.mockRejectedValue({ response: { status: 500 }, message: '服务异常' });
    render(<WatchButton assetCode="sh600519" />);

    await user.click(screen.getByTestId('watch-toggle'));
    await waitFor(() => expect(useWatchStore.getState().pendingCode).toBeNull());
    // 失败 ⇒ 本地 codes 仍为空（按钮还是「加自选」，没被误判成已自选）
    expect(useWatchStore.getState().codes).not.toContain('sh600519');
    expect(useWatchStore.getState().message).toContain('加入自选失败');
    expect(screen.getByTestId('watch-toggle')).toHaveAttribute('aria-pressed', 'false');
  });
});
