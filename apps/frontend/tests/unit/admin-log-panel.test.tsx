import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import AdminLogPanel, { LOG_TYPE_LABEL } from '../../src/components/AdminLogPanel';
import { mockResponse, renderWithRouter } from '../helpers';
import { expectNoCriticalA11yViolations, runA11y } from '../helpers/a11y';

/**
 * Wave 7 · 卡 1 —— Admin 日志面板（`components/AdminLogPanel.tsx`）
 *
 * 覆盖卡 1 的验收断言 A1~A8：
 *
 * | 断言 | 含义 | 用例 |
 * |---|---|---|
 * | A1 | 三类筛选参数正确传入请求 | 用例 1 |
 * | A2 | 只选类型时 `level` **不在** params 里（不是空串） | 用例 1 |
 * | A3 | 筛选变化 → `page` 重置为 1 | 用例 2 |
 * | A4 | 表格祖先链上有 `role="region"` + `aria-label` 的滚动容器 | 用例 3 |
 * | A5 | 长文本单元格带 `title` 全文 + 截断样式 | 用例 3 / 用例 6 |
 * | A6 | `innerWidth=375` → 无 `<table>`，走卡片分支 | 用例 4 |
 * | A7 | `innerWidth=1024` → 有 `<table>` | 用例 5 |
 * | A8 | 降级日志 `{exists:false}` → 空态文案，**不报错** | 用例 7 |
 *
 * ⚠️ **jsdom 没有 layout engine** → 真实宽度只能在真浏览器量
 *    （`scripts/probe-overflow.mjs`，卡 6 的 G7.7 门禁）。
 *    本文件只能断言**结构契约**（role / aria-label / tabindex / 截断样式）。
 */

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock },
}));

/** 日志一行（字段名与后端 `system_log` 一致） */
interface LogFixture {
  id?: number;
  log_date?: string;
  log_type?: string;
  level?: string;
  check_item?: string | null;
  message?: string;
  detail?: string | null;
}

/** 一条超长消息（400 字符的长路径文本 —— 实测 `detail` 最长 233 字符，故阈值不能按短文案定） */
const LONG_MESSAGE = `/opt/invol/data/market/${'segment-'.repeat(40)}quote.parquet`;

const ROWS: LogFixture[] = [
  {
    id: 1,
    log_date: '2026-10-20',
    log_type: 'datacheck',
    level: 'ERROR',
    check_item: 'C7',
    message: LONG_MESSAGE,
    detail: 'SELECT * FROM v_stock_qfq WHERE trade_date = 2026-99-99',
  },
  {
    id: 2,
    log_date: '2026-10-21',
    log_type: 'candidate_migrate',
    level: 'INFO',
    check_item: null,
    message: '候选迁移完成',
    detail: null,
  },
];

/** 取最后一次请求的 query params */
function lastParams(): Record<string, unknown> | undefined {
  const call = getMock.mock.calls.at(-1);
  const config = call?.[1] as { params?: Record<string, unknown> } | undefined;
  return config?.params;
}

/** 安装接口替身 */
function installMocks(
  options: {
    rows?: LogFixture[];
    fallback?: { exists: boolean; lines: string[] };
    total?: number;
  } = {},
): void {
  const rows = options.rows ?? ROWS;
  getMock.mockImplementation((url: string) => {
    if (String(url).includes('/admin/system-log/fallback')) {
      return Promise.resolve(mockResponse(options.fallback ?? { exists: false, lines: [] }));
    }
    return Promise.resolve(
      mockResponse(rows, {
        pagination: {
          page: 1,
          pageSize: 20,
          total: options.total ?? rows.length,
          totalPages: 1,
        },
      }),
    );
  });
}

/** 在给定视口宽度下渲染面板 */
function renderAtWidth(width: number): void {
  const original = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  try {
    renderWithRouter(<AdminLogPanel />);
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: original });
  }
}

beforeEach(() => {
  getMock.mockReset();
  installMocks();
});

