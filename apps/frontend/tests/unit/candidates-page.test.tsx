import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Candidates from '../../src/pages/Candidates';
import App from '../../src/App';
import { Navbar } from '../../src/pages/_shared';
import { mockResponse, renderWithRouter } from '../helpers';
import { expectNoCriticalA11yViolations, runA11y } from '../helpers/a11y';
import { useUserStore } from '../../src/store/user';

/**
 * T74 · 候选池页 `/candidates`（F-G3）页面级用例
 *
 * 覆盖实施计划 T74 的交付物与验收点：
 *
 * | 用例组 | 对应交付 |
 * |---|---|
 * | 路由可达 | 新页面 + 路由（`App.tsx` 注册 `/candidates`）|
 * | 导航入口 | 桌面 Navbar + 移动端 Tab（PRD §5.8 #7）|
 * | 列表字段齐全 | 代码 / 名称 / 基准价 / 现价 / 相对收益 / 跟踪天数 / 最新信号 |
 * | 删除候选 | 【移除】→ `DELETE /api/candidate/:asset_code`（软删）|
 * | 迁移到自选 | 【迁移自选】→ `POST /api/candidate/:id/migrate` + **迁移后 watch 不含该标的** |
 * | 空态 / 加载态 / 错误态 | PRD §5.8 #3「超时需有 loading 状态」|
 * | 375px 滚动容器 | `ScrollableTable` 的结构契约（overflow-x + role=region + tabIndex）|
 *
 * ⚠️ **「迁移后 watch 不含该标的」是本文件最关键的一条** ——
 *    PRD S5：「MVP 迁移操作**只在候选记录上打标记，不会自动创建自选关联**」。
 *    前端若「顺手」把标的加进自选，这条就红。
 */

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
  // App.tsx 订阅「会话过期」事件；本文件不触发过期，给个空实现即可
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/candidates',
}));

/** 候选池一行（字段名与后端 `GET /api/candidate` 一致）*/
interface CandidateFixture {
  id: number;
  asset_code: string;
  name?: string | null;
  candidate_reason?: string | null;
  candidate_base_price?: number | null;
  current_close?: number | null;
  relative_return?: number | null;
  tracked_days?: number | null;
  migrated_from_candidate?: number | null;
  migrated_price_mode?: string | null;
  created_at?: string | null;
  signal?: { plugin_id: string; direction: string; label: string; trade_date: string } | null;
}

/** 自选一行（`GET /api/watch`）*/
interface WatchFixture {
  id: number;
  asset_code: string;
  created_at?: string | null;
}

const CANDIDATE: CandidateFixture = {
  id: 1,
  asset_code: 'sh600519',
  name: '贵州茅台',
  candidate_reason: '跌破年线观察',
  candidate_base_price: 1500,
  current_close: 1650,
  relative_return: 0.1,
  tracked_days: 12,
  migrated_from_candidate: 0,
  migrated_price_mode: null,
  created_at: '2026-10-09 10:00:00',
  signal: { plugin_id: 'rsi_oversold', direction: 'buy', label: 'RSI 超卖', trade_date: '2026-10-20' },
};

/** 安装接口替身 */
function installMocks(
  options: {
    candidates?: CandidateFixture[];
    watch?: WatchFixture[];
    candidateError?: unknown;
  } = {},
): void {
  getMock.mockImplementation((url: string) => {
    if (String(url).startsWith('/candidate')) {
      if (options.candidateError !== undefined) return Promise.reject(options.candidateError);
      return Promise.resolve(mockResponse(options.candidates ?? []));
    }
    if (String(url).startsWith('/watch')) {
      return Promise.resolve(mockResponse(options.watch ?? []));
    }
    return Promise.resolve(mockResponse([]));
  });
  postMock.mockImplementation((url: string) => {
    if (String(url).includes('/migrate')) {
      // 后端 migrate 的真实响应体（PRD S5 的「只打标记」语义）
      return Promise.resolve(
        mockResponse({
          asset_code: 'sh600519',
          from: 'candidate',
          to: 'watch',
          price_mode: 'base',
          marked: true,
          autoCreated: false,
          message: '已标记为迁移完成；不会自动加入自选，需手动从候选池加入自选',
        }),
      );
    }
    if (String(url).startsWith('/watch')) {
      return Promise.resolve(mockResponse({ id: 2 }));
    }
    return Promise.resolve(mockResponse({ message: 'ok' }));
  });
  deleteMock.mockResolvedValue(mockResponse({ message: '已从候选池移除' }));
}

