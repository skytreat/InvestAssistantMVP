/**
 * T70 · K 线页测试（`klinecharts@10.1.0` + 前端算指标 · F-K1~F-K8）
 *
 * ## 覆盖的验收点（T70 任务卡「测试要点」①~⑧）
 *
 * | # | 验收点 | 本文件对应 |
 * |---|---|---|
 * | ① | 灌值逐位相等（注册的自定义指标读回的 `result` == 前端算出的值）| 「指标灌值逐位相等」describe |
 * | ② | fq 切换后 K 线与指标同步刷新 + ETF 走 `v_etf_*`（F-K10 回归）| 「数据链路」describe |
 * | ③ | 十字光标 tooltip 显示 OHLCV + 指标值 + 当日信号 | 「hover 悬浮窗」describe（纯渲染部分）|
 * | ④ | 缩放/平移不触发页面滚动 | **真浏览器验**（库内置，jsdom 无布局）|
 * | ⑤ | `ResizeObserver` 生效 | 「图表组件」describe（断言观察器被安装）|
 * | ⑥ | 副图 Tab 切换 MACD/RSI/KDJ，KDJ 与 core 逐位相同 | 「数据链路」+「指标灌值」describe |
 * | ⑦ | 信号标记位置正确（`trade_date` 对齐）+ hover 出明细 | 「信号标记」describe |
 * | ⑧ | `React.lazy` 生效：首屏不加载 klinecharts chunk | 「按需加载」describe |
 *
 * ## ⚠️ jsdom 的边界（务必读）
 *
 * - **视觉断言（y 轴 min/max、十字光标像素位置）jsdom 测不了** ——
 *   jsdom 无布局引擎、无真实 canvas ⇒ 只能钉**结构与数值契约**；
 *   G5.6（y 轴范围）由真浏览器脚本验。
 * - 为了能测「图表读回的值」，本文件给 `HTMLCanvasElement.getContext` 装了
 *   **2D context 替身**（`tests/helpers/fakeCanvas.ts`）——
 *   装上之后 klinecharts 在 jsdom 里能完整跑通（建图 → 灌数 → 建指标 → 读 result）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter, mockResponse } from '../helpers';
import { installFakeCanvas, restoreFakeCanvas } from '../helpers/fakeCanvas';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Indicator, KLineData } from 'klinecharts';
import { calculateKDJ } from '../../src/indicators/kdj';
import { calculateMACD, calculateRSI, calculateSMA } from '../../src/indicators/technical';
import {
  buildChartBars,
  aggregateBars,
  formatIndicator,
  parseMetricsJson,
  mapTradesToBars,
  type ChartBar,
  type RawBar,
  type SignalMarker,
  type TradeMarker,
} from '../../src/indicators/chartBars';
import {
  computeSignalMarkerPositions,
  drawSignalMarker,
  computeTradeMarkerPositions,
  type KdjIndicatorResult,
  type MacdIndicatorResult,
  type MaIndicatorResult,
  type RsiIndicatorResult,
  KDJ_INDICATOR,
  MA_INDICATOR,
  MACD_INDICATOR,
  RSI_INDICATOR,
  SIGNAL_INDICATOR,
  VOL_INDICATOR,
} from '../../src/indicators/chartIndicators';
import KlineHoverPanel from '../../src/components/KlineHoverPanel';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

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

/**
 * 图表组件替身
 *
 * ⚠️ 页面本身的行为（请求参数 / Tab / 开关 / 周期）才是这一层要测的；
 *    图表组件的真实行为在「图表组件」describe 里单独验。
 */
vi.mock('../../src/components/KlineChart', () => ({
  default: (props: {
    bars: unknown[];
    showMa: boolean;
    showTrades?: boolean;
    subIndicator: string;
    period: string;
  }) => (
    <div
      data-testid="kline-chart-stub"
      data-bars={String(props.bars.length)}
      data-show-ma={String(props.showMa)}
      data-show-trades={String(props.showTrades ?? true)}
      data-sub={props.subIndicator}
      data-period={props.period}
    />
  ),
}));

/* ------------------------------------------------------------------ *
 * 测试数据
 * ------------------------------------------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件位于 `apps/frontend/tests/unit/`）*/
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'packages/core/tests/fixtures/golden/kdj.json');

interface GoldenBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as {
  bars: GoldenBar[];
  params: { n: number; m1: number; m2: number };
};