afterEach(() => {
  // 视口宽度复位（jsdom 默认 1024）—— 防止 shuffle 后用例互相污染
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

describe('Wave 7 卡 1 · Admin 日志面板', () => {
  it('Admin 日志面板：三类筛选（日期范围/类型/level）参数正确传入请求', async () => {
    const user = userEvent.setup();
    installMocks();
    renderWithRouter(<AdminLogPanel />);

    // 首次请求：只有分页参数（空筛选项**不出现**，不是空串）
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(lastParams()).toEqual({ page: 1, page_size: 20 });

    // 只选类型 → level 不得出现在 params 里（A2）
    await user.selectOptions(screen.getByLabelText('日志类型'), 'datacheck');
    await waitFor(() => expect(lastParams()).toMatchObject({ log_type: 'datacheck' }));
    expect(lastParams()).not.toHaveProperty('level');
    expect(lastParams()).not.toHaveProperty('start_date');
    expect(lastParams()).not.toHaveProperty('end_date');

    // 再选 level + 日期范围
    await user.selectOptions(screen.getByLabelText('日志级别'), 'ERROR');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-10-21' } });

    await waitFor(() =>
      expect(lastParams()).toEqual({
        page: 1,
        page_size: 20,
        log_type: 'datacheck',
        level: 'ERROR',
        start_date: '2026-10-01',
        end_date: '2026-10-21',
      }),
    );
  });

  it('Admin 日志面板：筛选变化后分页重置为第 1 页', async () => {
    const user = userEvent.setup();
    installMocks({ total: 100 });
    renderWithRouter(<AdminLogPanel />);

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({ page: 1 });

    // 翻到第 2 页
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ page: 2 }));

    // 改筛选 → 页码必须回到 1
    await user.selectOptions(screen.getByLabelText('日志级别'), 'WARN');
    await waitFor(() => expect(lastParams()).toMatchObject({ page: 1, level: 'WARN' }));
  });

  it('Admin 日志面板：日志表套在 role=region 的横向滚动容器内（长路径不撑破文档）', async () => {
    installMocks();
    renderAtWidth(1024);

    const table = await screen.findByRole('table', { name: '系统日志' });
    const region = screen.getByTestId('scrollable-table');

    // axe 的 `scrollable-region-focusable` 要求可滚动区域**键盘可达**
    expect(region).toHaveAttribute('role', 'region');
    expect(region).toHaveAttribute('aria-label', '系统日志表');
    expect(region).toHaveAttribute('tabindex', '0');
    // 文档级横向溢出的两个根因都要挡住
    expect(region).toHaveStyle({ overflowX: 'auto', minWidth: '0' });

    // 表格确实在滚动容器**里面**
    expect(region.contains(table)).toBe(true);

    // 长文本：单元格内被截断，但 `title` 保留全文（悬停 / 读屏可取）
    const truncated = screen.getByTitle(LONG_MESSAGE);
    expect(truncated).toHaveStyle({
      maxWidth: '220px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    // 文本没被裁掉（DOM 里是全文）
    expect(truncated).toHaveTextContent(LONG_MESSAGE);
  });

  it('Admin 日志面板：<768px 渲染为卡片列表且不渲染 table', async () => {
    installMocks();
    renderAtWidth(375);

    await waitFor(() => expect(getMock).toHaveBeenCalled());

    // A6：窄视口**不得**渲染 table（否则读屏把表格与卡片读两遍）
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('scrollable-table')).toBeNull();

    // 走的是卡片分支
    const cards = screen.getAllByTestId('admin-log-card');
    expect(cards.length).toBe(ROWS.length);
    expect(cards[0]).toHaveTextContent('2026-10-20');
    expect(cards[0]).toHaveTextContent('数据校验');
    expect(cards[0]).toHaveTextContent('ERROR');
    expect(cards[0]).toHaveTextContent(LONG_MESSAGE);

    // 详情可展开（窄屏下没有横向滚动条可依赖）
    const toggle = screen.getAllByRole('button', { name: '展开详情' })[0];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getAllByRole('button', { name: '收起详情' })[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/SELECT \* FROM v_stock_qfq/)).toBeInTheDocument();
  });

  it('Admin 日志面板：≥768px 渲染表格分支', async () => {
    installMocks();
    renderAtWidth(1024);

    await screen.findByRole('table', { name: '系统日志' });
    expect(screen.queryByTestId('admin-log-card')).toBeNull();
  });

  it('Admin 日志面板：降级日志为空时显示空态而非报错', async () => {
    const user = userEvent.setup();
    installMocks({ fallback: { exists: false, lines: [] } });
    renderWithRouter(<AdminLogPanel />);

    await waitFor(() => expect(getMock).toHaveBeenCalled());

    // 折叠区默认收起 → 展开后才去拉降级日志
    expect(screen.queryByTestId('admin-log-fallback-empty')).toBeNull();
    await user.click(screen.getByRole('button', { name: /降级日志/ }));

    await waitFor(() => expect(screen.getByTestId('admin-log-fallback-empty')).toBeInTheDocument());
    expect(screen.getByTestId('admin-log-fallback-empty')).toHaveTextContent('无降级记录');
    // 空态**不是**错误
    expect(screen.queryByTestId('admin-log-fallback-error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // 确实调了降级日志端点
    const fallbackCalls = getMock.mock.calls.filter((c) =>
      String(c[0]).includes('/admin/system-log/fallback'),
    );
    expect(fallbackCalls).toHaveLength(1);
  });

  it('Admin 日志面板：降级日志有内容时逐行展示', async () => {
    const user = userEvent.setup();
    installMocks({
      fallback: {
        exists: true,
        lines: [JSON.stringify({ source: 'invest-assistant', level: 'ERROR', message: 'SQLite 不可用' })],
      },
    });
    renderWithRouter(<AdminLogPanel />);

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /降级日志/ }));

    const lines = await screen.findByTestId('admin-log-fallback-lines');
    expect(lines).toHaveTextContent('SQLite 不可用');
    expect(screen.queryByTestId('admin-log-fallback-empty')).toBeNull();
  });

  it('Admin 日志面板：类型下拉覆盖后端 system_log 全部 log_type（含 candidate_migrate）', async () => {
    installMocks();
    renderWithRouter(<AdminLogPanel />);

    const select = (await screen.findByLabelText('日志类型')) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    // 「全部」+ 后端 CHECK 白名单的 10 种（candidate_migrate 是 Wave 6 新增，旧映射表漏了）
    expect(values).toEqual(['', ...Object.keys(LOG_TYPE_LABEL)]);
    expect(values).toContain('candidate_migrate');
    expect(LOG_TYPE_LABEL.candidate_migrate).toBe('候选迁移');
  });

  it('Admin 日志面板：level 下拉只列 logger.ts 的 5 个合法等级', async () => {
    installMocks();
    renderWithRouter(<AdminLogPanel />);

    const select = (await screen.findByLabelText('日志级别')) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', 'INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS']);
  });

  it('Admin 日志面板：无 critical 级 a11y 违规', async () => {
    installMocks();
    renderWithRouter(<AdminLogPanel />);

    await screen.findByRole('table', { name: '系统日志' });
    const result = await runA11y(document.body);
    await expectNoCriticalA11yViolations(result);
  });
});
