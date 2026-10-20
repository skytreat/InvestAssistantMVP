/**
 * T67 · 卡 5 用例：今日动态概览卡（ux_v2 建议 D · P0 · **G3.3 的唯一覆盖**）
 *
 * 对应任务卡：`docs/audit/wave-3-task-cards.md` 卡 5。
 *
 * ## 这个文件守的是什么
 *
 * G3.3 的原文判据是「**今日动态概览卡 5 个数据块各自非空或有降级文案**」——
 * 注意是「**各自**」：5 个块里**任何一个**空着（或只显示一个转圈）都算不通过。
 * ⇒ 每个块都有**独立**的降级分支（接口失败 / 无数据各一条），
 *    且**单点失败不许拖垮整卡**（A9 的参数化用例）。
 *
 * ## 与 `dashboard.test.tsx` 分开的原因
 *
 * `dashboard.test.tsx` 里的断言是**回归红线**（donut 渐变字符串、总资产口径…），
 * 本卡是纯新增组件，用例另起文件，不去动既有断言的强度。
 *
 * ⚠️ **本卡不改 `pages/Dashboard.tsx`** —— 接线由批次 5 统一做。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import TodayActivityCard from '../../src/components/TodayActivityCard';
import { mockResponse, renderWithRouter } from '../helpers';
import { expectNoCriticalA11yViolations, runA11y } from '../helpers/a11y';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

interface ApiGetConfig {
  params?: Record<string, unknown>;
}

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: ApiGetConfig) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({ api: { get: getMock } }));

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

interface SignalFixture {
  plugin_id: string;
  direction: 'buy' | 'sell' | 'hold';
  label: string;
  trade_date: string;
}

interface PositionFixture {
  asset_code: string;
  totalQuantity: number;
  currentPrice: number | null;
  prevClose: number | null;
  signal: SignalFixture | null;
}

interface SignalRowFixture {
  asset_code: string;
  plugin_id: string;
  direction: string;
  label: string;
  trade_date: string;
}

const TRADE_DATE = '2026-10-17';

/**
 * 两只持仓
 *
 * ⚠️ `sh510300` 的 `prevClose` **故意为 null** ——
 *    卡 5 A2 要求「另一只 `prevClose === null` 不计入」，
 *    这样「+50.00」这个期望值才是真的（基数只有 600，而不是 600+200*10）。
 */
const DEFAULT_POSITIONS: PositionFixture[] = [
  {
    asset_code: 'sh600000',
    totalQuantity: 100,
    currentPrice: 6.5,
    prevClose: 6,
    signal: { plugin_id: 'macd_cross', direction: 'buy', label: '金叉', trade_date: TRADE_DATE },
  },
  {
    asset_code: 'sh510300',
    totalQuantity: 200,
    currentPrice: 3,
    prevClose: null,
    signal: null,
  },
];

/** `summary` 的形状（`priceDate` 可为 null —— 裁决 D-6 的回退分支）*/
interface HoldingSummaryFixture {
  totalMarketValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
  realizedPnL: number;
  priceDate: string | null;
  positionCount: number;
}

const DEFAULT_SUMMARY: HoldingSummaryFixture = {
  totalMarketValue: 1250,
  totalCostBasis: 1000,
  unrealizedPnl: 250,
  realizedPnL: 0,
  priceDate: TRADE_DATE,
  positionCount: 2,
};

/** 今日信号统计（2 买 + 1 卖 + 1 持有）*/
const DEFAULT_STATS = { total: 4, up: 2, down: 1, hold: 1 };

/** 今日信号列表（用于候选交集）*/
const DEFAULT_SIGNAL_ROWS: SignalRowFixture[] = [
  {
    asset_code: 'sz000001',
    plugin_id: 'macd_cross',
    direction: 'buy',
    label: '金叉',
    trade_date: TRADE_DATE,
  },
];

const DEFAULT_TRADES = [
  { asset_code: 'sh600000', trade_type: 'buy', quantity: 100, price: 6.2, is_auto_import: 0 },
  { asset_code: 'sh600000', trade_type: 'reduce', quantity: 50, price: 6.8, is_auto_import: 0 },
];

