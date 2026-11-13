/**
 * K 线图界面增强（UI 层）用例
 *
 * 覆盖四个入口：
 * 1. **图表标题区**显示「代码 + 名称」（名称来自现有 `/symbols/search`）
 * 2. **指标参数面板默认折叠** + 可点击展开 / 收起 + 同一次会话内记住
 * 3. **买点标记旁的中文单字**（建 / 加 / 减 / 清）与密集区避让
 * 4. **图表全屏**（Fullscreen API 进入 / 退出 + `fullscreenchange` 同步）
 *
 * ⚠️ jsdom 没有 layout engine ⇒ 本文件只钉**结构与调用契约**；
 *    文字与蜡烛的视觉重叠由真浏览器探针负责。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderWithRouter, mockResponse } from '../helpers';
import { installFakeCanvas, restoreFakeCanvas } from '../helpers/fakeCanvas';
import KlineParamPanel from '../../src/components/KlineParamPanel';
import KlineChart from '../../src/components/KlineChart';
import { TYPO } from '../../src/theme/tokens';
import { DEFAULT_INDICATOR_PARAMS } from '../../src/indicators/chartParams';
import { buildChartBars, type RawBar } from '../../src/indicators/chartBars';
import {
  TRADE_AGGREGATED_RADIUS,
  TRADE_BUY_COLOR,
  TRADE_MARKER_LABELS,
  TRADE_MARKER_RADIUS,
  TRADE_SELL_COLOR,
  computeTradeMarkerLabels,
  drawTradeMarkerLabel,
  tradeMarkerLabelText,
  type TradeMarkerGeometry,
} from '../../src/indicators/chartIndicators';

/* ------------------------------------------------------------------ *
 * api mock（只给「图表标题区」用例用）
 * ------------------------------------------------------------------ */

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<(url: string, cfg?: { params?: Record<string, unknown> }) => Promise<unknown>>(),
}));

vi.mock('../../src/api/client', () => ({
  api: {
    get: getMock,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  onSessionExpired: () => () => {},
  emitSessionExpired: () => {},
  currentPath: () => '/kline',
}));

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 造 n 根连续日线 */
function makeBars(count: number): RawBar[] {
  const bars: RawBar[] = [];
  const start = Date.UTC(2026, 0, 5);
  for (let i = 0; i < count; i++) {
    const close = Number((10 + Math.sin(i / 7) * 1.5 + i * 0.05).toFixed(2));
    bars.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open: Number((close - 0.05).toFixed(2)),
      high: Number((close + 0.2).toFixed(2)),
      low: Number((close - 0.2).toFixed(2)),
      close,
      volume: 1000 + i * 10,
      amount: (1000 + i * 10) * close,
    });
  }
  return bars;
}

const RAW_BARS = makeBars(30);

