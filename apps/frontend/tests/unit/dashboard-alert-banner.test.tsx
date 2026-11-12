import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import Dashboard from '../../src/pages/Dashboard';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';

interface ApiGetConfig {
  params?: Record<string, unknown>;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function logRow(overrides: Record<string, unknown>) {
  return {
    id: 1,
    log_date: TODAY,
    created_at: `${TODAY} 17:02:00`,
    log_type: 'tdx2db_update',
    level: 'ERROR',
    message: 'mock error',
    ...overrides,
  };
}

function installApiMock(opts: { update?: unknown[]; check?: unknown[] } = {}): void {
  getMock.mockImplementation(async (url: string, cfg?: ApiGetConfig) => {
    if (url === '/admin/system-log') {
      const logType = cfg?.params?.log_type;
      if (logType === 'tdx2db_update') return mockResponse(opts.update ?? []);
      if (logType === 'datacheck') return mockResponse(opts.check ?? []);
      return mockResponse([]);
    }
    switch (url) {
      case '/holding':
        return mockResponse([]);
      case '/asset-stat/latest':
        return mockResponse({
          trade_date: TODAY,
          total_assets_price_yield: 0,
          total_assets_actual_yield: 0,
          total_profit_price: 0,
          total_profit_actual: 0,
        });
      case '/signal':
      case '/signal/top5':
      case '/signal/stats':
      case '/trade':
      case '/candidate':
        return mockResponse([]);
      case '/ex-dividend/imports':
        return mockResponse({
          from: null,
          to: null,
          items: [],
          summary: { total: 0, dividendCount: 0, bonusCount: 0 },
        });
      case '/market/latest-date':
        return mockResponse({ date: TODAY });
      default:
        return mockResponse([]);
    }
  });
}

beforeEach(() => {
  getMock.mockReset();
  useUserStore.setState({ role: 'admin', token: 'tok', username: 'admin' });
});

describe('Dashboard · 今日行情链路 ERROR 红色横幅', () => {
  it('tdx2db_update 今日 ERROR → 显示红色横幅、失败信息与日志链接', async () => {
    installApiMock({
      update: [logRow({ message: 'tdx2db 退出码 1' })],
    });

    renderWithRouter(<Dashboard />);

    const banner = await screen.findByTestId('dashboard-system-alert');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(within(banner).getByText('今日行情链路异常')).toBeInTheDocument();
    expect(within(banner).getByText(/行情更新失败：tdx2db 退出码 1/)).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: '查看系统日志' })).toHaveAttribute(
      'href',
      '/admin?tab=logs',
    );

    expect(getMock).toHaveBeenCalledWith('/admin/system-log', {
      params: { start_date: TODAY, end_date: TODAY, page_size: 1, log_type: 'tdx2db_update' },
    });
  });

  it('datacheck 今日 ERROR → 显示数据校验异常', async () => {
    installApiMock({
      check: [logRow({ log_type: 'datacheck', message: 'C1 行情缺失' })],
    });

    renderWithRouter(<Dashboard />);

    const banner = await screen.findByTestId('dashboard-system-alert');
    expect(within(banner).getByText(/数据校验异常：C1 行情缺失/)).toBeInTheDocument();
    expect(within(banner).queryByText(/行情更新失败/)).not.toBeInTheDocument();
  });

  it('最新一条为 SUCCESS 时，不显示横幅（即使历史有 ERROR）', async () => {
    installApiMock({
      update: [
        logRow({ id: 2, level: 'SUCCESS', message: 'ok' }),
        logRow({ id: 1, level: 'ERROR', message: 'old error' }),
      ],
    });

    renderWithRouter(<Dashboard />);

    await waitFor(() =>
      expect(getMock.mock.calls.some((call) => call[1]?.params?.log_type === 'tdx2db_update')).toBe(true),
    );
    expect(screen.queryByTestId('dashboard-system-alert')).not.toBeInTheDocument();
  });

  it('非今日 / 非对应 log_type 的 ERROR 不会被误显示', async () => {
    installApiMock({
      update: [logRow({ log_date: YESTERDAY })],
      check: [logRow({ log_type: 'plugin_execute', message: 'plugin failed' })],
    });

    renderWithRouter(<Dashboard />);

    await waitFor(() =>
      expect(getMock.mock.calls.filter((call) => call[1]?.params?.log_type).length).toBe(2),
    );
    expect(screen.queryByTestId('dashboard-system-alert')).not.toBeInTheDocument();
  });

  it('非 admin 不请求告警数据，也不显示横幅', async () => {
    useUserStore.setState({ role: 'user', token: 'tok', username: 'user' });
    installApiMock({ update: [logRow({})] });

    renderWithRouter(<Dashboard />);
    await screen.findByText('仪表盘');

    expect(getMock.mock.calls.some((call) => call[1]?.params?.log_type)).toBe(false);
    expect(screen.queryByTestId('dashboard-system-alert')).not.toBeInTheDocument();
  });
});
