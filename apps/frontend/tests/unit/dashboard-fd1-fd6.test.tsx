/**
 * T67 · 卡 2 用例：资产汇总卡取值修正（F-D1）+ 资产组成饼图点击下钻（F-D6）
 *
 * 对应任务卡：`docs/audit/wave-3-task-cards.md` 卡 2。
 *
 * ## 为什么单独开一个文件
 *
 * 现有 `dashboard.test.tsx` 已逐字断言 donut 的 `conic-gradient` 字符串与图例文案
 * —— 那两条是**回归红线**（不得改动），本卡新增的用例一律另起文件，
 * 避免「为了让新用例通过而放松既有断言」。
 *
 * ## 两条被测口径
 *
 * - **F-D1**：「总资产」大字取 **市值口径**（`summary.totalMarketValue`），
 *   持仓总成本（`summary.totalCostBasis`）另起一行小字，两个口径互不顶替。
 * - **F-D6**：点击资产组成饼图的图例（或饼图本体）→ **持仓列表**按该类型过滤；
 *   再点同一段 → 取消过滤。过滤的是列表本身，**不切页**。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Dashboard from '../../src/pages/Dashboard';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';

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

interface AssetStatFixture {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

interface PositionFixture {
  asset_code: string;
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
}

interface PositionSummaryFixture {
  totalMarketValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
  realizedPnL: number;
  priceDate: string | null;
  positionCount: number;
}

/**
 * 默认资产快照（与 `AssetStat` 接口同形）
 *
 * ⚠️ 市值与成本**故意取不同数值**（1000 / 850）——
 *    否则「取的是市值还是成本」的断言无法区分真绿与假绿。
 */
const DEFAULT_STAT: AssetStatFixture = {
  trade_date: '2026-10-17',
  total_assets_price_yield: 0.1234,
  total_assets_actual_yield: 0.2345,
  total_profit_price: 1234.56,
  total_profit_actual: -789.01,
};

/** 默认持仓：一只股票（sh600000，市值 600）+ 一只 ETF（sh510300，市值 400）*/
const DEFAULT_POSITIONS: PositionFixture[] = [
  {
    asset_code: 'sh600000',
    totalQuantity: 100,
    totalCostBasis: 500,
    avgCost: 5,
    realizedPnL: 0,
    currentPrice: 6,
    priceDate: '2026-10-17',
    marketValue: 600,
    unrealizedPnl: 100,
    unrealizedYield: 0.2,
    weight: 0.6,
  },
  {
    asset_code: 'sh510300',
    totalQuantity: 100,
    totalCostBasis: 350,
    avgCost: 3.5,
    realizedPnL: 0,
    currentPrice: 4,
    priceDate: '2026-10-17',
    marketValue: 400,
    unrealizedPnl: 50,
    unrealizedYield: 0.142857,
    weight: 0.4,
  },
];

const DEFAULT_SUMMARY: PositionSummaryFixture = {
  totalMarketValue: 1000,
  totalCostBasis: 850,
  unrealizedPnl: 150,
  realizedPnL: 0,
  priceDate: '2026-10-17',
  positionCount: 2,
};

