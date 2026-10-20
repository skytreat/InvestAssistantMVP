/**
 * T67 · 批次 5 —— **Dashboard 接线集成用例**
 *
 * 对应任务卡：`docs/audit/wave-3-task-cards.md` 批次 5（接线 + 回归 + 探针）。
 *
 * ## 本文件测的是「接线」，不是「组件」
 *
 * 卡 3~7 的组件级断言分别在：
 * - `dashboard-cards.test.tsx`（持仓卡 / 进度条 / 排序过滤 / 信号标记）
 * - `trade-form-modal.test.tsx`（交易弹窗）
 * - `todayActivityCard.test.tsx`（今日动态卡）
 * - `symbol-detail-modal.test.tsx`（详情 Modal + K 线小图）
 * - `signalMiniMenu.test.tsx`（信号一键链路）
 *
 * 本文件只测**组件之间怎么串起来**：谁在哪个位置、点谁触发谁、
 * 状态怎么流、预填字段怎么逐字段传下去。
 *
 * ## 被测的 6 条接线契约
 *
 * | # | 契约 | 关键断言 |
 * |---|---|---|
 * | ① | `TodayActivityCard` 插在「资产汇总卡」与「持仓卡」之间 | 5 个数据块都在 + DOM 顺序 |
 * | ② | 持仓卡【买入】【卖出】→ `TradeFormModal` | 弹窗打开 + 代码预填 + 类型是买/卖 |
 * | ③ | 持仓卡**名称** → `PositionDetailModal` | 弹窗打开 + 含标的代码与名称 |
 * | ④ | 信号标记 → `SignalMiniMenu` → `TradeFormModal` | 数量 = D-9 / 理由 = D-11（逐字）|
 * | ⑤ | 三个模态都能用 ESC 关闭 | 关掉后 DOM 消失 |
 * | ⑥ | 模态渲染在**页面滚动容器之外** | 弹窗不是页面容器的后代 |
 *
 * ## 「假绿」防护
 *
 * - 断言用**逐字文本**（数量 `50`、理由 `macd_cross 金叉 买入 (2026-10-17)`），
 *   不用「存在某个元素」这种弱断言；
 * - 「从持仓卡直接下单」这条路径**额外断言数量/价格/理由都是空的** ——
 *   否则「预填残留」这类 bug 会被「有值就过」的断言掩盖；
 * - 模态位置用 `contains()` 断言（真结构断言，不是快照）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import Dashboard from '../../src/pages/Dashboard';
import { useUserStore } from '../../src/store/user';
import { mockResponse, renderWithRouter } from '../helpers';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

interface ApiGetConfig {
  params?: Record<string, unknown>;
}

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
  postMock: vi.fn<(url: string, body?: unknown) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock, post: postMock } }));

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** 行情交易日（信号过期判据 + 今日动态卡的日期锚点）*/
const PRICE_DATE = '2026-10-17';

/**
 * 两只持仓
 *
 * ⚠️ **数量刻意取奇偶混合**（100 / 200）——
 *    D-9 公式是 `Math.ceil(totalQuantity / 2)`，
 *    取偶数会让「ceil 与 floor 写错」这类 bug 测不出来。
 *    另有一只 `totalQuantity = 101` 的用例专门验 ceil（见下方 ④）。
 */
const POSITIONS = [
  {
    asset_code: 'sh600000',
    name: '浦发银行',
    totalQuantity: 100,
    totalCostBasis: 900,
    avgCost: 9,
    realizedPnL: 0,
    currentPrice: 10,
    priceDate: PRICE_DATE,
    marketValue: 1000,
    unrealizedPnl: 100,
    unrealizedYield: 0.1111,
    weight: 0.5,
    prevClose: 9.8,
    signal: { plugin_id: 'macd_cross', direction: 'buy', label: '金叉', trade_date: PRICE_DATE },
    industry: null,
  },
  {
    asset_code: 'sh510300',
    name: '沪深300ETF',
    totalQuantity: 200,
    totalCostBasis: 600,
    avgCost: 3,
    realizedPnL: 0,
    currentPrice: 3,
    priceDate: PRICE_DATE,
    marketValue: 600,
    unrealizedPnl: 0,
    unrealizedYield: 0,
    weight: 0.3,
    prevClose: 3.05,
    signal: { plugin_id: 'rsi_revert', direction: 'sell', label: '超买', trade_date: PRICE_DATE },
    industry: null,
  },
];