/** 取候选池表格的数据行 */
function candidateRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: '候选池列表' });
  return within(table).getAllByRole('row').slice(1);
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
  useUserStore.setState({ token: 'tok-test', refreshToken: null, username: 'tester', role: 'user' });
  installMocks();
});

describe('T74 · 路由可达 + 导航入口', () => {
  it('访问 /candidates → 渲染候选池页（不是 404 页）', async () => {
    renderWithRouter(<App />, { initialEntries: ['/candidates'] });

    expect(await screen.findByRole('heading', { name: '候选池' })).toBeInTheDocument();
    // 不是 NotFound 页
    expect(screen.queryByText('页面不存在')).not.toBeInTheDocument();
  });

  it('桌面导航有「候选池」入口，链接指向 /candidates', async () => {
    renderWithRouter(<Navbar />);

    const link = await screen.findByRole('link', { name: '候选池' });
    expect(link).toHaveAttribute('href', '/candidates');
  });

  it('移动端底部 Tab 有「候选池」入口（375px 视口，PRD §5.8 #6/#7）', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    try {
      renderWithRouter(<Navbar />);

      const tabbar = await screen.findByRole('navigation', { name: '底部导航' });
      const link = within(tabbar).getByRole('link', { name: /候选池/ });
      expect(link).toHaveAttribute('href', '/candidates');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: originalWidth,
      });
    }
  });
});