interface ApiOverrides {
  stat?: AssetStatFixture;
  positions?: PositionFixture[];
  /** 显式传 `null` 表示「后端没给汇总」（与「不传」= 用默认值 区分开）*/
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

/**
 * 把颜色字符串归一化成 6 位小写 hex
 *
 * jsdom 会把 `#dbeafe` 归一化成 `rgb(219, 234, 254)`，
 * 直接比对源码里的 hex 字面量会失败，故统一归一化后再断言
 * （与 `review.test.tsx` 的 `bg()` helper 同款思路）。
 */
function toHex(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    return hex.length === 3
      ? `#${hex
          .split('')
          .map((c) => c + c)
          .join('')}`
      : `#${hex}`;
  }
  const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(raw);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]];
    return `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  return raw;
}

/**
 * 「总资产」大字的值
 *
 * ⚠️ 页面上有**两处**「总资产」：卡片标题（第 254 行）+ 指标标签。
 *    指标标签的父元素首个子元素是 30px 的大字 —— 据此区分，
 *    不能直接用 `getByText('总资产')`（会命中两个元素而抛错）。
 */
function totalAssetValue(): string {
  const label = screen.getAllByText('总资产').find((el) => {
    const first = el.parentElement?.firstElementChild;
    return first instanceof HTMLElement && first.style.fontSize === '30px';
  });
  if (!label) throw new Error('未找到「总资产」指标标签');
  return label.parentElement?.firstElementChild?.textContent ?? '';
}

/** 资产组成图例按钮（可访问名 = 图例文案，如「股票 600.00（60.0%）」）*/
function legendButton(kind: 'stock' | 'etf'): HTMLElement {
  return screen.getByRole('button', { name: kind === 'stock' ? /^股票/ : /^ETF/ });
}

/** 饼图本体（带 conic-gradient 的那个节点）*/
function donutNode(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('[style*="conic-gradient"]');
  if (!node) throw new Error('未找到饼图节点');
  return node;
}

/**
 * 持仓明细区
 *
 * ⚠️ **卡 3（F-D2）起持仓区已从 `<table>` 改为卡片网格** ——
 *    本 helper 只改「定位哪个 DOM 节点」，**断言强度与语义完全不变**
 *    （仍是「当前渲染出来的标的代码，按渲染顺序」）。
 *    `<table aria-label="持仓明细">` 已按 F-D2 移除（卡 3 A1 断言页面内 table 数 3 → 2）。
 */
function holdingsTable(): HTMLElement {
  const table = document.querySelector<HTMLElement>('[data-testid="position-grid"]');
  if (!table) throw new Error('未找到持仓卡片区');
  return table;
}

/** 持仓明细区里当前渲染出来的标的代码*/
function holdingCodes(): string[] {
  return Array.from(holdingsTable().querySelectorAll('code')).map((el) => el.textContent ?? '');
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('F-D1 · 资产汇总卡「总资产」取值口径', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('F-D1 总资产：显示 summary.totalMarketValue 而非 totalCostBasis', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 大字 = 市值口径 1000.00（不是持仓总成本 850.00）
    expect(totalAssetValue()).toBe('1000.00');
    expect(totalAssetValue()).not.toBe('850.00');
  });

  it('F-D1 总资产：summary 缺失时显示 -- 不显示 NaN', async () => {
    installApiMock({ summary: null });
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(totalAssetValue()).toBe('--');
    expect(totalAssetValue()).not.toContain('NaN');
    expect(totalAssetValue()).not.toContain('undefined');
    expect(totalAssetValue()).not.toBe('0.00');

    // 成本副行同样降级为 '--'
    expect(screen.getByText('持仓总成本 --')).toBeInTheDocument();
  });

  it('F-D1 总资产：副行显示持仓总成本，两个口径不互相顶替', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 副行：成本口径单独一行，且值是 850.00
    expect(screen.getByText('持仓总成本 850.00')).toBeInTheDocument();

    // 两个口径同时在页面上，且「总资产」位置仍是市值口径
    expect(totalAssetValue()).toBe('1000.00');
    expect(totalAssetValue()).not.toBe('850.00');
  });
});

describe('F-D6 · 资产组成饼图点击下钻', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('F-D6 饼图下钻：点击「股票」图例后持仓列表只剩股票标的', async () => {
    const user = userEvent.setup();
    const { routerPath } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(holdingCodes()).toEqual(['sh600000', 'sh510300']);

    await user.click(legendButton('stock'));

    await waitFor(() => expect(holdingCodes()).toEqual(['sh600000']));
    expect(within(holdingsTable()).queryByText('sh510300')).not.toBeInTheDocument();
    expect(screen.getByText('持仓明细（1 只）')).toBeInTheDocument();

    // 下钻过滤的是持仓列表本身 —— **不切页**
    expect(routerPath).toBe('/');
  });

  it('F-D6 饼图下钻：点击「ETF」图例后持仓列表只剩 ETF 标的', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(legendButton('etf'));

    await waitFor(() => expect(holdingCodes()).toEqual(['sh510300']));
    expect(within(holdingsTable()).queryByText('sh600000')).not.toBeInTheDocument();
  });

  it('F-D6 饼图下钻：再次点击同一图例取消过滤', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(legendButton('stock'));
    await waitFor(() => expect(holdingCodes()).toEqual(['sh600000']));

    // 再点一次同一段 → 回到全部
    await user.click(legendButton('stock'));
    await waitFor(() => expect(holdingCodes()).toEqual(['sh600000', 'sh510300']));
    expect(legendButton('stock').getAttribute('aria-pressed')).toBe('false');
  });

  it('F-D6 饼图下钻：图例按钮 aria-pressed 反映选中态', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(legendButton('stock').getAttribute('aria-pressed')).toBe('false');
    expect(legendButton('etf').getAttribute('aria-pressed')).toBe('false');

    await user.click(legendButton('stock'));
    expect(legendButton('stock').getAttribute('aria-pressed')).toBe('true');
    expect(legendButton('etf').getAttribute('aria-pressed')).toBe('false');

    // 切到另一段 → 选中态跟着换
    await user.click(legendButton('etf'));
    expect(legendButton('stock').getAttribute('aria-pressed')).toBe('false');
    expect(legendButton('etf').getAttribute('aria-pressed')).toBe('true');
  });

  it('F-D6 饼图下钻：选中态有可见差异（底色 / 边框 / 字重）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const btn = legendButton('stock');
    // 未选中：透明底、常规字重
    expect(toHex(btn.style.background)).toBe('transparent');
    expect(btn.style.fontWeight).toBe('400');

    await user.click(legendButton('stock'));

    const active = legendButton('stock');
    // 选中：浅蓝底 + 蓝边框 + 粗体（三重可见差异）
    expect(toHex(active.style.background)).toBe('#dbeafe'); // COLORS.bgSelectedPrimary
    expect(toHex(active.style.borderColor)).toBe('#93c5fd'); // COLORS.borderSelectedPrimary
    expect(active.style.fontWeight).toBe('700');
  });

  it('F-D6 饼图下钻：点击饼图本体也能下钻（与图例一致）', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(donutNode(container));

    // jsdom 无布局 → 坐标判段退化为「市值占比大的一段」（股票 600 > ETF 400）
    await waitFor(() => expect(legendButton('stock').getAttribute('aria-pressed')).toBe('true'));
    expect(holdingCodes()).toEqual(['sh600000']);
  });

  it('F-D6 饼图下钻：饼图本体按点击位置判段（顶部 = 股票段 / 右侧 = ETF 段）', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // jsdom 没有布局引擎 → 手工给一个 120×120 的矩形（圆心 60,60）
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 120,
      bottom: 120,
      width: 120,
      height: 120,
      toJSON: () => ({}),
    });

    const donut = donutNode(container);

    // 12 点方向（正上方）→ 角度 0° → 落在股票段（0~60%）
    await user.pointer([{ target: donut, keys: '[MouseLeft]', coords: { clientX: 60, clientY: 10 } }]);
    await waitFor(() => expect(legendButton('stock').getAttribute('aria-pressed')).toBe('true'));

    // 3 点方向（正右方）→ 角度 90° → 落在 ETF 段（60~100%）
    await user.pointer([{ target: donut, keys: '[MouseLeft]', coords: { clientX: 100, clientY: 60 } }]);
    await waitFor(() => expect(legendButton('etf').getAttribute('aria-pressed')).toBe('true'));
    expect(holdingCodes()).toEqual(['sh510300']);
  });

  it('F-D6 饼图下钻：饼图本体键盘可达（Enter 可下钻）', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const donut = donutNode(container);
    donut.focus();
    expect(document.activeElement).toBe(donut);

    await user.keyboard('{Enter}');

    // jsdom 无布局 → 键盘路径退化为「市值占比大的一段」（股票）
    await waitFor(() => expect(legendButton('stock').getAttribute('aria-pressed')).toBe('true'));
  });

  it('F-D6 饼图下钻：过滤状态有可见反馈且可一键清除', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 未过滤时没有状态提示
    expect(screen.queryByText(/已按「股票」筛选持仓/)).not.toBeInTheDocument();

    await user.click(legendButton('stock'));

    // 可见反馈：告诉用户「现在按什么筛、筛出多少只」
    expect(screen.getByText(/已按「股票」筛选持仓/)).toBeInTheDocument();
    expect(screen.getByText(/已按「股票」筛选持仓（1 \/ 2 只）/)).toBeInTheDocument();

    // 可清除
    await user.click(screen.getByRole('button', { name: '清除筛选' }));

    await waitFor(() => expect(holdingCodes()).toEqual(['sh600000', 'sh510300']));
    expect(legendButton('stock').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText(/已按「股票」筛选持仓/)).not.toBeInTheDocument();
  });

  it('F-D6 饼图下钻：图例与饼图本体都有可访问名（a11y）', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 图例是真按钮 → 天然可聚焦、可读屏
    expect(legendButton('stock')).toHaveAccessibleName(/股票/);
    expect(legendButton('etf')).toHaveAccessibleName(/ETF/);

    // 饼图本体是 role=button + aria-label + 可聚焦（键盘可达）
    const donut = donutNode(container);
    expect(donut.getAttribute('role')).toBe('button');
    expect(donut.getAttribute('tabindex')).toBe('0');
    expect(donut.getAttribute('aria-label')).toContain('资产组成饼图');
  });

  it('回归：donut 渐变角度与图例文案不变', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(donutNode(container).getAttribute('style')).toContain(
      'conic-gradient(#2563eb 0% 60%, #16a34a 60% 100%)',
    );
    expect(screen.getByText('股票 600.00（60.0%）')).toBeInTheDocument();
    expect(screen.getByText('ETF 400.00（40.0%）')).toBeInTheDocument();
  });
});