const DEFAULT_DIVIDENDS = {
  from: TRADE_DATE,
  to: TRADE_DATE,
  items: [
    {
      asset_code: 'sh600519',
      trade_type: 'dividend',
      trade_date: TRADE_DATE,
      quantity: 100,
      price: 0.5,
    },
  ],
  summary: { total: 1, dividendCount: 1, bonusCount: 0 },
};

const DEFAULT_CANDIDATES = [{ asset_code: 'sz000001' }];

interface ApiOverrides {
  positions?: PositionFixture[];
  summary?: HoldingSummaryFixture | null;
  /** 统计端点的原始 `data`（故意放宽成 unknown —— 用来模拟契约漂移）*/
  stats?: unknown;
  signalRows?: SignalRowFixture[];
  signalTotal?: number | null;
  trades?: typeof DEFAULT_TRADES;
  dividends?: typeof DEFAULT_DIVIDENDS | null;
  candidates?: { asset_code: string }[];
  /** 需要失败的端点（抛错）*/
  failUrls?: string[];
}

function installApiMock(overrides: ApiOverrides = {}): void {
  // ⚠️ 清空调用历史 —— 「无 N+1」类断言要按**单个用例**统计请求次数
  getMock.mockClear();
  const positions = overrides.positions ?? DEFAULT_POSITIONS;
  const summary = 'summary' in overrides ? (overrides.summary ?? null) : DEFAULT_SUMMARY;
  const stats = 'stats' in overrides ? (overrides.stats ?? null) : DEFAULT_STATS;
  const signalRows = overrides.signalRows ?? DEFAULT_SIGNAL_ROWS;
  const signalTotal = 'signalTotal' in overrides ? (overrides.signalTotal ?? null) : signalRows.length;
  const trades = overrides.trades ?? DEFAULT_TRADES;
  const dividends = 'dividends' in overrides ? (overrides.dividends ?? null) : DEFAULT_DIVIDENDS;
  const candidates = overrides.candidates ?? DEFAULT_CANDIDATES;
  const failUrls = new Set(overrides.failUrls ?? []);

  getMock.mockImplementation(async (url: string) => {
    if (failUrls.has(url)) throw new Error(`接口失败（测试注入）：${url}`);
    switch (url) {
      case '/holding':
        return mockResponse(positions, { summary });
      case '/signal/stats':
        return mockResponse(stats);
      case '/signal':
        return mockResponse(signalRows, { pagination: { total: signalTotal } });
      case '/trade':
        return mockResponse(trades);
      case '/ex-dividend/imports':
        return mockResponse(dividends);
      case '/candidate':
        return mockResponse(candidates);
      default:
        throw new Error(`未预期的接口调用: ${url}`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 查询 helper
 * ------------------------------------------------------------------ */

/** 5 个数据块（顺序即 G3.3 的 ①~⑤）*/
const BLOCK_IDS = [
  'today-block-asset-change',
  'today-block-signals',
  'today-block-trades',
  'today-block-dividends',
  'today-block-focus',
] as const;

/** 数据块 id 的类型 */
type BlockId = (typeof BLOCK_IDS)[number];

function block(id: BlockId): HTMLElement {
  const el = screen.getByTestId(id);
  return el;
}

/**
 * 块里的**内容**文本（**剔除块标题**）
 *
 * ⚠️ 为什么不能直接用 `block(id).textContent`：
 *    块的 `<h3>` 标题（如「今日信号」）本身就有文字 ⇒ 只断言 `textContent.length > 0`
 *    的**块即使一个数据都没渲染也照样通过** —— 那是假绿。
 *    G3.3 的原文是「5 个数据块**各自**非空或有降级文案」⇒ 必须断言**内容**非空。
 */
function blockContent(id: BlockId): string {
  const el = block(id);
  const title = within(el).getByRole('heading').textContent ?? '';
  return (el.textContent ?? '').replace(title, '').trim();
}

/** 等所有块都结算完（不再有加载中的转圈）*/
async function waitSettled(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryAllByText('加载中...')).toHaveLength(0);
  });
}

/** 渲染并等结算 */
async function renderCard(overrides: ApiOverrides = {}): Promise<void> {
  installApiMock(overrides);
  renderWithRouter(<TodayActivityCard />);
  await waitSettled();
}

/** 本地自然日（与组件同口径，但**独立实现**一遍，避免「同源错误」互相掩盖）*/
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 取某次接口调用的参数（**最后一次** —— 一个用例里可能渲染多轮）*/
function paramsOf(url: string): Record<string, unknown> | undefined {
  const calls = getMock.mock.calls.filter((c) => c[0] === url);
  return calls[calls.length - 1]?.[1]?.params;
}

/* ------------------------------------------------------------------ *
 * G3.3 · 5 个块各自非空或有降级文案
 * ------------------------------------------------------------------ */

describe('建议 D · G3.3：5 个数据块各自非空或有降级文案', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：5 个数据块各自非空或有降级文案（G3.3）', async () => {
    await renderCard();

    for (const id of BLOCK_IDS) {
      const text = block(id).textContent ?? '';
      expect(text.trim().length, `块 ${id} 为空`).toBeGreaterThan(0);
      // ⚠️ **内容级断言** —— 块标题本身有字，只看 textContent 会假绿
      expect(blockContent(id), `块 ${id} 只有标题、没有内容`).not.toBe('');
    }

    // 5 个块都有可访问名（a11y：区块不能只有颜色/图标区分）
    expect(screen.getByRole('region', { name: '总资产变化' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '今日信号' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '今日成交' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '今日除权导入' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '重点关注' })).toBeInTheDocument();
  });

  it('建议 D：全部端点失败时，5 个块仍各自有降级文案（不许空白）', async () => {
    await renderCard({
      failUrls: ['/holding', '/signal/stats', '/signal', '/trade', '/ex-dividend/imports', '/candidate'],
    });

    for (const id of BLOCK_IDS) {
      expect((block(id).textContent ?? '').trim().length, `块 ${id} 为空`).toBeGreaterThan(0);
      expect(blockContent(id), `块 ${id} 只有标题、没有降级文案`).not.toBe('');
    }

    expect(block('today-block-asset-change')).toHaveTextContent('持仓数据暂不可用');
    expect(block('today-block-signals')).toHaveTextContent('今日信号暂不可用');
    expect(block('today-block-trades')).toHaveTextContent('今日成交暂不可用');
    expect(block('today-block-dividends')).toHaveTextContent('除权导入记录暂不可用');
    expect(block('today-block-focus')).toHaveTextContent('持仓信号暂不可用');
    expect(block('today-block-focus')).toHaveTextContent('候选信号暂不可用');
  });

  it('建议 D：接口返回空（空数组/零计数）时，5 个块各自有对应的空态文案', async () => {
    // ⚠️ 「接口失败」与「接口返回空」是**两种**情形，两种都必须有文案（不许空白）
    await renderCard({
      positions: [],
      summary: { ...DEFAULT_SUMMARY, priceDate: TRADE_DATE, positionCount: 0 },
      stats: { total: 0, up: 0, down: 0, hold: 0 },
      signalRows: [],
      signalTotal: 0,
      trades: [],
      dividends: {
        from: TRADE_DATE,
        to: TRADE_DATE,
        items: [],
        summary: { total: 0, dividendCount: 0, bonusCount: 0 },
      },
      candidates: [],
    });

    expect(block('today-block-asset-change')).toHaveTextContent('暂无持仓，暂无法对比今日变化');
    expect(block('today-block-signals')).toHaveTextContent('今日暂无策略信号');
    expect(block('today-block-trades')).toHaveTextContent('今日暂无成交');
    expect(block('today-block-dividends')).toHaveTextContent('今日无除权导入记录');
    expect(block('today-block-focus')).toHaveTextContent('今日暂无重点关注标的');

    for (const id of BLOCK_IDS) {
      expect(blockContent(id), `块 ${id} 只有标题、没有空态文案`).not.toBe('');
    }
  });

  it('建议 D：加载态用 Spinner（role="status"），且不出现空块', async () => {
    installApiMock();
    renderWithRouter(<TodayActivityCard />);

    // 加载中：每个块都有 role="status" 的转圈（不是空白）
    expect(screen.getAllByRole('status').length).toBeGreaterThanOrEqual(BLOCK_IDS.length);
    for (const id of BLOCK_IDS) {
      expect(within(block(id)).getAllByRole('status').length).toBeGreaterThanOrEqual(1);
    }

    // 冲刷挂起的请求（避免用例结束后再冒出 act 告警）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('建议 D：a11y —— 卡片自身 0 critical 违规（G3.4 同款门禁）', async () => {
    await renderCard();

    const result = await runA11y(document.body);
    await expectNoCriticalA11yViolations(result);
  });
});

