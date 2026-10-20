/**
 * T67 · 卡 3 用例：持仓卡片网格（F-D2）+ 仓位占比进度条（F-D3）+ 排序/过滤（F-D5）+ 信号标记（建议 A）
 *
 * 对应任务卡：`docs/audit/wave-3-task-cards.md` 卡 3。
 *
 * ## 为什么单独开一个文件
 *
 * `dashboard.test.tsx`（双口径 + donut 渐变）与 `dashboard-fd1-fd6.test.tsx`（F-D1/F-D6）
 * 里那些断言是**回归红线**（donut 的 `conic-gradient` 字符串、图例文案、总资产口径…），
 * 本卡新增的用例一律另起文件，避免「为了让新用例通过而放松既有断言」。
 *
 * ## 三条被测口径
 *
 * 1. **F-D2**：持仓区从 `<table>` 改成卡片网格（页面内 table 数 3 → 2）。
 * 2. **F-D3**：仓位占比是**进度条**（`role="progressbar"` + `aria-valuenow`），
 *    宽度 = `weight × 100`（**精确字符串**）；`weight` 为 `null` → 降级显示 `--`。
 * 3. **F-D5**：排序三档（盈亏金额 / 收益率 / 仓位占比，各可正倒序）+ 过滤
 *    （标的类型可用；**行业因数据源 0 行而禁用 + 显式文案**，裁决 D-4）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Dashboard from '../../src/pages/Dashboard';
import PositionCard from '../../src/components/PositionCard';
import WeightBar from '../../src/components/WeightBar';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';
import { MAX_WIDTH, SPACING } from '../../src/theme/tokens';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

interface ApiGetConfig {
  params?: Record<string, unknown>;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

interface SignalFixture {
  plugin_id: string;
  direction: 'buy' | 'sell' | 'hold';
  label: string;
  trade_date: string;
}

interface PositionFixture {
  asset_code: string;
  name: string | null;
  totalQuantity: number;
  totalCostBasis: number;
  avgCost: number;
  realizedPnL: number;
  currentPrice: number | null;
  priceDate: string | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedYield: number | null;
  weight: number | null;
  prevClose: number | null;
  signal: SignalFixture | null;
  industry: string | null;
}

interface PositionSummaryFixture {
  totalMarketValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
  realizedPnL: number;
  priceDate: string | null;
  positionCount: number;
}

const DEFAULT_STAT = {
  trade_date: '2026-10-17',
  total_assets_price_yield: 0.1234,
  total_assets_actual_yield: 0.2345,
  total_profit_price: 1234.56,
  total_profit_actual: -789.01,
};

/**
 * 三只持仓的**合成** fixture
 *
 * ⚠️ **刻意让三档排序的首卡互不相同**（卡 3 A5 的反「假绿」要求）：
 *   - 按盈亏金额降序 → 首卡 **B**（300）
 *   - 按收益率降序   → 首卡 **C**（0.30）
 *   - 按仓位占比降序 → 首卡 **A**（0.50）
 *
 * ⚠️ `unrealizedYield` 与 `unrealizedPnl / totalCostBasis` **不强制相等** ——
 *    后端保证那组恒等式，前端只做展示与排序，不依赖它；
 *    这里的收益率是**为排序构造的合成值**。
 *    `marketValue` 与 `weight` 则保持自洽（1000 / 600 / 400，占比 0.5 / 0.3 / 0.2）。
 */
