import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Signals from '../../src/pages/Signals';
import { mockResponse, renderWithRouter } from '../helpers';
import { COLORS } from '../../src/theme/tokens';
import { useUserStore } from '../../src/store/user';
import { useWatchStore } from '../../src/store/watch';

// main #172：操作列「加自选」按钮文案随 useWatchStore（已自选 ⇒「已自选」）。
// zustand 全局 store 不自动重置 —— CI shuffle 顺序下 watch 用例先跑会留脏状态，
// 统一钉住干净状态（未自选 ⇒ 恒显「加自选」），避免跨文件顺序依赖。
beforeEach(() => {
  useWatchStore.setState({ codes: [], loaded: true, loading: false, pendingCode: null, message: null });
});

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

/** 全局 mock：`api.get` / `api.patch`（V3.8 T149 信号生命周期操作） */
const { getMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
  patchMock: vi.fn(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, patch: patchMock } }));

/** 一行信号（字段名与后端 `user_strategy_signal` 一致）*/
interface SignalFixture {
  id: number;
  asset_code: string;
  /** 中文名（后端 `/api/signal` enrich；缺失为 null）*/
  asset_name?: string | null;
  plugin_id: string;
  plugin_category?: string;
  direction: string;
  label: string;
  strength?: number | null;
  grade?: string | null;
  expires_at?: string | null;
  /** F6 用：同一策略+标的+方向在冷却窗口内被合并的计数 */
  consecutive_days?: number;
  /** F2：后端派生的处理状态 + 关联成交 id */
  trade_status?: string;
  linked_trade_id?: number | null;
  link_broken?: boolean;
  trade_date: string;
  /** T154（ADR-027）：现金类标注（`asset_class='cash'`）*/
  is_cash?: boolean;
}

/** 后端默认日期口径元信息（F 域 P0-1）：最近有信号日 —— 前端不再自己拼「今天」 */
const DEFAULT_META: Record<string, unknown> = {
  trade_date: '2026-10-13',
  trade_date_source: 'signal',
  latest_quote_date: null,
};

/** 造一个分页响应 */
function pagedResponse(
  rows: SignalFixture[],
  page: number,
  totalPages: number,
  total: number,
  meta: Record<string, unknown> = DEFAULT_META,
) {
  return mockResponse(rows, {
    pagination: { page, pageSize: 50, total, totalPages },
    ...meta,
  });
}

/**
 * 安装 mock：按请求里的 `page` 返回对应页
 *
 * ⚠️ 页面还会取一次只读接口 `/market/latest-date`（用于「当前展示日 vs 行情最新日」
 *    旁注），这里返回固定的行情最新日，保证旁注文案可断言。
 */
function installPagedMock(
  pages: {
    rows: SignalFixture[];
    totalPages: number;
    total: number;
    meta?: Record<string, unknown>;
  }[],
): void {
  getMock.mockImplementation((url: string, cfg?: ApiGetConfig) => {
    if (url === '/market/latest-date') {
      return Promise.resolve(mockResponse({ date: '2026-11-06' }));
    }
    // F3：摘要区默认返回空（避免与主列表的 pill / 进度条断言互相干扰）
    if (url === '/signal/top5') {
      return Promise.resolve(mockResponse([], DEFAULT_META));
    }
    const requested = Number(cfg?.params?.page ?? 1);
    const idx = Math.min(Math.max(requested - 1, 0), pages.length - 1);
    const hit = pages[idx];
    return Promise.resolve(pagedResponse(hit.rows, requested, hit.totalPages, hit.total, hit.meta));
  });
}

/** 只看 `/signal` 的请求（`/market/latest-date` 不算在信号查询次数里）*/
function signalCalls(): [string, ApiGetConfig?][] {
  return getMock.mock.calls.filter(([url]) => url === '/signal');
}

/** 取最后一次信号查询的查询参数 */
function lastParams(): Record<string, unknown> {
  const calls = signalCalls();
  const last = calls[calls.length - 1];
  return last?.[1]?.params ?? {};
}

/**
 * 取「数据行」（T154 分组视图后：分组头行只含 `<th scope="rowgroup">`、无 cell role，
 * 按「含 cell role」过滤）
 */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((r) => within(r).queryAllByRole('cell').length > 0);
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
  patchMock.mockReset();
});

