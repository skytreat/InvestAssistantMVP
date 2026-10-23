/**
 * T67 · 卡 6 用例：标的详情 Modal + K 线小图（ux_v2 建议 C）
 *
 * 对应任务卡：`docs/audit/wave-3-task-cards.md` 卡 6（裁决 D-8 关于「抽 `klineCanvas.ts`」）。
 *
 * ## 被测口径
 *
 * 1. **四块内容**：持仓概览 / 今日信号 / 最近交易 / K 线小图（ux_v2 行 419-441）；
 * 2. **K 线小图默认 120 天**（ux_v2 行 434）→ 断言 `api.get` 的调用参数；
 * 3. **「进入完整 K 线页」**链接带上标的代码（实测路由只有 `/kline`，无路径参数）；
 * 4. **ESC 关闭** + `role="dialog"` / `aria-modal` / 可访问名（标题含代码与名称）；
 * 5. **jsdom 下 Canvas 不可用** → **不抛异常 + 有降级提示**（不白屏）。
 *
 * ⚠️ **jsdom 没有 Canvas 2D context** —— `canvas.getContext('2d')` 返回 `null`，
 *    故「画得出来」的用例必须 stub `HTMLCanvasElement.prototype.getContext`；
 *    「画不出来」的用例则 stub 成 `null`，断言降级文案（**不断言像素**）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import PositionDetailModal from '../../src/components/PositionDetailModal';
import type { Position } from '../../src/components/positionDomain';
import { mockResponse, renderWithRouter } from '../helpers';

/**
 * 前端源码根目录（`apps/frontend`）
 *
 * ⚠️ **不能靠 `import.meta.url`** —— vitest 的 jsdom 环境下它是 `http://localhost/...`，
 *    `new URL(..., import.meta.url)` 拿到的是 http URL，`readFileSync` 直接报错。
 *    故从 `process.cwd()` 向上找（兼容「在 apps/frontend 里跑」与「在仓库根跑」两种入口）。
 */
const FRONTEND_ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'src/components/klineCanvas.ts'))) return dir;
    if (existsSync(resolve(dir, 'apps/frontend/src/components/klineCanvas.ts'))) {
      return resolve(dir, 'apps/frontend');
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到前端源码根目录（apps/frontend）');
})();

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

const POSITION: Position = {
  asset_code: 'sh600000',
  name: '浦发银行',
  totalQuantity: 100,
  totalCostBasis: 900,
  avgCost: 9,
  realizedPnL: 12.5,
  currentPrice: 10,
  priceDate: '2026-10-17',
  marketValue: 1000,
  unrealizedPnl: 100,
  unrealizedYield: 0.1,
  weight: 0.5,
  prevClose: 9.8,
  signal: {
    plugin_id: 'macd_cross',
    direction: 'buy',
    label: '金叉',
    trade_date: '2026-10-17',
  },
  industry: null,
};

interface TradeRowFixture {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  trade_time: string;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
}

const TRADES: TradeRowFixture[] = [
  {
    id: 3,
    asset_code: 'sh600000',
    trade_type: 'buy',
    trade_date: '2026-10-16',
    trade_time: '09:35:00',
    quantity: 100,
    price: 9,
    fee: 5,
    trade_reason: '突破年线',
  },
  {
    id: 2,
    asset_code: 'sh600000',
    trade_type: 'add',
    trade_date: '2026-09-20',
    trade_time: '10:05:00',
    quantity: 200,
    price: 8.5,
    fee: 6,
    trade_reason: null,
  },
  {
    id: 1,
    asset_code: 'sh600000',
    trade_type: 'reduce',
    trade_date: '2026-08-01',
    trade_time: '14:20:00',
    quantity: 100,
    price: 9.5,
    fee: 5,
    trade_reason: '止盈',
  },
];

/** 30 根日线（够算 MA20；不刻意造 NaN —— 前端只负责画，后端负责算）*/
function makeKlines(count: number) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = 10 + i * 0.1;
    bars.push({
      date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.1,
      high: close + 0.2,
      low: close - 0.3,
      close,
      volume: 1000 + i,
      amount: 10000 + i,
    });
  }
  return bars;
}

const KLINES = makeKlines(30);

const INDICATORS = {
  macd: {
    dif: KLINES.map((k) => k.close - 10),
    dea: KLINES.map((k) => k.close - 10.05),
    macd: KLINES.map((k) => (k.close - 10) * 0.5),
  },
  rsi: KLINES.map(() => 55),
  ma5: KLINES.map((k) => k.close),
  ma10: KLINES.map((k) => k.close),
  ma20: KLINES.map((k) => k.close),
};

interface ApiMockOptions {
  trades?: TradeRowFixture[];
  klineFails?: boolean;
  tradesFail?: boolean;
}