const DEFAULT_POSITIONS: PositionFixture[] = [
  {
    asset_code: 'sh600000',
    name: '浦发银行',
    totalQuantity: 100,
    totalCostBasis: 900,
    avgCost: 9,
    realizedPnL: 12.5,
    currentPrice: 10,
    priceDate: '2026-10-17',
    marketValue: 1000,
    unrealizedPnl: 100,
    unrealizedYield: 0.1,
    weight: 0.5,
    prevClose: 9.8,
    signal: { plugin_id: 'macd_cross', direction: 'buy', label: '金叉', trade_date: '2026-10-17' },
    industry: null,
  },
  {
    asset_code: 'sh510300',
    name: '沪深300ETF',
    totalQuantity: 200,
    totalCostBasis: 300,
    avgCost: 1.5,
    realizedPnL: -3,
    currentPrice: 3,
    priceDate: '2026-10-17',
    marketValue: 600,
    unrealizedPnl: 300,
    unrealizedYield: 0.05,
    weight: 0.3,
    prevClose: 3.05,
    signal: { plugin_id: 'rsi_revert', direction: 'sell', label: '超买', trade_date: '2026-10-17' },
    industry: null,
  },
  {
    asset_code: 'sz159915',
    name: null,
    totalQuantity: 100,
    totalCostBasis: 200,
    avgCost: 2,
    realizedPnL: 0,
    currentPrice: 4,
    priceDate: '2026-10-17',
    marketValue: 400,
    unrealizedPnl: 200,
    unrealizedYield: 0.3,
    weight: 0.2,
    prevClose: 3.9,
    signal: null,
    industry: null,
  },
];

const DEFAULT_SUMMARY: PositionSummaryFixture = {
  totalMarketValue: 2000,
  totalCostBasis: 1400,
  unrealizedPnl: 600,
  realizedPnL: 9.5,
  priceDate: '2026-10-17',
  positionCount: 3,
};

interface ApiOverrides {
  stat?: typeof DEFAULT_STAT;
  positions?: PositionFixture[];
  summary?: PositionSummaryFixture | null;
}

function installApiMock(overrides: ApiOverrides = {}): void {
  const stat = overrides.stat ?? DEFAULT_STAT;
  const positions = overrides.positions ?? DEFAULT_POSITIONS;
  const summary = 'summary' in overrides ? (overrides.summary ?? null) : DEFAULT_SUMMARY;
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/holding':
        return mockResponse(positions, { summary });
      case '/asset-stat/latest':
        return mockResponse(stat);
      case '/signal':
        return mockResponse([]);
      case '/admin/system-log':
        return mockResponse([]);
      default:
        throw new Error(`未预期的接口调用: ${url}`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 查询 helper
 * ------------------------------------------------------------------ */

/** 卡片网格容器 */
function grid(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="position-grid"]');
  if (!el) throw new Error('未找到持仓卡片网格');
  return el;
}

/** 按代码取某张持仓卡 */
function cardOf(code: string): HTMLElement {
  const found = screen
    .getAllByTestId('position-card')
    .find((el) => el.querySelector('[data-testid="position-card-code"]')?.textContent === code);
  if (!found) throw new Error(`未找到持仓卡 ${code}`);
  return found;
}

/** 网格里当前渲染出来的标的代码（按渲染顺序）*/
function renderedCodes(): string[] {
  return Array.from(grid().querySelectorAll('[data-testid="position-card-code"]')).map(
    (el) => el.textContent ?? '',
  );
}

/** 进度条内层（宽度断言的对象）*/
function barFill(bar: HTMLElement): HTMLElement {
  const fill = bar.firstElementChild;
  if (!(fill instanceof HTMLElement)) throw new Error('进度条内层缺失');
  return fill;
}

/* ------------------------------------------------------------------ *
 * F-D2 · 持仓卡片化
 * ------------------------------------------------------------------ */

describe('F-D2 · 持仓从表格改为卡片网格', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('F-D2 持仓卡片化：持仓区不再是 table，卡片数 = 持仓数', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 持仓明细表已被卡片网格取代（卡 3 A1）
    expect(container.querySelector('table[aria-label="持仓明细"]')).toBeNull();
    // 页面内 table 总数 3 → 2（信号表 + 日志表仍在）；普通用户看不到日志表 → 只剩 1 张
    expect(container.querySelectorAll('table').length).toBe(1);

    expect(screen.getAllByTestId('position-card')).toHaveLength(3);
    expect(renderedCodes()).toEqual(['sh510300', 'sz159915', 'sh600000']); // 默认按盈亏金额降序
  });

  it('F-D2 持仓卡片化：admin 视角下 table 总数 3 → 2（信号表 + 日志表）', async () => {
    useUserStore.setState({ role: 'admin', token: null, username: null });
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(container.querySelector('table[aria-label="持仓明细"]')).toBeNull();
    expect(container.querySelectorAll('table').length).toBe(2);
  });

  it('F-D2 持仓卡片化：网格容器是 CSS Grid（流体列数，非 JS 断点）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(grid().style.display).toBe('grid');
    expect(grid().style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(min(320px, 100%), 1fr))');
  });
});