describe('T72 ① · 进页自动加载', () => {
  it('挂载即发一次请求：不带 trade_date（跟随后端默认日期口径）', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(signalCalls()[0]?.[0]).toBe('/signal');
    const params = signalCalls()[0]?.[1]?.params ?? {};
    // 🔴 F 域 P0-1：不再硬编码 todayStr()，日期口径由后端解析（最近有信号日 → 最近行情日 → 今天）
    // F1：分级 tab 默认「强」→ 参数里固定带 grade=strong（用户口径：默认只显强）
    // T154（ADR-027）：分组视图默认持仓组 → 固定带 scope=holdings
    expect(params).toEqual({ page: 1, page_size: 50, grade: 'strong', dedupe: 1, scope: 'holdings' });
    expect(params).not.toHaveProperty('trade_date');
    // 「全部策略 / 全部方向」⇒ 不预设这些过滤条件
    expect(params).not.toHaveProperty('plugin_id');
    expect(params).not.toHaveProperty('direction');
    expect(params).not.toHaveProperty('asset_code');
    expect(params).not.toHaveProperty('start_date');
    expect(params).not.toHaveProperty('end_date');
    // 日期输入框保持为空（= 默认口径），并在旁边说明实际展示的是哪天
    expect(await screen.findByTestId('signals-default-date-hint')).toHaveTextContent(
      '最近有信号日 2026-10-13',
    );
    // 列表态旁注：当前展示日 + 行情最新日（用户要能看出「展示的不是今天」）
    const note = await screen.findByTestId('signals-display-date-note');
    expect(note).toHaveTextContent('当前展示日 2026-10-13（最近有信号日）');
    expect(note).toHaveTextContent('行情最新 2026-11-06');
    // 非当前展示日（2026-10-12）的行 → 有灰显说明
    expect(screen.getByTestId('signals-gray-legend')).toHaveTextContent('非当前展示日 2026-10-13');
  });

  it('删掉「请点击查询按钮加载数据」空态', async () => {
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(screen.queryByText('请点击查询按钮加载数据')).not.toBeInTheDocument();
    // 换成有信息量的空态（写明后端解析出的「最近有信号日」）
    expect(await screen.findByTestId('signals-empty')).toHaveTextContent('最近有信号日 2026-10-13');
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

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(screen.getByText(/第 1 \/ 2 页，共 2 条/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(signalCalls()).toHaveLength(2));
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

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText(/第 2 \/ 2 页/);

    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled();
  });

  it('首页时「上一页」disabled', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 2, total: 2 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });
});

