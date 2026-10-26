import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import React from 'react';
import PortfolioReturn from '../../src/pages/PortfolioReturn';
import PositionCard from '../../src/components/PositionCard';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * V3.8 T146/T147 组合域用例
 *
 * - T147 收益页：总收益大字 + 风险/现金分项（钱从哪来）+ 费用单独显示 + 口径说明入口（必须存在）+ 券商筛选
 * - T146 持仓卡：现金类标签 + 券商维度列（'mixed' → 多券商；null → 手工）
 */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: vi.fn() },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/portfolio/return',
}));

const RETURN_DATA = {
  risk: { pnl: 1200, cost: 20000, rate: 6, realized: 800, dividend: 200, fees: 350 },
  cash: { pnl: 300, cost: 50000, rate: 0.6, repoInterest: 260, cashEtfChange: 40 },
  total: { pnl: 1500, cost: 70000, rate: 2.1, assets: 71500, invested: 70000, fees: 350 },
  caliberNote: '成本口径；与券商资金流水口径差异：逆回购利息按配对结果计。',
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url === '/portfolio/return') return Promise.resolve(mockResponse(RETURN_DATA));
    if (url === '/broker-import/batches')
      return Promise.resolve(mockResponse({ batches: [{ broker_code: 'gt' }] }));
    return Promise.reject(new Error(`unexpected get ${url}`));
  });
});

describe('T147 收益页 /portfolio/return', () => {
  it('总收益大字 + 分项展开 + 费用单独显示 + 口径说明入口', async () => {
    renderWithRouter(<PortfolioReturn />, { initialEntries: ['/portfolio/return'] });

    await waitFor(() => expect(screen.getByText('+2.1%')).toBeInTheDocument());
    // 分项（钱从哪来）
    expect(screen.getByText('已实现盈亏')).toBeInTheDocument();
    expect(screen.getByText('逆回购利息')).toBeInTheDocument();
    expect(screen.getByText('货币 ETF 市值变动')).toBeInTheDocument();
    // 费用单独显示
    expect(screen.getByText(/累计费用 350/)).toBeInTheDocument();
    // 口径说明入口（默认收起，点开可见）
    expect(screen.getByRole('button', { name: '口径说明' })).toBeInTheDocument();
  });

  it('口径说明点开可见（caliberNote 必须可呈现）', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithRouter(<PortfolioReturn />, { initialEntries: ['/portfolio/return'] });
    await waitFor(() => expect(screen.getByRole('button', { name: '口径说明' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '口径说明' }));
    expect(screen.getByText(/与券商资金流水口径差异/)).toBeInTheDocument();
  });

  it('券商筛选：选择后带 brokerCode 请求', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithRouter(<PortfolioReturn />, { initialEntries: ['/portfolio/return'] });
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox'), 'gt');
    await waitFor(() =>
      expect(
        getMock.mock.calls.some((c) => c[0] === '/portfolio/return' && c[1]?.params?.brokerCode === 'gt'),
      ).toBe(true),
    );
  });
});

describe('T146 持仓卡 券商/现金类维度', () => {
  const basePosition = {
    asset_code: 'sh511880',
    totalQuantity: 1000,
    totalCostBasis: 100000,
    avgCost: 100,
    realizedPnL: 0,
    currentPrice: 100,
    priceDate: '2026-10-24',
    marketValue: 100000,
    unrealizedPnl: 0,
    unrealizedYield: 0,
    weight: 1,
    prevClose: 100,
    signal: null,
    name: '华宝现金',
    industry: null,
  };

  it('现金类标签 + 单券商显示', () => {
    renderWithRouter(
      <PositionCard
        position={{ ...basePosition, asset_class: 'cash', broker_code: 'gt' } as never}
        assetType="etf"
      />,
    );
    expect(screen.getByTestId('position-card-cash')).toBeInTheDocument();
    expect(screen.getByTestId('position-card-broker')).toHaveTextContent('券商：gt');
  });

  it('多券商 → 「多券商」；纯手工 → 「手工」', () => {
    const { unmount } = renderWithRouter(
      <PositionCard
        position={{ ...basePosition, asset_class: 'cash', broker_code: 'mixed' } as never}
        assetType="etf"
      />,
    );
    expect(screen.getByTestId('position-card-broker')).toHaveTextContent('多券商');
    unmount();

    renderWithRouter(
      <PositionCard position={{ ...basePosition, broker_code: null } as never} assetType="etf" />,
    );
    expect(screen.getByTestId('position-card-broker')).toHaveTextContent('手工');
  });

  it('非现金类不渲染现金标签；旧接口（无字段）不渲染券商 chip', () => {
    const { unmount } = renderWithRouter(<PositionCard position={basePosition as never} assetType="etf" />);
    expect(screen.queryByTestId('position-card-cash')).toBeNull();
    expect(screen.queryByTestId('position-card-broker')).toBeNull();
    unmount();
  });
});