describe('T74 · 候选列表字段齐全', () => {
  it('一行里同时给出 代码 / 名称 / 基准价 / 现价 / 相对收益 / 跟踪天数 / 最新信号', async () => {
    installMocks({ candidates: [CANDIDATE] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    const rows = candidateRows();
    expect(rows).toHaveLength(1);

    const cells = within(rows[0]).getAllByRole('cell');
    // 列序：选择 / 代码 / 名称 / 基准价 / 现价 / 相对收益 / 跟踪天数 / 最新信号 / 操作
    expect(cells[1]).toHaveTextContent('sh600519');
    expect(cells[2]).toHaveTextContent('贵州茅台');
    expect(cells[3]).toHaveTextContent('1500.00');
    expect(cells[4]).toHaveTextContent('1650.00');
    expect(cells[5]).toHaveTextContent('10.00%');
    expect(cells[6]).toHaveTextContent('12 天');
    expect(cells[7]).toHaveTextContent('买入');
    expect(cells[7]).toHaveTextContent('RSI 超卖');
  });

  it('名称 / 现价 / 相对收益缺失时降级为 `--`（不显示 NaN / undefined）', async () => {
    installMocks({
      candidates: [
        {
          id: 2,
          asset_code: 'sh600036',
          name: null,
          candidate_base_price: 10,
          current_close: null,
          relative_return: null,
          tracked_days: 0,
        },
      ],
    });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    const cells = within(candidateRows()[0]).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('--');
    expect(cells[4]).toHaveTextContent('--');
    expect(cells[5]).toHaveTextContent('--');
    expect(cells[7]).toHaveTextContent('--');
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });
});

describe('T74 · 删除候选（软删）', () => {
  it('点【移除】→ 打到 `DELETE /api/candidate/:asset_code`', async () => {
    const user = userEvent.setup();
    installMocks({ candidates: [CANDIDATE] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    await user.click(screen.getByRole('button', { name: '移除候选：sh600519' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock.mock.calls[0]?.[0]).toBe('/candidate/sh600519');
  });
});

describe('T74 · 迁移到自选（T92：只打标记，不建关联）', () => {
  it('点【迁移自选】→ `POST /api/candidate/:id/migrate` + 当前价格模式', async () => {
    const user = userEvent.setup();
    installMocks({ candidates: [CANDIDATE] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    await user.click(screen.getByRole('button', { name: '迁移自选：sh600519' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe('/candidate/sh600519/migrate');
    expect(postMock.mock.calls[0]?.[1]).toEqual({ price_mode: 'base' });
  });

  it('切到「使用现价」→ price_mode 变成 current（两种模式可区分）', async () => {
    const user = userEvent.setup();
    installMocks({ candidates: [CANDIDATE] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    await user.click(screen.getByLabelText('使用现价'));
    await user.click(screen.getByRole('button', { name: '迁移自选：sh600519' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[1]).toEqual({ price_mode: 'current' });
  });

  it('🔴 迁移后自选列表**不含**该标的（PRD S5：迁移只打标记，不建 watch 关联）', async () => {
    const user = userEvent.setup();
    // 迁移前自选列表里没有该标的
    installMocks({ candidates: [CANDIDATE], watch: [] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    await user.click(screen.getByRole('button', { name: '迁移自选：sh600519' }));

    // 后端返回迁移成功的提示
    await waitFor(() => expect(screen.getByTestId('candidate-notice')).toBeInTheDocument());
    expect(screen.getByTestId('candidate-notice')).toHaveTextContent('不会自动加入自选');

    // 自选分区里没有这一行（列表为空时展示空态，而不是表格）
    const watchSection = screen.getByTestId('watch-list-panel');
    expect(within(watchSection).queryByText('sh600519')).not.toBeInTheDocument();
    expect(within(watchSection).getByTestId('watch-empty')).toBeInTheDocument();

    // 🔴 前端**没有**顺手调用「加入自选」接口
    const watchCalls = postMock.mock.calls.filter((call) => String(call[0]).startsWith('/watch'));
    expect(watchCalls).toHaveLength(0);
  });

  it('【加入自选】是另一个显式动作 → `POST /api/watch`（与迁移分开）', async () => {
    const user = userEvent.setup();
    installMocks({ candidates: [CANDIDATE], watch: [] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    await user.click(screen.getByRole('button', { name: '加入自选：sh600519' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]?.[0]).toBe('/watch');
    expect(postMock.mock.calls[0]?.[1]).toEqual({ asset_code: 'sh600519' });
  });
});

describe('T74 · 空态 / 加载态 / 错误态', () => {
  it('加载态：请求未回来时展示 loading（role=status）', async () => {
    getMock.mockImplementation(() => new Promise(() => {}));
    renderWithRouter(<Candidates />);

    expect(await screen.findByTestId('candidate-loading')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('空态：候选池为空时给出引导文案', async () => {
    installMocks({ candidates: [] });
    renderWithRouter(<Candidates />);

    expect(await screen.findByTestId('candidate-empty')).toHaveTextContent('候选池为空');
    // 自选分区也有自己的空态
    expect(screen.getByTestId('watch-empty')).toHaveTextContent('自选列表为空');
  });

  it('错误态：接口失败时展示错误文案 + 重新加载按钮', async () => {
    installMocks({ candidateError: { response: { data: { message: '候选池查询失败' } } } });
    renderWithRouter(<Candidates />);

    expect(await screen.findByTestId('candidate-error')).toHaveTextContent('候选池查询失败');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });
});

describe('T74 · 375px 表格不横向溢出（滚动容器结构契约）', () => {
  it('候选池表格被 `overflow-x:auto` + `min-width:0` 的滚动容器包住（带无障碍属性）', async () => {
    installMocks({ candidates: [CANDIDATE] });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '候选池列表' });
    const region = screen.getByTestId('scrollable-table');

    // axe 的 `scrollable-region-focusable` 要求可滚动区域必须能被键盘访问
    expect(region).toHaveAttribute('role', 'region');
    expect(region).toHaveAttribute('aria-label', '候选池列表表');
    expect(region).toHaveAttribute('tabindex', '0');
    // 文档级横向溢出的两个根因都要挡住
    expect(region).toHaveStyle({ overflowX: 'auto', minWidth: '0' });
  });

  it('自选分区也是同样的滚动容器结构', async () => {
    installMocks({
      candidates: [CANDIDATE],
      watch: [{ id: 1, asset_code: 'sh600000', created_at: '2026-10-01 09:00:00' }],
    });
    renderWithRouter(<Candidates />);

    await screen.findByRole('table', { name: '自选列表' });
    const regions = screen.getAllByTestId('scrollable-table');
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const region of regions) {
      expect(region).toHaveAttribute('role', 'region');
      expect(region).toHaveAttribute('tabindex', '0');
      expect(region).toHaveStyle({ overflowX: 'auto', minWidth: '0' });
    }
  });
});

describe('T74 · a11y（新增页面不得逃过 G3.4 门禁）', () => {
  it('候选池页无 critical 级 a11y 违规（渲染整个 <App />，含 header/main/footer）', async () => {
    installMocks({
      candidates: [CANDIDATE],
      watch: [{ id: 1, asset_code: 'sh600000', created_at: '2026-10-01 09:00:00' }],
    });
    renderWithRouter(<App />, { initialEntries: ['/candidates'] });

    await screen.findByRole('table', { name: '候选池列表' });
    const result = await runA11y(document.body);
    await expectNoCriticalA11yViolations(result);
  });
});
