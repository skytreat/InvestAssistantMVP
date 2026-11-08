import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import PaperAccount from '../../src/pages/PaperAccount';
import { mockErrorResponse, mockResponse, renderWithRouter } from '../helpers';

/**
 * PA-14 · 纸面账户页组件测试
 *
 * 覆盖 S4 Gate 要求的切阶段三态：**确认（二次确认 + 后果文案）/ 成功可见 / 失败可见**，
 * 以及影子期与落账期两套分区（影子期不展示持仓与净值）。
 */

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, post: postMock },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/paper',
}));

const SHADOW_ACCOUNT = {
  id: 1,
  name: '纸面账户',
  strategyId: 'buy_and_hold',
  strategyVersion: '1.0.0',
  strategyName: '买入持有',
  phase: 'shadow',
  status: 'active',
  initialCash: 1000000,
  cash: 1000000,
  startDate: '2026-11-05',
  ledgerStartDate: null,
  lastDecisionDate: '2026-11-06',
  lastSettledDate: null,
  benchmarkAssetCode: 'sh510300',
};

const TARGET_ORDER = {
  id: 11,
  decisionDate: '2026-11-06',
  tradeDate: '2026-11-09',
  assetCode: 'sh600000',
  intentKind: 'target',
  side: 'buy',
  targetWeight: 0.5,
  intentNotional: 500000,
  status: 'shadow',
  filledQty: 0,
  fillPrice: null,
  fee: 0,
  unfilledReason: null,
};

const SHADOW_REPORT = {
  account: SHADOW_ACCOUNT,
  shadow: {
    latestDecisionDate: '2026-11-06',
    latestTradeDate: '2026-11-09',
    latestTargets: [TARGET_ORDER],
    days: [{ decisionDate: '2026-11-06', targetCount: 1, buyIntentCount: 1, sellIntentCount: 0 }],
    stability: { comparedDays: 0, identicalDays: 0, changedDays: 0 },
    dataQuality: { checkedPairs: 1, missingBarPairs: 0, zeroVolumePairs: 0 },
    orderCounts: { shadow: 1 },
  },
  ledger: null,
};

const LEDGER_ACCOUNT = { ...SHADOW_ACCOUNT, phase: 'ledger', ledgerStartDate: '2026-11-09', cash: 1000000 };

const LEQUITY = [
  {
    tradeDate: '2026-11-09',
    equity: 1000000,
    cash: 1000000,
    riskMv: 0,
    cashMv: 0,
    exposure: 0,
    benchmarkClose: null,
    benchmarkStale: false,
  },
  {
    tradeDate: '2026-11-10',
    equity: 1012345.67,
    cash: 900000,
    riskMv: 112345.67,
    cashMv: 0,
    exposure: 0.11,
    benchmarkClose: 3800,
    benchmarkStale: false,
  },
];

const LEDGER_REPORT = {
  account: LEDGER_ACCOUNT,
  shadow: null,
  ledger: {
    equity: LEQUITY,
    positions: [
      {
        assetCode: 'sh600000',
        qty: 249900,
        avgCost: 4.0004,
        costBasis: 1000000,
        closeableQty: 0,
        lastPrice: 4.0004,
        lastPriceDate: '2026-11-10',
      },
    ],
    orderCounts: { filled: 1 },
    unfilledReasons: {},
    latest: {
      tradeDate: '2026-11-10',
      equity: 1012345.67,
      cash: 900000,
      cashMv: 0,
      exposure: 0.11,
      cashRatio: 0.89,
      cashLikeRatio: 0.89,
      unfilledBuyIntentRatio: 0,
    },
  },
};

const FILLED_ORDER = {
  ...TARGET_ORDER,
  id: 12,
  decisionDate: '2026-11-09',
  tradeDate: '2026-11-10',
  status: 'filled',
  filledQty: 249900,
  fillPrice: 4.0004,
  fee: 100,
};

/** 每个用例前重置：「当前阶段」是可变状态，切阶段成功后 getMock 返回落账期 */
let phase: 'shadow' | 'ledger' = 'shadow';