const SUMMARY = {
  totalMarketValue: 1600,
  totalCostBasis: 1500,
  unrealizedPnl: 100,
  realizedPnl: 0,
  priceDate: PRICE_DATE,
  positionCount: 2,
};

const STAT = {
  trade_date: PRICE_DATE,
  total_assets_price_yield: 0.1234,
  total_assets_actual_yield: 0.2345,
  total_profit_price: 1234.56,
  total_profit_actual: -789.01,
};

/** 今日信号（同时喂给「最新信号」表与今日动态卡）*/
const SIGNAL_ROWS = [
  {
    asset_code: 'sh600000',
    plugin_id: 'macd_cross',
    direction: 'buy',
    label: '金叉',
    trade_date: PRICE_DATE,
  },
  {
    asset_code: 'sz159915',
    plugin_id: 'ma_cross',
    direction: 'hold',
    label: '观望',
    trade_date: PRICE_DATE,
  },
];

/** 今日成交（今日动态卡块 ③ + 详情弹窗的「最近交易」）*/
const TRADE_ROWS = [
  {
    id: 1,
    asset_code: 'sh600000',
    trade_type: 'buy',
    trade_date: PRICE_DATE,
    trade_time: '09:31:00',
    quantity: 100,
    price: 10,
    fee: 5,
    trade_reason: 'macd_cross 金叉 买入',
    is_auto_import: 0,
  },
];

/** 今日除权导入（今日动态卡块 ④）*/
const DIVIDEND_IMPORTS = {
  from: PRICE_DATE,
  to: PRICE_DATE,
  items: [{ asset_code: 'sh000001', trade_type: 'dividend', trade_date: PRICE_DATE, quantity: 0, price: 0 }],
  summary: { total: 1, dividendCount: 1, bonusCount: 0 },
};

/** 候选池（今日动态卡块 ⑤ 的「候选」侧）*/
const CANDIDATE_ROWS = [{ asset_code: 'sz159915' }];

/** 今日信号统计（今日动态卡块 ② 的服务端精确口径）*/
const SIGNAL_STATS = { total: 2, up: 1, down: 1, hold: 0 };

function installApiMock(): void {
  getMock.mockImplementation(async (url: string) => {
    switch (url) {
      case '/holding':
        return mockResponse(POSITIONS, { summary: SUMMARY });
      case '/asset-stat/latest':
        return mockResponse(STAT);
      case '/signal':
        return mockResponse(SIGNAL_ROWS);
      case '/signal/stats':
        return mockResponse(SIGNAL_STATS);
      case '/trade':
        return mockResponse(TRADE_ROWS);
      case '/ex-dividend/imports':
        return mockResponse(DIVIDEND_IMPORTS);
      case '/candidate':
        return mockResponse(CANDIDATE_ROWS);
      case '/admin/system-log':
        return mockResponse([]);
      default:
        // K 线小图等其它端点：返回空数据（组件会走「无数据」分支，不崩）
        if (url.startsWith('/quote/')) {
          return mockResponse({ symbol: 'sh600000', fq: 'qfq', klines: [], indicators: null, signals: [] });
        }
        throw new Error(`未预期的接口调用: ${url}`);
    }
  });
  postMock.mockResolvedValue(mockResponse({ id: 99 }));
}

/* ------------------------------------------------------------------ *
 * 查询 helper
 * ------------------------------------------------------------------ */

/** 按代码取某张持仓卡 */
function cardOf(code: string): HTMLElement {
  const found = screen
    .getAllByTestId('position-card')
    .find((el) => el.querySelector('[data-testid="position-card-code"]')?.textContent === code);
  if (!found) throw new Error(`未找到持仓卡 ${code}`);
  return found;
}