function installApiMock(options: ApiMockOptions = {}): void {
  const trades = options.trades ?? TRADES;
  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/quote/')) {
      if (options.klineFails) throw new Error('K 线接口不可用');
      return mockResponse({
        symbol: 'sh600000',
        fq: 'qfq',
        klines: KLINES,
        indicators: INDICATORS,
        signals: [],
      });
    }
    if (url === '/trade') {
      if (options.tradesFail) throw new Error('交易接口不可用');
      return mockResponse(trades, {
        pagination: { page: 1, limit: 5, total: trades.length, totalPages: 1 },
      });
    }
    throw new Error(`未预期的接口调用: ${url}`);
  });
}

/* ------------------------------------------------------------------ *
 * Canvas stub（jsdom 无 2D context）
 * ------------------------------------------------------------------ */

/**
 * 让画布「画得出来」/「画不出来」
 *
 * ⚠️ **只装一次 spy**（`beforeEach`），用例通过改 `canvasContext` 切换行为 ——
 *    反复 `vi.spyOn` 同一个方法会叠加代理层，行为依赖 spy 链的恢复顺序（实测踩过坑）。
 */
let canvasContext: CanvasRenderingContext2D | null = createFakeContext();

/** 假的 2D context：只提供本项目用到的那些方法 */
function createFakeContext(): CanvasRenderingContext2D {
  const noop = (): void => undefined;
  return {
    scale: noop,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fillText: noop,
    setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
}

/** 模拟「环境不支持 Canvas」（jsdom 默认就是 `getContext` 返回 null）*/
function stubCanvasUnsupported(): void {
  canvasContext = null;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('建议 C · 标的详情 Modal', () => {
  beforeEach(() => {
    installApiMock();
    // 画布默认「画得出来」（用例需要「画不出来」时调 `stubCanvasUnsupported()`）
    canvasContext = createFakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => canvasContext as CanvasRenderingContext2D | null,
    );
  });

  it('建议 C：open=false 时不渲染任何 DOM，也不发任何请求', () => {
    const { container } = render(
      <PositionDetailModal open={false} position={POSITION} onCancel={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('建议 C：打开后四个区块都有内容（持仓概览 / 今日信号 / 最近交易 / K 线小图）', async () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    // ① 持仓概览
    const overview = screen.getByTestId('position-detail-overview');
    expect(within(overview).getByText('持仓数量')).toBeInTheDocument();
    expect(within(overview).getByText('移动加权成本')).toBeInTheDocument();
    expect(within(overview).getByText('现价')).toBeInTheDocument();
    expect(within(overview).getByText('浮动盈亏')).toBeInTheDocument();
    expect(within(overview).getByText('仓位占比')).toBeInTheDocument();

    // ② 今日信号
    const signal = screen.getByTestId('position-detail-signal');
    await waitFor(() => expect(signal).toHaveTextContent('macd_cross'));
    expect(signal).toHaveTextContent('金叉');

    // ③ 最近交易
    const trades = screen.getByTestId('position-detail-trades');
    await waitFor(() => expect(within(trades).getAllByTestId('position-detail-trade-row')).toHaveLength(3));

    // ④ K 线小图
    const kline = screen.getByTestId('position-detail-kline');
    await waitFor(() => expect(within(kline).getByTestId('kline-mini-chart')).toBeInTheDocument());
  });

  it('建议 C：持仓概览的数值与 /api/holding 的该条持仓逐个相等', async () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const overview = screen.getByTestId('position-detail-overview');
    expect(within(overview).getByText('100')).toBeInTheDocument(); // 持仓数量
    expect(within(overview).getByText('9.0000')).toBeInTheDocument(); // 移动加权成本
    expect(within(overview).getByText('10.00')).toBeInTheDocument(); // 现价
    expect(within(overview).getByText('100.00')).toBeInTheDocument(); // 浮动盈亏
    expect(within(overview).getByText('10.00%')).toBeInTheDocument(); // 浮动收益率
    expect(within(overview).getByText('50.00%')).toBeInTheDocument(); // 仓位占比
  });

  it('建议 C：无信号时今日信号区块显示「今日无策略信号」', async () => {
    renderWithRouter(
      <PositionDetailModal open position={{ ...POSITION, signal: null }} onCancel={() => {}} />,
    );
    expect(screen.getByTestId('position-detail-signal')).toHaveTextContent('今日无策略信号');
  });

  it('建议 C：K 线小图默认 120 天且渲染 canvas（canvas.width > 0）', async () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    // 请求参数：默认 120 天 + qfq
    await waitFor(() => {
      const call = getMock.mock.calls.find((c) => c[0].startsWith('/quote/'));
      expect(call).toBeDefined();
      expect(call?.[1]).toEqual({ params: { days: 120, fq: 'qfq' } });
    });

    const canvas = await screen.findByTestId('kline-mini-chart-canvas');
    await waitFor(() => expect((canvas as HTMLCanvasElement).width).toBeGreaterThan(0));
    expect(screen.getByTestId('kline-mini-chart-sub-canvas')).toBeInTheDocument();
  });

  it('建议 C：【进入完整 K 线页】的 href 带 symbol 参数，跳转后路由含该参数', async () => {
    const user = userEvent.setup();
    // ⚠️ `routerPath` 是 **getter** —— 不能解构（解构会把当时的值取快照），
    //    必须在 `waitFor` 回调里现读 `result.routerPath`。
    const result = renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const link = screen.getByRole('link', { name: /进入完整 K 线页/ });
    expect(link).toHaveAttribute('href', '/kline?symbol=sh600000');

    await user.click(link);
    await waitFor(() => expect(result.routerPath).toBe('/kline?symbol=sh600000'));
  });

  it('建议 C：最近交易为空时显示「暂无交易记录」', async () => {
    installApiMock({ trades: [] });
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId('position-detail-trades-empty')).toHaveTextContent('暂无交易记录'),
    );
  });

  it('建议 C：最近交易有 N 条就渲染 N 条', async () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const rows = await screen.findAllByTestId('position-detail-trade-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('2026-10-16');
    expect(rows[0]).toHaveTextContent('买入');
    expect(rows[1]).toHaveTextContent('加仓');
    expect(rows[2]).toHaveTextContent('减仓');
  });

  it('建议 C：K 线接口失败时小图区显示降级文案（不白屏、不抛未捕获异常）', async () => {
    installApiMock({ klineFails: true });
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const err = await screen.findByTestId('kline-mini-chart-error');
    expect(err).toHaveTextContent('K 线数据加载失败');
    // 其余三块不受影响
    expect(screen.getByTestId('position-detail-overview')).toBeInTheDocument();
    expect(screen.getByTestId('position-detail-trades')).toBeInTheDocument();
  });

  it('建议 C：jsdom 下 Canvas 不可用时不抛异常且给出降级提示', async () => {
    stubCanvasUnsupported();
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const notice = await screen.findByTestId('kline-mini-chart-unsupported');
    expect(notice).toHaveTextContent('当前环境不支持 Canvas');
    // 画布元素仍在（只是画不出内容），其余区块正常
    expect(screen.getByTestId('kline-mini-chart-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('position-detail-overview')).toBeInTheDocument();
  });

  it('建议 C：ESC 关闭 Modal（触发 onCancel）', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={onCancel} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('T79 ④：Modal 内有面包屑，当前项为标的代码', async () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const nav = screen.getByRole('navigation', { name: '面包屑' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '仪表盘' })).toHaveAttribute('href', '/');
    expect(screen.getByText('sh600000')).toHaveAttribute('aria-current', 'page');
  });

  it('建议 C：role=dialog + aria-modal + 可访问名（标题含代码与名称）', () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog).toHaveAccessibleName('标的详情 · sh600000 浦发银行');
  });

  it('建议 C：name 缺失时标题只含代码（回退，不出现 null 字面量）', () => {
    renderWithRouter(<PositionDetailModal open position={{ ...POSITION, name: null }} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('标的详情 · sh600000');
    expect(dialog.textContent).not.toContain('null');
  });

  it('建议 C：底部【买入】【卖出】触发 onTrade（代码 + 方向）', async () => {
    const onTrade = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} onTrade={onTrade} />);

    await user.click(screen.getByRole('button', { name: '买入' }));
    expect(onTrade).toHaveBeenCalledWith('sh600000', 'buy');

    await user.click(screen.getByRole('button', { name: '卖出' }));
    expect(onTrade).toHaveBeenCalledWith('sh600000', 'sell');
  });

  it('建议 C：未接入 onTrade 时【买入】【卖出】为 disabled 占位', () => {
    renderWithRouter(<PositionDetailModal open position={POSITION} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: '买入' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '卖出' })).toBeDisabled();
  });
});