/* ------------------------------------------------------------------ *
 * 块 ① 总资产变化（对比昨收）
 * ------------------------------------------------------------------ */

describe('建议 D · 块 ① 总资产变化（对比昨收）', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：总资产变化按昨收计算金额与百分比', async () => {
    await renderCard();

    const el = block('today-block-asset-change');
    // Σ(6.5×100) − Σ(6×100) = +50.00；基数 = Σ昨收市值 = 600 → +8.33%
    expect(within(el).getByText('+50.00')).toBeInTheDocument();
    expect(within(el).getByText('（+8.33%）')).toBeInTheDocument();
    // 缺昨收的持仓被排除，且**说明了排除了几只**
    expect(el).toHaveTextContent('已排除 1 只');
  });

  it('建议 D：总资产变化在 prevClose 缺失时降级且不出现 NaN', async () => {
    await renderCard({
      positions: [{ ...DEFAULT_POSITIONS[0], prevClose: null }, DEFAULT_POSITIONS[1]],
    });

    const el = block('today-block-asset-change');
    expect(el).toHaveTextContent('无昨收数据，暂无法对比今日变化');
    expect(el.textContent).not.toContain('NaN');
    expect(el.textContent).not.toContain('undefined');
    expect(el.textContent).not.toContain('Infinity');
  });

  it('建议 D：持仓接口返回空数组时块 ① 走「暂无持仓」文案', async () => {
    await renderCard({ positions: [] });

    const el = block('today-block-asset-change');
    expect(el).toHaveTextContent('暂无持仓，暂无法对比今日变化');
    expect(el.textContent).not.toContain('NaN');
    expect(blockContent('today-block-asset-change')).not.toBe('');
  });

  it('建议 D：昨收/现价字段缺失或非有限数时排除该持仓，且不出现 NaN', async () => {
    // ⚠️ 「非 null」不等于「可用」——字段**缺失**（undefined）与**脏数据**（NaN / Infinity）
    //    都会让乘法产出 NaN（A3 明令不许出现 NaN），故必须按「有限数」过滤
    const dirty = [
      { ...DEFAULT_POSITIONS[0], prevClose: undefined, currentPrice: undefined },
      { ...DEFAULT_POSITIONS[1], prevClose: Number.NaN, currentPrice: 3 },
      { ...DEFAULT_POSITIONS[1], prevClose: 2.9, currentPrice: Number.POSITIVE_INFINITY },
    ] as unknown as PositionFixture[];

    await renderCard({ positions: dirty });

    const el = block('today-block-asset-change');
    expect(el.textContent).not.toContain('NaN');
    expect(el.textContent).not.toContain('Infinity');
    expect(el.textContent).not.toContain('undefined');
    // 3 只全部被排除 → 走降级文案，并说明排除了几只
    expect(el).toHaveTextContent('无昨收数据，暂无法对比今日变化');
    expect(el).toHaveTextContent('已排除 3 只');
  });

  it('建议 D：部分持仓字段异常时，可用的那只照常算（差额不被脏数据带偏）', async () => {
    const dirty = [
      { ...DEFAULT_POSITIONS[0] }, // 可用：6 → 6.5 × 100 = +50.00
      { ...DEFAULT_POSITIONS[1], currentPrice: undefined },
    ] as unknown as PositionFixture[];

    await renderCard({ positions: dirty });

    const el = block('today-block-asset-change');
    expect(el).toHaveTextContent('+50.00');
    expect(el.textContent).not.toContain('NaN');
    expect(el).toHaveTextContent('已排除 1 只');
  });

  it('建议 D：持仓接口失败时块 ① 走降级文案', async () => {
    await renderCard({ failUrls: ['/holding'] });

    const el = block('today-block-asset-change');
    expect(el).toHaveTextContent('持仓数据暂不可用');
    expect(el.textContent).not.toContain('NaN');
  });
});

