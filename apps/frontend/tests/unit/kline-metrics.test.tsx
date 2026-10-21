/**
 * T73 · K 线页切到「K 线路由下发 `metrics_json`」（省一次网络往返）
 *
 * ## 覆盖的验收点
 *
 * | # | 验收点 | 本文件对应 |
 * |---|---|---|
 * | ① | K 线页**只发一次**请求（**不再有** `/api/signal?asset_code=` 补取）| 「单次请求」describe |
 * | ② | hover 面板在**有 `metrics_json`** 时显示指标明细（F-K8）| 「metrics 明细」describe |
 * | ③ | hover 面板在 `metrics_json` 为 `null` 时**降级**（不报错、不显示空明细）| 同上 |
 * | ④ | hover 面板的**数据来源**是「最新 bars」而非图表内部数据列表（T71 滞后问题核对）| 「数据来源」describe |
 *
 * ## ⚠️ 为什么这里要 mock `klinecharts`
 *
 * jsdom 里**触发不了**库的十字光标（库只在自己处理鼠标事件时派发 `onCrosshairChange`，
 * 而 jsdom 无布局 ⇒ 像素坐标算不出 `dataIndex`）。
 *
 * ⇒ 本文件把 `klinecharts` 换成**假图表**：
 * - `subscribeAction('onCrosshairChange', cb)` → 把回调存起来，测试里**手动触发**；
 * - `convertFromPixel(...)` → 固定返回测试指定的下标；
 * - `getDataList()` → 返回**图表内部那份**（可用于复现 T71 的「数据列表滞后」）。
 *
 * 这样才能在单测里**真的**驱动 `KlineChart` 的 hover 逻辑（而不是绕过组件）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithRouter, mockResponse } from '../helpers';
import { calculateSMA } from '../../src/indicators/technical';
import type { RawBar } from '../../src/indicators/chartBars';

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

/* ------------------------------------------------------------------ *
 * klinecharts mock（假图表 —— 见文件头说明）
 * ------------------------------------------------------------------ */

/** 假图表的最小接口（只列 `KlineChart.tsx` 真正用到的方法）*/
interface FakeChart {
  setDataLoader: (loader: {
    getBars: (params: { type: string; callback: (data: unknown[]) => void }) => void;
  }) => void;
  setSymbol: (symbol: unknown) => void;
  setPeriod: (period: unknown) => void;
  resetData: () => void;
  getDataList: () => unknown[];
  getIndicators: (filter: { name: string }) => unknown[];
  createIndicator: (template: unknown, isOverride?: boolean) => string;
  removeIndicator: (template: unknown) => void;
  overrideIndicator: (template: unknown) => void;
  subscribeAction: (type: string, callback: (data: unknown) => void) => void;
  convertFromPixel: (points: unknown[], options: unknown) => Array<{ dataIndex?: number }>;
  setPaneOptions: (options: unknown) => void;
  resize: () => void;
  dispose: () => void;
}

/** 假图表的共享状态（测试用来驱动 hover、观察数据列表）*/
interface ChartState {
  chart: FakeChart | null;
  /** `onCrosshairChange` 的订阅回调（测试手动触发）*/
  crosshair: ((data: unknown) => void) | null;
  /** 图表内部数据列表（`getDataList()` 的返回值）*/
  dataList: unknown[];
  /** `convertFromPixel` 固定返回的下标*/
  hoverIndex: number;
  /** `resetData` 被调用的次数（= 图表重新取数的次数）*/
  resetCount: number;
}

const { chartState } = vi.hoisted(() => ({
  chartState: {
    chart: null,
    crosshair: null,
    dataList: [],
    hoverIndex: 100,
    resetCount: 0,
  } as unknown as ChartState,
}));

vi.mock('klinecharts', () => {
  const makeChart = () => {
    let loader: {
      getBars: (params: { type: string; callback: (data: unknown[]) => void }) => void;
    } | null = null;

    const chart: FakeChart = {
      setDataLoader: (l) => {
        loader = l;
      },
      setSymbol: () => undefined,
      setPeriod: () => undefined,
      resetData: () => {
        chartState.resetCount += 1;
        if (!loader) return;
        loader.getBars({
          type: 'init',
          callback: (data: unknown[]) => {
            chartState.dataList = data;
          },
        });
      },
      // ⚠️ 返回**图表内部那份**（T71：改参数时它不刷新 ⇒ 挂的是旧指标字段）
      getDataList: () => chartState.dataList,
      getIndicators: () => [],
      createIndicator: () => 'fake_indicator_id',
      removeIndicator: () => undefined,
      overrideIndicator: () => undefined,
      subscribeAction: (type, callback) => {
        if (type === 'onCrosshairChange') chartState.crosshair = callback;
      },
      convertFromPixel: () => [{ dataIndex: chartState.hoverIndex }],
      setPaneOptions: () => undefined,
      resize: () => undefined,
      dispose: () => undefined,
    };
    return chart;
  };

  return {
    registerIndicator: () => undefined,
    init: () => {
      chartState.chart = makeChart();
      chartState.crosshair = null;
      chartState.dataList = [];
      chartState.resetCount = 0;
      return chartState.chart;
    },
    dispose: () => undefined,
    getSupportedIndicators: () => [],
  };
});

