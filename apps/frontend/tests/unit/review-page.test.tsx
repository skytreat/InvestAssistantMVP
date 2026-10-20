/**
 * T69 · Review 页（交易复盘）补全 + bug 修复的用例
 *
 * 覆盖 T69 ①~⑦：
 * 1. ① 日期范围筛选（`start_date` / `end_date` 进请求参数）
 * 2. ② 4 色 pill 标签 + 图例（止损红 > 系统信号绿 > 主观决策橙 > 未复盘灰）
 * 3. ③ 分页可推进（**Wave 1 就登记、至今未修的 `setPage` 缺失 bug**）
 * 4. ④ 交易类型筛选项/列表文案统一取自 `components/tradeTypes`
 * 5. ⑤ 收益曲线悬浮 tooltip 显示具体数值
 * 6. ⑥ 筛选即时生效（300ms 防抖自动重查，**没有「筛选」按钮**）
 * 7. ⑦ 三态字段选中态视觉加强（是=绿 / 否=红 / 未标记=灰 + fontWeight 600 + borderWidth 2px）
 * 8. G4.6 · 375px 无横向溢出的**结构契约**（表格套可横向滚动容器 + 长文本截断）
 *
 * ⚠️ **jsdom 没有 layout engine**（`clientWidth` 恒 0）→ 真实溢出数值只能靠
 *    真浏览器探针（`scripts/probe-overflow.mjs`），本文件只钉结构契约。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Review from '../../src/pages/Review';
import { mockResponse, renderWithRouter } from '../helpers';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

interface ApiGetConfig {
  params?: Record<string, unknown>;
}

const { getMock, patchMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
  patchMock: vi.fn<(url: string, payload?: unknown) => Promise<unknown>>(),
  postMock: vi.fn<(url: string, payload?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({
  api: { get: getMock, patch: patchMock, post: postMock },
}));

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

interface TradeFixture {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
  is_auto_import: number;
  system_followed: number | null;
  strategy_match: number | null;
  is_stop_loss: number | null;
  review_summary: string | null;
  remark: string | null;
  created_at: string;
}

function trade(over: Partial<TradeFixture> = {}): TradeFixture {
  return {
    id: 1,
    asset_code: 'sh600000',
    trade_type: 'buy',
    trade_date: '2026-03-15',
    quantity: 100,
    price: 10.5,
    fee: 5.25,
    trade_reason: '突破均线',
    is_auto_import: 0,
    system_followed: 0,
    strategy_match: null,
    is_stop_loss: null,
    review_summary: null,
    remark: null,
    created_at: '2026-03-15 10:00:00',
    ...over,
  };
}

/**
 * 4 色标签的 4 个代表样本（另加一个「止损 + 系统信号」用于验优先级）
 *
 * | 样本 | 关键字段 | 期望档位 |
 * |---|---|---|
 * | sh600001 | `is_stop_loss=1` + `system_followed=1` | 止损（红）—— **优先级最高** |
 * | sh600002 | `system_followed=1` | 系统信号（绿）|
 * | sh600003 | `review_summary` 非空 | 主观决策（橙）|
 * | sh600004 | 全部未标记 | 未复盘（灰）|
 */
const TAG_TRADES: TradeFixture[] = [
  trade({ id: 1, asset_code: 'sh600001', is_stop_loss: 1, system_followed: 1 }),
  trade({ id: 2, asset_code: 'sh600002', system_followed: 1 }),
  trade({ id: 3, asset_code: 'sh600003', review_summary: '按计划执行' }),
  trade({ id: 4, asset_code: 'sh600004' }),
];

const HISTORY = [
  {
    trade_date: '2026-01-15',
    total_assets_price_yield: 0.1234,
    total_assets_actual_yield: 0.2345,
    total_profit_price: 1234.56,
    total_profit_actual: 2345.67,
  },
  {
    trade_date: '2026-02-15',
    total_assets_price_yield: -0.0512,
    total_assets_actual_yield: 0.0101,
    total_profit_price: -512.34,
    total_profit_actual: 101.1,
  },
];