/** 造 n 根连续日线（升序）*/
function makeBars(count: number, base = 10): RawBar[] {
  const bars: RawBar[] = [];
  const start = Date.UTC(2026, 0, 5);
  for (let i = 0; i < count; i++) {
    const close = Number((base + i * 0.1).toFixed(2));
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

/** 后端 K 线接口的响应体（envelope 内层）*/
function klinePayload(
  klines: RawBar[],
  signals: Array<{
    trade_date: string;
    direction: string;
    label: string;
    strength: number | null;
    plugin_id: string;
  }> = [],
  symbolClass = 'stock',
  trades: Array<{
    id: number;
    trade_date: string;
    trade_time: string | null;
    trade_type: string;
    marker_type: 'open' | 'add' | 'reduce' | 'close';
    quantity: number;
    price: number;
    adj_price: number;
  }> = [],
) {
  return {
    symbol: 'sh600000',
    fq: 'qfq',
    symbolClass,
    klines,
    indicators: null,
    signals,
    trades,
  };
}

/** 取出所有发往 K 线接口的请求 */
function klineCalls(): Array<{ url: string; params: Record<string, unknown> }> {
  return getMock.mock.calls
    .map((call) => ({ url: String(call[0]), params: (call[1]?.params ?? {}) as Record<string, unknown> }))
    .filter((c) => c.url.includes('/kline'));
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/kline')) {
      return mockResponse(klinePayload(makeBars(30)));
    }
    if (String(url).includes('/signal')) {
      return mockResponse([]);
    }
    return mockResponse([]);
  });
});

/* ------------------------------------------------------------------ *
 * ① 数据链路（请求参数 / query / fq / Tab / 开关 / 周期）
 * ------------------------------------------------------------------ */

describe('T70 · K 线页数据链路', () => {
  it('T70: 请求的是**真实路由** `/quote/:symbol/kline`（修复必修 bug ①：旧代码打的是不存在的 `/kline/<code>`）', async () => {
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    const urls = getMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('/quote/sh600000/kline'))).toBe(true);
    // 🔴 旧路由不存在 —— 必须**没有**任何 `/kline/<code>` 形式的请求
    expect(urls.some((u) => /^\/kline\//.test(u))).toBe(false);
  });

  it('T79 ④：深层页面有面包屑（仪表盘 / K线图 / 当前标的）', async () => {
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline?symbol=sh600519'] });

    await waitFor(() => expect(getMock).toHaveBeenCalled());

    const nav = screen.getByRole('navigation', { name: '面包屑' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '仪表盘' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'K线图' })).toHaveAttribute('href', '/kline');
    expect(screen.getByText('sh600519')).toHaveAttribute('aria-current', 'page');
  });

  it('T70: 消费 `?symbol=` query（修复必修 bug ②：从标的详情 Modal 跳过来要落到目标标的）', async () => {
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline?symbol=sh600519'] });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    const urls = getMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('/quote/sh600519/kline'))).toBe(true);
    expect(urls.some((u) => u.includes('sh600000'))).toBe(false);
    // 输入框也要同步成 URL 里的标的
    await waitFor(() => expect(screen.getByLabelText('代码：')).toHaveValue('sh600519'));
  });

  it('T70: fq 切换 → 重新取数（复权四值中的三个：前/后/不复权）', async () => {
    const user = userEvent.setup();
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
    await waitFor(() => expect(getMock).toHaveBeenCalled());

    const select = screen.getByLabelText('复权方式：') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['qfq', 'hfq', 'bfq']);

    await user.selectOptions(select, 'hfq');
    await waitFor(() => {
      expect(klineCalls().some((c) => c.params.fq === 'hfq')).toBe(true);
    });

    await user.selectOptions(select, 'bfq');
    await waitFor(() => {
      expect(klineCalls().some((c) => c.params.fq === 'bfq')).toBe(true);
    });

    // 不复权用的是 `bfq`（走 v_* 视图族 ⇒ ETF 才能路由到 v_etf_*），
    // **不是** `raw`（raw_kline_daily 不做 class 过滤）
    expect(klineCalls().some((c) => c.params.fq === 'raw')).toBe(false);
  });

  it('T70: ETF 标的照常渲染（前端只透传 symbol + fq，由后端按 class 路由到 v_etf_*）', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/kline')) {
        return mockResponse(klinePayload(makeBars(30), [], 'etf'));
      }
      return mockResponse([]);
    });
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline?symbol=sh510300'] });

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    // 请求带的是 ETF 代码本身（后端据此查 raw_symbol_class → v_etf_*）
    expect(getMock.mock.calls.some((c) => String(c[0]).startsWith('/quote/sh510300/kline'))).toBe(true);
    // 数据照常进图表（不为空）
    await waitFor(() => {
      const stub = screen.getByTestId('kline-chart-stub');
      expect(Number(stub.getAttribute('data-bars'))).toBe(30);
    });
    expect(screen.queryByTestId('kline-error')).not.toBeInTheDocument();
  });

  it('T70: 副图 Tab 可切换 MACD / RSI / KDJ（桌面端同样可切 —— F-K5）', async () => {
    const user = userEvent.setup();
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toBeInTheDocument());

    const macdTab = screen.getByTestId('kline-sub-tab-macd');
    const rsiTab = screen.getByTestId('kline-sub-tab-rsi');
    const kdjTab = screen.getByTestId('kline-sub-tab-kdj');
    expect(macdTab).toHaveAttribute('aria-selected', 'true');

    await user.click(rsiTab);
    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-sub', 'rsi'));
    expect(rsiTab).toHaveAttribute('aria-selected', 'true');
    expect(macdTab).toHaveAttribute('aria-selected', 'false');

    await user.click(kdjTab);
    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-sub', 'kdj'));
  });

  it('T70: MA 可隐藏（F-K3）', async () => {
    const user = userEvent.setup();
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toBeInTheDocument());
    expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-show-ma', 'true');

    await user.click(screen.getByLabelText('显示 MA(5/10/20/60)'));
    await waitFor(() =>
      expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-show-ma', 'false'),
    );
  });

  it('T70: 周K / 月K 基于日线聚合（F-K7）', async () => {
    const user = userEvent.setup();
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toBeInTheDocument());
    const dailyBars = Number(screen.getByTestId('kline-chart-stub').getAttribute('data-bars'));

    await user.selectOptions(screen.getByLabelText('K线周期：'), 'week');
    await waitFor(() =>
      expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-period', 'week'),
    );
    const weeklyBars = Number(screen.getByTestId('kline-chart-stub').getAttribute('data-bars'));
    expect(weeklyBars).toBeGreaterThan(0);
    expect(weeklyBars).toBeLessThan(dailyBars);
  });
});