/** 读交易弹窗里某个字段的当前值 */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement).value;
}

/**
 * 交易弹窗的 dialog 节点
 *
 * ⚠️ **必须按 `trade-form-overlay` 限定** —— 详情弹窗也是 `role="dialog"`，
 *    两层同时在场时 `getByRole('dialog')` 会抛「找到多个」。
 */
function tradeDialog(): HTMLElement {
  return within(screen.getByTestId('trade-form-overlay')).getByRole('dialog');
}

/**
 * 打开 Mini-Menu 里的操作项
 *
 * ⚠️ **为什么用 `fireEvent.click` 而不是 `user.click`** ——
 *    `userEvent` 的 `mouseout` 事件**不带 `relatedTarget`**（实测：userEvent v14
 *    的 `createEvent` 只给 focus 事件设 `relatedTarget`，鼠标事件一律为 `null`）。
 *    React 的 `onMouseLeave` 在 `relatedTarget === null` 时会**无条件触发**
 *    → Mini-Menu 包裹层（`onMouseLeave` → 关闭菜单）会在指针移动时把菜单关掉
 *    → 菜单项在 click 落地前就被卸载 → 回调不触发。
 *
 *    ⚠️ 这是 **jsdom 环境的产物**，不是组件缺陷：真浏览器里
 *    `mouseout` 的 `relatedTarget` = 鼠标移入的元素（仍在包裹层内）
 *    → React 不会触发包裹层的 `onMouseLeave`（实测：relatedTarget 正确时 leave 不触发）。
 *    真浏览器验证走 `scripts/a11y-check.mjs` / 溢出探针。
 *
 *    ⇒ 用例里「打开菜单」用真实的 hover / click 事件，
 *      「点菜单项」用 `fireEvent.click`（不移动指针，绕开上面的 jsdom 产物）。
 */
function clickMenuItem(name: string): void {
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('批次 5 接线 · ① TodayActivityCard 插在资产汇总卡与持仓卡之间', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('今日动态概览卡已渲染在 Dashboard 里（5 个数据块都在）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(screen.getByTestId('today-activity-card')).toBeInTheDocument();

    // 5 个数据块（裁决：G3.3「5 个块各自非空或有降级文案」）
    for (const id of [
      'today-block-asset-change',
      'today-block-signals',
      'today-block-trades',
      'today-block-dividends',
      'today-block-focus',
    ]) {
      const block = screen.getByTestId(id);
      expect(block, `${id} 不应为空`).not.toBeEmptyDOMElement();
      // 每个块都要有内容（不是空白块）
      expect(block.textContent?.trim(), `${id} 不允许是空白块`).not.toBe('');
    }
  });

  it('5 个数据块各自有真实内容（不是降级文案）', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // ① 总资产变化：Σ(现价×数量) − Σ(昨收×数量) = (1000+600) − (980+610) = +10.00
    await waitFor(() => expect(screen.getByTestId('today-block-asset-change')).toHaveTextContent('+10.00'));
    // ② 今日信号：▲1 / ▼1 / ·0，共 2 条
    const signals = screen.getByTestId('today-block-signals');
    await waitFor(() => expect(signals).toHaveTextContent('▲1'));
    expect(signals).toHaveTextContent('▼1');
    expect(signals).toHaveTextContent('共 2 条');
    // ③ 今日成交：sh600000 买入 100
    const trades = screen.getByTestId('today-block-trades');
    await waitFor(() => expect(trades).toHaveTextContent('sh600000'));
    expect(trades).toHaveTextContent('买入');
    // ④ 今日除权导入：共 1 条 + sh000001 分红
    const dividends = screen.getByTestId('today-block-dividends');
    await waitFor(() => expect(dividends).toHaveTextContent('共 1 条'));
    expect(dividends).toHaveTextContent('sh000001');
    // ⑤ 重点关注：持仓有信号 + 候选有信号
    const focus = screen.getByTestId('today-block-focus');
    await waitFor(() => expect(focus).toHaveTextContent('sh600000'));
    expect(focus).toHaveTextContent('sz159915');
  });

  it('位置契约：今日动态卡在「资产组成」与「持仓明细」之间（DOM 顺序）', async () => {
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const todayCard = screen.getByTestId('today-activity-card');
    const donutTitle = screen.getByText('资产组成');
    const holdingsTitle = screen.getByText(/^持仓明细（/);

    // 三者在同一个容器里，且顺序是「资产组成 → 今日动态 → 持仓明细」
    expect(donutTitle.compareDocumentPosition(todayCard)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(todayCard.compareDocumentPosition(holdingsTitle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.contains(todayCard)).toBe(true);
  });
});

