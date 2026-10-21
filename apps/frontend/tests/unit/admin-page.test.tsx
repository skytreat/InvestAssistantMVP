/**
 * Admin 页级集成用例（Wave 7 · 卡 6 接线收口）
 *
 * 对应任务卡：`docs/audit/wave-7-task-cards.md` 卡 6。
 *
 * ## 这个文件守的是「接线」本身的 4 件事
 *
 * 1. **旧的内联块真的没了** —— 页面由 5 个新组件拼成（不再有内联的
 *    6 列日志表 / 校验卡片 / 备份区 / 角色区 / 手动触发区）；
 * 2. **`alert()` 归零** —— 旧实现有 2 处阻塞式 `alert()`（备份成功/失败），
 *    既打断读屏用户，又承载不了「失败后重试」；
 * 3. **G7.6 的展示面** —— 校验卡片**恒为 12 张**（不是空态、不是 2 张）；
 * 4. **G7.7 的结构层** —— 日志区在 `<768px` 走**卡片分支**（不渲染 `<table>`），
 *    `≥768px` 才渲染表格（横向滚动容器 + 截断）。
 *
 * ⚠️ 各组件的**内部行为**（筛选参数、二次确认、请求体）由各自的组件用例覆盖
 *   （`admin-log-panel` / `admin-backup-panel` / `admin-role-panel` /
 *   `admin-trigger-panel` / `datacheck-cards`）—— 本文件只管**页面级接线**。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Admin from '../../src/pages/Admin';
import { mockResponse } from '../helpers';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, put: vi.fn(), delete: vi.fn() },
}));

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** 12 项校验结果（名称由后端下发，前端只渲染）*/
const CHECK_ITEMS = Array.from({ length: 12 }, (_, i) => ({
  checkId: `C${i + 1}`,
  name: `校验名称 C${i + 1}`,
  result: 'PASS',
  message: `C${i + 1} PASS`,
  detail: null,
}));

/** 系统日志一行（`message` 故意很长 —— 旧实现的无滚动容器就是被它撑破的）*/
const LONG_PATH = '/var/log/invol/quotes.duckdb.backup.2026-10-20.very.long.path.name.parquet';
const LOG_ROWS = [
  {
    id: 1,
    log_date: '2026-10-20',
    log_type: 'datacheck',
    level: 'INFO',
    check_item: 'C1',
    message: LONG_PATH,
    detail: LONG_PATH,
  },
];

/** 备份列表一行 */
const BACKUPS = [
  { name: 'business.db.2026-10-20', size: 1048576, modified: '2026-10-20T17:05:00.000Z' },
  { name: 'v_stock_qfq.2026-10-20.parquet', size: 2048, modified: '2026-10-20T17:05:00.000Z' },
];