/* ------------------------------------------------------------------ *
 * 卡片 8 项字段
 * ------------------------------------------------------------------ */

describe('卡片字段 · PRD §5.3 行 230 的 8 项（裁决 D-16：不含行业）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('8 项字段全部渲染且互不串位（逐项精确匹配）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const card = cardOf('sh600000');

    // ① 代码
    expect(within(card).getByText('sh600000')).toBeInTheDocument();
    // ② 名称
    expect(within(card).getByText('浦发银行')).toBeInTheDocument();
    // ③ 现价
    expect(within(card).getByText('10.00')).toBeInTheDocument();
    // ④ 持仓数量
    expect(within(card).getByText('100')).toBeInTheDocument();
    // ⑤ 移动加权成本
    expect(within(card).getByText('9.0000')).toBeInTheDocument();
    // ⑥ 盈亏
    expect(within(card).getByText('100.00')).toBeInTheDocument();
    // ⑦ 收益率
    expect(within(card).getByText('10.00%')).toBeInTheDocument();
    // ⑧ 仓位占比（进度条 + 百分比文本）
    expect(within(card).getByText('50.00%')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar')).toBeInTheDocument();
    // ⑨ 信号标记（建议 A）
    expect(within(card).getByTestId('signal-badge')).toBeInTheDocument();

    // 字段标签也都在
    for (const label of ['现价', '持仓数量', '移动加权成本', '盈亏', '收益率', '仓位占比']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
  });

  it('name 为 null 时回退显示代码，且不出现 null / undefined 字面量', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const card = cardOf('sz159915');
    // 名称缺失 → 回退为代码（卡 3 A10）
    expect(within(card).getAllByText('sz159915').length).toBeGreaterThanOrEqual(1);
    expect(card.textContent).not.toContain('null');
    expect(card.textContent).not.toContain('undefined');
    expect(card.textContent).not.toContain('NaN');
  });

  it('ETF 标的带 ETF 标记', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(within(cardOf('sh510300')).getByTestId('position-card-etf')).toBeInTheDocument();
    expect(within(cardOf('sh600000')).queryByTestId('position-card-etf')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * F-D3 · 仓位占比进度条
 * ------------------------------------------------------------------ */

describe('F-D3 · 仓位占比进度条', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('F-D3 进度条：宽度等于 weight 百分比（精确字符串）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const barA = within(cardOf('sh600000')).getByRole('progressbar');
    expect(barFill(barA).style.width).toBe('50%');

    const barB = within(cardOf('sh510300')).getByRole('progressbar');
    expect(barFill(barB).style.width).toBe('30%');

    const barC = within(cardOf('sz159915')).getByRole('progressbar');
    expect(barFill(barC).style.width).toBe('20%');
  });

  it('F-D3 进度条：role=progressbar + aria-valuenow/min/max + 可访问名', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const bar = within(cardOf('sh600000')).getByRole('progressbar');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar).toHaveAccessibleName('sh600000 仓位占比');
  });

  it('F-D3 进度条：weight 为 null 时降级（不渲染条，显示 --）', async () => {
    installApiMock({
      positions: [
        {
          ...DEFAULT_POSITIONS[0],
          asset_code: 'sh600000',
          weight: null,
        },
      ],
    });
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const card = cardOf('sh600000');
    expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(card).getByText('仓位占比')).toBeInTheDocument();
    expect(within(card).getByText('--')).toBeInTheDocument();
    expect(card.textContent).not.toContain('NaN');
  });
});

/* ------------------------------------------------------------------ *
 * F-D5 · 排序三档
 * ------------------------------------------------------------------ */