/* ------------------------------------------------------------------ *
 * 块 ② 今日信号 ▲▼· 统计
 * ------------------------------------------------------------------ */

describe('建议 D · 块 ② 今日信号统计', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：今日信号按 buy/sell/hold 三态计数', async () => {
    await renderCard();

    const el = block('today-block-signals');
    expect(el).toHaveTextContent('▲2');
    expect(el).toHaveTextContent('▼1');
    expect(el).toHaveTextContent('·1');
    // 符号不能是唯一语义载体 → 必须有中文标签
    expect(el).toHaveTextContent('买入');
    expect(el).toHaveTextContent('卖出');
    expect(el).toHaveTextContent('持有');
  });

  it('建议 D：今日无信号时显示空态文案而不是空白', async () => {
    await renderCard({ stats: { total: 0, up: 0, down: 0, hold: 0 } });

    const el = block('today-block-signals');
    expect(el).toHaveTextContent('今日暂无策略信号');
    expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('建议 D：今日信号超过 200 条时提示截断', async () => {
    // 200 条列表 + pagination.total = 500 —— 服务端分页上限 200
    const rows: SignalRowFixture[] = Array.from({ length: 200 }, (_, i) => ({
      asset_code: `sh60${String(i).padStart(4, '0')}`,
      plugin_id: 'macd_cross',
      direction: 'buy',
      label: '金叉',
      trade_date: TRADE_DATE,
    }));

    await renderCard({
      // 统计接口不可用 → 降级为列表计数（列表被截断 → 必须提示）
      failUrls: ['/signal/stats'],
      signalRows: rows,
      signalTotal: 500,
    });

    const el = block('today-block-signals');
    expect(el).toHaveTextContent('仅显示前 200 条');
    expect(el).toHaveTextContent('▲200');
  });

  it('建议 D：统计端点可用时以服务端精确计数为准，列表截断仍要提示', async () => {
    // 统计端点是 1 次 GROUP BY → 计数**不受分页上限影响**（不会静默偏小）
    const rows: SignalRowFixture[] = Array.from({ length: 200 }, (_, i) => ({
      asset_code: `sh60${String(i).padStart(4, '0')}`,
      plugin_id: 'macd_cross',
      direction: 'buy',
      label: '金叉',
      trade_date: TRADE_DATE,
    }));

    await renderCard({
      stats: { total: 500, up: 300, down: 150, hold: 50 },
      signalRows: rows,
      signalTotal: 500,
    });

    const el = block('today-block-signals');
    // 精确计数优先于列表计数
    expect(el).toHaveTextContent('▲300');
    expect(el).toHaveTextContent('▼150');
    expect(el).toHaveTextContent('·50');
    expect(el).toHaveTextContent('共 500 条');
    // 列表被截断的事实仍要说明（候选交集只用到前 200 条）
    expect(el).toHaveTextContent('仅显示前 200 条');
  });

  it('建议 D：统计端点与列表端点都可用时，统计口径优先', async () => {
    // 列表只有 1 条 buy，统计端点说 3 条 → 以统计端点为准（否则数字会静默偏小）
    await renderCard({
      stats: { total: 3, up: 2, down: 1, hold: 0 },
      signalRows: [{ ...DEFAULT_SIGNAL_ROWS[0] }],
      signalTotal: 1,
    });

    const el = block('today-block-signals');
    expect(el).toHaveTextContent('▲2');
    expect(el).toHaveTextContent('▼1');
    expect(el).toHaveTextContent('共 3 条');
  });

  it('建议 D：统计与列表都不可用时走降级文案', async () => {
    await renderCard({ failUrls: ['/signal/stats', '/signal'] });

    const el = block('today-block-signals');
    expect(el).toHaveTextContent('今日信号暂不可用');
  });

  it('建议 D：统计端点返回形状异常时降级到列表计数（不渲染 undefined）', async () => {
    // 契约漂移 / mock 写错：统计端点返回了数组而不是 { total, up, down, hold }
    await renderCard({ stats: [] });

    const el = block('today-block-signals');
    expect(el.textContent).not.toContain('undefined');
    expect(el.textContent).not.toContain('NaN');
    // 降级到列表计数（列表 1 条 buy → ▲1）
    expect(el).toHaveTextContent('▲1');
  });
});