describe('G5.5 · asset_code / start_date / end_date 筛选 + 升序', () => {
  it('填了 asset_code / start_date / end_date → 请求参数正确（防抖后自动重查）', async () => {
    const user = userEvent.setup();
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    const { container } = renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));

    const assetInput = screen.getByLabelText('标的代码');
    await user.type(assetInput, 'sh600000');

    const dateInputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    // 顺序：交易日期 / 起始日期 / 结束日期
    fireChange(dateInputs[1], '2026-10-01');
    fireChange(dateInputs[2], '2026-10-15');

    // 防抖 300ms 后自动重查（无需点按钮）
    await waitFor(() => expect(signalCalls()).toHaveLength(2), { timeout: 2000 });

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
    const dataRowsList = dataRows();
    // 列序：代码(0) 策略(1) 方向(2) 分级(3) 强度(4) 标签(5) 交易日期(6) 状态(7) 操作(8)
    const dates = dataRowsList.map((r) => within(r).getAllByRole('cell')[6].textContent);
    expect(dates).toEqual(['2026-10-01', '2026-10-12', '2026-10-20']);

    // 前端**没有**按方向重排（后端给什么顺序就渲染什么顺序；组内等强度稳定排序保持原序）
    const directions = dataRowsList.map((r) => within(r).getAllByRole('cell')[2].textContent);
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

  it('空态写明「最近有信号日 YYYY-MM-DD」+「收盘后 17:02 自动运行信号生成」', async () => {
    installPagedMock([{ rows: [], totalPages: 0, total: 0 }]);
    renderWithRouter(<Signals />);

    const empty = await screen.findByTestId('signals-empty');
    expect(empty).toHaveTextContent('最近有信号日 2026-10-13');
    expect(empty).toHaveTextContent('收盘后 17:02 自动运行信号生成');
    // 时刻必须是 17:02（17:03 是除权导入）
    expect(empty).not.toHaveTextContent('17:03');
  });

  it('无信号但行情可用 → 空态写明「行情最新 YYYY-MM-DD」（而不是让人以为没信号）', async () => {
    installPagedMock([
      {
        rows: [],
        totalPages: 0,
        total: 0,
        meta: {
          trade_date: '2026-11-04',
          trade_date_source: 'quote',
          latest_quote_date: '2026-11-04',
        },
      },
    ]);
    renderWithRouter(<Signals />);

    const empty = await screen.findByTestId('signals-empty');
    expect(empty).toHaveTextContent('行情最新 2026-11-04');
    expect(empty).not.toHaveTextContent('今日暂无策略信号');
    // 默认口径提示同样指向行情最新日
    expect(screen.getByTestId('signals-default-date-hint')).toHaveTextContent('行情最新 2026-11-04');
  });

  it('行情库也不可用（source=today）→ 空态明确说明「行情库暂不可用」', async () => {
    installPagedMock([
      {
        rows: [],
        totalPages: 0,
        total: 0,
        meta: { trade_date: null, trade_date_source: 'today', latest_quote_date: null },
      },
    ]);
    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signals-empty')).toHaveTextContent('行情库暂不可用');
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

/** V3.8 T149 · 信号生命周期操作（采纳/忽略/关联交易，PRD_v3 §4.2） */
describe('T149 · 信号操作列（采纳/忽略 → PATCH /signal/:id/{adopt|ignore}）', () => {
  it('点「采纳」→ PATCH /signal/1/adopt，成功后按钮变「已采纳」', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    patchMock.mockResolvedValue(mockResponse({}));
    renderWithRouter(<Signals />);
    const btn = await screen.findByRole('button', { name: '采纳' });
    await userEvent.click(btn);
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('/signal/1/adopt'));
    expect((await screen.findAllByRole('button', { name: '已采纳' })).length).toBeGreaterThan(0);
  });

  it('点「忽略」→ PATCH /signal/1/ignore', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    patchMock.mockResolvedValue(mockResponse({}));
    renderWithRouter(<Signals />);
    await userEvent.click(await screen.findByRole('button', { name: '忽略' }));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('/signal/1/ignore'));
  });
});

/** F3 · 今日 Top 5 摘要区（PRD_v3 §4.2） */
describe('F3 · 今日 Top 5 摘要区', () => {
  it('跟随主列表展示日拉取摘要，并展示排名 / 日期来源', async () => {
    const top5Calls: Array<Record<string, unknown> | undefined> = [];
    getMock.mockImplementation((url: string, cfg?: ApiGetConfig) => {
      if (url === '/market/latest-date') {
        return Promise.resolve(mockResponse({ date: '2026-11-06' }));
      }
      if (url === '/signal/top5') {
        top5Calls.push(cfg?.params);
        return Promise.resolve(
          mockResponse([BUY_ROW], {
            trade_date: '2026-10-13',
            trade_date_source: 'signal',
            latest_quote_date: null,
            limit: 5,
          }),
        );
      }
      return Promise.resolve(pagedResponse([BUY_ROW], 1, 1, 1));
    });

    renderWithRouter(<Signals />);

    const summary = await screen.findByTestId('signals-top5-summary');
    expect(within(summary).getByText('今日 Top 5 摘要')).toBeInTheDocument();

    // 摘要跟随主列表解析出的展示日（2026-10-13），不是硬编码「今天」
    await waitFor(() => expect(top5Calls).toEqual([{ trade_date: '2026-10-13' }]));
    expect(screen.getByTestId('signals-top5-date-note')).toHaveTextContent(
      '摘要交易日 2026-10-13（最近有信号日）',
    );

    const table = within(summary).getByRole('table', { name: '今日 Top 5 摘要' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2); // 表头 + 1 条
    expect(within(rows[1]).getByText('1')).toBeInTheDocument(); // 排名
    expect(within(rows[1]).getByText('sh600000')).toBeInTheDocument();
  });

  it('摘要接口失败时静默降级，不影响主列表', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/market/latest-date') {
        return Promise.resolve(mockResponse({ date: '2026-11-06' }));
      }
      if (url === '/signal/top5') return Promise.reject(new Error('摘要失败'));
      return Promise.resolve(pagedResponse([BUY_ROW], 1, 1, 1));
    });

    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signals-top5-empty')).toHaveTextContent('该交易日暂无信号');
    // 主列表仍然正常渲染
    expect(screen.getByRole('table', { name: '策略信号列表' })).toBeInTheDocument();
  });
});

