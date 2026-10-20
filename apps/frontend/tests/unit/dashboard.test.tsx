import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Dashboard, { DonutChart, isEtf } from '../../src/pages/Dashboard';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * T61 · Dashboard 前端用例
 *
 * 覆盖两条主线：
 * 1. 双口径 Tab 切换（Requirements §5.4：价格收益率 vs 实际收益率）
 *    —— 默认「价格口径」，切到「实际口径」后总盈亏 / 总收益率 / 口径说明文案三者同步换源
 * 2. donut 角度计算（股票 vs ETF 资产组成）
 *    —— 背景 conic-gradient 的分段百分比 + 图例百分比
 *
 * 断言口径全部按 `src/pages/Dashboard.tsx` 源码逐行核实：
 * - 背景分段用**原始数值** `stockPct`（`(stock/total)*100`），**没有** toFixed；
 *   toFixed(1) 只出现在**图例**文案里。
 * - 总盈亏的 `+` 前缀只在数值 >= 0 时出现。
 * - 口径说明文案在「快照日期」那一行的尾部，与其它文案同处一个 div。
 */

/** api.get 的第二个参数（axios config），本用例只关心 params */
interface ApiGetConfig {
  params?: Record<string, unknown>;
}

/** 全局 mock：`api.get` 按 URL 分派返回不同数据 */
const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/** 资产快照（与 `AssetStat` 接口同形）*/
interface AssetStatFixture {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

/** 持仓（与 `Position` 接口同形）*/
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

/** 持仓汇总（与 `PositionSummary` 接口同形）*/
interface PositionSummaryFixture {
  totalMarketValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
  realizedPnL: number;
  priceDate: string | null;
  positionCount: number;
}

/**
 * 默认资产快照：价格口径与实际口径**取不同数值**（否则「切换后数值变化」的断言无意义）
 * - 价格口径：盈亏 +1234.56、收益率 12.34%
 * - 实际口径：盈亏 -789.01（负数，顺带验证不带 + 号）、收益率 23.45%
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
  summary?: PositionSummaryFixture;
}

/** 安装 api.get 的分派实现（每个用例自给自足，不依赖其它用例的副作用）*/
function installApiMock(overrides: ApiOverrides = {}): void {
  const stat = overrides.stat ?? DEFAULT_STAT;
  const positions = overrides.positions ?? DEFAULT_POSITIONS;
  const summary = overrides.summary ?? DEFAULT_SUMMARY;
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

/**
 * 取某个指标下方的数值文本
 *
 * Dashboard 的指标结构是「值 div + 标签 div」并列（源码 238-269 行），
 * 故标签的父元素的首个子元素即数值节点。
 */
function metricText(label: string): string {
  const labelEl = screen.getByText(label);
  const valueEl = labelEl.parentElement?.firstElementChild;
  return valueEl?.textContent ?? '';
}

/** 取 donut 背景节点（带 conic-gradient 的那个 div）*/
function donutNode(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[style*="conic-gradient"]');
}

describe('Dashboard · 双口径 Tab 切换', () => {
  beforeEach(() => {
    // 非 admin 角色 —— 用于断言 admin 接口不被调用
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('初始为价格口径：总盈亏 / 总收益率 / 口径说明均取价格口径', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(metricText('总盈亏')).toBe('+1234.56');
    expect(metricText('总收益率')).toBe('12.34%');
    expect(screen.getByText(/价格口径：纯价格涨跌，不含分红送转/)).toBeInTheDocument();
    expect(screen.queryByText(/实际口径：含分红等现金流/)).not.toBeInTheDocument();
  });

  it('点击「实际口径」后切换为实际口径数值与说明文案', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const priceProfit = metricText('总盈亏');
    const priceYield = metricText('总收益率');
    expect(priceProfit).toBe('+1234.56');
    expect(priceYield).toBe('12.34%');

    await user.click(screen.getByRole('button', { name: '实际口径' }));

    await waitFor(() => expect(metricText('总盈亏')).toBe('-789.01'));
    expect(metricText('总收益率')).toBe('23.45%');

    // 两个口径的数值确实不同（否则上面的断言无意义）
    expect(metricText('总盈亏')).not.toBe(priceProfit);
    expect(metricText('总收益率')).not.toBe(priceYield);

    expect(screen.getByText(/实际口径：含分红等现金流，反映真实收益/)).toBeInTheDocument();
    expect(screen.queryByText(/价格口径：纯价格涨跌/)).not.toBeInTheDocument();
  });

  it('盈亏为负时数值前不带 + 号（两个口径都是负数时均如此）', async () => {
    installApiMock({
      stat: { ...DEFAULT_STAT, total_profit_price: -500, total_profit_actual: -800 },
    });
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(metricText('总盈亏')).toBe('-500.00');
    expect(metricText('总盈亏')).not.toContain('+');

    await user.click(screen.getByRole('button', { name: '实际口径' }));

    await waitFor(() => expect(metricText('总盈亏')).toBe('-800.00'));
    expect(metricText('总盈亏')).not.toContain('+');
  });

  it('资产组成按 ETF / 股票分类汇总市值（sh600000=600 股票，sh510300=400 ETF）', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(donutNode(container)?.getAttribute('style')).toContain(
      'conic-gradient(#2563eb 0% 60%, #16a34a 60% 100%)',
    );
    expect(screen.getByText('股票 600.00（60.0%）')).toBeInTheDocument();
    expect(screen.getByText('ETF 400.00（40.0%）')).toBeInTheDocument();
  });

  it('非 admin 角色不请求 /admin/system-log，也不渲染「最近日志」卡片', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const urls = getMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain('/holding');
    expect(urls).toContain('/asset-stat/latest');
    expect(urls).toContain('/signal');
    expect(urls).not.toContain('/admin/system-log');

    // 信号接口固定带 page_size=5
    expect(getMock).toHaveBeenCalledWith('/signal', { params: { page_size: 5 } });
    expect(screen.queryByText('最近日志')).not.toBeInTheDocument();
  });
});

