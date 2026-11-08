/**
 * kline-overlay-merge.test.tsx — 画线加载的并发竞态（PR review 反馈）
 *
 * 场景：标注列表的加载请求还没返回时，用户点了「保存」或「删除」。
 * 若直接用 `setOverlays(rows)` 整体覆盖，就会出现「刚保存的消失 / 删掉的被刷回来」。
 *
 * 本文件从**页面层**验证接线（`klineOverlays.test.ts` 只验合并函数本身）：
 * 1. 加载进行中新增 → 返回快照不含它 ⇒ 保留；
 * 2. 加载进行中删除 → 返回快照仍带着它 ⇒ 排除。
 *
 * ⚠️ 图表组件用替身（真实绘制在 `kline-overlay-toolbar.test.tsx` 里验）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter, mockResponse } from '../helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    delete: mocks.delete,
    put: vi.fn(),
    patch: vi.fn(),
  },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/kline',
}));

/** 图表替身：把当前 overlays 的 id 暴露成属性，并提供两个模拟用户动作的按钮 */
vi.mock('../../src/components/KlineChart', () => ({
  default: (props: {
    overlays?: Array<{ id: number | string }>;
    onCreateOverlay?: (draft: unknown) => Promise<unknown>;
    onDeleteOverlay?: (id: number) => Promise<unknown>;
  }) => (
    <div
      data-testid="chart-stub"
      data-overlays={(props.overlays ?? []).map((item) => String(item.id)).join(',')}
    >
      <button
        data-testid="stub-save"
        onClick={() =>
          void props.onCreateOverlay?.({
            symbol: 'sh600000',
            period: 'day',
            name: 'horizontalStraightLine',
            points: [{ timestamp: Date.UTC(2026, 9, 12), value: 10 }],
            text: null,
          })
        }
      >
        save
      </button>
      <button data-testid="stub-delete" onClick={() => void props.onDeleteOverlay?.(1)}>
        delete
      </button>
    </div>
  ),
}));

/** 手动可解的 promise —— 用来制造「请求飞行中」窗口 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function serverOverlay(id: number) {
  return {
    id,
    symbol: 'sh600000',
    period: 'day',
    name: 'horizontalStraightLine',
    points: [{ timestamp: Date.UTC(2026, 9, 12), value: 10 }],
    text: null,
    created_at: '2026-10-12 10:00:00',
  };
}

function klinePayload() {
  const klines = [0, 1, 2].map((i) => {
    const close = Number((10 + i * 0.1).toFixed(2));
    return {
      date: new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      amount: 1000 * close,
    };
  });
  return {
    symbol: 'sh600000',
    fq: 'bfq',
    symbolClass: 'stock',
    klines,
    indicators: null,
    signals: [],
    trades: [],
  };
}

let overlayDeferred: ReturnType<typeof deferred<unknown>>;

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.delete.mockReset();
  overlayDeferred = deferred<unknown>();
  mocks.get.mockImplementation((url: string) => {
    // 标注列表故意挂起 —— 由用例决定何时返回旧快照
    if (url === '/kline-overlays') return overlayDeferred.promise;
    if (String(url).includes('/kline')) return Promise.resolve(mockResponse(klinePayload()));
    return Promise.resolve(mockResponse([]));
  });
});

/** 渲染 K 线页并把复权切到 bfq（画线只在不复权口径加载）+ 等加载请求发出 */
async function renderWithOverlayLoadPending() {
  const { default: Kline } = await import('../../src/pages/Kline');
  renderWithRouter(<Kline />, { initialEntries: ['/kline?symbol=sh600000'] });
  const user = userEvent.setup();
  const select = document.getElementById('kline-select-fq') as HTMLSelectElement;
  await user.selectOptions(select, 'bfq');
  await waitFor(() => expect(mocks.get.mock.calls.some((call) => call[0] === '/kline-overlays')).toBe(true));
  return user;
}

describe('画线加载的并发竞态', () => {
  it('加载进行中新增：返回快照不含新标注 ⇒ 保留本地新增（同 id 以服务端为准）', async () => {
    const user = await renderWithOverlayLoadPending();

    mocks.post.mockResolvedValueOnce(mockResponse(serverOverlay(5)));
    await user.click(screen.getByTestId('stub-save'));
    await waitFor(() => expect(screen.getByTestId('chart-stub')).toHaveAttribute('data-overlays', '5'));

    // 挂起中的请求此刻才返回「新增之前的旧快照」
    overlayDeferred.resolve(mockResponse([serverOverlay(1)]));
    await waitFor(() => expect(screen.getByTestId('chart-stub')).toHaveAttribute('data-overlays', '1,5'));
  });

  it('加载进行中删除：返回快照仍带已删 id ⇒ 排除，不刷回', async () => {
    const user = await renderWithOverlayLoadPending();

    mocks.delete.mockResolvedValueOnce(mockResponse(null));
    await user.click(screen.getByTestId('stub-delete'));

    overlayDeferred.resolve(mockResponse([serverOverlay(1), serverOverlay(2)]));
    await waitFor(() => expect(screen.getByTestId('chart-stub')).toHaveAttribute('data-overlays', '2'));
  });
});