/** 造一条标记几何（默认：买入侧实心单笔） */
function makeMarker(overrides: Partial<TradeMarkerGeometry> = {}): TradeMarkerGeometry {
  return {
    index: 1,
    date: '2026-01-06',
    x: 50,
    y: 100,
    color: TRADE_BUY_COLOR,
    shape: 'solid',
    radius: TRADE_MARKER_RADIUS,
    trades: [
      {
        id: 1,
        trade_date: '2026-01-06',
        trade_time: null,
        trade_type: 'buy',
        marker_type: 'open',
        quantity: 100,
        price: 10,
        adj_price: 10,
      },
    ],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * ① 标记文字：单字用词 + 颜色 + 聚合 + 避让
 * ------------------------------------------------------------------ */

describe('K 线标记文字（建 / 加 / 减 / 清）', () => {
  it('四种类型只输出**单字**，不带「仓」字，且买卖两侧颜色与标记一致', () => {
    expect(TRADE_MARKER_LABELS).toEqual({ open: '建', add: '加', reduce: '减', close: '清' });
    expect(Object.values(TRADE_MARKER_LABELS).every((label) => !label.includes('仓'))).toBe(true);

    const cases: Array<[TradeMarkerGeometry['trades'][number]['marker_type'], string, string]> = [
      ['open', '建', TRADE_BUY_COLOR],
      ['add', '加', TRADE_BUY_COLOR],
      ['reduce', '减', TRADE_SELL_COLOR],
      ['close', '清', TRADE_SELL_COLOR],
    ];
    for (const [type, text, color] of cases) {
      const marker = makeMarker({
        color,
        shape: type === 'open' || type === 'close' ? 'solid' : 'hollow',
        trades: [{ ...makeMarker().trades[0], marker_type: type }],
      });
      expect(tradeMarkerLabelText(marker)).toBe(text);
      expect(computeTradeMarkerLabels([marker])[0]).toMatchObject({ text, color });
    }
  });

  it('同日多笔（聚合圆环）→ 文字是**笔数**', () => {
    const base = makeMarker().trades[0];
    const marker = makeMarker({
      shape: 'aggregated',
      radius: TRADE_AGGREGATED_RADIUS,
      trades: [
        { ...base, id: 1, marker_type: 'add' },
        { ...base, id: 2, marker_type: 'reduce' },
        { ...base, id: 3, marker_type: 'add' },
      ],
    });
    expect(tradeMarkerLabelText(marker)).toBe('3');
    expect(computeTradeMarkerLabels([marker])[0].text).toBe('3');
  });

  it('靠近右边界（价格轴）→ 文字自动改到标记**左侧**，不压价格轴', () => {
    const marker = makeMarker({ x: 100, y: 100 });
    // 右侧放不下（100 + 4 + 3 + 11 = 118 > 110）
    const flipped = computeTradeMarkerLabels([marker], { rightBoundary: 110 })[0];
    expect(flipped.align).toBe('right');
    expect(flipped.x).toBe(100 - TRADE_MARKER_RADIUS - 3);

    // 空间充足 → 仍在右侧
    const normal = computeTradeMarkerLabels([marker], { rightBoundary: 200 })[0];
    expect(normal.align).toBe('left');
    expect(normal.x).toBeGreaterThan(marker.x);
  });

  it('密集区（相邻 4px）→ 文字**上下错行**避让，纵向不再相互重叠', () => {
    const markers = [
      makeMarker({ index: 1, x: 50, y: 100 }),
      makeMarker({ index: 2, x: 54, y: 100 }),
      makeMarker({ index: 3, x: 58, y: 100 }),
    ];
    const labels = computeTradeMarkerLabels(markers, { rightBoundary: 300 });

    expect(labels).toHaveLength(3);
    // 三条文字的垂直中心必须互不相同（错行）
    const ys = labels.map((label) => label.y);
    expect(new Set(ys).size).toBe(3);
  });

  it('`drawTradeMarkerLabel` 在 canvas 上画出文字（颜色 = 标记颜色，且有底色块）', () => {
    const fillText = vi.fn();
    const fillRect = vi.fn();
    const ctx = {
      save: () => undefined,
      restore: () => undefined,
      fillText,
      fillRect,
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;

    const label = computeTradeMarkerLabels([makeMarker()])[0];
    drawTradeMarkerLabel(ctx, label);

    expect(fillRect).toHaveBeenCalledTimes(1);
    expect(fillText).toHaveBeenCalledTimes(1);
    expect(fillText.mock.calls[0][0]).toBe('建');
    expect(ctx.fillStyle).toBe(TRADE_BUY_COLOR);
    expect(ctx.textBaseline).toBe('middle');
  });
});

/* ------------------------------------------------------------------ *
 * ② 指标参数面板：默认折叠 + 切换 + 会话内记住
 * ------------------------------------------------------------------ */

describe('指标参数面板折叠', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  function renderPanel() {
    return render(
      <KlineParamPanel
        params={DEFAULT_INDICATOR_PARAMS}
        unit="日"
        barCount={120}
        onChange={() => undefined}
        onReset={() => undefined}
      />,
    );
  }

  it('默认折叠：字段不可见，但「当前生效」摘要仍可见', () => {
    renderPanel();

    const toggle = screen.getByTestId('kline-param-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('MA1 周期（日）：')).not.toBeInTheDocument();
    expect(screen.getByTestId('kline-param-summary')).toHaveTextContent('MA(5/10/20/60)');
    expect(screen.queryByTestId('kline-param-reset')).not.toBeInTheDocument();
  });

  it('点击头部展开 → 字段可见；再点收起；状态写入 sessionStorage', async () => {
    renderPanel();
    const toggle = screen.getByTestId('kline-param-toggle');

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('MA1 周期（日）：')).toBeInTheDocument();
    expect(sessionStorage.getItem('invest.kline.paramPanel.expanded')).toBe('1');

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('MA1 周期（日）：')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('invest.kline.paramPanel.expanded')).toBe('0');
  });

  it('展开后卸载再挂载 → 仍保持展开（同一次页面会话内记住）', async () => {
    const first = renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId('kline-param-toggle'));
    });
    expect(screen.getByLabelText('MA1 周期（日）：')).toBeInTheDocument();
    first.unmount();

    renderPanel();
    expect(screen.getByTestId('kline-param-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('MA1 周期（日）：')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * ③ 图表标题区：代码 + 名称
 * ------------------------------------------------------------------ */

describe('图表标题区（代码 + 名称）', () => {
  afterEach(() => {
    vi.doUnmock('../../src/components/KlineChart');
    vi.resetModules();
  });

  it('标的名称来自现有元数据接口，标题同时显示代码与名称', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/kline')) {
        return mockResponse({
          symbol: 'sh600000',
          fq: 'qfq',
          symbolClass: 'stock',
          klines: RAW_BARS,
          indicators: null,
          signals: [],
          trades: [],
        });
      }
      if (String(url).includes('/symbols/search')) {
        return mockResponse([{ symbol: 'sh600000', name: '浦发银行' }]);
      }
      return mockResponse([]);
    });

    // 图表替身：本用例只测页面标题区
    vi.doMock('../../src/components/KlineChart', () => ({
      default: () => <div data-testid="kline-chart-stub" />,
    }));
    vi.resetModules();

    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline?symbol=sh600000'] });

    await waitFor(() =>
      expect(screen.getByTestId('kline-symbol-title')).toHaveTextContent('sh600000 浦发银行'),
    );
    // 复用的是现有接口（不是新造数据源）
    expect(getMock.mock.calls.some(([url]) => String(url).includes('/symbols/search'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * ④ 全屏（Fullscreen API）
 * ------------------------------------------------------------------ */

describe('图表全屏切换', () => {
  let fullscreenElement: Element | null = null;
  const requestFullscreen = vi.fn();
  const exitFullscreen = vi.fn();

  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  beforeEach(() => {
    fullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });

    /** 模拟浏览器：设置当前全屏元素并派发 `fullscreenchange` */
    const applyFullscreen = (element: Element | null) => {
      fullscreenElement = element;
      document.dispatchEvent(new Event('fullscreenchange'));
    };

    requestFullscreen.mockReset();
    exitFullscreen.mockReset();
    requestFullscreen.mockImplementation(async function (this: Element) {
      // 把调用者（wrapper）作为全屏元素；`this` 只作为参数传递，避免 no-this-alias
      applyFullscreen(this);
    });
    exitFullscreen.mockImplementation(async () => {
      applyFullscreen(null);
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
  });

  it('点击「全屏」→ 调 requestFullscreen；再点「退出全屏」→ 调 exitFullscreen', async () => {
    render(
      <KlineChart
        symbol="sh600000"
        period="day"
        bars={buildChartBars(RAW_BARS, 'day', [], DEFAULT_INDICATOR_PARAMS)}
        dataSignature="sig"
        params={DEFAULT_INDICATOR_PARAMS}
        showMa
        showTrades={false}
        subIndicator="macd"
      />,
    );

    const button = screen.getByTestId('kline-fullscreen-toggle');
    expect(button).toHaveAttribute('aria-label', '全屏');

    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-label', '退出全屏'));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    // 全屏的目标就是图表根元素（hover 浮窗 / 按钮一起进全屏）
    expect(requestFullscreen.mock.instances[0]).toBe(screen.getByTestId('kline-chart-wrapper'));

    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-label', '全屏'));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('浏览器侧退出（Esc）→ `fullscreenchange` 把布局与按钮状态复原', async () => {
    render(
      <KlineChart
        symbol="sh600000"
        period="day"
        bars={buildChartBars(RAW_BARS, 'day', [], DEFAULT_INDICATOR_PARAMS)}
        dataSignature="sig"
        params={DEFAULT_INDICATOR_PARAMS}
        showMa
        showTrades={false}
        subIndicator="macd"
      />,
    );

    const wrapper = screen.getByTestId('kline-chart-wrapper');
    const container = screen.getByTestId('kline-chart-container');
    const button = screen.getByTestId('kline-fullscreen-toggle');

    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(container.style.height).toBe('100%'));

    // 模拟用户按 Esc：浏览器退出全屏后只会派发 `fullscreenchange`
    fullscreenElement = null;
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    expect(wrapper.style.height).toBe('');
    expect(button).toHaveAttribute('aria-label', '全屏');
    expect(container.style.height).toBe('560px');
    // 退出后必须重绘（尺寸复原）
    expect(exitFullscreen).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 浮层定位 + 全屏按钮可见性（2026-11-13）
 * ------------------------------------------------------------------ */

/**
 * ⚠️ jsdom 没有 layout engine ⇒ 这里只钉**结构契约**（DOM 嵌套关系）与**样式字面量**：
 *
 * - 浮层（hover 浮窗 / 交易明细 / 全屏按钮）必须挂在**图表区容器**内 ——
 *   图表区在「画线工具栏」**下方**，故浮层**永远不会盖住工具按钮**；
 * - 全屏按钮必须是「实心品牌色 + 粗体」（旧实现是半透明黑底 + 11px 灰字，压在深色画布上几乎不可见）。
 */
describe('浮层定位与全屏按钮可见性', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  function renderChart() {
    return render(
      <KlineChart
        symbol="sh600000"
        period="day"
        bars={buildChartBars(RAW_BARS, 'day', [], DEFAULT_INDICATOR_PARAMS)}
        dataSignature="sig"
        params={DEFAULT_INDICATOR_PARAMS}
        showMa
        showTrades={false}
        subIndicator="macd"
      />,
    );
  }

  it('画线工具栏在图表区**之外**，浮层（图标/浮窗）挂在图表区之内 ⇒ 不覆盖工具按钮', () => {
    renderChart();

    const toolbar = screen.getByTestId('kline-overlay-toolbar');
    const area = screen.getByTestId('kline-chart-area');
    const button = screen.getByTestId('kline-fullscreen-toggle');

    // 工具栏是图表区的**兄弟**（在它上面）
    expect(area.contains(toolbar)).toBe(false);
    // 图表容器在图表区之内
    expect(area.contains(screen.getByTestId('kline-chart-container'))).toBe(true);
    // 全屏按钮浮在画布上（不压工具栏）
    expect(area.contains(button)).toBe(true);
  });

  it('全屏按钮是「实心品牌色 + 粗体白字」（不再是半透明灰底小字）', () => {
    renderChart();

    const button = screen.getByTestId('kline-fullscreen-toggle');
    expect(button.style.background).not.toBe('');
    // 旧实现是 `rgba(0, 0, 0, 0.45)` 半透明底 ⇒ 断言现在**不是**半透明
    expect(button.style.background).not.toContain('rgba');
    expect(button.style.fontWeight).toBe('600');
    expect(button.style.fontSize).toBe(TYPO.smallSize);
  });
});