const STATS = {
  totalTrades: 4,
  reviewedCount: 1,
  closedCount: 0,
  winCount: 0,
  lossCount: 0,
  winRate: null,
  avgWin: null,
  avgLoss: null,
  profitLossRatio: null,
  totalRealizedPnl: 0,
};

interface ApiOverrides {
  trades?: TradeFixture[];
  totalPages?: number;
  total?: number;
  history?: typeof HISTORY;
}

function installApiMock(overrides: ApiOverrides = {}): void {
  const trades = overrides.trades ?? TAG_TRADES;
  const totalPages = overrides.totalPages ?? 1;
  const total = overrides.total ?? trades.length;
  const history = overrides.history ?? HISTORY;

  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/review/yield':
        return mockResponse(STATS);
      case '/review/trades':
        return mockResponse(trades, { pagination: { totalPages, total } });
      case '/asset-stat/history':
        return mockResponse(history);
      default:
        throw new Error(`未预期的接口调用: ${url}`);
    }
  });

  patchMock.mockResolvedValue(mockResponse(null));
  postMock.mockResolvedValue(mockResponse(null));
}

/** 最近一次 `/review/trades` 请求的参数 */
function lastTradesParams(): Record<string, unknown> {
  const calls = getMock.mock.calls.filter((c) => c[0] === '/review/trades');
  expect(calls.length).toBeGreaterThan(0);
  return (calls[calls.length - 1][1]?.params ?? {}) as Record<string, unknown>;
}

/** 取某一行交易里的标签 pill */
function pillOf(assetCode: string): HTMLElement {
  const cell = screen.getByText(assetCode).closest('tr');
  if (!cell) throw new Error(`未找到交易行：${assetCode}`);
  const pill = within(cell).getByTestId(/^review-tag-/);
  return pill;
}