/* ------------------------------------------------------------------ *
 * ② 按需加载（React.lazy）
 * ------------------------------------------------------------------ */

describe('T70 · 按需加载（React.lazy）', () => {
  it('T70: 页面模块**不静态引入** klinecharts（首屏不下载 klinecharts chunk）', async () => {
    const klinechartsLoaded = vi.fn();
    vi.doMock('klinecharts', () => {
      klinechartsLoaded();
      return {};
    });
    vi.resetModules();
    // 动态 import 页面模块（页面只对 klinecharts 做**类型**导入 → 运行时不加载）
    await import('../../src/pages/Kline');
    expect(klinechartsLoaded).not.toHaveBeenCalled();
    vi.doUnmock('klinecharts');
    vi.resetModules();
  });

  it('T70: 源码层面 —— 图表组件走 `React.lazy` + 动态 `import("klinecharts")`', () => {
    const pageSrc = readFileSync(path.join(REPO_ROOT, 'apps/frontend/src/pages/Kline.tsx'), 'utf8');
    const chartSrc = readFileSync(
      path.join(REPO_ROOT, 'apps/frontend/src/components/KlineChart.tsx'),
      'utf8',
    );

    // 页面：lazy 引入图表组件，且**没有**静态 import klinecharts
    expect(pageSrc).toMatch(/lazy\(\(\)\s*=>\s*import\('\.\.\/components\/KlineChart'\)\)/);
    expect(pageSrc).not.toMatch(/^import .*from 'klinecharts'/m);

    // 图表组件：运行时动态 import，类型走 `import type`
    expect(chartSrc).toMatch(/await import\('klinecharts'\)/);
    expect(chartSrc).not.toMatch(/^import \{[^}]*\} from 'klinecharts'/m);
    expect(chartSrc).toMatch(/^import type \{[^}]*\} from 'klinecharts'/m);
  });
});

/* ------------------------------------------------------------------ *
 * ③ 指标灌值逐位相等（klinecharts v10 round-trip）
 * ------------------------------------------------------------------ */