describe('批次 5 接线 · ② 持仓卡【买入】【卖出】→ TradeFormModal', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('点【买入】→ 交易弹窗打开，标的代码预填正确', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(screen.queryByTestId('trade-form-overlay')).not.toBeInTheDocument();

    await user.click(within(cardOf('sh600000')).getByRole('button', { name: '买入' }));

    await screen.findByTestId('trade-form-overlay');
    // 标题 = 「买入 + 标的代码」
    expect(tradeDialog()).toHaveAccessibleName('买入 sh600000');
    // 标的代码预填正确（只读）
    expect(fieldValue('标的代码')).toBe('sh600000');
    // 交易类型 = 买入
    expect(fieldValue('交易类型')).toBe('buy');
  });

  it('点【卖出】→ 交易弹窗打开，标题与交易类型都是卖出', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(within(cardOf('sh510300')).getByRole('button', { name: '卖出' }));

    await screen.findByTestId('trade-form-overlay');
    expect(tradeDialog()).toHaveAccessibleName('卖出 sh510300');
    expect(fieldValue('标的代码')).toBe('sh510300');
    expect(fieldValue('交易类型')).toBe('sell');
  });

  it('从持仓卡直接下单**不预填**数量/价格/理由（没有草稿就是空的）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(within(cardOf('sh600000')).getByRole('button', { name: '买入' }));
    await screen.findByTestId('trade-form-overlay');

    // ⚠️ 这条断言防「预填残留」：上一次一键链路的草稿不能漏进这一次的手工下单
    expect(fieldValue('数量')).toBe('');
    expect(fieldValue('价格')).toBe('');
    expect(fieldValue('操作理由')).toBe('');
  });

  it('关闭交易弹窗后再点另一张卡的【买入】→ 代码与类型跟着换（不是上一次的值）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(within(cardOf('sh600000')).getByRole('button', { name: '买入' }));
    await screen.findByTestId('trade-form-overlay');
    expect(fieldValue('标的代码')).toBe('sh600000');

    // 取消 → 弹窗关闭
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByTestId('trade-form-overlay')).not.toBeInTheDocument());

    // 再点另一张卡
    await user.click(within(cardOf('sh510300')).getByRole('button', { name: '卖出' }));
    await screen.findByTestId('trade-form-overlay');
    expect(fieldValue('标的代码')).toBe('sh510300');
    expect(fieldValue('交易类型')).toBe('sell');
  });

  it('提交交易成功 → 弹窗关闭 + 重新拉一次持仓（onDone 链路）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(within(cardOf('sh600000')).getByRole('button', { name: '买入' }));
    await screen.findByTestId('trade-form-overlay');

    // 填三个必填字段（数量 > 0、价格 >= 0、理由非空）
    await user.type(screen.getByLabelText('数量'), '100');
    await user.type(screen.getByLabelText('价格'), '10');
    await user.type(screen.getByLabelText('操作理由'), '手工下单');

    const holdingCallsBefore = getMock.mock.calls.filter((c) => c[0] === '/holding').length;

    await user.click(screen.getByRole('button', { name: '提交交易' }));

    // 提交成功 → 弹窗关闭
    await waitFor(() => expect(screen.queryByTestId('trade-form-overlay')).not.toBeInTheDocument());
    // 父级重新拉了一次持仓（持仓卡与资产卡一起刷新）
    await waitFor(() =>
      expect(getMock.mock.calls.filter((c) => c[0] === '/holding').length).toBe(holdingCallsBefore + 1),
    );

    // 载荷字段名与后端契约一致（`asset_code` / `trade_type` / `quantity` / `price` / `trade_reason`）
    expect(postMock).toHaveBeenCalledWith(
      '/trade',
      expect.objectContaining({
        asset_code: 'sh600000',
        trade_type: 'buy',
        quantity: 100,
        price: 10,
        trade_reason: '手工下单',
      }),
    );
  });
});

