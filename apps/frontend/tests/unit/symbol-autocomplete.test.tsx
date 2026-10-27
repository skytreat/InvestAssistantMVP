import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import SymbolAutocomplete from '../../src/components/SymbolAutocomplete';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * V3.8 T142 · SymbolAutocomplete 增强（PRD_v3 §2.1/§2.2 · INV-S1-*）
 *
 * 覆盖：防抖 200ms / 10 条上限 / 现金类标签 / 唯一命中自动确认 / 确认态提示 / 键盘导航
 */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/trade',
}));

/** 受控 harness（组件 value/onChange 必须接外部 state）*/
function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <SymbolAutocomplete
      value={val}
      onChange={(v) => {
        setVal(v);
        onValue?.(v);
      }}
      id="sym-input"
    />
  );
}

function input(): HTMLInputElement {
  const el = document.getElementById('sym-input');
  if (!el) throw new Error('未找到标的输入框');
  return el as HTMLInputElement;
}

beforeEach(() => {
  getMock.mockReset();
});

describe('T142 · 防抖 200ms', () => {
  it('输入后 200ms 防抖窗口内不发请求，静默后才发', async () => {
    getMock.mockResolvedValue(mockResponse([]));
    renderWithRouter(<Harness />);
    const user = userEvent.setup();
    await user.type(input(), '60');
    await new Promise((r) => setTimeout(r, 60)); // 防抖窗口内采样
    expect(getMock).not.toHaveBeenCalled();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(getMock).toHaveBeenCalledWith('/symbols/search', { params: { q: '60' } });
  });

  it('连打 3 个字符 → 只发一次（取最后一次输入）', async () => {
    getMock.mockResolvedValue(mockResponse([]));
    renderWithRouter(<Harness />);
    const user = userEvent.setup();
    await user.type(input(), '600');
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(getMock.mock.calls[0][1]?.params.q).toBe('600');
  });
});

describe('T142 · 10 条上限', () => {
  it('后端返回 15 条 → 列表只渲染 10 条', async () => {
    getMock.mockResolvedValue(
      mockResponse(
        Array.from({ length: 15 }, (_, i) => ({ symbol: `sh60000${i}`, name: `股票${i}` })),
      ) as never,
    );
    renderWithRouter(<Harness />);
    const user = userEvent.setup();
    await user.type(input(), '60');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(10);
  });
});

describe('T142 · 现金类标签', () => {
  it('asset_class=cash 的候选显示「现金」徽标（risk 类不显示）', async () => {
    getMock.mockResolvedValue(
      mockResponse([
        { symbol: 'sh511880', name: '银华日利', asset_class: 'cash' },
        { symbol: 'sh600000', name: '浦发银行', asset_class: 'risk' },
      ]) as never,
    );
    renderWithRouter(<Harness />);
    const user = userEvent.setup();
    await user.type(input(), '银华');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByText('现金', { exact: true })).toHaveLength(1);
  });
});

describe('T142 · 唯一命中自动确认 + 确认态提示', () => {
  it('返回恰好 1 条 → 自动填入完整代码 + 显示「✓ 名称」确认态（不弹列表）', async () => {
    getMock.mockResolvedValue(
      mockResponse([{ symbol: 'sh600519', name: '贵州茅台', asset_class: 'risk' }]) as never,
    );
    const seen: string[] = [];
    renderWithRouter(<Harness onValue={(v) => seen.push(v)} />);
    const user = userEvent.setup();
    await user.type(input(), '茅台');
    await waitFor(() => expect(input().value).toBe('sh600519'));
    expect(screen.getByRole('status').textContent).toBe('✓ 贵州茅台');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(seen[seen.length - 1]).toBe('sh600519');
  });

  it('重新编辑 → 确认态清除', async () => {
    getMock.mockResolvedValue(mockResponse([{ symbol: 'sh600519', name: '贵州茅台' }] as never));
    renderWithRouter(<Harness />);
    const user = userEvent.setup();
    await user.type(input(), '茅台');
    await waitFor(() => expect(input().value).toBe('sh600519'));
    expect(screen.getByRole('status')).toBeInTheDocument();
    await user.type(input(), 'x');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('T142 · 键盘导航（↑↓/Enter/Esc 保留）', () => {
  it('ArrowDown 高亮第一项 + Enter 选中 → 填入代码并显示确认态', async () => {
    getMock.mockResolvedValue(
      mockResponse([
        { symbol: 'sh600000', name: '浦发银行' },
        { symbol: 'sh600519', name: '贵州茅台' },
      ]) as never,
    );
    renderWithRouter(<Harness />);
    const user = userEvent.setup();
    await user.type(input(), '60');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(input().value).toBe('sh600000'));
    expect(screen.getByRole('status').textContent).toBe('✓ 浦发银行');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