/**
 * 裁决 D-8 的回归：组件层**不得**依赖页面层
 *
 * 若 `components/KlineMiniChart.tsx` 从 `pages/Kline.tsx` import 绘制函数，
 * 打包器会把 **Kline 整页代码拉进 Dashboard 首屏 chunk** → 破坏 T66 的不变量
 * （动态层面的回归用例见 `tests/unit/lazyLoading.test.tsx`；此处补**静态依赖边界**这一层）。
 */
describe('建议 C · D-8 回归：组件层不依赖页面层', () => {
  const files = ['KlineMiniChart.tsx', 'PositionDetailModal.tsx', 'klineCanvas.ts'];

  it('三个新组件文件都不 import 任何 `pages/` 模块', () => {
    for (const name of files) {
      const src = readFileSync(resolve(FRONTEND_ROOT, 'src/components', name), 'utf-8');
      expect(src, `${name} 不得 import 页面层`).not.toMatch(/from\s+['"][^'"]*pages\//);
    }
  });

  it('绘制逻辑在 `klineCanvas.ts` 里（不是从 Kline 页 import 来的）', () => {
    const src = readFileSync(resolve(FRONTEND_ROOT, 'src/components/klineCanvas.ts'), 'utf-8');
    for (const fn of [
      'export function setupCanvas',
      'export function drawMain',
      'export function drawMACD',
    ]) {
      expect(src).toContain(fn);
    }
  });
});