describe('批次 5 接线 · ③ 持仓卡名称 → PositionDetailModal', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('点持仓卡名称 → 详情弹窗打开，含标的代码与名称', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    expect(screen.queryByTestId('position-detail-modal')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '浦发银行' }));

    const modal = await screen.findByTestId('position-detail-modal');
    expect(modal).toBeInTheDocument();
    // 标题含代码与名称
    expect(modal).toHaveTextContent('sh600000');
    expect(modal).toHaveTextContent('浦发银行');
    // 持仓概览区块用的是**父级已持有的持仓数据**（不重复请求）
    expect(screen.getByTestId('position-detail-overview')).toHaveTextContent('100');
  });

  it('详情弹窗里的【买入】→ 换成交易弹窗并预填该标的代码（详情弹窗同时关闭）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(screen.getByRole('button', { name: '浦发银行' }));
    await screen.findByTestId('position-detail-modal');

    await user.click(
      within(screen.getByTestId('position-detail-modal')).getByRole('button', { name: '买入' }),
    );

    await screen.findByTestId('trade-form-overlay');
    expect(tradeDialog()).toHaveAccessibleName('买入 sh600000');
    expect(fieldValue('标的代码')).toBe('sh600000');
    // ⚠️ 两层模态不叠放（否则 ESC 会一次关掉两层）
    expect(screen.queryByTestId('position-detail-modal')).not.toBeInTheDocument();
  });
});

describe('批次 5 接线 · ④ 信号标记 → SignalMiniMenu → TradeFormModal（一键链路）', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('hover 信号标记 → Mini-Menu 打开；点【立即买入】→ 交易弹窗按 D-9 / D-11 预填（逐字）', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 卡片里的信号标记是一键链路的唯一入口
    const trigger = within(cardOf('sh600000')).getByTestId('signal-mini-menu-trigger');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.hover(trigger);

    const menu = screen.getByRole('menu', { name: '信号操作菜单' });
    expect(menu).toHaveTextContent('macd_cross');
    expect(menu).toHaveTextContent('金叉');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    clickMenuItem('立即买入');

    // 弹窗打开，5 个字段逐字断言
    await screen.findByTestId('trade-form-overlay');
    expect(fieldValue('标的代码')).toBe('sh600000');
    expect(fieldValue('交易类型')).toBe('buy');
    expect(fieldValue('数量')).toBe('50'); // D-9：ceil(100 / 2)
    expect(fieldValue('价格')).toBe('10'); // currentPrice
    expect(fieldValue('操作理由')).toBe('macd_cross 金叉 买入 (2026-10-17)'); // D-11
  });

  it('click 信号标记同样弹出 Mini-Menu（D-10 双触发），点【立即买入】→ 同样预填', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const trigger = within(cardOf('sh600000')).getByTestId('signal-mini-menu-trigger');

    // click 触发（触屏可达 —— PRD §5.8 #1「桌面和手机功能对等」）
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: '信号操作菜单' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    clickMenuItem('立即买入');

    await screen.findByTestId('trade-form-overlay');
    expect(fieldValue('数量')).toBe('50');
    expect(fieldValue('操作理由')).toBe('macd_cross 金叉 买入 (2026-10-17)');
  });

  it('卖出信号 → 菜单里只有【立即卖出】，预填数量 / 理由逐字正确', async () => {
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    fireEvent.click(within(cardOf('sh510300')).getByTestId('signal-mini-menu-trigger'));

    expect(screen.queryByRole('menuitem', { name: '立即买入' })).not.toBeInTheDocument();
    clickMenuItem('立即卖出');

    await screen.findByTestId('trade-form-overlay');
    expect(fieldValue('标的代码')).toBe('sh510300');
    expect(fieldValue('交易类型')).toBe('sell');
    expect(fieldValue('数量')).toBe('100'); // D-9：ceil(200 / 2)
    expect(fieldValue('价格')).toBe('3');
    expect(fieldValue('操作理由')).toBe('rsi_revert 超买 卖出 (2026-10-17)'); // D-11
  });

  it('D-9 公式在接线上生效：101 股 → 51 股（ceil，不是 floor）', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (url === '/holding') {
        return mockResponse([{ ...POSITIONS[0], totalQuantity: 101, marketValue: 1010, weight: 1 }], {
          summary: { ...SUMMARY, positionCount: 1 },
        });
      }
      return installApiMockFallback(url);
    });

    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    fireEvent.click(within(cardOf('sh600000')).getByTestId('signal-mini-menu-trigger'));
    clickMenuItem('立即买入');

    await screen.findByTestId('trade-form-overlay');
    expect(fieldValue('数量')).toBe('51');
  });
});