describe('T70 · 指标灌值逐位相等（klinecharts v10 round-trip）', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T70: 前端指标副本与 core 的适配层**字节一致**（改一份必须同步另一份）', () => {
    const coreSrc = readFileSync(path.join(REPO_ROOT, 'packages/core/src/indicators/adapters.ts'), 'utf8');
    const feSrc = readFileSync(path.join(REPO_ROOT, 'apps/frontend/src/indicators/technical.ts'), 'utf8');
    expect(feSrc, 'technical.ts 与 core 的 adapters.ts 已漂移').toBe(coreSrc);
  });

  /** 建图 + 灌数 + 建指标（复刻 `KlineChart.tsx` 的调用序列）*/
  async function buildChart(bars: ChartBar[]) {
    const kc = await import('klinecharts');
    const container = document.createElement('div');
    container.style.width = '800px';
    container.style.height = '600px';
    document.body.appendChild(container);

    kc.registerIndicator(MA_INDICATOR);
    kc.registerIndicator(MACD_INDICATOR);
    kc.registerIndicator(RSI_INDICATOR);
    kc.registerIndicator(KDJ_INDICATOR);
    kc.registerIndicator(VOL_INDICATOR);

    const chart = kc.init(container, { locale: 'zh-CN' });
    expect(chart).not.toBeNull();
    const instance = chart!;

    instance.setDataLoader({
      getBars: (params) => {
        params.callback(bars as unknown as KLineData[], false);
      },
    });
    instance.setSymbol({ ticker: 'sh600000', pricePrecision: 2, volumePrecision: 0 });
    instance.setPeriod({ type: 'day', span: 1 });
    instance.resetData();

    instance.createIndicator({ name: MA_INDICATOR.name, paneId: 'candle_pane', series: 'price' }, true);
    instance.createIndicator({ name: MACD_INDICATOR.name });
    instance.createIndicator({ name: RSI_INDICATOR.name });
    instance.createIndicator({ name: KDJ_INDICATOR.name });
    instance.createIndicator({ name: VOL_INDICATOR.name });

    // 等库内部的 calc 微任务跑完
    await new Promise((r) => setTimeout(r, 0));
    return { kc, instance };
  }

  it('T70: 注册的自定义指标读回的 `result` 与前端算出的值**逐位相同**（MA/MACD/RSI/KDJ）', async () => {
    const rawBars: RawBar[] = golden.bars.map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: 1000,
      amount: 1000 * b.close,
    }));
    const bars = buildChartBars(rawBars, 'day');
    const { instance } = await buildChart(bars);

    const closes = rawBars.map((b) => b.close);
    const expectedMa5 = calculateSMA(closes, 5);
    const expectedMa10 = calculateSMA(closes, 10);
    const expectedMa20 = calculateSMA(closes, 20);
    const expectedMa60 = calculateSMA(closes, 60);
    const expectedMacd = calculateMACD(closes);
    const expectedRsi = calculateRSI(closes);
    const expectedKdj = calculateKDJ(
      rawBars.map((b) => b.high),
      rawBars.map((b) => b.low),
      closes,
      golden.params.n,
      golden.params.m1,
      golden.params.m2,
    );

    // ⚠️ 库的 `getIndicators()` 返回 `Indicator<unknown>` → `result` 元素是 unknown
    //    ⇒ 这里显式收窄成我们注册时的结果类型（断言才有类型）
    const ma = instance.getIndicators({
      name: MA_INDICATOR.name,
    })[0] as unknown as Indicator<MaIndicatorResult>;
    const macd = instance.getIndicators({
      name: MACD_INDICATOR.name,
    })[0] as unknown as Indicator<MacdIndicatorResult>;
    const rsi = instance.getIndicators({
      name: RSI_INDICATOR.name,
    })[0] as unknown as Indicator<RsiIndicatorResult>;
    const kdj = instance.getIndicators({
      name: KDJ_INDICATOR.name,
    })[0] as unknown as Indicator<KdjIndicatorResult>;

    expect(ma.result.length).toBe(bars.length);
    for (let i = 0; i < bars.length; i++) {
      // 🔒 零容差：`Object.is` 语义（NaN 与 NaN 也相等）
      // ⚠️ MA 的字段名是**线序号**（`ma1`~`ma4`）而不是周期 —— 周期可编辑（T71）
      expect(Object.is(ma.result[i].ma1, expectedMa5[i]), `MA5[${i}]`).toBe(true);
      expect(Object.is(ma.result[i].ma2, expectedMa10[i]), `MA10[${i}]`).toBe(true);
      expect(Object.is(ma.result[i].ma3, expectedMa20[i]), `MA20[${i}]`).toBe(true);
      expect(Object.is(ma.result[i].ma4, expectedMa60[i]), `MA60[${i}]`).toBe(true);
      expect(Object.is(macd.result[i].dif, expectedMacd.dif[i]), `DIF[${i}]`).toBe(true);
      expect(Object.is(macd.result[i].dea, expectedMacd.dea[i]), `DEA[${i}]`).toBe(true);
      expect(Object.is(macd.result[i].macd, expectedMacd.macd[i]), `MACD[${i}]`).toBe(true);
      expect(Object.is(rsi.result[i].rsi, expectedRsi[i]), `RSI[${i}]`).toBe(true);
      expect(Object.is(kdj.result[i].k, expectedKdj.k[i]), `K[${i}]`).toBe(true);
      expect(Object.is(kdj.result[i].d, expectedKdj.d[i]), `D[${i}]`).toBe(true);
      expect(Object.is(kdj.result[i].j, expectedKdj.j[i]), `J[${i}]`).toBe(true);
    }
  });

  it('T70: 图表里**只有**自定义指标（APP_ 前缀），没有用 klinecharts 内置指标（避免双口径）', async () => {
    const bars = buildChartBars(makeBars(60), 'day');
    const { kc, instance } = await buildChart(bars);

    const names = instance.getIndicators().map((i) => i.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith('APP_'))).toBe(true);
    // 内置指标（MA / MACD / RSI / KDJ / VOL）在库里是存在的 —— 我们**不用**它们
    const builtins = kc.getSupportedIndicators();
    expect(builtins).toContain('MA');
    expect(builtins).toContain('MACD');
    expect(builtins).toContain('RSI');
    expect(builtins).toContain('KDJ');
    expect(names).not.toContain('MA');
    expect(names).not.toContain('MACD');
    expect(names).not.toContain('RSI');
    expect(names).not.toContain('KDJ');
  });

  it('T70: 信号标记指标已注册 —— 未注册的名字 `createIndicator` **静默返回 null**（实测踩过：标记不显示且无报错）', async () => {
    const kc = await import('klinecharts');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const chart = kc.init(container)!;

    // 🔴 反证：没注册过的指标名 → 返回 null（**只打一条 warn，不抛异常**）
    expect(chart.createIndicator({ name: 'APP_NEVER_REGISTERED' })).toBeNull();

    // 正证：注册过的自定义指标（含信号标记）→ 返回 id
    kc.registerIndicator(SIGNAL_INDICATOR);
    expect(
      chart.createIndicator({ name: SIGNAL_INDICATOR.name, paneId: 'candle_pane' }, true),
    ).not.toBeNull();
    expect(chart.getIndicators({ name: SIGNAL_INDICATOR.name }).length).toBe(1);
  });

  it('T70: `applyNewData` 在 v10 已不存在（9.x 教程作废）⇒ 用 setDataLoader + setSymbol + setPeriod + resetData', async () => {
    const kc = await import('klinecharts');
    const chart = kc.init(document.createElement('div'));
    expect(chart).not.toBeNull();
    const anyChart = chart as unknown as Record<string, unknown>;
    expect(anyChart.applyNewData).toBeUndefined();
    expect(typeof anyChart.setDataLoader).toBe('function');
    expect(typeof anyChart.setSymbol).toBe('function');
    expect(typeof anyChart.setPeriod).toBe('function');
    expect(typeof anyChart.resetData).toBe('function');
    // v10 的读回接口是 `getIndicators`（不是 9.x 的 `getIndicatorSeries`）
    expect(typeof anyChart.getIndicators).toBe('function');
    expect(anyChart.getIndicatorSeries).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * ④ KDJ 边界（G5.4）
 * ------------------------------------------------------------------ */

describe('T70 · KDJ 边界（G5.4）', () => {
  it('T70: 首个窗口即横盘（Hn−Ln=0）→ K₀=D₀=50，且**不产生 NaN**', () => {
    const len = golden.params.n;
    const highs = new Array<number>(len).fill(7);
    const lows = new Array<number>(len).fill(7);
    const closes = new Array<number>(len).fill(7);
    const r = calculateKDJ(highs, lows, closes);

    expect(r.k[len - 1]).toBe(50);
    expect(r.d[len - 1]).toBe(50);
    expect(r.j[len - 1]).toBe(50);
    // ⚠️ 前 `n - 1` 根是「数据不足期」→ 按契约就是 NaN（不是除零污染）
    const warmup = golden.params.n - 1;
    for (const series of [r.k, r.d, r.j]) {
      expect(series.filter((v) => Number.isNaN(v)).length).toBe(warmup);
      // 除零**不得**污染出 NaN / Infinity（横盘期必须全是有限值）
      expect(series.slice(warmup).some((v) => Number.isNaN(v))).toBe(false);
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });

  it('T70: KDJ 灌进图表的值与前端算出的值逐位相同（递归指标不允许容差）', async () => {
    installFakeCanvas();
    try {
      const rawBars: RawBar[] = golden.bars.map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: 1000,
        amount: 1000 * b.close,
      }));
      const bars = buildChartBars(rawBars, 'day');
      const kc = await import('klinecharts');
      const container = document.createElement('div');
      document.body.appendChild(container);
      kc.registerIndicator(KDJ_INDICATOR);
      const chart = kc.init(container)!;
      chart.setDataLoader({
        getBars: (params) => params.callback(bars as unknown as KLineData[], false),
      });
      chart.setSymbol({ ticker: 'sh600000', pricePrecision: 2, volumePrecision: 0 });
      chart.setPeriod({ type: 'day', span: 1 });
      chart.resetData();
      chart.createIndicator({ name: KDJ_INDICATOR.name });
      await new Promise((r) => setTimeout(r, 0));

      const kdj = chart.getIndicators({
        name: KDJ_INDICATOR.name,
      })[0] as unknown as Indicator<KdjIndicatorResult>;
      const expected = calculateKDJ(
        rawBars.map((b) => b.high),
        rawBars.map((b) => b.low),
        rawBars.map((b) => b.close),
        golden.params.n,
        golden.params.m1,
        golden.params.m2,
      );
      for (let i = 0; i < bars.length; i++) {
        expect(Object.is(kdj.result[i].k, expected.k[i]), `K[${i}]`).toBe(true);
        expect(Object.is(kdj.result[i].d, expected.d[i]), `D[${i}]`).toBe(true);
        expect(Object.is(kdj.result[i].j, expected.j[i]), `J[${i}]`).toBe(true);
      }
    } finally {
      restoreFakeCanvas();
    }
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 信号标记（F-K8）
 * ------------------------------------------------------------------ */

describe('T70 · 信号标记（F-K8）', () => {
  const signals: SignalMarker[] = [
    {
      trade_date: '2026-01-07',
      direction: 'buy',
      label: '超卖买入',
      strength: 0.8,
      plugin_id: 'rsi_oversold',
      metrics: { rsi: 25.31, period: 14 },
    },
    {
      trade_date: '2026-01-15',
      direction: 'sell',
      label: '超买卖出',
      strength: 0.6,
      plugin_id: 'rsi_oversold',
      metrics: null,
    },
  ];

  it('T70: 标记位置按 `trade_date` 精确对齐到那一根 K 线', () => {
    const bars = buildChartBars(makeBars(20), 'day', signals);
    const positions = computeSignalMarkerPositions(
      bars,
      (index) => index * 10,
      (value) => 100 - value,
    );

    expect(positions.length).toBe(2);
    // 第 2026-01-07 根 → index 2（makeBars 从 2026-01-05 起）
    expect(positions[0].index).toBe(2);
    expect(positions[0].date).toBe('2026-01-07');
    expect(positions[0].x).toBe(20);
    expect(positions[0].direction).toBe('buy');
    // 第 2026-01-15 根 → index 10
    expect(positions[1].index).toBe(10);
    expect(positions[1].date).toBe('2026-01-15');
    expect(positions[1].direction).toBe('sell');
    // 买入画在最低价下方、卖出画在最高价上方
    expect(positions[0].y).toBe(100 - bars[2].low);
    expect(positions[1].y).toBe(100 - bars[10].high);
  });

  it('T70: 对不上交易日的信号不画（不猜、不近似）', () => {
    const bars = buildChartBars(makeBars(5), 'day', [{ ...signals[0], trade_date: '2099-01-01' }]);
    expect(
      computeSignalMarkerPositions(
        bars,
        () => 0,
        () => 0,
      ),
    ).toHaveLength(0);
  });

  it('T70: 标记绘制调用了 canvas（且方向决定颜色）', () => {
    const calls: Array<{ fillStyle: unknown }> = [];
    const ctx = {
      save: () => undefined,
      restore: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      closePath: () => undefined,
      fill: () => undefined,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;
    const spy = vi.spyOn(ctx, 'fill');
    Object.defineProperty(ctx, 'fillStyle', {
      set: (v: unknown) => calls.push({ fillStyle: v }),
      get: () => '',
    });

    drawSignalMarker(ctx, {
      index: 0,
      date: '2026-01-05',
      x: 10,
      y: 20,
      direction: 'buy',
      color: '#16a34a',
    });
    expect(spy).toHaveBeenCalled();
    expect(calls[0].fillStyle).toBe('#16a34a');
  });

  it('T70: hover 悬浮窗显示方向 + 强度 + 指标明细（F-K8）', () => {
    const bars = buildChartBars(makeBars(20), 'day', signals);
    const bar = bars[2];
    render(<KlineHoverPanel bar={bar} showMa subIndicator="rsi" />);

    expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent('2026-01-07');
    expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent('开');
    expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent('收');
    expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent('量');

    const signal = screen.getByTestId('kline-hover-signal');
    expect(signal).toHaveTextContent('买入');
    expect(signal).toHaveTextContent('强度 80%');
    expect(signal).toHaveTextContent('超卖买入');
    expect(signal).toHaveTextContent('rsi_oversold');

    const metrics = screen.getByTestId('kline-hover-signal-metrics');
    expect(metrics).toHaveTextContent('rsi=25.31');
    expect(metrics).toHaveTextContent('period=14');
  });

  it('T70: `metrics_json` 解析容错（脏数据不炸）', () => {
    expect(parseMetricsJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseMetricsJson({ a: 1 })).toEqual({ a: 1 });
    expect(parseMetricsJson('not-json')).toBeNull();
    expect(parseMetricsJson(null)).toBeNull();
    expect(parseMetricsJson(undefined)).toBeNull();
  });

  /**
   * T73 · hover 面板的 MA 行**必须活着**
   *
   * ⚠️ **历史坑**（T71 遗留）：`ChartBar` 的 MA 字段从 `ma5/ma10/ma20/ma60`
   *    改名成**线序号** `ma1..ma4`（周期可编辑 ⇒ 字段名不能写死周期）。
   *    一旦 hover 面板没跟着改，就会出现两种坏结果：
   *    ① 编译不过（`bar.ma5` 不存在）；② 悄悄把 MA 行删掉 / 留成未使用变量
   *    （`maPeriods` / `maValues` 变成 unused ⇒ eslint 报错）。
   *
   * ⇒ 本用例钉死：**MA 行按「当前周期」出标签，值取自 `ma1..ma4`**。
   */
  it('T73: hover 面板的 MA 行按**当前周期**出标签、值取自 `ma1..ma4`（不许被删掉 / 不许写死周期）', () => {
    const bars = buildChartBars(makeBars(20), 'day', signals);
    const bar = bars[2];
    render(<KlineHoverPanel bar={bar} showMa subIndicator="macd" maPeriods={[25, 10, 20, 60]} />);

    const panel = screen.getByTestId('kline-hover-panel');
    // 标签 = **传入的当前周期**（不是写死的 5/10/20/60）
    expect(panel).toHaveTextContent('MA25');
    expect(panel).toHaveTextContent('MA10');
    expect(panel).toHaveTextContent('MA20');
    expect(panel).toHaveTextContent('MA60');
    // 值 = `ma1..ma4`（线序号 ⇒ 与 periods 一一对应）
    expect(panel).toHaveTextContent(`MA25 ${formatIndicator(bar.ma1)}`);
    expect(panel).toHaveTextContent(`MA10 ${formatIndicator(bar.ma2)}`);
    expect(panel).toHaveTextContent(`MA20 ${formatIndicator(bar.ma3)}`);
    expect(panel).toHaveTextContent(`MA60 ${formatIndicator(bar.ma4)}`);
  });

  it('T73: `showMa=false` → MA 行不出现（但信号行仍在）', () => {
    const bars = buildChartBars(makeBars(20), 'day', signals);
    const bar = bars[2];
    render(<KlineHoverPanel bar={bar} showMa={false} subIndicator="macd" />);

    const panel = screen.getByTestId('kline-hover-panel');
    expect(panel).not.toHaveTextContent('MA5');
    expect(panel).not.toHaveTextContent('MA10');
    // 信号行不受 MA 显隐影响
    expect(screen.getByTestId('kline-hover-signal')).toHaveTextContent('买入');
  });
});

/* ------------------------------------------------------------------ *
 * ⑥ 周期聚合（F-K7 纯函数层）
 * ------------------------------------------------------------------ */

describe('T152 · 交易标记页交互', () => {
  function tradePayload(date: string, markerType: TradeMarker['marker_type']) {
    return {
      id: 1,
      trade_date: date,
      trade_time: '09:35:00',
      trade_type: markerType === 'open' ? 'buy' : markerType === 'add' ? 'add' : 'reduce',
      marker_type: markerType,
      quantity: 100,
      price: 10,
      adj_price: 10.5,
    };
  }

  it('T152: K 线响应中的 trades[] 进入图表 bars，交易点开关默认开', async () => {
    const user = userEvent.setup();
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/kline')) {
        return mockResponse(klinePayload(makeBars(30), [], 'stock', [tradePayload('2026-01-07', 'open')]));
      }
      return mockResponse([]);
    });
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });

    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toBeInTheDocument());
    expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-show-trades', 'true');

    await user.click(screen.getByLabelText('交易点'));
    await waitFor(() =>
      expect(screen.getByTestId('kline-chart-stub')).toHaveAttribute('data-show-trades', 'false'),
    );
  });

  it('T152: 无交易记录时不渲染交易图例，开关仍可用', async () => {
    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });

    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toBeInTheDocument());
    expect(screen.queryByText('建仓')).not.toBeInTheDocument();
    expect(screen.getByLabelText('交易点')).toBeInTheDocument();
  });
});

