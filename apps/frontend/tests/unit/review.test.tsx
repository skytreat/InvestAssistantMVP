import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Review, { bucketByPeriod } from '../../src/pages/Review';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * T61 · Review（交易复盘）前端用例
 *
 * 覆盖两条主线：
 * 1. 收益曲线 bucket 分组（`bucketByPeriod`）—— 按周期（月/季/年）取每期**最后一个**快照，
 *    用于收益率曲线的终点连线（PRD R2/R4）。
 * 2. 「编辑复盘」弹窗的**三态按钮组**（未标记 / 是 / 否）—— 两组独立：
 *    「是否符合策略」选中底色 `#dbeafe`，「是否止损」选中底色 `#fee2e2`，未选中 `#fff`。
 *
 * 断言口径全部按 `src/pages/Review.tsx` 源码逐行核实（**不按任务描述的推测口径**）：
 * - 周期取值集合是 **monthly / quarterly / yearly**（`CurvePeriod`，源码 61 行），
 *   **没有 weekly / daily**；分桶 key = `floor((year * 12 + month) / months)`。
 * - `PERIOD_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 }`（源码 67 行）。
 * - 桶内保留规则是 `r.trade_date >= prev.trade_date`（源码 89 行）→ 留 trade_date **最大**的一条。
 * - 桶 key 用 `new Date(trade_date)` 的**本地时区** getFullYear/getMonth 推算；
 *   `new Date('YYYY-MM-DD')` 按 UTC 解析，本地时区为负偏移时会把「月初/年初」划到上一期。
 *   故本文件的分桶数据**一律取月中（10~20 日）**，避免用例随 CI 时区漂移。
 * - 落库请求是 **`api.patch`**（源码 242 行，`PATCH /trade/{id}`），**不是 put / post**；
 *   载荷里 `strategy_match` / `is_stop_loss` 是**数字** 1 / 0（源码 235 / 238 行），**不是字符串**。
 * - 挂载时并发请求 3 个接口：`GET /review/yield`、`GET /review/trades`、`GET /asset-stat/history`。
 */

/** api.get 的第二个参数（axios config），本文件只关心 params */
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

/** 历史快照（与 `HistoryPoint` 接口同形）*/
interface HistoryPointFixture {
  trade_date: string;
  total_assets_price_yield: number;
  total_assets_actual_yield: number;
  total_profit_price: number;
  total_profit_actual: number;
}

/** 交易记录（与 `TradeRow` 接口同形）*/
interface TradeRowFixture {
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

/** 复盘统计（与 `ReviewStats` 接口同形）*/
interface ReviewStatsFixture {
  totalTrades: number;
  reviewedCount: number;
  closedCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitLossRatio: number | null;
  totalRealizedPnl: number;
}

/** 造一条历史快照（收益率字段给不同值，便于断言「取到的是哪一条」）*/
function hp(trade_date: string, priceYield: number): HistoryPointFixture {
  return {
    trade_date,
    total_assets_price_yield: priceYield,
    total_assets_actual_yield: priceYield + 0.01,
    total_profit_price: priceYield * 1000,
    total_profit_actual: priceYield * 1000 + 10,
  };
}

/** 默认交易：三个标记字段**都未标记**（null）→ 打开弹窗时三态均为「未标记」*/
const DEFAULT_TRADE: TradeRowFixture = {
  id: 101,
  asset_code: 'sh600000',
  trade_type: 'buy',
  trade_date: '2026-10-17',
  quantity: 100,
  price: 10.5,
  fee: 5.25,
  trade_reason: '突破均线',
  is_auto_import: 0,
  system_followed: 1,
  strategy_match: null,
  is_stop_loss: null,
  review_summary: null,
  remark: null,
  created_at: '2026-10-17 10:00:00',
};

const DEFAULT_STATS: ReviewStatsFixture = {
  totalTrades: 1,
  reviewedCount: 0,
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
  trades?: TradeRowFixture[];
  stats?: ReviewStatsFixture;
  history?: HistoryPointFixture[];
}

/** 安装 api mock 的分派实现（每个用例自给自足，不依赖其它用例的副作用）*/
function installApiMock(overrides: ApiOverrides = {}): void {
  const trades = overrides.trades ?? [DEFAULT_TRADE];
  const stats = overrides.stats ?? DEFAULT_STATS;
  const history = overrides.history ?? [];

  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/review/yield':
        return mockResponse(stats);
      case '/review/trades':
        return mockResponse(trades, { pagination: { totalPages: 1, total: trades.length } });
      case '/asset-stat/history':
        return mockResponse(history);
      default:
        throw new Error(`未预期的接口调用: ${url}`);
    }
  });

  patchMock.mockResolvedValue(mockResponse(null));
  postMock.mockResolvedValue(mockResponse(null));
}

/**
 * 读取 inline style 的 background 并归一化成 6 位小写 hex
 *
 * jsdom 会把 `#fff` 归一化成 `rgb(255, 255, 255)`、`#dbeafe` 归一化成 `rgb(219, 234, 254)`，
 * 直接比对源码里的 hex 字面量会失败，故统一归一化后再断言。
 */
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

