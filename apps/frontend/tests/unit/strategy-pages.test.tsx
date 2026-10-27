import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import StrategyConfig from '../../src/pages/StrategyConfig';
import StrategyEffectiveness from '../../src/pages/StrategyEffectiveness';
import RiskCheck from '../../src/pages/RiskCheck';
import { renderWithRouter, mockResponse } from '../helpers';

/**
 * V3.8 策略域 · 页面级用例（T148 策略配置 / T150 有效性 + 体检）
 *
 * - T148：插件列表按分类渲染、启用开关、参数具名编辑（schema 驱动 + 范围校验拦截）
 * - T150：T+1/T+5/T+10 后续表现（真实行情 outcome）；体检四指标 + 行业分布（分母排除现金）
 */

const { getMock, postMock, putMock, patchMock, delMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  patchMock: vi.fn(),
  delMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock, put: putMock, patch: patchMock, delete: delMock },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/strategy/config',
}));

const PLUGINS = [
  {
    id: 'rsi_oversold',
    name: 'RSI 超卖',
    category: 'monitor',
    description: 'RSI 低于阈值触发买入信号',
    enabled: 1,
    params: { period: 6, threshold: 30 },
    paramSchema: [
      { key: 'period', label: '周期', type: 'number', min: 2, max: 100, default: 6 },
      { key: 'threshold', label: '阈值', type: 'number', min: 0, max: 100, default: 30, unit: '%' },
    ],
  },
  {
    id: 'liquidity_filter',
    name: '流动性过滤',
    category: 'filter',
    description: '剔除低流动性标的',
    enabled: 0,
    params: {},
    paramSchema: [
      { key: 'minTurnover', label: '最低成交额', type: 'number', min: 0, max: 1e9, default: 10000000 },
    ],
  },
];

const OUTCOME = {
  signalId: 7,
  asset_code: 'sh600000',
  trade_date: '2024-01-02',
  direction: 'buy',
  baseClose: 10,
  t1: { date: '2024-01-03', close: 10.2, changePct: 2 },
  t5: { date: '2024-01-09', close: 9.8, changePct: -2 },
  t10: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/strategy/plugins':
        return mockResponse(PLUGINS);
      case '/signal':
        return mockResponse([
          {
            id: 7,
            asset_code: 'sh600000',
            plugin_id: 'rsi_oversold',
            direction: 'buy',
            trade_date: '2024-01-02',
          },
        ]);
      case '/strategy/signals/7/outcome':
        return mockResponse(OUTCOME);
      case '/portfolio/risk-check':
        return mockResponse({
          singleStockMaxWeight: 12.5,
          top10Concentration: 55,
          availableCashRatio: 20,
          maxDrawdown: 8.4,
          industryDistribution: [
            { industry: '60', weight: 60 },
            { industry: '00', weight: 40 },
          ],
          cashExcluded: true,
        });
      default:
        return mockResponse({ data: [] });
    }
  });
  putMock.mockResolvedValue(mockResponse({ data: null }));
  patchMock.mockResolvedValue(mockResponse({ data: null }));
  postMock.mockResolvedValue(mockResponse({ data: null }));
  delMock.mockResolvedValue(mockResponse({ data: null }));
});

describe('T148 策略配置页（/strategy/config）', () => {
  it('按分类渲染插件列表，含启用开关', async () => {
    renderWithRouter(<StrategyConfig />);
    expect(await screen.findByText('监控类策略')).toBeInTheDocument();
    expect(screen.getByText('过滤类策略')).toBeInTheDocument();
    expect(screen.getByText('RSI 超卖')).toBeInTheDocument();
    expect(screen.getByText('流动性过滤')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'RSI 超卖 启用' })).toBeChecked();
  });

  it('编辑参数 → 超范围值被前端校验拦截（不发请求）', async () => {
    renderWithRouter(<StrategyConfig />);
    await screen.findByText('RSI 超卖');
    // 两个插件各有一个「编辑参数」按钮，取第一个（rsi_oversold）
    await userEvent.click(screen.getAllByRole('button', { name: /编辑参数/ })[0]);
    const threshold = await screen.findByLabelText(/阈值/);
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '999');
    await userEvent.click(screen.getByRole('button', { name: /^保存$/ }));
    expect(await screen.findByText(/插件「RSI 超卖」的「阈值」不能大于 100/)).toBeInTheDocument();
    // 校验拦截 → 不发 put
    expect(putMock).not.toHaveBeenCalled();
  });

  it('启用开关切换 → PUT /toggle 且列表状态更新', async () => {
    renderWithRouter(<StrategyConfig />);
    await screen.findByText('流动性过滤');
    await userEvent.click(screen.getByRole('checkbox', { name: '流动性过滤 启用' }));
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/strategy/plugins/liquidity_filter/toggle', { enabled: true }),
    );
    expect(await screen.findByText(/已启用/)).toBeInTheDocument();
  });
});

describe('T150 策略有效性页（/strategy/effectiveness）', () => {
  it('列出信号，点「后续表现」渲染 T+1/T+5/T+10', async () => {
    renderWithRouter(<StrategyEffectiveness />);
    const btn = await screen.findByRole('button', { name: '后续表现' });
    await userEvent.click(btn);
    expect(await screen.findByText('2%（2024-01-03）')).toBeInTheDocument();
    expect(screen.getByText('-2%（2024-01-09）')).toBeInTheDocument();
    // T+10 为 null → 占位
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('T150 组合体检页（/portfolio/risk-check）', () => {
  it('四指标卡片 + 行业分布（标注近似 + 排除现金分母）', async () => {
    renderWithRouter(<RiskCheck />);
    expect(await screen.findByText('12.5%')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.getByText('8.4%')).toBeInTheDocument();
    expect(screen.getByText('行业/板块（代码前缀）')).toBeInTheDocument();
    expect(screen.getByText(/分母已排除现金类资产/)).toBeInTheDocument();
    expect(screen.getByText(/为近似口径/)).toBeInTheDocument();
  });
});
