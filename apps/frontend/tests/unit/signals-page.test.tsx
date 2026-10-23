import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Signals from '../../src/pages/Signals';
import { mockResponse, renderWithRouter } from '../helpers';
import { COLORS } from '../../src/theme/tokens';
import { useUserStore } from '../../src/store/user';

/**
 * T72 · Signals 页增强（页面级用例）
 *
 * 覆盖实施计划 T72 的 ①②③ 与 G5.5：
 *
 * | 用例组 | 对应交付 |
 * |---|---|
 * | 进页自动加载 | ①（挂载即请求；删「请点击查询」空态）|
 * | 方向彩色 pill | ②（买入绿 / 卖出红 / 持仓灰 —— PRD §5.2 + SignalBadge 同款口径）|
 * | 强度进度条/星 | ②（`strength` 是 **0~1 的可空 REAL**；字段缺失 → 降级 `--`，不渲染进度条）|
 * | 标签 tag | ② |
 * | 分页 | ③（`pagination.totalPages` + `page` 参数）|
 * | G5.5 筛选与排序 | `asset_code` / `start_date` / `end_date` 参数正确 + 升序（交易日升序）|
 *
 * ⚠️ **「升序」= 交易日（trade_date）升序，不是方向升序** ——
 *    后端固定 `ORDER BY trade_date ASC, created_at ASC, id ASC`
 *    （`apps/backend/src/routes/signal.ts:73`，
 *    后端用例 `apps/backend/tests/unit/t54-signal-filter.test.ts:217` 锁定）。
 *    ⇒ 前端**不重排**，按接口返回顺序渲染（分页下前端排序会错乱）。
 *
 * ⚠️ 本文件与既有 `signals.test.tsx`（T61 的键盘可达性用例）**互补不重叠**：
 *    既有文件覆盖键盘操作与参数组装，本文件覆盖 T72 的渲染与分页交付。
 */

/** api.get 的第二个参数（axios config），本文件只关心 params */
interface ApiGetConfig {
  params?: Record<string, unknown>;
}

/** 全局 mock：`api.get` */
const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/** 一行信号（字段名与后端 `user_strategy_signal` 一致）*/
interface SignalFixture {
  id: number;
  asset_code: string;
  plugin_id: string;
  plugin_category?: string;
  direction: string;
  label: string;
  strength?: number | null;
  trade_date: string;
}

/** 今天的日期（与页面 `todayStr()` 同口径，避免跨天抖动）*/
function todayStr(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 造一个分页响应 */
function pagedResponse(rows: SignalFixture[], page: number, totalPages: number, total: number) {
  return mockResponse(rows, {
    pagination: { page, pageSize: 50, total, totalPages },
  });
}

/** 安装 mock：按请求里的 `page` 返回对应页 */
function installPagedMock(pages: { rows: SignalFixture[]; totalPages: number; total: number }[]): void {
  getMock.mockImplementation((_url: string, cfg?: ApiGetConfig) => {
    const requested = Number(cfg?.params?.page ?? 1);
    const idx = Math.min(Math.max(requested - 1, 0), pages.length - 1);
    const hit = pages[idx];
    return Promise.resolve(pagedResponse(hit.rows, requested, hit.totalPages, hit.total));
  });
}

/** 取最后一次请求的查询参数 */
function lastParams(): Record<string, unknown> {
  const calls = getMock.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[1]?.params ?? {};
}

const BUY_ROW: SignalFixture = {
  id: 1,
  asset_code: 'sh600000',
  plugin_id: 'rsi_oversold',
  plugin_category: 'monitor',
  direction: 'buy',
  label: 'RSI 超卖',
  strength: 0.62,
  trade_date: '2026-10-12',
};

beforeEach(() => {
  getMock.mockReset();
});

describe('T72 ① · 进页自动加载', () => {
  it('挂载即发一次请求：今日 + 全部策略 + 全部方向', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(getMock.mock.calls[0]?.[0]).toBe('/signal');
    const params = getMock.mock.calls[0]?.[1]?.params ?? {};
    expect(params).toEqual({ page: 1, page_size: 50, trade_date: todayStr() });
    // 「全部策略 / 全部方向」⇒ 不预设任何过滤条件
    expect(params).not.toHaveProperty('plugin_id');
    expect(params).not.toHaveProperty('direction');
    expect(params).not.toHaveProperty('asset_code');
    expect(params).not.toHaveProperty('start_date');
    expect(params).not.toHaveProperty('end_date');
  });

  it('删掉「请点击查询按钮加载数据」空态', async () => {
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('请点击查询按钮加载数据')).not.toBeInTheDocument();
    // 换成有信息量的空态（今日视角）
    expect(await screen.findByTestId('signals-empty')).toHaveTextContent('今日暂无策略信号');
  });

  it('接口报错时展示错误文案（不吞异常）', async () => {
    getMock.mockRejectedValue({ response: { data: { message: '信号查询失败' } } });
    renderWithRouter(<Signals />);

    expect(await screen.findByText('信号查询失败')).toBeInTheDocument();
  });
});