/** 用户列表 */
const USERS = [{ id: 1, username: 'admin', role: 'admin', created_at: '2026-10-01 10:00:00' }];

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();

  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/admin/datacheck/result':
        return mockResponse(CHECK_ITEMS);
      case '/admin/system-log':
        return mockResponse(LOG_ROWS, { pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
      case '/admin/system-log/fallback':
        return mockResponse({ exists: false, lines: [] });
      case '/admin/backups':
        return mockResponse(BACKUPS);
      case '/admin/users':
        return mockResponse(USERS);
      default:
        return mockResponse([]);
    }
  });
  postMock.mockResolvedValue(mockResponse(null));
  patchMock.mockResolvedValue(mockResponse(null));
});

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('Admin 页：接线（卡 6）', () => {
  it('Admin 页：渲染五个面板（日志/触发/备份/角色/校验卡片）且无 alert', async () => {
    render(<Admin />);

    // ① 校验仪表盘（组件自带卡片框与标题）
    await waitFor(() => expect(screen.getAllByTestId('datacheck-card')).toHaveLength(12));
    expect(screen.getByText('数据校验结果（C1-C12）— 点击卡片查看详情')).toBeInTheDocument();

    // ② 手动触发面板（行情更新补跑 / 数据校验 / 信号生成）
    //    ⚠️ 用 `selector: 'div'` 排除日志类型下拉里的 `<option>手动触发</option>`
    expect(screen.getByText('手动触发', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即补跑行情更新' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '执行数据校验' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '执行信号生成' })).toBeInTheDocument();

    // ③ 备份与恢复面板
    expect(screen.getByText('备份与恢复')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即备份' })).toBeInTheDocument();

    // ④ 角色管理面板
    expect(screen.getByText('角色管理')).toBeInTheDocument();
    expect(await screen.findByText('admin')).toBeInTheDocument();

    // ⑤ 系统日志面板（组件自带卡片框与 `<h2>` 标题）
    expect(screen.getByTestId('admin-log-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '系统日志' })).toBeInTheDocument();

    // 🔴 **旧的内联块必须已经消失**（接线不是「新增」，是「替换」）
    //    判据不是「没有日志表」（新组件也有表），而是**结构变了**：
    //    - 旧的日志表**没有** `role="region"` 滚动容器 → 现在必须有；
    //    - 旧的标题是 `<div>` → 现在是 `<h2>`（上面已断言）。
    expect(screen.getByRole('region', { name: '系统日志表' })).toBeInTheDocument();
    // 旧的「执行备份」按钮（阻塞式 alert 反馈的那个）已经没有了
    expect(screen.queryByRole('button', { name: '执行备份' })).toBeNull();
    // 旧的「行情更新补跑」卡片标题已并入「手动触发」面板
    expect(screen.queryByText('行情更新补跑（Requirements §5.1 管理员手动补跑）')).toBeNull();

    // 🔴 **alert() 归零** —— 旧实现有 2 处阻塞式弹窗
    const alertSpy = vi.spyOn(window, 'alert');
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('Admin 页：校验卡片渲染 12 张且每张带 checkId 与名称（G7.6 展示面）', async () => {
    render(<Admin />);
    await waitFor(() => expect(screen.getAllByTestId('datacheck-card')).toHaveLength(12));

    const cards = screen.getAllByTestId('datacheck-card');
    expect(cards.map((c) => c.getAttribute('data-check-id'))).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'C9',
      'C10',
      'C11',
      'C12',
    ]);
    for (const card of cards) {
      expect(card.textContent).toContain('校验名称');
    }
  });

  it('Admin 页：手动触发校验成功后刷新校验卡片（接线的数据流）', async () => {
    const user = userEvent.setup();
    render(<Admin />);
    await waitFor(() => expect(screen.getAllByTestId('datacheck-card')).toHaveLength(12));

    const before = getMock.mock.calls.filter((c) => c[0] === '/admin/datacheck/result').length;

    // 点「执行数据校验」→ 二次确认 → 确认
    await user.click(screen.getByRole('button', { name: '执行数据校验' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '确认执行' }));

    await waitFor(() => {
      const after = getMock.mock.calls.filter((c) => c[0] === '/admin/datacheck/result').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('Admin 页：日志区在 <768px 走卡片分支、不渲染 table（G7.7 结构层）', async () => {
    const originalWidth = window.innerWidth;
    // ⚠️ 只改 `innerWidth`、**不派发 resize**：组件在挂载时读一次 `window.innerWidth`
    //   决定分支（`useIsNarrowViewport` 的初值），派发事件反而会在 act 之外触发更新。
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });

    try {
      render(<Admin />);
      await waitFor(() => expect(screen.getByTestId('admin-log-cards')).toBeInTheDocument());
      // 窄视口：日志区**不渲染** `<table>`（读屏不该把同一份内容读两遍）
      expect(screen.queryByTestId('admin-log-panel')?.querySelector('table')).toBeNull();
      // 备份列表 / 用户列表仍是表格（它们各自套了 `ScrollableTable` 滚动容器）
      expect(screen.getByRole('table', { name: '备份列表' })).toBeInTheDocument();
      expect(screen.getByRole('table', { name: '用户列表' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: originalWidth,
        configurable: true,
        writable: true,
      });
    }
  });

  it('Admin 页：日志表在 ≥768px 渲染表格且套在滚动容器内', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true });

    try {
      render(<Admin />);
      await waitFor(() => expect(screen.getByRole('table', { name: '系统日志' })).toBeInTheDocument());
      expect(screen.queryByTestId('admin-log-cards')).toBeNull();

      // 滚动容器带 `role="region"` + `aria-label` + `tabIndex=0`
      const region = screen.getByRole('region', { name: '系统日志表' });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(region.querySelector('table')).not.toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: originalWidth,
        configurable: true,
        writable: true,
      });
    }
  });
});