describe('F-D5 · 排序三档（盈亏金额 / 收益率 / 仓位占比）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('F-D5 排序：按盈亏金额 / 收益率 / 仓位占比 三档首卡各不相同', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 默认：按盈亏金额降序 → 首卡 B
    expect(renderedCodes()[0]).toBe('sh510300');

    await user.click(screen.getByRole('button', { name: '按收益率' }));
    await waitFor(() => expect(renderedCodes()[0]).toBe('sz159915'));

    await user.click(screen.getByRole('button', { name: '按仓位占比' }));
    await waitFor(() => expect(renderedCodes()[0]).toBe('sh600000'));

    await user.click(screen.getByRole('button', { name: '按盈亏金额' }));
    await waitFor(() => expect(renderedCodes()[0]).toBe('sh510300'));
  });

  it('F-D5 排序：三档的完整顺序都正确', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(renderedCodes()).toEqual(['sh510300', 'sz159915', 'sh600000']); // 盈亏 300 / 200 / 100

    await user.click(screen.getByRole('button', { name: '按收益率' }));
    await waitFor(
      () => expect(renderedCodes()).toEqual(['sz159915', 'sh600000', 'sh510300']), // 0.30 / 0.10 / 0.05
    );

    await user.click(screen.getByRole('button', { name: '按仓位占比' }));
    await waitFor(
      () => expect(renderedCodes()).toEqual(['sh600000', 'sh510300', 'sz159915']), // 0.5 / 0.3 / 0.2
    );
  });

  it('F-D5 排序：可切换正序 / 倒序', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const dirBtn = screen.getByRole('button', { name: '降序' });
    await user.click(dirBtn);

    // 升序 → 盈亏最小的那只排第一
    await waitFor(() => expect(renderedCodes()).toEqual(['sh600000', 'sz159915', 'sh510300']));
    expect(screen.getByRole('button', { name: '升序' })).toBeInTheDocument();
  });

  it('F-D5 排序：三个排序按钮互斥（aria-pressed 反映当前档位）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const pnlBtn = screen.getByRole('button', { name: '按盈亏金额' });
    const yieldBtn = screen.getByRole('button', { name: '按收益率' });
    const weightBtn = screen.getByRole('button', { name: '按仓位占比' });

    expect(pnlBtn.getAttribute('aria-pressed')).toBe('true');
    expect(yieldBtn.getAttribute('aria-pressed')).toBe('false');
    expect(weightBtn.getAttribute('aria-pressed')).toBe('false');

    await user.click(yieldBtn);

    expect(pnlBtn.getAttribute('aria-pressed')).toBe('false');
    expect(yieldBtn.getAttribute('aria-pressed')).toBe('true');
    expect(weightBtn.getAttribute('aria-pressed')).toBe('false');
  });
});

/* ------------------------------------------------------------------ *
 * F-D5 · 过滤
 * ------------------------------------------------------------------ */