/** 「是否符合策略」三态组的容器（label 的父元素，内含 label + 3 个按钮）*/
function strategyGroup(): HTMLElement {
  const wrapper = screen.getByText('是否符合策略').parentElement;
  if (!wrapper) throw new Error('未找到「是否符合策略」三态组容器');
  return wrapper;
}

/** 「是否止损」三态组的容器*/
function stopLossGroup(): HTMLElement {
  const wrapper = screen.getByText('是否止损').parentElement;
  if (!wrapper) throw new Error('未找到「是否止损」三态组容器');
  return wrapper;
}

/** 取「是否符合策略」组内的某个按钮（未标记 / 是 / 否）*/
function strategyButton(name: string): HTMLElement {
  return within(strategyGroup()).getByRole('button', { name });
}

/** 取「是否止损」组内的某个按钮（未标记 / 是 / 否）*/
function stopLossButton(name: string): HTMLElement {
  return within(stopLossGroup()).getByRole('button', { name });
}

/** 打开交易行的「编辑复盘」弹窗（等待交易表格渲染完再点）*/
async function openEditModal(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: '编辑复盘' }));
  await screen.findByText(/^编辑复盘 — /);
}

describe('Review · 收益曲线 bucketByPeriod 分桶', () => {
  it('monthly：同一自然月只保留 trade_date 最大的一条', () => {
    const rows = [
      hp('2026-01-10', 0.1),
      hp('2026-01-25', 0.2),
      hp('2026-02-12', 0.3),
      hp('2026-02-20', 0.4),
      hp('2026-03-15', 0.5),
    ];

    const out = bucketByPeriod(rows, 'monthly');

    expect(out.map((r) => r.trade_date)).toEqual(['2026-01-25', '2026-02-20', '2026-03-15']);
    // 保留的必须是**输入里那一行对象本身**（不是副本）
    expect(out[0]).toBe(rows[1]);
    expect(out[1]).toBe(rows[3]);
    expect(out[2]).toBe(rows[4]);
  });

  it('quarterly：同一自然季度只保留 trade_date 最大的一条', () => {
    const rows = [
      hp('2026-01-10', 0.1),
      hp('2026-02-20', 0.2),
      hp('2026-04-05', 0.3),
      hp('2026-05-15', 0.4),
      hp('2026-07-18', 0.5),
    ];

    const out = bucketByPeriod(rows, 'quarterly');

    // Q1(1~3 月) 留 02-20；Q2(4~6 月) 留 05-15；Q3 留 07-18
    expect(out.map((r) => r.trade_date)).toEqual(['2026-02-20', '2026-05-15', '2026-07-18']);
  });

  it('yearly：同一自然年只保留 trade_date 最大的一条', () => {
    const rows = [hp('2025-06-10', 0.1), hp('2025-11-20', 0.2), hp('2026-02-10', 0.3), hp('2026-08-15', 0.4)];

    const out = bucketByPeriod(rows, 'yearly');

    expect(out.map((r) => r.trade_date)).toEqual(['2025-11-20', '2026-08-15']);
  });

  it('返回结果按 trade_date 升序（与入参顺序无关）', () => {
    const rows = [hp('2026-03-15', 0.5), hp('2026-01-25', 0.2), hp('2026-02-20', 0.4)];

    const out = bucketByPeriod(rows, 'monthly');

    expect(out.map((r) => r.trade_date)).toEqual(['2026-01-25', '2026-02-20', '2026-03-15']);
    expect(out.map((r) => r.trade_date)).toEqual([...out.map((r) => r.trade_date)].sort());
  });

  it('入参乱序时仍保留桶内 trade_date 最大的一条（`>=` 语义）', () => {
    const rows = [hp('2026-01-25', 0.2), hp('2026-01-10', 0.1), hp('2026-01-18', 0.3)];

    const out = bucketByPeriod(rows, 'monthly');

    expect(out).toHaveLength(1);
    expect(out[0].trade_date).toBe('2026-01-25');
  });

  it('空数组输入 → 返回空数组', () => {
    expect(bucketByPeriod([], 'monthly')).toEqual([]);
  });

  it('只有一条输入 → 原样返回（同一对象引用）', () => {
    const rows = [hp('2026-05-15', 0.42)];

    const out = bucketByPeriod(rows, 'monthly');

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rows[0]);
    expect(out[0].total_assets_price_yield).toBe(0.42);
  });

  it('非法日期的快照被跳过（不抛错、不进桶）', () => {
    const rows = [hp('invalid-date', 0.1), hp('2026-01-10', 0.2)];

    const out = bucketByPeriod(rows, 'monthly');

    expect(out.map((r) => r.trade_date)).toEqual(['2026-01-10']);
  });
});