/** F1 · 信号分级（PRD_v3 §4.2：默认只显强 / 过期置灰不删 / 标注生成于 X 天前） */
describe('F1 · 信号分级', () => {
  it('默认只显强：进页请求带 grade=strong；切「全部」后不再带', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(screen.getByTestId('signals-grade-tab-strong')).toHaveAttribute('aria-pressed', 'true');
    expect(signalCalls()[0]?.[1]?.params).toMatchObject({ grade: 'strong' });

    await user.click(screen.getByTestId('signals-grade-tab-all'));

    await waitFor(() => expect(signalCalls().length).toBeGreaterThanOrEqual(2));
    const params = lastParams();
    expect(params).not.toHaveProperty('grade');
    expect(screen.getByTestId('signals-grade-tab-all')).toHaveAttribute('aria-pressed', 'true');
  });

  it('分级 tag 按 grade 着色（强 / 中 / 弱 三档可辨）', async () => {
    installPagedMock([
      {
        rows: [
          { ...BUY_ROW, id: 1, grade: 'strong', expires_at: '2999-01-01' },
          { ...BUY_ROW, id: 2, grade: 'medium', expires_at: '2999-01-01' },
          { ...BUY_ROW, id: 3, grade: 'weak', expires_at: '2999-01-01' },
        ],
        totalPages: 1,
        total: 3,
      },
    ]);
    renderWithRouter(<Signals />);

    const tags = await screen.findAllByTestId('signal-grade-tag');
    expect(tags.map((t) => t.textContent)).toEqual(['强', '中', '弱']);
    expect(tags[0]).toHaveAttribute('data-grade', 'strong');
    expect(tags[1]).toHaveAttribute('data-grade', 'medium');
    expect(tags[2]).toHaveAttribute('data-grade', 'weak');
  });

  it('过期信号置灰不删，并标注「生成于 X 天前」', async () => {
    const expired = { ...BUY_ROW, trade_date: '2026-01-02', expires_at: '2026-01-05' };
    installPagedMock([{ rows: [expired], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    const row = await screen.findByTestId('signals-row-expired');
    expect(row).toHaveStyle({ opacity: '0.6' });
    // 行仍在表内（不删），并给出「生成于 N 天前」
    expect(within(row).getByTestId('signals-expired-age')).toHaveTextContent(/生成于 \d+ 天前/);
  });
});

/** F6 · 冷却只做展示层合并去重（不影响生成与交易链路） */
describe('F6 · 冷却展示合并', () => {
  it('列表请求带 dedupe=1（只影响展示，不改生成）', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(signalCalls()[0]?.[1]?.params).toMatchObject({ dedupe: 1 });
  });

  it('合并行标注「连续第 N 日选中」，并显示默认 3 根 K 线旁注', async () => {
    installPagedMock([{ rows: [{ ...BUY_ROW, consecutive_days: 3 }], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signals-consecutive-count')).toHaveTextContent('连续第 3 日选中');
    expect(screen.getByTestId('signals-cooldown-note')).toHaveTextContent('冷却 3 根 K 线');
    // 旁注必须写明「仅展示层」，避免被误解为抑制信号
    expect(screen.getByTestId('signals-cooldown-note')).toHaveTextContent('不影响信号生成与交易链路');
  });

  it('未合并行（consecutive_days=1 或缺失）不显示连续标注', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    await screen.findByTestId('signal-label-tag');
    expect(screen.queryByTestId('signals-consecutive-count')).not.toBeInTheDocument();
  });

  it('后端下发的 cooldown_bars 覆盖旁注窗口（可配置）', async () => {
    installPagedMock([
      {
        rows: [BUY_ROW],
        totalPages: 1,
        total: 1,
        meta: { ...DEFAULT_META, cooldown_bars: 5 },
      },
    ]);
    renderWithRouter(<Signals />);

    expect(await screen.findByTestId('signals-cooldown-note')).toHaveTextContent('冷却 5 根 K 线');
  });
});

/* ------------------------------------------------------------------ *
 * F2 · 信号处理状态 + 关联成交详情
 *
 * 状态由后端派生（`trade_status`），前端只渲染；点击「查看成交」走
 * `GET /api/signal/:id/linked-trade`，不跳页。
 * ------------------------------------------------------------------ */

describe('F2 · 信号处理状态与关联成交', () => {
  const TRADED_ROW: SignalFixture = {
    ...BUY_ROW,
    id: 1,
    trade_date: '2026-11-06',
    trade_status: 'traded',
    linked_trade_id: 12,
  };
  const PENDING_ROW: SignalFixture = {
    ...BUY_ROW,
    id: 2,
    trade_date: '2026-11-05',
    trade_status: 'pending',
    linked_trade_id: null,
  };

  function installMockWithDetail(): void {
    getMock.mockImplementation((url: string, cfg?: ApiGetConfig) => {
      if (url === '/market/latest-date') return Promise.resolve(mockResponse({ date: '2026-11-06' }));
      if (url === '/signal/top5') return Promise.resolve(mockResponse([], DEFAULT_META));
      if (url.startsWith('/signal/') && url.endsWith('/linked-trade')) {
        return Promise.resolve(
          mockResponse({
            signal_id: 1,
            asset_code: 'sh600000',
            trade_date: '2026-11-06',
            direction: 'buy',
            linked_trade_id: 12,
            trade_status: 'traded',
            link_broken: false,
            trade: {
              id: 12,
              asset_code: 'sh600000',
              trade_type: 'buy',
              direction: 'buy',
              trade_date: '2026-11-06',
              trade_time: '10:30:00',
              quantity: 100,
              price: 10,
              fee: 5,
              amount: 1000,
              realized_pnl: null,
            },
          }),
        );
      }
      const requested = Number(cfg?.params?.page ?? 1);
      return Promise.resolve(pagedResponse([TRADED_ROW, PENDING_ROW], requested, 1, 2));
    });
  }

  it('列表按后端 trade_status 渲染「已成交 / 未处理」，只有已成交有「查看成交」', async () => {
    installMockWithDetail();
    renderWithRouter(<Signals />);

    await screen.findAllByText('sh600000');
    const tags = screen.getAllByTestId('signal-trade-status');
    expect(tags.map((t) => t.textContent)).toEqual(expect.arrayContaining(['已成交', '未处理']));
    // 只有已成交那一行有「查看成交」；未成交那一行有「录入交易」入口
    expect(screen.getAllByTestId('signal-trade-view')).toHaveLength(1);
    expect(screen.getAllByTestId('signal-trade-entry')).toHaveLength(1);
  });

  it('点「查看成交」→ 调 /signal/:id/linked-trade 并展开详情（金额 / 方向 / 日期 / 盈亏）', async () => {
    installMockWithDetail();
    const user = userEvent.setup();
    renderWithRouter(<Signals />);

    await screen.findAllByText('sh600000');
    await user.click(screen.getByTestId('signal-trade-view'));

    await waitFor(() =>
      expect(getMock.mock.calls.some(([url]) => url === '/signal/1/linked-trade')).toBe(true),
    );
    const panel = await screen.findByTestId('signal-trade-detail');
    expect(within(panel).getByText(/成交 #12/)).toBeInTheDocument();
    expect(within(panel).getByText(/· 买入（buy）/)).toBeInTheDocument();
    expect(within(panel).getByText(/成交日 2026-11-06 10:30:00/)).toBeInTheDocument();
    expect(within(panel).getByText(/成交金额 ¥1000\.00/)).toBeInTheDocument();
    expect(screen.getByTestId('signal-trade-pnl')).toHaveTextContent('不可得');
  });
});

describe('标的名称 + K 线超链接', () => {
  it('标的列展示「名称(代码)」并链接到 K 线页', async () => {
    installPagedMock([{ rows: [{ ...BUY_ROW, asset_name: '浦发银行' }], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    // T154：分组头也渲染标的链接（同一标的 2 处），任一即可
    const links = await screen.findAllByRole('link', { name: '浦发银行(sh600000)' });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute('href', '/kline?symbol=sh600000');
  });

  it('名称缺失时回退为代码，仍链接到 K 线页', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    const links = await screen.findAllByRole('link', { name: 'sh600000' });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute('href', '/kline?symbol=sh600000');
  });
});

/** T154（ADR-027，SDD_v3 §10.4.4）· 分组视图：组内聚合 + 组合优先综合结论 + 现金类标注 */
describe('T154 · 分组视图组内聚合与综合结论', () => {
  const COMBO_BUY = {
    ...BUY_ROW,
    id: 21,
    plugin_id: 'combo:combo_1',
    label: 'MACD金叉+放量',
    strength: 0.55,
    trade_date: '2026-10-13',
  };
  const COMBO_SELL = { ...COMBO_BUY, id: 22, direction: 'sell', label: '组合卖出' };

  it('每标的一个 `<tbody>` + 分组头（`<th colSpan=9 scope=rowgroup>`，归属 + 现金类标注）', async () => {
    installPagedMock([{ rows: [{ ...COMBO_BUY, is_cash: true }], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    const tbody = await screen.findByTestId('signals-group-sh600000');
    expect(tbody.tagName).toBe('TBODY');
    const header = within(tbody).getByTestId('signals-group-header-sh600000');
    const rowgroup = within(header).queryByRole('rowgroup') as HTMLElement | null;
    if (!rowgroup) {
      // jsdom 下 role=rowgroup 的暴露不稳定 ⇒ 直接断言 DOM 结构
      expect(header.querySelector('th[scope="rowgroup"][colspan="9"]')).not.toBeNull();
    } else {
      expect(rowgroup).toHaveAttribute('colSpan', '9');
    }
    expect(header).toHaveTextContent('持仓组');
    expect(header).toHaveTextContent('现金类');
  });

  it('组内排序：组合行置顶，其余按强度降序（单条件 0.9 排在组合 0.55 之后）', async () => {
    installPagedMock([
      { rows: [BUY_ROW, { ...COMBO_BUY }], totalPages: 1, total: 2 }, // BUY_ROW strength=0.62
    ]);
    renderWithRouter(<Signals />);

    await screen.findByRole('table');
    const pluginIds = dataRows().map((r) => within(r).getAllByRole('cell')[1].textContent);
    expect(pluginIds[0]).toContain('combo:combo_1');
    expect(pluginIds[1]).toContain('rsi_oversold');
  });

  it('综合结论：无组合 ⇒「无组合结论」（不得由单条件合成）', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    const conclusion = await screen.findByTestId('signals-group-conclusion-sh600000');
    expect(conclusion).toHaveTextContent('无组合结论');
  });

  it('综合结论：同标的组合 buy+sell ⇒ 卖出优先（细则⑦）', async () => {
    installPagedMock([{ rows: [{ ...COMBO_BUY }, COMBO_SELL], totalPages: 1, total: 2 }]);
    renderWithRouter(<Signals />);

    const conclusion = await screen.findByTestId('signals-group-conclusion-sh600000');
    expect(conclusion).toHaveTextContent('◆ 综合结论：卖出');
    expect(conclusion).toHaveTextContent('买卖冲突 ⇒ 卖出优先');
  });

  it('过期（置灰）组合行不参与结论：过期组合 buy + 当日组合 sell ⇒ 结论=卖出', async () => {
    installPagedMock([
      {
        rows: [{ ...COMBO_BUY, trade_date: '2026-01-02', expires_at: '2026-01-05' }, COMBO_SELL],
        totalPages: 1,
        total: 2,
      },
    ]);
    renderWithRouter(<Signals />);

    const conclusion = await screen.findByTestId('signals-group-conclusion-sh600000');
    expect(conclusion).toHaveTextContent('◆ 综合结论：卖出');
    // 过期行仍渲染（置灰不删）
    expect(screen.getByTestId('signals-row-expired')).toBeInTheDocument();
  });

  it('切「自选组」⇒ 请求带 scope=watch（默认持仓组 ⇒ scope=holdings）', async () => {
    const user = userEvent.setup();
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    await waitFor(() => expect(signalCalls()).toHaveLength(1));
    expect(lastParams()).toMatchObject({ scope: 'holdings' });

    await user.click(screen.getByTestId('signals-group-tab-watch'));
    await waitFor(() => expect(signalCalls()).toHaveLength(2));
    expect(lastParams()).toMatchObject({ scope: 'watch', page: 1 });
    expect(screen.getByTestId('signals-group-tab-watch')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('加自选（策略信号页每行可把标的沉淀成观察池）', () => {
  it('每行「操作」列有「加自选」按钮（标的代码为该行的 asset_code）', async () => {
    installPagedMock([{ rows: [BUY_ROW], totalPages: 1, total: 1 }]);
    renderWithRouter(<Signals />);

    // 等信号行渲染 + WatchButton 挂载
    const buttons = await screen.findAllByTestId('watch-toggle');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]).toHaveAttribute('data-code', 'sh600000');
  });
});