/* ------------------------------------------------------------------ *
 * 测试数据
 * ------------------------------------------------------------------ */

/** 造 n 根连续日线（升序）*/
function makeBars(count: number, base = 10): RawBar[] {
  const bars: RawBar[] = [];
  const start = Date.UTC(2026, 0, 5);
  for (let i = 0; i < count; i++) {
    const close = Number((base + Math.sin(i / 7) * 1.5 + i * 0.05).toFixed(2));
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

const RAW_BARS = makeBars(120);
const CLOSES = RAW_BARS.map((b) => b.close);
/** hover 的下标（选一个四条 MA 都已「预热完成」的位置）*/
const HOVER_INDEX = 100;
/** 该下标对应的交易日*/
const HOVER_DATE = RAW_BARS[HOVER_INDEX].date;

/** K 线接口的响应体（envelope 内层）—— `signals[]` 带 `metrics_json`（原始 JSON 字符串 | null）*/
function klinePayload(metricsJson: string | null) {
  return {
    symbol: 'sh600000',
    fq: 'qfq',
    symbolClass: 'stock',
    klines: RAW_BARS,
    indicators: null,
    signals: [
      {
        trade_date: HOVER_DATE,
        direction: 'buy',
        label: '超卖买入',
        strength: 0.8,
        plugin_id: 'rsi_oversold',
        metrics_json: metricsJson,
      },
    ],
  };
}

beforeEach(() => {
  getMock.mockReset();
  chartState.chart = null;
  chartState.crosshair = null;
  chartState.dataList = [];
  chartState.hoverIndex = HOVER_INDEX;
  chartState.resetCount = 0;
  getMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/kline')) {
      return mockResponse(klinePayload('{"rsi":25.31,"period":14}'));
    }
    // ⚠️ 其它任何请求都是**多余的**（本页只该发一次 K 线请求）⇒ 直接抛错让用例立刻炸
    throw new Error(`K 线页不应请求该接口: ${String(url)}`);
  });
});

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 渲染 K 线页并等图表就绪*/
async function renderKline(): Promise<void> {
  const { default: Kline } = await import('../../src/pages/Kline');
  renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
  await waitFor(() => expect(chartState.chart).not.toBeNull());
}

/** 触发十字光标（假图表把回调存在 `chartState.crosshair`）*/
async function hover(): Promise<void> {
  await act(async () => {
    chartState.crosshair?.({ x: 120 });
  });
}

/** 所有发出去的请求 URL*/
function requestUrls(): string[] {
  return getMock.mock.calls.map((c) => String(c[0]));
}

/* ------------------------------------------------------------------ *
 * ① 单次请求
 * ------------------------------------------------------------------ */