describe('T72 ② · 方向彩色 pill', () => {
  it('buy=绿 / sell=红 / hold=灰（PRD §5.2 + SignalBadge 同款口径）', async () => {
    installPagedMock([
      {
        rows: [
          { ...BUY_ROW, id: 1, direction: 'buy' },
          { ...BUY_ROW, id: 2, direction: 'sell' },
          { ...BUY_ROW, id: 3, direction: 'hold' },
        ],
        totalPages: 1,
        total: 3,
      },
    ]);
    renderWithRouter(<Signals />);

    const pills = await screen.findAllByTestId('signal-direction-pill');
    expect(pills).toHaveLength(3);

    // 买入：绿（bgPillSuccess / textPillSuccess / borderPillSuccess）
    expect(pills[0]).toHaveAttribute('data-direction', 'buy');
    expect(pills[0]).toHaveStyle({
      background: COLORS.bgPillSuccess,
      color: COLORS.textPillSuccess,
      border: `1px solid ${COLORS.borderPillSuccess}`,
    });
    expect(pills[0]).toHaveTextContent('买入');

    // 卖出：红（bgPillDanger / textPillDanger / borderPillDanger）
    expect(pills[1]).toHaveAttribute('data-direction', 'sell');
    expect(pills[1]).toHaveStyle({
      background: COLORS.bgPillDanger,
      color: COLORS.textPillDanger,
      border: `1px solid ${COLORS.borderPillDanger}`,
    });
    expect(pills[1]).toHaveTextContent('卖出');

    // 持仓：灰（bgPillNeutral / textPillNeutral / borderPillNeutral）
    expect(pills[2]).toHaveAttribute('data-direction', 'hold');
    expect(pills[2]).toHaveStyle({
      background: COLORS.bgPillNeutral,
      color: COLORS.textPillNeutral,
      border: `1px solid ${COLORS.borderPillNeutral}`,
    });
    expect(pills[2]).toHaveTextContent('持仓');
  });
});