describe('F-D5 · 过滤（标的类型可用 / 行业禁用）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('F-D5 过滤：按标的类型过滤后卡片集合正确', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const select = screen.getByLabelText('标的类型') as HTMLSelectElement;
    expect(select).toHaveValue('all');
    expect(renderedCodes()).toHaveLength(3);

    await user.selectOptions(select, 'stock');
    await waitFor(() => expect(renderedCodes()).toEqual(['sh600000']));

    await user.selectOptions(select, 'etf');
    await waitFor(() => expect(renderedCodes()).toEqual(['sh510300', 'sz159915']));

    await user.selectOptions(select, 'all');
    await waitFor(() => expect(renderedCodes()).toHaveLength(3));
  });

  it('F-D5 过滤：类型筛选与饼图下钻共用同一个 state（单一真相源）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const select = screen.getByLabelText('标的类型') as HTMLSelectElement;

    // 点饼图图例 → 下拉框同步
    await user.click(screen.getByRole('button', { name: /^股票/ }));
    await waitFor(() => expect(select).toHaveValue('stock'));
    expect(renderedCodes()).toEqual(['sh600000']);

    // 反向：下拉框选 ETF → 饼图图例的 aria-pressed 同步
    await user.selectOptions(select, 'etf');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^ETF/ })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(renderedCodes()).toEqual(['sh510300', 'sz159915']);
  });

  it('F-D5 过滤：行业数据源不可用时控件禁用并有说明文案', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const industrySelect = screen.getByLabelText('行业') as HTMLSelectElement;
    expect(industrySelect).toBeDisabled();
    expect(screen.getByText('行业数据源暂不可用')).toBeInTheDocument();
  });

  it('F-D5 过滤：行业字段一旦有数据，控件自动启用（不再写死禁用）', async () => {
    installApiMock({
      positions: [{ ...DEFAULT_POSITIONS[0], industry: '银行' }],
    });
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const industrySelect = screen.getByLabelText('行业') as HTMLSelectElement;
    expect(industrySelect).not.toBeDisabled();
    expect(screen.queryByText('行业数据源暂不可用')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 建议 A · 信号标记
 * ------------------------------------------------------------------ */

describe('建议 A · 持仓卡信号标记', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('建议 A 信号标记：buy / sell 渲染方向符号 + 插件名 + 标签', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const buyBadge = within(cardOf('sh600000')).getByTestId('signal-badge');
    expect(buyBadge).toHaveTextContent('▲');
    expect(buyBadge).toHaveTextContent('买入');
    expect(buyBadge).toHaveTextContent('macd_cross');
    expect(buyBadge).toHaveTextContent('金叉');

    const sellBadge = within(cardOf('sh510300')).getByTestId('signal-badge');
    expect(sellBadge).toHaveTextContent('▼');
    expect(sellBadge).toHaveTextContent('卖出');
    expect(sellBadge).toHaveTextContent('rsi_revert');
    expect(sellBadge).toHaveTextContent('超买');
  });

  it('建议 A 信号标记：hold 方向渲染 · 持有', async () => {
    installApiMock({
      positions: [
        {
          ...DEFAULT_POSITIONS[0],
          signal: { plugin_id: 'ma_cross', direction: 'hold', label: '观望', trade_date: '2026-10-17' },
        },
      ],
    });
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const badge = within(cardOf('sh600000')).getByTestId('signal-badge');
    expect(badge).toHaveTextContent('·');
    expect(badge).toHaveTextContent('持有');
  });

  it('建议 A 信号标记：无信号时只留「· 持有」占位，不渲染信号徽章', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const card = cardOf('sz159915');
    expect(within(card).queryByTestId('signal-badge')).not.toBeInTheDocument();
    expect(within(card).getByTestId('signal-hold')).toHaveTextContent('· 持有');
  });

  it('建议 A 信号标记：信号过期（≥5 自然日）显示 ⚠ 信号过期', async () => {
    installApiMock({
      positions: [
        {
          ...DEFAULT_POSITIONS[0],
          signal: {
            plugin_id: 'macd_cross',
            direction: 'buy',
            label: '金叉',
            trade_date: '2026-10-10', // 距 2026-10-17 恰好 7 天
          },
        },
      ],
    });
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const badge = within(cardOf('sh600000')).getByTestId('signal-badge');
    // 文案逐字照 ux_v2 行 360 / 卡 3 A9：「⚠信号过期」
    expect(badge).toHaveTextContent('⚠信号过期');
    // 过期后不再显示方向符号（避免用户误以为是最新信号）
    expect(badge).not.toHaveTextContent('▲');
  });

  it('建议 A 信号标记：未过期（<5 自然日）不显示过期文案', async () => {
    installApiMock({
      positions: [
        {
          ...DEFAULT_POSITIONS[0],
          signal: {
            plugin_id: 'macd_cross',
            direction: 'buy',
            label: '金叉',
            trade_date: '2026-10-15', // 距 2026-10-17 为 2 天
          },
        },
      ],
    });
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const badge = within(cardOf('sh600000')).getByTestId('signal-badge');
    expect(badge).not.toHaveTextContent('⚠信号过期');
    expect(badge).toHaveTextContent('▲');
  });
});

/* ------------------------------------------------------------------ *
 * 卡片操作按钮（卡 4 接入弹窗前的占位）
 * ------------------------------------------------------------------ */