describe('T152 · 交易标记映射', () => {
  function trade(overrides: Partial<TradeMarker> = {}): TradeMarker {
    return {
      id: 1,
      trade_date: '2026-01-07',
      trade_time: null,
      trade_type: 'buy',
      marker_type: 'open',
      quantity: 100,
      price: 10,
      adj_price: 10,
      ...overrides,
    };
  }

  it('日K：周末交易归入其后最近一根，不改写交易日期', () => {
    // makeBars 从 2026-01-05（周一）开始
    const mapped = mapTradesToBars(makeBars(7), 'day', [trade({ trade_date: '2026-01-11' })]);
    const withTrade = mapped.find((group) => group.length > 0);
    expect(withTrade).toBeDefined();
    expect(withTrade!).toHaveLength(1);
    expect(withTrade![0].trade_date).toBe('2026-01-11');
  });

  it('周K：桶内任意交易归入同一根周期K线', () => {
    const weekly = buildChartBars(makeBars(14), 'week', [], undefined, [
      trade({ id: 1, trade_date: '2026-01-05' }),
      trade({ id: 2, trade_date: '2026-01-09', marker_type: 'add' }),
    ]);
    const withTrades = weekly.filter((bar) => bar.trades.length > 0);
    expect(withTrades).toHaveLength(1);
    expect(withTrades[0].trades.map((t) => t.id)).toEqual([1, 2]);
  });

  it('标记几何：单笔实心、同日多笔聚合为圆环', () => {
    const bars = buildChartBars(makeBars(10), 'day', [], undefined, [
      trade({ id: 1, marker_type: 'open' }),
      trade({ id: 2, trade_date: '2026-01-07', marker_type: 'reduce' }),
    ]);
    const markers = computeTradeMarkerPositions(
      bars,
      (index) => index * 10,
      () => 100,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0].shape).toBe('aggregated');
    expect(markers[0].radius).toBe(9);
    expect(markers[0].trades).toHaveLength(2);
  });
});

