import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Spinner from '../../src/components/Spinner';
import EmptyState from '../../src/components/EmptyState';
import ConfirmDialog from '../../src/components/ConfirmDialog';
import Dashboard from '../../src/pages/Dashboard';
import Admin from '../../src/pages/Admin';
import Review from '../../src/pages/Review';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * T65 · 共享 UI 组件（Spinner / EmptyState / ConfirmDialog）用例
 *
 * 覆盖三条主线：
 * 1. **Spinner** —— 无障碍语义（role=status / aria-live / aria-label）、
 *    `size` / `label` / `inline` 三个 prop 的实际效果、动画确实挂上了。
 * 2. **EmptyState** —— 纯容器：title / description / icon / action 由调用方给，
 *    组件本身**不内置任何业务文案**（缺 description 时不能报错）。
 * 3. **ConfirmDialog** —— `open=false` 不渲染任何 DOM、`role=dialog` + `aria-modal`
 *    + `aria-labelledby`、取消 / 确认 / ESC 三条关闭路径、danger 态按钮配色。
 *
 * 另有一条**回归线**：加载区（Dashboard / Admin / Review）必须渲染出 `role="status"`，
 * 而不是裸的 `<div>加载中...</div>` —— 这是 T65 的核心交付（12 处加载文案替换）。
 */

/* ────────────────────────── api mock（加载区回归用） ────────────────────────── */

