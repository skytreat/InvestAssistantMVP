import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePluginNames } from '../../src/components/usePluginNames';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

beforeEach(() => {
  getMock.mockReset();
});

describe('usePluginNames', () => {
  it('api.get 正常返回 → 建立 plugin_id → 中文名映射', async () => {
    getMock.mockResolvedValue({
      data: {
        code: 0,
        data: [
          { id: 'rsi_oversold', name: 'RSI 超买超卖' },
          { id: 'macd_cross', name: 'MACD 金叉死叉' },
          { id: 123, name: '跳过：id 非字符串' },
          { id: 'missing_name', name: 0 },
        ],
      },
    });

    const { result } = renderHook(() => usePluginNames());
    await waitFor(() => expect(result.current.pluginNameMap.size).toBe(3));

    expect(result.current.pluginNameMap.get('rsi_oversold')).toBe('RSI 超买超卖');
    expect(result.current.pluginNameOf('macd_cross')).toBe('MACD 金叉死叉');
    expect(result.current.pluginNameOf('missing_name')).toBe('missing_name');
    expect(result.current.pluginNameOf('unknown')).toBe('unknown');
    expect(result.current.pluginNameOf(null, '—')).toBe('—');
    expect(result.current.pluginNameOf(undefined, 'dash')).toBe('dash');
  });

  it('api.get 未实现（测试 mock 返回 undefined）→ 静默降级，不抛错', async () => {
    getMock.mockImplementation(() => undefined);

    const { result } = renderHook(() => usePluginNames());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pluginNameMap.size).toBe(0);
    expect(result.current.pluginNameOf('abc')).toBe('abc');
  });

  it('后端返回失败 envelope → 不建映射', async () => {
    getMock.mockResolvedValue({ data: { code: 'INTERNAL_ERROR', data: [] } });

    const { result } = renderHook(() => usePluginNames());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pluginNameMap.size).toBe(0);
  });

  it('data 不是数组 → 不建映射', async () => {
    getMock.mockResolvedValue({ data: { code: 0, data: { id: 'x', name: 'y' } } });

    const { result } = renderHook(() => usePluginNames());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pluginNameMap.size).toBe(0);
  });

  it('api.get reject → 静默降级', async () => {
    getMock.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => usePluginNames());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.pluginNameMap.size).toBe(0);
  });

  it('组件卸载后 promise 才 resolve → 不再 setState', async () => {
    let resolveFn: ((v: unknown) => void) | undefined;
    getMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFn = res;
        }),
    );

    const { result, unmount } = renderHook(() => usePluginNames());
    unmount();

    await act(async () => {
      resolveFn?.({ data: { code: 0, data: [{ id: 'late', name: '晚到' }] } });
    });

    expect(result.current.pluginNameMap.size).toBe(0);
  });
});