/* ------------------------------------------------------------------ *
 * 块 ③ 今日成交
 * ------------------------------------------------------------------ */

describe('建议 D · 块 ③ 今日成交', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：今日成交渲染前 1-2 条', async () => {
    await renderCard();

    const el = block('today-block-trades');
    expect(el).toHaveTextContent('sh600000');
    expect(el).toHaveTextContent('买入');
    expect(el).toHaveTextContent('减仓');
    expect(el).toHaveTextContent('100');
  });

  it('建议 D：今日成交为空时显示空态文案而不是空白', async () => {
    await renderCard({ trades: [] });

    const el = block('today-block-trades');
    expect(el).toHaveTextContent('今日暂无成交');
    expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('建议 D：今日成交接口失败时走降级文案', async () => {
    await renderCard({ failUrls: ['/trade'] });

    expect(block('today-block-trades')).toHaveTextContent('今日成交暂不可用');
  });
});

/* ------------------------------------------------------------------ *
 * 块 ④ 今日除权导入
 * ------------------------------------------------------------------ */

describe('建议 D · 块 ④ 今日除权导入', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：今日除权导入渲染 summary', async () => {
    await renderCard();

    const el = block('today-block-dividends');
    expect(el).toHaveTextContent('共 1 条');
    expect(el).toHaveTextContent('sh600519');
    expect(el).toHaveTextContent('分红');
  });

  it('建议 D：今日除权导入为空时显示空态文案', async () => {
    await renderCard({
      dividends: {
        from: TRADE_DATE,
        to: TRADE_DATE,
        items: [],
        summary: { total: 0, dividendCount: 0, bonusCount: 0 },
      },
    });

    const el = block('today-block-dividends');
    expect(el).toHaveTextContent('今日无除权导入记录');
    expect((el.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('建议 D：除权导入的 summary 与 items 不一致时仍渲染 summary.total（A7 判据）', async () => {
    // A7 原文：「`items` 非空 → 出现 `summary.total` 的数字」——
    // 故**不能**因为 summary.total 为 0 就把明细一起藏起来
    await renderCard({
      dividends: {
        from: TRADE_DATE,
        to: TRADE_DATE,
        items: [
          {
            asset_code: 'sh600519',
            trade_type: 'dividend',
            trade_date: TRADE_DATE,
            quantity: 100,
            price: 0.5,
          },
        ],
        summary: { total: 3, dividendCount: 3, bonusCount: 0 },
      },
    });

    const el = block('today-block-dividends');
    expect(el).toHaveTextContent('共 3 条');
    expect(el).toHaveTextContent('sh600519');
  });

  it('建议 D：除权导入接口失败时走降级文案', async () => {
    await renderCard({ failUrls: ['/ex-dividend/imports'] });

    expect(block('today-block-dividends')).toHaveTextContent('除权导入记录暂不可用');
  });
});

/* ------------------------------------------------------------------ *
 * 块 ⑤ 重点关注
 * ------------------------------------------------------------------ */

describe('建议 D · 块 ⑤ 重点关注（持仓 + 候选有信号）', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：重点关注同时含持仓有信号与候选有信号', async () => {
    await renderCard();

    const el = block('today-block-focus');
    // 持仓有信号（来自 /api/holding 的 signal 字段）
    expect(el).toHaveTextContent('sh600000');
    expect(el).toHaveTextContent('持仓');
    // 候选有信号（信号列表 ∩ 候选池）
    expect(el).toHaveTextContent('sz000001');
    expect(el).toHaveTextContent('候选');
  });

  it('建议 D：候选接口失败时仍显示持仓部分并给出降级文案', async () => {
    await renderCard({ failUrls: ['/candidate'] });

    const el = block('today-block-focus');
    expect(el).toHaveTextContent('sh600000');
    expect(el).toHaveTextContent('候选信号暂不可用');
  });

  it('建议 D：两边都没有信号时显示空态文案', async () => {
    await renderCard({
      positions: [{ ...DEFAULT_POSITIONS[0], signal: null }],
      signalRows: [],
      candidates: [],
    });

    expect(block('today-block-focus')).toHaveTextContent('今日暂无重点关注标的');
  });

  it('建议 D：持仓缺 signal 字段时不算「有信号」（不误报）', async () => {
    // ⚠️ `signal` **字段缺失**（undefined）时不能当成「有信号」——
    //    否则每只持仓都会被误报成「· 持有」
    await renderCard({
      positions: [{ ...DEFAULT_POSITIONS[0], signal: undefined }] as unknown as PositionFixture[],
      signalRows: [],
      candidates: [],
    });

    const el = block('today-block-focus');
    expect(el).toHaveTextContent('今日暂无重点关注标的');
    expect(el).not.toHaveTextContent('sh600000');
  });

  it('建议 D：重点关注在持仓/候选都可用时各自最多列 3 项并说明省略了多少', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      asset_code: `sh60${String(i).padStart(4, '0')}`,
      totalQuantity: 100,
      currentPrice: 6.5,
      prevClose: 6,
      signal: { plugin_id: 'macd_cross', direction: 'buy' as const, label: '金叉', trade_date: TRADE_DATE },
    }));

    await renderCard({ positions: many, signalRows: [], candidates: [] });

    const el = block('today-block-focus');
    expect(el).toHaveTextContent('持仓共 5 项有信号，仅显示前 3 项');
  });
});