describe('Review · 编辑复盘 3 态弹窗', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('挂载时请求 3 个接口：/review/yield、/review/trades、/asset-stat/history', async () => {
    renderWithRouter(<Review />);
    await screen.findByRole('button', { name: '编辑复盘' });

    const urls = getMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain('/review/yield');
    expect(urls).toContain('/review/trades');
    expect(urls).toContain('/asset-stat/history');
    expect(getMock).toHaveBeenCalledWith('/asset-stat/history', { params: { days: 365 } });
  });

  it('打开弹窗 → 两个三态组初始均为「未标记」选中', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    // 标题形如「编辑复盘 — sh600000 (2026-10-17)」
    expect(screen.getByText('编辑复盘 — sh600000 (2026-10-17)')).toBeInTheDocument();

    // 「是否符合策略」组：未标记选中（#dbeafe），是 / 否 未选中（#fff）
    expect(bg(strategyButton('未标记'))).toBe('#dbeafe');
    expect(bg(strategyButton('是'))).toBe('#ffffff');
    expect(bg(strategyButton('否'))).toBe('#ffffff');

    // 「是否止损」组：未标记选中（#fee2e2），是 / 否 未选中（#fff）
    expect(bg(stopLossButton('未标记'))).toBe('#fee2e2');
    expect(bg(stopLossButton('是'))).toBe('#ffffff');
    expect(bg(stopLossButton('否'))).toBe('#ffffff');
  });

  it('点「是否符合策略」的「是」→ 该组选中态变 #dbeafe，且「是否止损」组不受影响', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    await user.click(strategyButton('是'));

    expect(bg(strategyButton('是'))).toBe('#dbeafe');
    // 原选中项「未标记」让位
    expect(bg(strategyButton('未标记'))).toBe('#ffffff');
    expect(bg(strategyButton('否'))).toBe('#ffffff');

    // 另一组完全不受影响：仍是「未标记」选中（#fee2e2），是 / 否 未选中（#fff）
    expect(bg(stopLossButton('未标记'))).toBe('#fee2e2');
    expect(bg(stopLossButton('是'))).toBe('#ffffff');
    expect(bg(stopLossButton('否'))).toBe('#ffffff');

    // 三态切换只是改表单状态，**不发写请求**
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('点「是否止损」的「否」→ 该组选中态变 #fee2e2', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    await user.click(stopLossButton('否'));

    expect(bg(stopLossButton('否'))).toBe('#fee2e2');
    expect(bg(stopLossButton('未标记'))).toBe('#ffffff');
    expect(bg(stopLossButton('是'))).toBe('#ffffff');

    // 策略组不受影响
    expect(bg(strategyButton('未标记'))).toBe('#dbeafe');

    expect(patchMock).not.toHaveBeenCalled();
  });

  it('点「保存」→ 发出 PATCH /trade/{id}，载荷含 strategy_match=1 / is_stop_loss=0', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    await user.click(strategyButton('是'));
    await user.click(stopLossButton('否'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const [url, payload] = patchMock.mock.calls[0];
    expect(url).toBe('/trade/101');
    // 载荷里是**数字** 1 / 0（源码 235 / 238 行），不是字符串 '1' / '0'
    expect(payload).toEqual({
      review_summary: null,
      strategy_match: 1,
      is_stop_loss: 0,
      remark: null,
    });

    // 保存成功后弹窗关闭
    await waitFor(() => expect(screen.queryByText(/^编辑复盘 — /)).not.toBeInTheDocument());
  });

  it('点「取消」→ 弹窗关闭（标题消失）且不发写请求', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    await user.click(strategyButton('是'));
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByText(/^编辑复盘 — /)).not.toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('已有标记的交易打开弹窗 → 三态回显原值（strategy_match=1 / is_stop_loss=0）', async () => {
    installApiMock({
      trades: [{ ...DEFAULT_TRADE, strategy_match: 1, is_stop_loss: 0 }],
    });
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    expect(bg(strategyButton('是'))).toBe('#dbeafe');
    expect(bg(strategyButton('未标记'))).toBe('#ffffff');
    expect(bg(stopLossButton('否'))).toBe('#fee2e2');
    expect(bg(stopLossButton('未标记'))).toBe('#ffffff');
  });

  it('三态值与原值相同 → 载荷里不含 strategy_match / is_stop_loss', async () => {
    installApiMock({
      trades: [{ ...DEFAULT_TRADE, strategy_match: 1, is_stop_loss: 0 }],
    });
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    // 重新点选与原值相同的「是」/「否」→ 两个三态字段都判定为「未变更」
    await user.click(strategyButton('是'));
    await user.click(stopLossButton('否'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const payload = patchMock.mock.calls[0][1];
    expect(payload).not.toHaveProperty('strategy_match');
    expect(payload).not.toHaveProperty('is_stop_loss');
  });

  it('所有字段均未变更 → 载荷为空，源码直接关窗且不发写请求', async () => {
    installApiMock({
      trades: [
        {
          ...DEFAULT_TRADE,
          strategy_match: 1,
          is_stop_loss: 0,
          review_summary: '按策略执行',
          remark: '无',
        },
      ],
    });
    const user = userEvent.setup();
    renderWithRouter(<Review />);
    await openEditModal(user);

    // 重新点选与原值相同的「是」/「否」→ 全部字段无变化
    await user.click(strategyButton('是'));
    await user.click(stopLossButton('否'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByText(/^编辑复盘 — /)).not.toBeInTheDocument());
    expect(patchMock).not.toHaveBeenCalled();
  });
});