describe('T72 ② · 强度（进度条 / 星）', () => {
  it('strength 有值 → 渲染进度条（role=progressbar）+ 百分比', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByTestId('signal-strength')).toHaveTextContent('62%');
  });

  it('strength 字段不存在 → 降级显示 `--`，且**不渲染**进度条', async () => {
    const { strength: _ignored, ...rowWithoutStrength } = BUY_ROW;
    installPagedMock([{ rows: [rowWithoutStrength], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signal-strength-empty')).toHaveTextContent('--');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('strength = null → 同样降级（后端 strength 是可空列）', async () => {
    installPagedMock([{ rows: [{ ...BUY_ROW, strength: null }], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signal-strength-empty')).toHaveTextContent('--');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('T72 ② · 标签 tag', () => {
  it('label 渲染成 tag 元素', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    const tag = await screen.findByTestId('signal-label-tag');
    expect(tag).toHaveTextContent('RSI 超卖');
    expect(tag).toHaveStyle({
      background: COLORS.bgPillNeutral,
      color: COLORS.textPillNeutral,
      border: `1px solid ${COLORS.borderPillNeutral}`,
    });
  });

  it('label 为空 → 降级 `--`', async () => {
    installPagedMock([{ rows: [{ ...BUY_ROW, label: '' }], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signal-label-empty')).toHaveTextContent('--');
  });
});

describe('T72 ③ · 分页', () => {
  it('点「下一页」→ 页码变 2 + 请求带 page=2', async () => {
    const user = userEvent.setup();
    installPagedMock([
      { rows: [BUY_ROW], totalPages: 2, total: 2 },
      { rows: [{ ...BUY_ROW, id: 2, trade_date: '2026-10-13' }], totalPages: 2, total: 2 },
    ]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/第 1 \/ 2 页，共 2 条/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(lastParams().page).toBe(2);
    expect(await screen.findByText(/第 2 \/ 2 页，共 2 条/)).toBeInTheDocument();
  });

  it('末页时「下一页」disabled', async () => {
    const user = userEvent.setup();
    installPagedMock([
      { rows: [BUY_ROW], totalPages: 2, total: 2 },
      { rows: [{ ...BUY_ROW, id: 2, trade_date: '2026-10-13' }], totalPages: 2, total: 2 },
    ]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText(/第 2 \/ 2 页/);

    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
  });

  it('首页时「上一页」disabled', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 2, total: 2 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });
});

describe('G5.5 · asset_code / start_date / end_date 筛选 + 升序', () => {
  it('填了 asset_code / start_date / end_date → 请求参数正确（防抖后自动重查）', async () => {
    const user = userEvent.setup();
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    const { container } = renderWithRouter(<Signals />);

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

    const assetInput = screen.getByLabelText('标的代码');
    await user.type(assetInput, 'sh600000');

    const dateInputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    // 顺序：交易日期 / 起始日期 / 结束日期
    fireChange(dateInputs[1], '2026-10-01');
    fireChange(dateInputs[2], '2026-10-15');

    // 防抖 300ms 后自动重查（无需点按钮）
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const params = lastParams();
    expect(params.asset_code).toBe('sh600000');
    expect(params.start_date).toBe('2026-10-01');
    expect(params.end_date).toBe('2026-10-15');
    // 改筛选后回到第 1 页
    expect(params.page).toBe(1);
  });

  it('升序 = 交易日升序：前端按接口返回顺序渲染，不做二次排序', async () => {
    const rows: SignalFixture[] = [
      { ...BUY_ROW, id: 1, trade_date: '2026-10-01', direction: 'sell' },
      { ...BUY_ROW, id: 2, trade_date: '2026-10-12', direction: 'buy' },
      { ...BUY_ROW, id: 3, trade_date: '2026-10-20', direction: 'hold' },
    ];
    installPagedMock([{ rows, totalPages: 1, total: 3 }]);
    renderWithRouter(<Signals />);

    await screen.findByRole('table');
    const dataRows = screen.getAllByRole('row').slice(1);
    const dates = dataRows.map((r) => within(r).getAllByRole('cell')[5].textContent);
    expect(dates).toEqual(['2026-10-01', '2026-10-12', '2026-10-20']);

    // 前端**没有**按方向重排（后端给什么顺序就渲染什么顺序）
    const directions = dataRows.map((r) => within(r).getAllByRole('cell')[2].textContent);
    expect(directions).toEqual(['▼ 卖出', '▲ 买入', '· 持仓']);
  });
});

/** 直接改 date 输入框的值（jsdom 的 date 输入不支持逐字符键入）*/
function fireChange(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('T79 ③ · 信号空态引导', () => {
  beforeEach(() => {
    getMock.mockReset();
    useUserStore.setState({ role: 'user', token: null, username: null });
  });

  afterEach(() => {
    useUserStore.setState({ role: null, token: null, username: null });
  });

  it('空态包含「今日暂无策略信号」+「收盘后 17:02 自动运行信号生成」', async () => {
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    renderWithRouter(<Signals />);

    const empty = await screen.findByTestId('signals-empty');
    expect(empty).toHaveTextContent('今日暂无策略信号');
    expect(empty).toHaveTextContent('收盘后 17:02 自动运行信号生成');
    // 时刻必须是 17:02（17:03 是除权导入）
    expect(empty).not.toHaveTextContent('17:03');
  });

  it('管理员额外看到【立即运行信号】，点击跳转 Admin', async () => {
    useUserStore.setState({ role: 'admin', token: 't', username: 'admin' });
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    const user = userEvent.setup();
    const result = renderWithRouter(<Signals />, { initialEntries: ['/signals'] });

    const runNow = await screen.findByTestId('signals-run-now');
    expect(runNow).toHaveTextContent('立即运行信号');

    await user.click(runNow);
    await waitFor(() => expect(result.routerPath).toBe('/admin'));
  });

  it('普通用户看不到【立即运行信号】', async () => {
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    renderWithRouter(<Signals />);

    await screen.findByTestId('signals-empty');
    expect(screen.queryByTestId('signals-run-now')).not.toBeInTheDocument();
  });
});