describe('卡片操作按钮 · 【买入】【卖出】', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('按钮存在且可访问名正确（买入 / 卖出）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const buttons = screen.getAllByRole('button', { name: '买入' });
    expect(buttons).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '卖出' })).toHaveLength(3);
  });

  it('未接入交易回调时按钮为 disabled 占位（卡 4 负责接上）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    for (const btn of screen.getAllByRole('button', { name: '买入' })) {
      expect(btn).toBeDisabled();
    }
  });

  it('接入 onTrade 后点击【买入】【卖出】触发回调（代码 + 方向）', async () => {
    const onTrade = vi.fn();
    render(<PositionCard position={DEFAULT_POSITIONS[0]} assetType="stock" onTrade={onTrade} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '买入' }));
    expect(onTrade).toHaveBeenCalledWith('sh600000', 'buy');

    await user.click(screen.getByRole('button', { name: '卖出' }));
    expect(onTrade).toHaveBeenCalledWith('sh600000', 'sell');
    expect(onTrade).toHaveBeenCalledTimes(2);
  });

  it('WeightBar：weight=null 时不渲染 progressbar（组件级）', () => {
    render(<WeightBar weight={null} label="sh600000 仓位占比" />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('WeightBar：weight=0.4 → 宽度 40% 且 aria-valuenow=40（组件级）', () => {
    render(<WeightBar weight={0.4} label="sh600000 仓位占比" />);
    const bar = screen.getByRole('progressbar');
    expect(barFill(bar).style.width).toBe('40%');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
  });

  it('接入 onOpenDetail 后名称可点击（卡 6 的入口钩子）', async () => {
    const onOpenDetail = vi.fn();
    render(<PositionCard position={DEFAULT_POSITIONS[0]} assetType="stock" onOpenDetail={onOpenDetail} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '浦发银行' }));
    expect(onOpenDetail).toHaveBeenCalledWith('sh600000');
  });

  it('未接入 onOpenDetail 时名称不可点击（退化为纯文本）', () => {
    render(<PositionCard position={DEFAULT_POSITIONS[0]} assetType="stock" />);
    expect(screen.queryByRole('button', { name: '浦发银行' })).not.toBeInTheDocument();
    expect(screen.getByText('浦发银行')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 网格布局 · 375px 不溢出
 * ------------------------------------------------------------------ */

describe('网格布局 · 桌面 3 列 / 平板 2 列 / 手机 1 列（纯 CSS，无 JS 断点）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  /**
   * 按 CSS Grid 的 `auto-fill` 规则推算列数
   *
   * ⚠️ 这段算式与 `Dashboard.tsx` 里 `grid-template-columns` 的声明**同源**：
   *    轨道下限 320px、间隙 `SPACING.gapRelaxed`、容器可用宽 =
   *    `min(视口宽, MAX_WIDTH) - 页面内边距×2 - 卡片内边距×2`。
   *    真实列数由浏览器排版决定 —— jsdom 没有 layout engine，
   *    真浏览器验证由卡 8 的溢出探针（G3.5）负责。
   */
  const TRACK_MIN = 320;
  const GAP = parseFloat(SPACING.gapRelaxed);

  function availableWidth(viewport: number): number {
    const pageWidth = Math.min(viewport, MAX_WIDTH) - parseFloat(SPACING.pagePadding) * 2;
    return pageWidth - parseFloat(SPACING.cardPadding) * 2;
  }

  function columnsAt(viewport: number): number {
    const width = availableWidth(viewport);
    return Math.max(1, Math.floor((width + GAP) / (TRACK_MIN + GAP)));
  }

  it('三档视口的列数契约：375 → 1 列 / 768 → 2 列 / 1024 → 2 列 / 1440 → 3 列', () => {
    expect(columnsAt(375)).toBe(1);
    expect(columnsAt(768)).toBe(2);
    expect(columnsAt(1024)).toBe(2);
    expect(columnsAt(1440)).toBe(3);
  });

  it('375px 下轨道宽度被 100% 封顶（不会撑破容器 → 无横向溢出）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // `min(320px, 100%)` 的意义：容器只有 295px 时轨道取 295px 而不是 320px
    const width = availableWidth(375);
    expect(width).toBeLessThan(TRACK_MIN);
    // 声明里必须带 `min(320px, 100%)` 这个上限
    expect(grid().style.gridTemplateColumns).toContain('min(320px, 100%)');
  });

  it('卡片本身允许收缩（min-width: 0），避免 Grid 子项撑破轨道', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    for (const card of screen.getAllByTestId('position-card')) {
      // jsdom 对无单位 0 的归一化可能是 '0' 或 '0px'
      expect(['0', '0px']).toContain(card.style.minWidth);
      expect(card.style.overflowWrap).toBe('anywhere');
    }
  });
});
