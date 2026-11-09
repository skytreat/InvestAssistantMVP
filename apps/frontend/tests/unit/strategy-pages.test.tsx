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

/** F4 Step B：样本不足时后端清空一切百分比，前端只显示 N */
const EMPTY_STATS = {
  horizon: 't5',
  sampleSize: 3,
  excessSampleSize: 3,
  statusCounts: { ok: 3, incomplete: 0, suspended: 0, no_entry: 0, excluded: 0 },
  insufficientSample: true,
  winRateAbsolute: null,
  winRateExcess: null,
  avgNetReturn: null,
  avgBenchmarkReturn: null,
  avgExcessReturn: null,
};

const EFFECTIVENESS = {
  meta: {
    from: '2026-08-10',
    to: '2026-11-08',
    benchmark: 'sh510300',
    benchmarkClass: 'etf',
    groupBy: 'plugin',
    horizons: ['t1', 't5', 't10'],
    notional: 50000,
    sampleSize: 3,
    insufficientSample: true,
    statusCounts: { ok: 3, incomplete: 0, suspended: 0, no_entry: 0, excluded: 0 },
    fees: {
      commissionRate: 0.0001,
      minCommission: 5,
      stampDutyRate: 0,
      transferFeeRate: 0,
      slippageRate: 0.0001,
    },
    feeModelLabel: 'ETF 口径（印花税 0 / 过户费 0）',
    feeModels: [],
    // F4 Step C：采纳/忽略三分口径（样本不足时不出百分比）
    adoption: {
      adopted: 1,
      ignored: 1,
      pending: 1,
      processed: 2,
      insufficientSample: true,
      adoptionRate: null,
    },
    generatedAt: '2026-11-08T00:00:00.000Z',
  },
  summary: [EMPTY_STATS],
  groups: [],
  details: [],
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
      case '/strategy/effectiveness':
        return mockResponse(EFFECTIVENESS);
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

describe('F6 · 跨境 ETF 提示（PRD U13）', () => {
  it('编辑组合策略参数时提示一次，可关闭；再次编辑不再出现', async () => {
    renderWithRouter(<StrategyConfig />);
    await screen.findByText('RSI 超卖');

    // 第一次打开参数编辑器 → 出现提示
    await userEvent.click(screen.getAllByRole('button', { name: /编辑参数/ })[0]);
    const hint = await screen.findByTestId('strategy-crossborder-hint');
    expect(hint).toHaveTextContent('跨境 ETF 在 A 股时段流动性受限');
    // 提示不阻断保存/编辑（参数表单照常渲染）
    expect(await screen.findByLabelText(/阈值/)).toBeInTheDocument();

    // 关闭提示
    await userEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByTestId('strategy-crossborder-hint')).not.toBeInTheDocument();

    // 收起后再打开另一个策略 → 不再重复提示
    await userEvent.click(screen.getByRole('button', { name: '收起参数' }));
    await userEvent.click(screen.getAllByRole('button', { name: /编辑参数/ })[1]);
    expect(screen.queryByTestId('strategy-crossborder-hint')).not.toBeInTheDocument();
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

  it('有效性统计：费率口径脚注常显；样本不足只显示 N 条、不显示百分比', async () => {
    renderWithRouter(<StrategyEffectiveness />);
    expect(await screen.findByText(/本次结果基于 ETF 口径（印花税 0 \/ 过户费 0）/)).toBeInTheDocument();
    expect(screen.getByText(/样本不足（3 条）/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出汇总' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出明细' })).toBeInTheDocument();
  });
});

describe('T150 组合体检页（/portfolio/risk-check）', () => {
  it('四指标卡片 + 行业分布（排除现金分母）', async () => {
    renderWithRouter(<RiskCheck />);
    expect(await screen.findByText('12.5%')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.getByText('8.4%')).toBeInTheDocument();
    expect(screen.getByText('行业分布（板块口径）')).toBeInTheDocument();
    expect(screen.getByText('行业/板块')).toBeInTheDocument();
    expect(screen.getByText(/分母已排除现金类资产/)).toBeInTheDocument();
    expect(screen.getByText(/数据不可用时降级为交易所维度/)).toBeInTheDocument();
  });

  /**
   * 2026-11-06（J3）：行业数据不可用时后端返回 distributionBasis='exchange'，
   * 前端标题/表头/行名必须同步改成交易所口径（不能继续显示「行业」）。
   */
  it('行业数据不可用 → 降级为交易所分布，行名映射为交易所', async () => {
    getMock.mockImplementationOnce(async () =>
      mockResponse({
        singleStockMaxWeight: 34.67,
        top10Concentration: 97.07,
        availableCashRatio: 0,
        maxDrawdown: 15.32,
        industryDistribution: [
          { industry: 'sh', weight: 83.12 },
          { industry: 'sz', weight: 16.88 },
        ],
        cashExcluded: true,
        distributionBasis: 'exchange',
        distributionNote:
          '当前按交易所维度展示（sh=上交所 / sz=深交所 / bj=北交所）：本机行情副本板块成分为 0 行。',
        maxDrawdownNote: '口径：累计盈亏自峰值回落 ÷ 全期峰值持仓成本。',
      }),
    );
    renderWithRouter(<RiskCheck />);
    expect(await screen.findByText('15.32%')).toBeInTheDocument();
    expect(screen.getByText('交易所分布（行业数据不可用，降级）')).toBeInTheDocument();
    expect(screen.getByText('交易所')).toBeInTheDocument();
    expect(screen.getByText('上交所（sh）')).toBeInTheDocument();
    expect(screen.getByText('深交所（sz）')).toBeInTheDocument();
    expect(screen.getByText('83.12%')).toBeInTheDocument();
    expect(screen.getByText(/当前按交易所维度展示/)).toBeInTheDocument();
    expect(screen.getByText(/全期峰值持仓成本/)).toBeInTheDocument();
  });

  /**
   * 2026-11-06：ETF 为主的组合行业归属覆盖为 0，行业分布会全部落进「未分类」。
   * 必须展示覆盖率，避免用户把「未分类 100%」当成数据错误。
   */
  it('行业口径下展示覆盖率：ETF 为主 → 0/12 并标注数据覆盖问题', async () => {
    getMock.mockImplementationOnce(async () =>
      mockResponse({
        singleStockMaxWeight: 12.5,
        top10Concentration: 55,
        availableCashRatio: 20,
        maxDrawdown: 15.32,
        industryDistribution: [{ industry: '未分类', weight: 100 }],
        cashExcluded: true,
        distributionBasis: 'industry',
        industryCoverage: { covered: 0, total: 12, rate: 0 },
        distributionNote: '行业分布：按通达信板块成分聚合（block_type=tdx_research，block_level=1）。',
      }),
    );
    renderWithRouter(<RiskCheck />);
    expect(await screen.findByText('行业分布（板块口径）')).toBeInTheDocument();
    expect(screen.getByText(/行业归属覆盖 0\/12 只持仓（0%）/)).toBeInTheDocument();
    expect(screen.getByText(/「未分类」占 100% 属数据覆盖问题/)).toBeInTheDocument();
  });
});