/* ------------------------------------------------------------------ *
 * A9 · 单点失败不拖垮整卡
 * ------------------------------------------------------------------ */

describe('建议 D · A9 单端点失败只降级对应块，其余块正常', () => {
  beforeEach(() => {
    installApiMock();
  });

  const CASES: Array<{
    url: string;
    /** 预期出现降级文案的块 */
    degraded: Array<[BlockId, string]>;
    /** 预期仍正常出内容的块 */
    intact: Array<[BlockId, string]>;
  }> = [
    {
      url: '/holding',
      degraded: [
        ['today-block-asset-change', '持仓数据暂不可用'],
        ['today-block-focus', '持仓信号暂不可用'],
      ],
      intact: [
        ['today-block-signals', '▲2'],
        ['today-block-trades', 'sh600000'],
        ['today-block-dividends', '共 1 条'],
      ],
    },
    {
      url: '/signal/stats',
      // 统计接口挂 → 块 ② 降级为**列表计数**（列表 1 条 buy → ▲1），仍不是空白
      degraded: [],
      intact: [
        ['today-block-signals', '▲1'],
        ['today-block-trades', 'sh600000'],
        ['today-block-dividends', '共 1 条'],
      ],
    },
    {
      url: '/signal',
      degraded: [['today-block-focus', '候选信号暂不可用']],
      intact: [
        ['today-block-asset-change', '+50.00'],
        ['today-block-signals', '▲2'],
        ['today-block-trades', 'sh600000'],
        ['today-block-dividends', '共 1 条'],
      ],
    },
    {
      url: '/trade',
      degraded: [['today-block-trades', '今日成交暂不可用']],
      intact: [
        ['today-block-asset-change', '+50.00'],
        ['today-block-signals', '▲2'],
        ['today-block-dividends', '共 1 条'],
        ['today-block-focus', 'sh600000'],
      ],
    },
    {
      url: '/ex-dividend/imports',
      degraded: [['today-block-dividends', '除权导入记录暂不可用']],
      intact: [
        ['today-block-asset-change', '+50.00'],
        ['today-block-signals', '▲2'],
        ['today-block-trades', 'sh600000'],
        ['today-block-focus', 'sh600000'],
      ],
    },
    {
      url: '/candidate',
      degraded: [['today-block-focus', '候选信号暂不可用']],
      intact: [
        ['today-block-asset-change', '+50.00'],
        ['today-block-signals', '▲2'],
        ['today-block-trades', 'sh600000'],
        ['today-block-dividends', '共 1 条'],
      ],
    },
  ];

  for (const c of CASES) {
    it(`建议 D：单端点失败只降级对应块，其余块正常（${c.url}）`, async () => {
      await renderCard({ failUrls: [c.url] });

      for (const [id, text] of c.degraded) {
        expect(block(id), `${c.url} 应让 ${id} 降级`).toHaveTextContent(text);
      }
      for (const [id, text] of c.intact) {
        expect(block(id), `${c.url} 不应影响 ${id}`).toHaveTextContent(text);
      }
      // 无论哪个端点挂，其余块都不许空白
      for (const id of BLOCK_IDS) {
        expect((block(id).textContent ?? '').trim().length, `块 ${id} 为空`).toBeGreaterThan(0);
        expect(blockContent(id), `块 ${id} 只有标题、没有内容`).not.toBe('');
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 日期锚点（裁决 D-6）
 * ------------------------------------------------------------------ */

describe('建议 D · 日期锚点', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：日期锚点取 summary.priceDate', async () => {
    await renderCard();

    // 行情交易日 = 2026-10-17 → 其余端点都用这个日期
    expect(paramsOf('/signal/stats')).toEqual({ trade_date: TRADE_DATE });
    expect(paramsOf('/signal')).toEqual({ trade_date: TRADE_DATE, page_size: 200 });
    expect(paramsOf('/trade')).toEqual({ start_date: TRADE_DATE, end_date: TRADE_DATE, limit: 2 });
    expect(paramsOf('/ex-dividend/imports')).toEqual({ date: TRADE_DATE });
    // 卡头显示这个日期 + 中文星期（2026-10-17 是周六）
    expect(screen.getByTestId('today-activity-date')).toHaveTextContent('2026-10-17');
    expect(screen.getByTestId('today-activity-date')).toHaveTextContent('周六');
  });

  it('建议 D：priceDate 缺失时回退本地自然日', async () => {
    await renderCard({ summary: { ...DEFAULT_SUMMARY, priceDate: null } });

    const today = localToday();
    expect(paramsOf('/signal/stats')).toEqual({ trade_date: today });
    expect(paramsOf('/signal')).toEqual({ trade_date: today, page_size: 200 });
    expect(paramsOf('/trade')).toEqual({ start_date: today, end_date: today, limit: 2 });
    expect(paramsOf('/ex-dividend/imports')).toEqual({ date: today });
    expect(screen.getByTestId('today-activity-date')).toHaveTextContent(today);
  });
});

/* ------------------------------------------------------------------ *
 * 请求次数（无 N+1）与文案约束
 * ------------------------------------------------------------------ */

describe('建议 D · 请求次数与文案约束', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：无 N+1 —— 每个端点只请求 1 次（候选/信号不逐标的请求）', async () => {
    await renderCard();

    const counts = new Map<string, number>();
    for (const call of getMock.mock.calls) {
      const url = call[0];
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    // 持仓 1 次（块 ① 与块 ⑤ 的持仓部分**共用**同一次响应）
    expect(counts.get('/holding')).toBe(1);
    // 候选池 1 次（**不**逐只候选去查信号）
    expect(counts.get('/candidate')).toBe(1);
    // 信号列表 1 次（块 ② 的降级计数与块 ⑤ 的候选交集**共用**）
    expect(counts.get('/signal')).toBe(1);
    expect(counts.get('/signal/stats')).toBe(1);
    expect(counts.get('/trade')).toBe(1);
    expect(counts.get('/ex-dividend/imports')).toBe(1);
    expect(getMock.mock.calls.length).toBe(6);
  });

  it('建议 D：卡片文案不出现调度时刻（信号 17:02 / 除权 17:03 属 T79 ③）', async () => {
    await renderCard();

    const text = screen.getByTestId('today-activity-card').textContent ?? '';
    expect(text).not.toContain('17:02');
    expect(text).not.toContain('17:03');
  });
});

/* ------------------------------------------------------------------ *
 * 组件级：无障碍与窄屏
 * ------------------------------------------------------------------ */

describe('建议 D · 组件级约束', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('建议 D：卡片根节点是 region 且有可访问名', async () => {
    await renderCard();

    const card = screen.getByTestId('today-activity-card');
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveAttribute('aria-label', '今日动态');
  });

  it('建议 D：块容器允许收缩（min-width: 0），375px 下不横向溢出', async () => {
    await renderCard();

    for (const id of BLOCK_IDS) {
      const el = block(id);
      expect(['0', '0px']).toContain(el.style.minWidth);
      expect(el.style.overflowWrap).toBe('anywhere');
    }

    const grid = screen.getByTestId('today-activity-card').querySelector('div');
    expect(grid?.style.gridTemplateColumns).toContain('min(190px, 100%)');
  });

  it('建议 D：组件可独立渲染（不依赖 Dashboard 接线）', async () => {
    installApiMock();
    render(<TodayActivityCard />);
    expect(screen.getByTestId('today-activity-card')).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