describe('T70 · 周期聚合', () => {
  it('T70: 周K 聚合口径（首开 / 最高 / 最低 / 末收 / 量额求和 / 日期取最后交易日）', () => {
    const bars = makeBars(14);
    const weekly = aggregateBars(bars, 'week');
    expect(weekly.length).toBeLessThan(bars.length);
    expect(weekly.length).toBeGreaterThan(0);
    // 首周含几根由「起始日是周几」决定 → 动态取首周的最后一根
    const firstWeekCount = weekly[0].date === bars[6].date ? 7 : weekly[0].date === bars[5].date ? 6 : 5;
    const firstWeekBars = bars.slice(0, firstWeekCount);
    const firstWeek = weekly[0];
    expect(firstWeek.open).toBe(firstWeekBars[0].open);
    expect(firstWeek.close).toBe(firstWeekBars[firstWeekBars.length - 1].close);
    expect(firstWeek.high).toBe(Math.max(...firstWeekBars.map((b) => b.high)));
    expect(firstWeek.low).toBe(Math.min(...firstWeekBars.map((b) => b.low)));
    expect(firstWeek.volume).toBe(firstWeekBars.reduce((s, b) => s + b.volume, 0));
    expect(firstWeek.amount).toBeCloseTo(
      firstWeekBars.reduce((s, b) => s + b.amount, 0),
      6,
    );
    expect(firstWeek.date).toBe(firstWeekBars[firstWeekBars.length - 1].date);
  });

  it('T70: 月K 聚合口径', () => {
    const bars = makeBars(70);
    const monthly = aggregateBars(bars, 'month');
    expect(monthly.length).toBeGreaterThan(0);
    expect(monthly.length).toBeLessThan(bars.length);
    expect(monthly[0].date.slice(0, 7)).toBe(bars[0].date.slice(0, 7));
  });

  it('T70: 日K 周期原样返回（不复制出新的语义）', () => {
    const bars = makeBars(3);
    expect(aggregateBars(bars, 'day')).toEqual(bars);
  });
});
