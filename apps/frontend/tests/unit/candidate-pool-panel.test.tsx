/**
 * T79 ⑥ · Dashboard 候选池联动面板
 *
 * 口径（实施计划 T79）：
 * - 默认折叠成一条窄条：「候选池 N 只 · M 只有信号」；
 * - 展开 Top 5，**有信号优先 → 跟踪天数长优先**；
 * - 每条可【买入】→ 父级预填 `TradeFormModal`（现价 + D-11 理由）；
 * - 已迁移候选（`migrated_from_candidate=1`）不占用 Dashboard 跟踪位。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import CandidatePoolPanel from '../../src/components/CandidatePoolPanel';
import { mockResponse, renderWithRouter } from '../helpers';

interface CandidateFixture {
  asset_code: string;
  name: string | null;
  current_close: number | null;
  tracked_days: number | null;
  migrated_from_candidate: number;
  signal: {
    plugin_id: string;
    direction: 'buy' | 'sell' | 'hold';
    label: string;
    trade_date: string;
  } | null;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

const ROWS: CandidateFixture[] = [
  {
    asset_code: 'sh600001',
    name: '无信号但跟踪久',
    current_close: 10.5,
    tracked_days: 100,
    migrated_from_candidate: 0,
    signal: null,
  },
  {
    asset_code: 'sh600002',
    name: '有信号跟踪 30 天',
    current_close: 20.5,
    tracked_days: 30,
    migrated_from_candidate: 0,
    signal: { plugin_id: 'macd_cross', direction: 'buy', label: '金叉', trade_date: '2026-10-22' },
  },
  {
    asset_code: 'sh600003',
    name: '有信号跟踪 10 天',
    current_close: 30.5,
    tracked_days: 10,
    migrated_from_candidate: 0,
    signal: { plugin_id: 'rsi_revert', direction: 'sell', label: '超买', trade_date: '2026-10-22' },
  },
  {
    asset_code: 'sh600004',
    name: '已迁移',
    current_close: 40.5,
    tracked_days: 999,
    migrated_from_candidate: 1,
    signal: { plugin_id: 'macd_cross', direction: 'buy', label: '金叉', trade_date: '2026-10-22' },
  },
];

function install(rows: CandidateFixture[] = ROWS): void {
  getMock.mockImplementation(async (url: string) => {
    if (url === '/candidate') return mockResponse(rows);
    throw new Error(`未预期的接口调用: ${url}`);
  });
}

describe('T79 ⑥ · CandidatePoolPanel', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('默认折叠，窄条只统计未迁移候选（N 只 · M 只有信号）', async () => {
    install();
    renderWithRouter(<CandidatePoolPanel />);

    expect(await screen.findByText('候选池 3 只 · 2 只有信号')).toBeInTheDocument();
    expect(screen.queryByTestId('candidate-pool-body')).not.toBeInTheDocument();
    expect(screen.queryByText('sh600004')).not.toBeInTheDocument();
  });

  it('展开后按「有信号优先 → 跟踪天数长优先」排序，最多 5 条', async () => {
    install();
    const user = userEvent.setup();
    renderWithRouter(<CandidatePoolPanel />);
    await screen.findByText('候选池 3 只 · 2 只有信号');

    await user.click(screen.getByTestId('candidate-pool-toggle'));

    const rows = screen.getAllByTestId('candidate-pool-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('sh600002');
    expect(rows[1]).toHaveTextContent('sh600003');
    expect(rows[2]).toHaveTextContent('sh600001');
  });

  it('【买入】回传代码 / 现价 / D-11 理由', async () => {
    install();
    const onBuy = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<CandidatePoolPanel onBuy={onBuy} />);
    await screen.findByText('候选池 3 只 · 2 只有信号');

    await user.click(screen.getByTestId('candidate-pool-toggle'));
    await user.click(screen.getByRole('button', { name: '买入 sh600002' }));

    expect(onBuy).toHaveBeenCalledWith({
      assetCode: 'sh600002',
      price: 20.5,
      reason: 'macd_cross 金叉 买入 (2026-10-22)',
    });
  });

  it('接口失败时降级为「候选池暂不可用」，不拖垮页面', async () => {
    getMock.mockRejectedValue(new Error('HTTP 500'));
    renderWithRouter(<CandidatePoolPanel />);

    expect(await screen.findByText('候选池暂不可用')).toBeInTheDocument();
  });

  it('空态提供去条件选股的出口', async () => {
    install([]);
    const user = userEvent.setup();
    renderWithRouter(<CandidatePoolPanel />);
    await screen.findByText('候选池 0 只 · 0 只有信号');

    await user.click(screen.getByTestId('candidate-pool-toggle'));

    expect(await screen.findByTestId('candidate-pool-empty')).toHaveTextContent('候选池暂无标的');
    expect(screen.getByRole('link', { name: '去条件选股' })).toHaveAttribute('href', '/stockscan');
    expect(screen.queryByTestId('candidate-pool-row')).not.toBeInTheDocument();
  });
});