describe('DonutChart · 角度计算', () => {
  it('股票 600 / ETF 400 → 背景按 60% 分段，图例显示 60.0% / 40.0%', () => {
    const { container } = render(<DonutChart stock={600} etf={400} />);

    const chart = donutNode(container);
    expect(chart).not.toBeNull();
    // 背景用原始数值（无 toFixed）—— 60 恰好整除，不产生小数尾巴
    expect(chart?.getAttribute('style')).toContain(
      'conic-gradient(#2563eb 0% 60%, #16a34a 60% 100%)',
    );

    expect(screen.getByText('股票 600.00（60.0%）')).toBeInTheDocument();
    expect(screen.getByText('ETF 400.00（40.0%）')).toBeInTheDocument();
  });

  it('无持仓（stock=0 etf=0）→ 渲染占位文案且不出现 conic-gradient', () => {
    const { container } = render(<DonutChart stock={0} etf={0} />);

    expect(screen.getByText('暂无持仓资产')).toBeInTheDocument();
    expect(donutNode(container)).toBeNull();
    expect(container.innerHTML).not.toContain('conic-gradient');
  });

  it('只有 ETF（stock=0 etf=100）→ 股票段为 0%', () => {
    const { container } = render(<DonutChart stock={0} etf={100} />);

    const chart = donutNode(container);
    expect(chart).not.toBeNull();
    expect(chart?.getAttribute('style')).toContain(
      'conic-gradient(#2563eb 0% 0%, #16a34a 0% 100%)',
    );

    expect(screen.getByText('股票 0.00（0.0%）')).toBeInTheDocument();
    expect(screen.getByText('ETF 100.00（100.0%）')).toBeInTheDocument();
  });
});

describe('isEtf · A 股 ETF 代码判定', () => {
  const CASES: [string, boolean][] = [
    ['sh510300', true],
    ['sh600000', false],
    ['sz159915', true],
    ['sz000001', false],
    ['sh588000', true],
    ['sz001979', false],
  ];

  it.each(CASES)('%s → %s', (code, expected) => {
    expect(isEtf(code)).toBe(expected);
  });
});