beforeEach(() => {
  vi.clearAllMocks();
  phase = 'shadow';
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/paper/accounts':
        return mockResponse([phase === 'shadow' ? SHADOW_ACCOUNT : LEDGER_ACCOUNT]);
      case '/paper/accounts/1/report':
        return mockResponse(phase === 'shadow' ? SHADOW_REPORT : LEDGER_REPORT);
      case '/paper/accounts/1/orders':
        return mockResponse(phase === 'shadow' ? [TARGET_ORDER] : [FILLED_ORDER]);
      default:
        return mockResponse([]);
    }
  });
});

describe('PA-14 纸面账户页', () => {
  it('影子期：展示当前阶段、固定提示与目标清单，且「手动切换阶段」按钮存在', async () => {
    renderWithRouter(<PaperAccount />, { initialEntries: ['/paper'] });
    expect(await screen.findByText('影子期（shadow）')).toBeInTheDocument();
    expect(screen.getByText(/模拟成交，非真实交易；/)).toBeInTheDocument();
    expect(await screen.findByText('sh600000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '切换到落账期' })).toBeInTheDocument();
  });

  it('切阶段：二次确认写明重置水位与不补记；确认后 POST 参数正确且成功可见', async () => {
    postMock.mockImplementation(async (_url: string, body: { to: string; confirm: boolean }) => {
      expect(body).toEqual({ to: 'ledger', confirm: true });
      phase = 'ledger';
      return mockResponse(LEDGER_ACCOUNT);
    });

    renderWithRouter(<PaperAccount />, { initialEntries: ['/paper'] });
    await userEvent.click(await screen.findByRole('button', { name: '切换到落账期' }));

    // 二次确认 + 后果文案（不是「确定要切换吗」）
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/重置决策与结算水位/)).toBeInTheDocument();
    expect(screen.getByText(/不会补记成交/)).toBeInTheDocument();
    expect(screen.getByText(/清空持仓检查点/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '确认切换' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/paper/accounts/1/phase', { to: 'ledger', confirm: true }),
    );
    // 成功可见
    expect(await screen.findByRole('status')).toHaveTextContent(/已切换到落账期/);
    // 切换后进入落账期分区
    expect(await screen.findByTestId('paper-ledger-section')).toBeInTheDocument();
  });

  it('切阶段失败：错误原因可见（不静默吞掉）', async () => {
    postMock.mockRejectedValue(
      mockErrorResponse(409, 'PAPER_PENDING_EXISTS', '存在 3 条待成交订单，不能切阶段'),
    );

    renderWithRouter(<PaperAccount />, { initialEntries: ['/paper'] });
    await userEvent.click(await screen.findByRole('button', { name: '切换到落账期' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认切换' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('存在 3 条待成交订单，不能切阶段');
    // 失败后仍停留在影子期（按钮保留，可重试）
    expect(screen.getByRole('button', { name: '切换到落账期' })).toBeInTheDocument();
  });

  it('落账期：展示净值与持仓，不提供切阶段按钮（单向不可回退）', async () => {
    phase = 'ledger';
    renderWithRouter(<PaperAccount />, { initialEntries: ['/paper'] });

    expect(await screen.findByTestId('paper-ledger-section')).toBeInTheDocument();
    expect(screen.getByText('¥1,012,345.67')).toBeInTheDocument();
    expect(screen.getAllByText('249,900').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /净值曲线/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '切换到落账期' })).toBeNull();
    expect(screen.getByText(/阶段只允许单向切换/)).toBeInTheDocument();
  });

  it('无纸面账户时给出空态提示', async () => {
    getMock.mockImplementation(async (url: string) =>
      url === '/paper/accounts' ? mockResponse([]) : mockResponse(null),
    );
    renderWithRouter(<PaperAccount />, { initialEntries: ['/paper'] });
    expect(await screen.findByText('当前没有纸面账户。')).toBeInTheDocument();
  });
});