/** 归一化 inline style 的 background（jsdom 会把 hex 转成 rgb()）*/
function bg(el: HTMLElement): string {
  const raw = el.style.background.trim().toLowerCase();
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    return hex.length === 3
      ? `#${hex
          .split('')
          .map((c) => c + c)
          .join('')}`
      : `#${hex}`;
  }
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(raw);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]];
    return `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  return raw;
}

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
  postMock.mockReset();
  installApiMock();
});

/* ------------------------------------------------------------------ *
 * ① 日期范围筛选
 * ------------------------------------------------------------------ */

describe('T69 ① · Review 日期范围筛选', () => {
  it('页面有 start_date / end_date 两个日期输入框（gap-list F-R1 实测旧实现为 0 个）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    expect(screen.getByLabelText('起始日期：')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('结束日期：')).toHaveAttribute('type', 'date');
    expect(document.querySelectorAll('input[type=date]').length).toBe(2);
  });

  it('填入日期范围 → 请求参数带上 start_date / end_date（无需点任何按钮）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    fireEvent.change(screen.getByLabelText('起始日期：'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('结束日期：'), { target: { value: '2026-03-31' } });

    await waitFor(
      () => {
        const params = lastTradesParams();
        expect(params.start_date).toBe('2026-01-01');
        expect(params.end_date).toBe('2026-03-31');
      },
      { timeout: 3000 },
    );
  });

  it('只填起始日期 → 只带 start_date（end_date 不传空串）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    fireEvent.change(screen.getByLabelText('起始日期：'), { target: { value: '2026-02-01' } });

    await waitFor(
      () => {
        expect(lastTradesParams().start_date).toBe('2026-02-01');
      },
      { timeout: 3000 },
    );
    expect(lastTradesParams().end_date).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * ② 4 色 pill 标签 + 图例
 * ------------------------------------------------------------------ */

describe('T69 ② · 4 色 pill 标签 + 图例', () => {
  it('四个档位的底色分别是 止损红 / 系统绿 / 主观橙 / 未复盘灰', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    // 止损红（优先级最高：既是止损又跟了系统信号）
    expect(bg(pillOf('sh600001'))).toBe('#fee2e2');
    expect(pillOf('sh600001')).toHaveAttribute('data-tag-key', 'stopLoss');
    // 系统信号绿
    expect(bg(pillOf('sh600002'))).toBe('#dcfce7');
    expect(pillOf('sh600002')).toHaveAttribute('data-tag-key', 'systemSignal');
    // 主观决策橙
    expect(bg(pillOf('sh600003'))).toBe('#ffedd5');
    expect(pillOf('sh600003')).toHaveAttribute('data-tag-key', 'manualDecision');
    // 未复盘灰
    expect(bg(pillOf('sh600004'))).toBe('#f3f4f6');
    expect(pillOf('sh600004')).toHaveAttribute('data-tag-key', 'unreviewed');
  });

  it('优先级：止损红 > 系统信号绿（同时命中时取止损）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const pill = pillOf('sh600001');
    expect(pill).toHaveAttribute('data-tag-key', 'stopLoss');
    expect(pill).toHaveTextContent('止损');
  });

  it('标签是 pill（带底色 + 描边 + 圆角），不是彩色文字（gap-list F-R2）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const pill = pillOf('sh600002');
    expect(pill.style.borderRadius).toBe('4px');
    expect(pill.style.border).toContain('1px solid');
    expect(pill.style.background).not.toBe('');
  });

  it('图例存在且 4 个色块齐全（4 色靠颜色传达 ⇒ 图例是必须项）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    for (const key of ['stopLoss', 'systemSignal', 'manualDecision', 'unreviewed']) {
      expect(screen.getByTestId(`review-legend-${key}`)).toBeInTheDocument();
    }
  });
});

/* ------------------------------------------------------------------ *
 * ③ 分页 bug（setPage 缺失）
 * ------------------------------------------------------------------ */

describe('T69 ③ · 分页可推进（修 setPage 缺失 bug）', () => {
  beforeEach(() => {
    installApiMock({ totalPages: 3, total: 60 });
  });

  it('初始显示「第 1 / 3 页」', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    expect(await screen.findByText(/第 1 \/ 3 页，共 60 条/)).toBeInTheDocument();
  });

  it('点「下一页」→ 页码变 2，且请求带 page=2（**旧实现页码永远停在 1**）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    await user.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument());
    expect(lastTradesParams().page).toBe(2);
  });

  it('点「上一页」→ 页码从 2 退回 1', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => expect(screen.getByText(/第 1 \/ 3 页/)).toBeInTheDocument());
    expect(lastTradesParams().page).toBe(1);
  });

  it('第 1 页时「上一页」禁用，最后一页时「下一页」禁用', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByText(/第 3 \/ 3 页/)).toBeInTheDocument());

    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  });

  it('改筛选条件 → 自动回到第 1 页', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('交易类型：'), 'buy');
    await waitFor(() => expect(lastTradesParams().page).toBe(1), { timeout: 3000 });
  });
});

/* ------------------------------------------------------------------ *
 * ④ 交易类型统一取自共享模块
 * ------------------------------------------------------------------ */

describe('T69 ④ · 交易类型标签统一（共享模块 tradeTypes）', () => {
  it('筛选下拉的 7 个选项文案取自 components/tradeTypes', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const select = screen.getByLabelText('交易类型：') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['全部', '买入', '加仓', '减仓', '清仓', '分红', '送股', '转增']);
  });

  it('列表里的类型列用同一个中文名（`transfer` = 转增，不是「转托管」/「转股」）', async () => {
    installApiMock({
      trades: [trade({ id: 9, asset_code: 'sh600009', trade_type: 'transfer' })],
    });
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    // 只在**表格内**找（筛选下拉的 <option> 里也有「转增」）
    const table = screen.getByRole('table', { name: '交易复盘列表' });
    expect(within(table).getByText('转增')).toBeInTheDocument();
    expect(within(table).queryByText('转托管')).not.toBeInTheDocument();
    expect(within(table).queryByText('转股')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 收益曲线 tooltip
 * ------------------------------------------------------------------ */

describe('T69 ⑤ · 收益曲线悬浮 tooltip', () => {
  it('悬浮数据点 → tooltip 显示该点的日期与两个口径的收益率', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    expect(screen.queryByTestId('yield-curve-tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId('yield-point-0'));

    const tip = await screen.findByTestId('yield-curve-tooltip');
    expect(tip).toHaveTextContent('2026-01-15');
    // 价格口径 12.34% / 实际口径 23.45%
    expect(tip).toHaveTextContent('12.34%');
    expect(tip).toHaveTextContent('23.45%');
  });

  it('tooltip 的数值与曲线数据一致（第 2 个点：-5.12% / +1.01%）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    fireEvent.mouseEnter(screen.getByTestId('yield-point-1'));

    const tip = await screen.findByTestId('yield-curve-tooltip');
    expect(tip).toHaveTextContent('2026-02-15');
    expect(tip).toHaveTextContent('-5.12%');
    expect(tip).toHaveTextContent('1.01%');
  });

  it('鼠标移开 → tooltip 消失', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    fireEvent.mouseEnter(screen.getByTestId('yield-point-0'));
    await screen.findByTestId('yield-curve-tooltip');

    fireEvent.mouseLeave(screen.getByTestId('yield-point-0'));
    await waitFor(() => expect(screen.queryByTestId('yield-curve-tooltip')).not.toBeInTheDocument());
  });
});

/* ------------------------------------------------------------------ *
 * ⑥ 筛选即时生效（debounce，无「筛选」按钮）
 * ------------------------------------------------------------------ */

describe('T69 ⑥ · 筛选即时生效（300ms 防抖，无「筛选」按钮）', () => {
  it('**没有**「筛选」按钮（ux_v2 §3.3-3：即时生效，不需要手动触发）', async () => {
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    expect(screen.queryByRole('button', { name: '筛选' })).not.toBeInTheDocument();
  });

  it('改下拉 → 300ms 内自动重查（请求带上新条件），无需点按钮', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const before = getMock.mock.calls.filter((c) => c[0] === '/review/trades').length;

    await user.selectOptions(screen.getByLabelText('交易类型：'), 'buy');

    // 自动出结果（无需任何按钮）
    await waitFor(
      () => {
        expect(getMock.mock.calls.filter((c) => c[0] === '/review/trades').length).toBeGreaterThan(before);
      },
      { timeout: 3000 },
    );
    expect(lastTradesParams().trade_type).toBe('buy');
  });

  it('改「止损」下拉 → 自动重查并带上 is_stop_loss', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    await user.selectOptions(screen.getByLabelText('止损：'), '1');

    await waitFor(() => expect(lastTradesParams().is_stop_loss).toBe('1'), { timeout: 3000 });
  });

  it('防抖：连续改两个下拉 → 只发**一次**请求（防抖窗口内合并）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const before = getMock.mock.calls.filter((c) => c[0] === '/review/trades').length;

    await user.selectOptions(screen.getByLabelText('交易类型：'), 'buy');
    await user.selectOptions(screen.getByLabelText('止损：'), '1');

    await waitFor(
      () => {
        const params = lastTradesParams();
        expect(params.trade_type).toBe('buy');
        expect(params.is_stop_loss).toBe('1');
      },
      { timeout: 3000 },
    );

    // 窗口过后再等一会儿，确认没有第二次请求
    await new Promise((r) => setTimeout(r, 600));
    const after = getMock.mock.calls.filter((c) => c[0] === '/review/trades').length;
    expect(after - before).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * ⑦ 三态字段视觉
 * ------------------------------------------------------------------ */

describe('T69 ⑦ · 三态字段选中态视觉（是=绿 / 否=红 / 未标记=灰）', () => {
  beforeEach(() => {
    // 三态字段全未标记的交易（弹窗打开时两个组都应停在「未标记」）
    installApiMock({ trades: [trade({ id: 21 })] });
  });

  async function openModal(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    renderWithRouter(<Review />);
    await user.click((await screen.findAllByRole('button', { name: '编辑复盘' }))[0]);
    await screen.findByText(/^编辑复盘 — /);
  }

  function group(label: string): HTMLElement {
    const wrapper = screen.getByText(label).parentElement;
    if (!wrapper) throw new Error(`未找到三态组：${label}`);
    return wrapper;
  }

  function btn(label: string, name: string): HTMLElement {
    return within(group(label)).getByRole('button', { name });
  }

  it('默认「未标记」选中：灰底 + fontWeight 600 + borderWidth 2px', async () => {
    const user = userEvent.setup();
    await openModal(user);

    const none = btn('是否符合策略', '未标记');
    expect(bg(none)).toBe('#f3f4f6');
    expect(none.style.fontWeight).toBe('600');
    expect(none.style.borderWidth).toBe('2px');
    expect(none).toHaveAttribute('aria-pressed', 'true');
  });

  it('未选中项与选中项视觉可区分（白底 + 常规字重 + 1px 描边）', async () => {
    const user = userEvent.setup();
    await openModal(user);

    const yes = btn('是否符合策略', '是');
    expect(bg(yes)).toBe('#ffffff');
    expect(yes.style.fontWeight).toBe('400');
    expect(yes.style.borderWidth).toBe('1px');
    expect(yes).toHaveAttribute('aria-pressed', 'false');
  });

  it('点「是」→ 绿底；点「否」→ 红底（**是/否必须可区分**）', async () => {
    const user = userEvent.setup();
    await openModal(user);

    await user.click(btn('是否符合策略', '是'));
    expect(bg(btn('是否符合策略', '是'))).toBe('#dcfce7');
    expect(bg(btn('是否符合策略', '否'))).toBe('#ffffff');

    await user.click(btn('是否符合策略', '否'));
    expect(bg(btn('是否符合策略', '否'))).toBe('#fee2e2');
    expect(bg(btn('是否符合策略', '是'))).toBe('#ffffff');
  });

  it('「是否止损」组同样遵循 是=绿 / 否=红 / 未标记=灰', async () => {
    const user = userEvent.setup();
    await openModal(user);

    expect(bg(btn('是否止损', '未标记'))).toBe('#f3f4f6');

    await user.click(btn('是否止损', '是'));
    expect(bg(btn('是否止损', '是'))).toBe('#dcfce7');

    await user.click(btn('是否止损', '否'));
    expect(bg(btn('是否止损', '否'))).toBe('#fee2e2');
    expect(bg(btn('是否止损', '未标记'))).toBe('#ffffff');
  });

  it('两个三态组互相独立（改策略组不影响止损组）', async () => {
    const user = userEvent.setup();
    await openModal(user);

    await user.click(btn('是否符合策略', '是'));

    expect(bg(btn('是否止损', '未标记'))).toBe('#f3f4f6');
    expect(bg(btn('是否止损', '是'))).toBe('#ffffff');
  });
});

/* ------------------------------------------------------------------ *
 * G4.6 · 375px 无横向溢出（结构契约）
 * ------------------------------------------------------------------ */

describe('G4.6 · Review 表格的可横向滚动容器 + 长文本截断', () => {
  it('交易表被包在 role=region + aria-label + tabindex=0 的滚动容器里', async () => {
    const { container } = renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const el = container.querySelector<HTMLElement>('[role="region"][aria-label="交易复盘列表表"]');
    expect(el).not.toBeNull();
    expect(el?.style.overflowX).toBe('auto');
    expect(el?.style.minWidth).toBe('0');
    expect(el?.getAttribute('tabindex')).toBe('0');
    expect(el?.querySelector('table[aria-label="交易复盘列表"]')).not.toBeNull();
  });

  it('「操作理由」长文本截断（ellipsis）且 title 保留全文', async () => {
    const long = '突破均线后加仓，随后因大盘系统性回撤止损离场，理由很长很长很长';
    installApiMock({ trades: [trade({ id: 11, trade_reason: long })] });
    renderWithRouter(<Review />);
    await screen.findAllByRole('button', { name: '编辑复盘' });

    const cell = screen.getByText(long).closest('td');
    const inner = cell?.firstElementChild as HTMLElement | null;
    expect(inner).not.toBeNull();
    expect(inner?.style.textOverflow).toBe('ellipsis');
    expect(inner?.style.overflow).toBe('hidden');
    expect(inner?.style.whiteSpace).toBe('nowrap');
    expect(inner?.getAttribute('title')).toBe(long);
  });
});