describe('T73 · K 线页只发一次请求（不再补取 /api/signal）', () => {
  it('T73: `api.get` **只被调用 1 次**（硬断言调用次数）', async () => {
    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('T73: 请求 URL 集合**恰好**是 K 线接口（**没有** `/api/signal?asset_code=` 补取）', async () => {
    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    const urls = requestUrls();
    expect(urls).toEqual(['/quote/sh600000/kline']);
    // 🔴 旧实现的补取请求（硬断言 URL 形态）
    expect(urls.some((u) => u.startsWith('/signal'))).toBe(false);
    expect(urls.some((u) => u.includes('asset_code'))).toBe(false);
    expect(urls.some((u) => u.includes('page_size'))).toBe(false);
  });

  it('T73: 补取请求的**参数**（`asset_code` / `page_size`）也不再出现', async () => {
    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    const params = getMock.mock.calls.map((c) => (c[1]?.params ?? {}) as Record<string, unknown>);
    expect(params).toHaveLength(1);
    expect(params[0].days).toBe(120);
    expect(params[0].fq).toBe('qfq');
    expect(params[0].asset_code).toBeUndefined();
    expect(params[0].page_size).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * ②③ metrics 明细：有 / 无
 * ------------------------------------------------------------------ */

describe('T73 · 信号指标明细（metrics_json）随 K 线下发', () => {
  it('T73: `metrics_json` 有值 → hover 面板显示指标明细（F-K8）', async () => {
    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    await hover();

    const panel = screen.getByTestId('kline-hover-panel');
    expect(panel).toHaveTextContent(HOVER_DATE);

    const signal = screen.getByTestId('kline-hover-signal');
    expect(signal).toHaveTextContent('买入');
    expect(signal).toHaveTextContent('强度 80%');
    expect(signal).toHaveTextContent('超卖买入');
    expect(signal).toHaveTextContent('rsi_oversold');

    // 🔴 指标明细（来自 K 线路由下发的 `metrics_json`）
    const metrics = screen.getByTestId('kline-hover-signal-metrics');
    expect(metrics).toHaveTextContent('rsi=25.31');
    expect(metrics).toHaveTextContent('period=14');
  });

  it('T73: `metrics_json` 为 **null** → 降级（信号行仍在，明细行**不出现**，不报错）', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/kline')) {
        return mockResponse(klinePayload(null));
      }
      throw new Error(`K 线页不应请求该接口: ${String(url)}`);
    });

    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    await hover();

    // 信号行照常显示（方向 / 强度 / 标签 / 插件 id）
    const signal = screen.getByTestId('kline-hover-signal');
    expect(signal).toHaveTextContent('买入');
    expect(signal).toHaveTextContent('强度 80%');
    expect(signal).toHaveTextContent('rsi_oversold');

    // ⚠️ 明细行**不出现**（而不是出现一个空的「指标 」行）
    expect(screen.queryByTestId('kline-hover-signal-metrics')).not.toBeInTheDocument();
    // 页面也没报错
    expect(screen.queryByTestId('kline-error')).not.toBeInTheDocument();
  });

  it('T73: `metrics_json` 是**脏 JSON 字符串** → 降级为无明细（不炸整页）', async () => {
    getMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/kline')) {
        return mockResponse(klinePayload('{not-json'));
      }
      throw new Error(`K 线页不应请求该接口: ${String(url)}`);
    });

    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    await hover();

    expect(screen.getByTestId('kline-hover-signal')).toHaveTextContent('买入');
    expect(screen.queryByTestId('kline-hover-signal-metrics')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kline-error')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * ④ hover 面板的数据来源（核对 T71 的「数据列表滞后」）
 * ------------------------------------------------------------------ */

describe('T73 · hover 面板的数据来源（核对 T71 滞后问题）', () => {
  it('T73: hover 面板读的是**最新 bars**（不是图表内部数据列表）⇒ 改参数后 tooltip 显示**新值**', async () => {
    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    await hover();
    const panel = screen.getByTestId('kline-hover-panel');
    expect(panel).toHaveTextContent('MA5');
    expect(panel).toHaveTextContent(`MA5 ${calculateSMA(CLOSES, 5)[HOVER_INDEX].toFixed(2)}`);

    // 改 MA1 周期（改参数 ⇒ 前端重算 bars ⇒ 零网络请求）
    const input = screen.getByLabelText('MA1 周期（日）：') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '25');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 🔴 图表内部数据列表**没有**刷新（T71 的已知滞后）⇒ 证明两者确实是不同的来源
    const staleMa1 = (chartState.dataList[HOVER_INDEX] as { ma1: number }).ma1;
    expect(staleMa1).toBe(calculateSMA(CLOSES, 5)[HOVER_INDEX]);

    // 但 hover 面板显示的是**新值**（说明它读的是页面最新算出的 bars）
    await waitFor(() => {
      expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent(
        `MA25 ${calculateSMA(CLOSES, 25)[HOVER_INDEX].toFixed(2)}`,
      );
    });
    expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent('MA25');
    expect(screen.getByTestId('kline-hover-panel')).not.toHaveTextContent('MA5 ');
  });

  it('T73: 改参数**不发任何请求**（T71 的零网络请求保证不受本次改动影响）', async () => {
    await renderKline();
    await waitFor(() => expect(chartState.dataList.length).toBe(RAW_BARS.length));

    const before = getMock.mock.calls.length;
    expect(before).toBe(1);

    await hover();

    const input = screen.getByLabelText('MA1 周期（日）：') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '25');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await waitFor(() => expect(screen.getByTestId('kline-hover-panel')).toHaveTextContent('MA25'));
    expect(getMock.mock.calls.length).toBe(before);
  });
});