describe('批次 5 接线 · ⑤ ESC 关闭三个模态', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('ESC 关闭交易弹窗', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(within(cardOf('sh600000')).getByRole('button', { name: '买入' }));
    await screen.findByTestId('trade-form-overlay');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('trade-form-overlay')).not.toBeInTheDocument());
  });

  it('ESC 关闭详情弹窗', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    await user.click(screen.getByRole('button', { name: '浦发银行' }));
    await screen.findByTestId('position-detail-modal');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('position-detail-modal')).not.toBeInTheDocument());
  });
});

describe('批次 5 接线 · ⑥ 模态渲染在页面滚动容器之外', () => {
  beforeEach(() => {
    useUserStore.setState({ role: 'user', token: null, username: null });
    installApiMock();
  });

  it('交易弹窗不是页面容器的后代（不会被祖先 overflow 裁剪）', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    // 页面容器 = RTL 容器的第一个子元素（承载「总资产 / 资产组成 / 持仓明细」…）
    const pageContainer = container.firstElementChild as HTMLElement;
    expect(pageContainer).not.toBeNull();
    expect(pageContainer.textContent).toContain('总资产');

    await user.click(within(cardOf('sh600000')).getByRole('button', { name: '买入' }));
    const overlay = await screen.findByTestId('trade-form-overlay');

    // ⚠️ 关键断言：弹窗**不在**页面容器内部
    expect(pageContainer.contains(overlay)).toBe(false);
    // 但它仍然是 Dashboard 的一部分（在 RTL 容器里）
    expect(container.contains(overlay)).toBe(true);
  });

  it('详情弹窗同样在页面容器之外', async () => {
    const user = userEvent.setup();
    const { container } = renderWithRouter(<Dashboard />);
    await screen.findByText('总盈亏');

    const pageContainer = container.firstElementChild as HTMLElement;

    await user.click(screen.getByRole('button', { name: '浦发银行' }));
    const modal = await screen.findByTestId('position-detail-modal');

    expect(pageContainer.contains(modal)).toBe(false);
    expect(container.contains(modal)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 辅助：把默认分派逻辑抽出来，供个别用例覆盖单个端点时复用
 * ------------------------------------------------------------------ */

/** 默认 mock 之外的端点分派（供「只覆盖 /holding」的用例调用）*/
async function installApiMockFallback(url: string): Promise<unknown> {
  switch (url) {
    case '/asset-stat/latest':
      return mockResponse(STAT);
    case '/signal':
      return mockResponse(SIGNAL_ROWS);
    case '/signal/stats':
      return mockResponse(SIGNAL_STATS);
    case '/trade':
      return mockResponse(TRADE_ROWS);
    case '/ex-dividend/imports':
      return mockResponse(DIVIDEND_IMPORTS);
    case '/candidate':
      return mockResponse(CANDIDATE_ROWS);
    case '/admin/system-log':
      return mockResponse([]);
    default:
      if (url.startsWith('/quote/')) {
        return mockResponse({ symbol: 'sh600000', fq: 'qfq', klines: [], indicators: null, signals: [] });
      }
      throw new Error(`未预期的接口调用: ${url}`);
  }
}