/** api.get 的第二个参数（axios config），本文件只关心 url */
interface ApiGetConfig {
  params?: Record<string, unknown>;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/** 永不 resolve 的 promise —— 让页面停在「加载中」状态 */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/* ────────────────────────── 小工具 ────────────────────────── */

/**
 * 读取 inline style 的 background 并归一化成 6 位小写 hex
 *
 * jsdom 会把 `#dc2626` 归一化成 `rgb(220, 38, 38)`，直接比对 hex 字面量会失败。
 */
function bg(el: HTMLElement): string {
  const raw = el.style.background.trim().toLowerCase();
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    return hex.length === 3
      ? `#${hex
          .split('')
          .map((c) => c + c)
          .join('')}`
      : `#${hex}`;
  }
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(raw);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]];
    return `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  return raw;
}

/* ────────────────────────── Spinner ────────────────────────── */

describe('T65 · Spinner', () => {
  it('渲染出 role="status" + aria-live="polite" + aria-label（默认「加载中...」）', () => {
    render(<Spinner />);

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-label', '加载中...');
    // 无障碍名即 aria-label
    expect(screen.getByRole('status', { name: '加载中...' })).toBe(status);
  });

  it('可见文案与 aria-label 一致（读屏不会读成两遍）', () => {
    render(<Spinner />);

    // 可见文案节点标了 aria-hidden，避免与容器 aria-label 重复播报
    const visible = screen.getByText('加载中...');
    expect(visible).toBeInTheDocument();
    expect(visible).toHaveAttribute('aria-hidden', 'true');
  });

  it('size 生效：圆环宽高 = size（默认 24）', () => {
    const { rerender } = render(<Spinner />);

    const ring = screen.getByTestId('spinner-ring');
    expect(ring.style.width).toBe('24px');
    expect(ring.style.height).toBe('24px');

    rerender(<Spinner size={40} />);
    expect(screen.getByTestId('spinner-ring').style.width).toBe('40px');
    expect(screen.getByTestId('spinner-ring').style.height).toBe('40px');
  });

  it('label 自定义生效（aria-label + 可见文案同时换）', () => {
    render(<Spinner label="查询中..." />);

    expect(screen.getByRole('status', { name: '查询中...' })).toBeInTheDocument();
    expect(screen.getByText('查询中...')).toBeInTheDocument();
    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
  });

  it('inline 模式：容器 display 变 inline-flex（与相邻文字同一行）', () => {
    const { rerender } = render(<Spinner />);

    expect(screen.getByTestId('spinner').style.display).toBe('flex');

    rerender(<Spinner inline />);
    expect(screen.getByTestId('spinner').style.display).toBe('inline-flex');
  });

  it('动画确实挂上了（animation 引用 global.css 里的 @keyframes spin）', () => {
    render(<Spinner />);

    const ring = screen.getByTestId('spinner-ring');
    expect(ring.style.animation).toContain('spin');
    // 圆环本体是「border + 异色 border-top」实现，不引第三方动画库
    expect(ring.style.borderTopColor).not.toBe('');
  });
});

/* ────────────────────────── EmptyState ────────────────────────── */

describe('T65 · EmptyState', () => {
  it('渲染 title / description / action', () => {
    render(
      <EmptyState
        title="暂无持仓"
        description="添加一笔交易后这里会显示持仓明细"
        action={<button>去添加</button>}
      />,
    );

    expect(screen.getByText('暂无持仓')).toBeInTheDocument();
    expect(screen.getByText('添加一笔交易后这里会显示持仓明细')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去添加' })).toBeInTheDocument();
  });

  it('无 description 时不报错（且不渲染空描述节点）', () => {
    const { container } = render(<EmptyState title="暂无数据" />);

    expect(screen.getByText('暂无数据')).toBeInTheDocument();
    // 除标题外不该有第二个文本节点
    expect(container.textContent).toBe('暂无数据');
  });

  it('icon 传入时渲染出来（装饰性图标对读屏隐藏）', () => {
    render(<EmptyState title="暂无信号" icon="📊" />);

    // 图标节点本身就是带 aria-hidden 的容器
    const icon = screen.getByText('📊');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('容器是居中布局（text-align: center）', () => {
    const { container } = render(<EmptyState title="暂无数据" />);

    const root = container.firstElementChild as HTMLElement;
    expect(root.style.textAlign).toBe('center');
    expect(root.style.alignItems).toBe('center');
  });
});

/* ────────────────────────── ConfirmDialog ────────────────────────── */

describe('T65 · ConfirmDialog', () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onConfirm.mockReset();
    onCancel.mockReset();
  });

  it('open=false 时不渲染任何 DOM', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />,
    );

    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('open=true 时有 role="dialog" + aria-modal="true" + aria-labelledby 指向标题', () => {
    render(
      <ConfirmDialog
        open
        title="确认删除？"
        message="删除后不可恢复"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy as string);
    expect(titleEl?.textContent).toBe('确认删除？');

    // 正文通过 aria-describedby 关联
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe('删除后不可恢复');
  });

  it('点「取消」→ 触发 onCancel（不触发 onConfirm）', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('点「确认」→ 触发 onConfirm（不触发 onCancel）', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: '确认' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('按 ESC → 触发 onCancel', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('按其它键 → 不触发 onCancel（只认 ESC）', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);

    await user.keyboard('{Enter}');
    await user.keyboard('a');

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('按钮文案可自定义', () => {
    render(
      <ConfirmDialog
        open
        title="确认软删除？"
        confirmText="删除"
        cancelText="再想想"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再想想' })).toBeInTheDocument();
  });

  it('danger 时确认按钮是危险色（COLORS.danger），普通态是主色', () => {
    const { rerender } = render(
      <ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />,
    );

    expect(bg(screen.getByRole('button', { name: '确认' }))).toBe('#2563eb');

    rerender(<ConfirmDialog open danger title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);

    expect(bg(screen.getByRole('button', { name: '确认' }))).toBe('#dc2626');
  });

  it('遮罩 + 居中卡片（role=dialog 在遮罩内，遮罩色 = COLORS.maskOverlay）', () => {
    render(<ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);

    const dialog = screen.getByRole('dialog');
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.background).toContain('rgba(0, 0, 0, 0.5)');
    expect(overlay.style.display).toBe('flex');
  });

  it('关闭后（open=false）DOM 被移除', () => {
    const { rerender } = render(
      <ConfirmDialog open title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(<ConfirmDialog open={false} title="确认删除？" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/* ───────────────────── 加载区替换回归（12 处加载文案） ───────────────────── */

describe('T65 · 加载区替换为 Spinner', () => {
  beforeEach(() => {
    getMock.mockReset();
    // 所有请求都不返回 → 页面停在 loading 态
    getMock.mockImplementation(() => pending());
    useUserStore.setState({ role: 'user', token: null, username: null });
  });

  it('Dashboard 加载态渲染出 role="status"（不再是裸 div 文本）', async () => {
    renderWithRouter(<Dashboard />);

    const statuses = await screen.findAllByRole('status');
    // 资产快照 / 持仓 / 信号 三处加载区
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    for (const s of statuses) {
      expect(s).toHaveAttribute('aria-label', '加载中...');
    }

    // 可见文案仍在（只是从裸 div 换成了 Spinner 内部节点）
    expect(screen.getAllByText('加载中...').length).toBe(statuses.length);
  });

  it('Admin 加载态渲染出 role="status"', async () => {
    renderWithRouter(<Admin />);

    const statuses = await screen.findAllByRole('status');
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]).toHaveAttribute('aria-label', '加载中...');
  });

  it('Review 加载态渲染出 role="status"（收益曲线 + 交易列表两处）', async () => {
    renderWithRouter(<Review />);

    const statuses = await screen.findAllByRole('status');
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    for (const s of statuses) {
      expect(s).toHaveAttribute('aria-label', '加载中...');
    }
  });

  it('Review 统计未到达时渲染 `--` 而不是 0', async () => {
    renderWithRouter(<Review />);

    // 「总交易数」卡片：统计接口未返回 → 显示 `--`
    const totalLabel = await screen.findByText('总交易数');
    const valueEl = totalLabel.parentElement?.firstElementChild;
    expect(valueEl?.textContent).toBe('--');

    // 「已复盘」同理
    const reviewedLabel = screen.getByText('已复盘');
    expect(reviewedLabel.parentElement?.firstElementChild?.textContent).toBe('--');
  });

  it('Review 统计已到达且计数为 0 时仍显示 0（0 是有效值，不被改成 --）', async () => {
    getMock.mockImplementation(async (url: string) => {
      switch (url) {
        case '/review/yield':
          return mockResponse({
            totalTrades: 0,
            reviewedCount: 0,
            closedCount: 0,
            winCount: 0,
            lossCount: 0,
            winRate: null,
            avgWin: null,
            avgLoss: null,
            profitLossRatio: null,
            totalRealizedPnl: 0,
          });
        case '/review/trades':
          return mockResponse([], { pagination: { totalPages: 1, total: 0 } });
        case '/asset-stat/history':
          return mockResponse([]);
        default:
          throw new Error(`未预期的接口调用: ${url}`);
      }
    });

    renderWithRouter(<Review />);

    const totalLabel = await screen.findByText('总交易数');
    expect(totalLabel.parentElement?.firstElementChild?.textContent).toBe('0');

    const reviewedLabel = screen.getByText('已复盘');
    expect(reviewedLabel.parentElement?.firstElementChild?.textContent).toBe('0');

    // 统计明细行同样是 0，而不是 --
    expect(await screen.findByText(/平仓 0 笔（盈利 0 \/ 亏损 0）/)).toBeInTheDocument();
  });

  it('Review 统计字段缺失（null）时明细行渲染 `--`', async () => {
    getMock.mockImplementation(async (url: string) => {
      switch (url) {
        case '/review/yield':
          return mockResponse({
            totalTrades: 1,
            reviewedCount: 1,
            // 后端正常不会返回 null，这里模拟脏数据
            closedCount: null as unknown as number,
            winCount: null as unknown as number,
            lossCount: null as unknown as number,
            winRate: null,
            avgWin: null,
            avgLoss: null,
            profitLossRatio: null,
            totalRealizedPnl: 0,
          });
        case '/review/trades':
          return mockResponse([], { pagination: { totalPages: 1, total: 0 } });
        case '/asset-stat/history':
          return mockResponse([]);
        default:
          throw new Error(`未预期的接口调用: ${url}`);
      }
    });

    renderWithRouter(<Review />);

    expect(await screen.findByText(/平仓 -- 笔（盈利 -- \/ 亏损 --）/)).toBeInTheDocument();
  });
});

/* ────────────────────────── 组件与页面混用 ────────────────────────── */

describe('T65 · Spinner 与既有页面组件混用', () => {
  it('Spinner 可放进卡片容器里（不破坏卡片结构）', () => {
    render(
      <div style={{ padding: 16 }}>
        <Spinner inline label="查询中..." />
      </div>,
    );

    const wrapper = screen.getByTestId('spinner');
    expect(wrapper.parentElement).toHaveStyle({ padding: '16px' });
    expect(within(wrapper).getByText('查询中...')).toBeInTheDocument();
  });
});
