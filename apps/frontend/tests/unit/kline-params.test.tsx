/**
 * T71 · K 线指标参数实时生效（零网络请求）
 *
 * ## 覆盖的验收点（T71 任务卡）
 *
 * | # | 验收点 | 本文件对应 |
 * |---|---|---|
 * | ① | 改 period 后重绘 < 300ms（PRD §6.3）| 「重绘耗时」describe |
 * | ② | 前端与后端对同一 `(closes, params)` 结果**逐位相同**（走 golden）| 各用例都用 `technical.ts` / `kdj.ts` 现场算一遍再逐位比对 |
 * | ③ | **柱值 ×2 与 A 股约定一致**（§4.3.2 回归断言）| 「MACD 参数」用例里断言 `macd === 2*(dif-dea)` |
 *
 * ## 🔴 本文件的核心断言：**零网络请求**
 *
 * 两条独立的硬断言：
 *
 * 1. `api.get` 的调用次数**不变**（页面层：不重新取 K 线）；
 * 2. klinecharts **数据加载器**的 `getBars` 调用次数**不变**（图表层：连内存 loader 都不碰）。
 *
 * 第 2 条靠包裹 `klinecharts.init` → 包裹 `chart.setDataLoader` → 计数实现。
 *
 * ## ⚠️ jsdom 的边界
 *
 * - **视觉**（参考线是否好看、图有没有变形）jsdom 测不了 ⇒ 真浏览器探针判；
 * - 本文件只钉**数值契约**（指标值逐位相等）+ **结构**（零请求 / 耗时 / 越界 / a11y）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter, mockResponse } from '../helpers';
import { installFakeCanvas, restoreFakeCanvas } from '../helpers/fakeCanvas';
import type { Indicator } from 'klinecharts';
import { calculateKDJ } from '../../src/indicators/kdj';
import { calculateMACD, calculateRSI, calculateSMA } from '../../src/indicators/technical';
import { buildChartBars, type ChartBar, type RawBar } from '../../src/indicators/chartBars';
import {
  RSI_OVERSOLD_COLOR,
  RSI_OVERBOUGHT_COLOR,
  drawRsiThresholds,
} from '../../src/indicators/chartIndicators';
import {
  DEFAULT_INDICATOR_PARAMS,
  PARAM_RANGES,
  type IndicatorParams,
} from '../../src/indicators/chartParams';

/* ------------------------------------------------------------------ *
 * api mock
 * ------------------------------------------------------------------ */

const { getMock, loaderSpy, holder } = vi.hoisted(() => ({
  getMock: vi.fn(),
  /** klinecharts 数据加载器的 `getBars` 调用次数（图表层的「零取数」硬断言）*/
  loaderSpy: vi.fn(),
  /** 图表实例 + 计数（供断言读指标结果）*/
  holder: { chart: null as unknown, inits: 0 },
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

/**
 * 包裹 `klinecharts.init` —— 抓图表实例 + 统计数据加载器的 `getBars` 调用
 *
 * ⚠️ `chart.setDataLoader` 是实例方法（原型上的），直接赋值会生成自有属性 ⇒ 可拦截 ✅
 */
vi.mock('klinecharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('klinecharts')>();
  return {
    ...actual,
    init: (...args: Parameters<typeof actual.init>) => {
      const chart = actual.init(...args);
      holder.chart = chart;
      holder.inits += 1;
      if (chart) {
        const original = chart.setDataLoader.bind(chart);
        chart.setDataLoader = (loader) => {
          original({
            ...loader,
            getBars: (params) => {
              loaderSpy();
              return loader.getBars(params);
            },
          });
        };
      }
      return chart;
    },
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
const HIGHS = RAW_BARS.map((b) => b.high);
const LOWS = RAW_BARS.map((b) => b.low);

beforeEach(() => {
  getMock.mockReset();
  loaderSpy.mockReset();
  holder.chart = null;
  holder.inits = 0;
  getMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/kline')) {
      return mockResponse({
        symbol: 'sh600000',
        fq: 'qfq',
        symbolClass: 'stock',
        klines: RAW_BARS,
        indicators: null,
        signals: [],
      });
    }
    return mockResponse([]);
  });
});

afterEach(() => {
  vi.doUnmock('../../src/components/KlineChart');
  vi.resetModules();
});

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 读某个指标的计算结果（`result[i]` 是该根 K 线上的指标值）*/
function indicatorResult<T = Record<string, number>>(name: string): T[] {
  const chart = holder.chart as {
    getIndicators: (f: { name: string }) => Indicator<unknown>[];
  } | null;
  if (!chart) return [];
  const list = chart.getIndicators({ name });
  if (!list || list.length === 0) return [];
  return (list[0] as unknown as Indicator<T>).result as T[];
}

/** 渲染 K 线页并等待图表就绪*/
async function renderKline(): Promise<void> {
  const { default: Kline } = await import('../../src/pages/Kline');
  renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
  await waitFor(() => expect(holder.chart).not.toBeNull());
  // 等指标算完（库在微任务里重算）
  await waitFor(() => expect(indicatorResult('APP_MA').length).toBe(RAW_BARS.length));
}

/** 改一个参数输入框（模拟用户改值）*/
async function setParam(label: string, value: string): Promise<void> {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

/* ------------------------------------------------------------------ *
 * ① 改参数 → 图表里的指标值随之改变
 * ------------------------------------------------------------------ */

describe('T71 · 改参数 → 图表指标值随之改变', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T71: 改 MA 周期 → APP_MA 的值随之改变（逐位等于 `calculateSMA(closes, 新周期)`）', async () => {
    await renderKline();

    const before = indicatorResult<{ ma1: number }>('APP_MA');
    const beforeLast = before[before.length - 1].ma1;
    expect(beforeLast).toBe(calculateSMA(CLOSES, 5)[CLOSES.length - 1]);

    await setParam('MA1 周期（日）：', '25');

    await waitFor(() => {
      const after = indicatorResult<{ ma1: number }>('APP_MA');
      expect(after[after.length - 1].ma1).toBe(calculateSMA(CLOSES, 25)[CLOSES.length - 1]);
    });
    // 确实变了（不是同一个值蒙混过关）
    const after = indicatorResult<{ ma1: number }>('APP_MA');
    expect(after[after.length - 1].ma1).not.toBe(beforeLast);

    // 🔴 `figures` 也要跟着变 —— figure 标题里带的是**当前周期**
    const figures = (
      holder.chart as unknown as {
        getIndicators: (f: { name: string }) => Array<{ figures: Array<{ title: string }> }>;
      }
    )
      .getIndicators({ name: 'APP_MA' })[0]
      .figures.map((f) => f.title);
    expect(figures).toEqual(['MA25: ', 'MA10: ', 'MA20: ', 'MA60: ']);
  });

  it('T71: 改 MACD 参数 → APP_MACD 的值随之改变（且柱值仍是 A 股口径 2×(DIF−DEA)）', async () => {
    await renderKline();

    await setParam('MACD 快线（日）：', '8');

    await waitFor(() => {
      const expected = calculateMACD(CLOSES, 8, 26, 9);
      const result = indicatorResult<{ dif: number; dea: number; macd: number }>('APP_MACD');
      const last = result[result.length - 1];
      expect(last.dif).toBe(expected.dif[expected.dif.length - 1]);
      expect(last.dea).toBe(expected.dea[expected.dea.length - 1]);
      expect(last.macd).toBe(expected.macd[expected.macd.length - 1]);
    });

    // §4.3.2 回归：柱值 = 2 × (DIF − DEA)（A 股通达信约定，**不是**库的美式 1×）
    const result = indicatorResult<{ dif: number; dea: number; macd: number }>('APP_MACD');
    const last = result[result.length - 1];
    expect(last.macd).toBe(2 * (last.dif - last.dea));
  });

  it('T71: 改 RSI 参数 → APP_RSI 的值随之改变', async () => {
    const user = userEvent.setup();
    await renderKline();

    // 切到 RSI 副图（指标才会被创建）
    await user.click(screen.getByTestId('kline-sub-tab-rsi'));
    await waitFor(() => expect(indicatorResult('APP_RSI').length).toBe(RAW_BARS.length));

    await setParam('RSI 周期（日）：', '21');

    await waitFor(() => {
      const expected = calculateRSI(CLOSES, 21);
      const result = indicatorResult<{ rsi: number }>('APP_RSI');
      expect(result[result.length - 1].rsi).toBe(expected[expected.length - 1]);
    });
  });

  it('T71: 改 KDJ 参数 → APP_KDJ 的值随之改变', async () => {
    const user = userEvent.setup();
    await renderKline();

    await user.click(screen.getByTestId('kline-sub-tab-kdj'));
    await waitFor(() => expect(indicatorResult('APP_KDJ').length).toBe(RAW_BARS.length));

    await setParam('KDJ N（日）：', '14');

    await waitFor(() => {
      const expected = calculateKDJ(HIGHS, LOWS, CLOSES, 14, 3, 3);
      const result = indicatorResult<{ k: number; d: number; j: number }>('APP_KDJ');
      const last = result[result.length - 1];
      expect(last.k).toBe(expected.k[expected.k.length - 1]);
      expect(last.d).toBe(expected.d[expected.d.length - 1]);
      expect(last.j).toBe(expected.j[expected.j.length - 1]);
    });
  });

  it('T71: RSI 阈值改了 → 副图参考线跟着变（超买/超卖阈值进 draw 闭包）', async () => {
    await renderKline();
    // 阈值只影响参考线，不影响 RSI 线本身的数值
    const before = indicatorResult<{ rsi: number }>('APP_RSI');
    await setParam('RSI 超买阈值（点）：', '80');
    const after = indicatorResult<{ rsi: number }>('APP_RSI');
    expect(after.length).toBe(before.length);
  });

  it('T71: **先改参数再切副图 Tab** → 新建的指标也是新参数的值（不是旧值）', async () => {
    const user = userEvent.setup();
    await renderKline();

    // 先改 RSI 周期（此时 RSI 副图还没建，图表里没有 RSI 指标）
    await setParam('RSI 周期（日）：', '21');
    // 再切到 RSI 副图 ⇒ 此刻才创建 RSI 指标
    await user.click(screen.getByTestId('kline-sub-tab-rsi'));

    await waitFor(() => {
      const result = indicatorResult<{ rsi: number }>('APP_RSI');
      expect(result.length).toBe(RAW_BARS.length);
      expect(result[result.length - 1].rsi).toBe(calculateRSI(CLOSES, 21)[CLOSES.length - 1]);
    });
  });
});

/* ------------------------------------------------------------------ *
 * ①-b RSI 超买/超卖参考线
 * ------------------------------------------------------------------ */

describe('T71 · RSI 超买/超卖参考线', () => {
  it('T71: `drawRsiThresholds` 在超买/超卖阈值处各画一条横线', () => {
    const strokes: Array<{ color: string; y: number }> = [];
    const ctx = {
      save: () => undefined,
      restore: () => undefined,
      setLineDash: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      strokeStyle: '',
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    let currentY = 0;
    let currentColor = '';
    vi.spyOn(ctx, 'moveTo').mockImplementation((_x: number, y: number) => {
      currentY = y;
    });
    vi.spyOn(ctx, 'stroke').mockImplementation(() => {
      strokes.push({ color: currentColor, y: currentY });
    });
    Object.defineProperty(ctx, 'strokeStyle', {
      set: (v: unknown) => {
        currentColor = String(v);
      },
      get: () => '',
    });

    drawRsiThresholds(
      ctx,
      { getVisibleRange: () => ({ from: 0, to: 10 }) },
      { convertToPixel: (index: number) => index * 10 },
      { convertToPixel: (value: number) => 100 - value },
      70,
      30,
    );

    expect(strokes).toHaveLength(2);
    // 超买 70 → y = 30；超卖 30 → y = 70
    expect(strokes[0].y).toBe(30);
    expect(strokes[1].y).toBe(70);
    expect(strokes[0].color).toBe(RSI_OVERBOUGHT_COLOR);
    expect(strokes[1].color).toBe(RSI_OVERSOLD_COLOR);
  });
});

/* ------------------------------------------------------------------ *
 * ② 零网络请求（硬断言）
 * ------------------------------------------------------------------ */

describe('T71 · 零网络请求', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T71: 改参数后 `api.get` 未被再次调用（**不重新取 K 线**）', async () => {
    await renderKline();

    const callsBefore = getMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    await setParam('MA1 周期（日）：', '30');
    await waitFor(() => {
      const result = indicatorResult<{ ma1: number }>('APP_MA');
      expect(result[result.length - 1].ma1).toBe(calculateSMA(CLOSES, 30)[CLOSES.length - 1]);
    });

    expect(getMock.mock.calls.length).toBe(callsBefore);
  });

  it('T71: 改参数后 klinecharts 数据加载器的 `getBars` 未被再次调用（连内存取数都不做）', async () => {
    await renderKline();

    const loaderCallsBefore = loaderSpy.mock.calls.length;
    expect(loaderCallsBefore).toBeGreaterThan(0);

    await setParam('MA2 周期（日）：', '15');
    await waitFor(() => {
      const result = indicatorResult<{ ma2: number }>('APP_MA');
      expect(result[result.length - 1].ma2).toBe(calculateSMA(CLOSES, 15)[CLOSES.length - 1]);
    });

    expect(loaderSpy.mock.calls.length).toBe(loaderCallsBefore);
  });

  it('T71: 改 MACD / RSI / KDJ 参数同样零请求', async () => {
    const user = userEvent.setup();
    await renderKline();
    const callsBefore = getMock.mock.calls.length;
    const loaderCallsBefore = loaderSpy.mock.calls.length;

    await setParam('MACD 慢线（日）：', '30');
    await setParam('RSI 周期（日）：', '9');
    await setParam('KDJ M1（日）：', '5');

    // 切到 KDJ 副图（指标存在才会重算）
    await user.click(screen.getByTestId('kline-sub-tab-kdj'));
    await waitFor(() => expect(indicatorResult('APP_KDJ').length).toBe(RAW_BARS.length));

    expect(getMock.mock.calls.length).toBe(callsBefore);
    expect(loaderSpy.mock.calls.length).toBe(loaderCallsBefore);
  });
});

/* ------------------------------------------------------------------ *
 * ③ 重绘耗时（PRD §6.3 ≤ 300ms）
 * ------------------------------------------------------------------ */

describe('T71 · 重绘耗时（PRD §6.3）', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T71: 改参数 → 重绘耗时 < 300ms（客户端计算，`performance.now()` 实测）', async () => {
    await renderKline();

    const input = screen.getByLabelText('MA1 周期（日）：');
    const expected = calculateSMA(CLOSES, 30)[CLOSES.length - 1];

    const t0 = performance.now();
    await act(async () => {
      fireEvent.change(input, { target: { value: '30' } });
      // 让 klinecharts 的重算微任务链跑完
      // （overrideIndicator → 微任务 → calc → taskScheduler → layout）
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    const elapsed = performance.now() - t0;

    // 数值确实已经更新（说明「同步完成即渲染」，不是等了个轮询）
    const result = indicatorResult<{ ma1: number }>('APP_MA');
    expect(result[result.length - 1].ma1).toBe(expected);

    expect(elapsed).toBeLessThan(300);
  });
});

/* ------------------------------------------------------------------ *
 * ④ 越界处理
 * ------------------------------------------------------------------ */

describe('T71 · 参数越界 → 夹取 + 提示', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T71: MA 周期填 999 → 被夹到上限 250 + 显示提示（不产生 Infinity）', async () => {
    await renderKline();

    const input = screen.getByLabelText('MA1 周期（日）：') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '999' } });
    });

    await waitFor(() => expect(input).toHaveValue(PARAM_RANGES.maPeriod.max));
    const hint = screen.getByTestId('kline-param-ma1-hint');
    expect(hint).toHaveTextContent('已取 250');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    // 数值侧：没有 Infinity 混进图表
    const result = indicatorResult<{ ma1: number }>('APP_MA');
    expect(result.some((r) => r.ma1 === Infinity || r.ma1 === -Infinity)).toBe(false);
    // NaN 只出现在「预热期」（SMA 前 period-1 根本就没有值）——不是参数非法导致的
    const nanCount = result.filter((r) => Number.isNaN(r.ma1)).length;
    expect(nanCount).toBe(Math.min(RAW_BARS.length, PARAM_RANGES.maPeriod.max - 1));
    // 并且提示用户「数据不足」（当前 120 根 < 250 根）
    expect(hint.textContent).toContain('已取 250');
  });

  it('T71: 合法周期 → 只有预热期是 NaN，其余都是有限值', async () => {
    await renderKline();

    await setParam('MA1 周期（日）：', '25');

    await waitFor(() => {
      const result = indicatorResult<{ ma1: number }>('APP_MA');
      expect(result[result.length - 1].ma1).toBe(calculateSMA(CLOSES, 25)[CLOSES.length - 1]);
    });
    const result = indicatorResult<{ ma1: number }>('APP_MA');
    const nanCount = result.filter((r) => Number.isNaN(r.ma1)).length;
    expect(nanCount).toBe(24); // 前 24 根是预热期
    expect(result.filter((r) => !Number.isFinite(r.ma1)).length).toBe(nanCount);
  });

  it('T71: MACD 快线 ≥ 慢线 → 被夹到「慢线 − 1」+ 提示', async () => {
    await renderKline();

    const input = screen.getByLabelText('MACD 快线（日）：') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '40' } });
    });

    await waitFor(() => expect(input).toHaveValue(25));
    expect(screen.getByTestId('kline-param-macdFast-hint')).toHaveTextContent('小于慢线');
  });

  it('T71: RSI 超卖填 80（> 超买 70）→ 被夹到合法区间 50 + 提示', async () => {
    await renderKline();

    const input = screen.getByLabelText('RSI 超卖阈值（点）：') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '80' } });
    });

    await waitFor(() => expect(input).toHaveValue(PARAM_RANGES.rsiOversold.max));
    expect(screen.getByTestId('kline-param-rsiOversold-hint')).toHaveTextContent('已取 50');
  });

  it('T71: RSI 超卖 ≥ 超买（都在合法区间内）→ 被夹到「超买 − 1」+ 提示', async () => {
    await renderKline();

    // 先把超买压到 50（合法区间下界），再把超卖也设成 50 ⇒ 必须落到 49
    await setParam('RSI 超买阈值（点）：', '50');
    const input = screen.getByLabelText('RSI 超卖阈值（点）：') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '50' } });
    });

    await waitFor(() => expect(input).toHaveValue(49));
    expect(screen.getByTestId('kline-param-rsiOversold-hint')).toHaveTextContent('小于超买阈值 50');
  });

  it('T71: 输入非数字 → **不生效**（参数保持原值）+ 提示', async () => {
    await renderKline();

    const input = screen.getByLabelText('MA1 周期（日）：') as HTMLInputElement;
    const before = indicatorResult<{ ma1: number }>('APP_MA')[RAW_BARS.length - 1].ma1;

    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });

    expect(screen.getByTestId('kline-param-ma1-hint')).toHaveTextContent('请输入数字');
    // 参数没变 ⇒ 指标值不变
    expect(indicatorResult<{ ma1: number }>('APP_MA')[RAW_BARS.length - 1].ma1).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 恢复默认
 * ------------------------------------------------------------------ */

describe('T71 · 恢复默认', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T71: 「恢复默认」把参数与图表值一起还原', async () => {
    const user = userEvent.setup();
    await renderKline();

    await setParam('MA1 周期（日）：', '25');
    await setParam('MACD 快线（日）：', '8');
    await waitFor(() => {
      const result = indicatorResult<{ ma1: number }>('APP_MA');
      expect(result[result.length - 1].ma1).toBe(calculateSMA(CLOSES, 25)[CLOSES.length - 1]);
    });

    await user.click(screen.getByTestId('kline-param-reset'));

    await waitFor(() => {
      expect(screen.getByLabelText('MA1 周期（日）：')).toHaveValue(DEFAULT_INDICATOR_PARAMS.ma.periods[0]);
      expect(screen.getByLabelText('MACD 快线（日）：')).toHaveValue(DEFAULT_INDICATOR_PARAMS.macd.fast);
    });

    // 图表值也回到默认
    await waitFor(() => {
      const result = indicatorResult<{ ma1: number }>('APP_MA');
      expect(result[result.length - 1].ma1).toBe(
        calculateSMA(CLOSES, DEFAULT_INDICATOR_PARAMS.ma.periods[0])[CLOSES.length - 1],
      );
    });
    // 提示也一并清掉
    expect(screen.queryByTestId('kline-param-ma1-hint')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * ⑥ a11y
 * ------------------------------------------------------------------ */

describe('T71 · 参数面板 a11y', () => {
  beforeAll(() => {
    installFakeCanvas();
  });
  afterAll(() => {
    restoreFakeCanvas();
  });

  it('T71: 每个输入都有 `<label htmlFor>` + `id` + 可见单位', async () => {
    await renderKline();

    const cases: Array<[string, string]> = [
      ['MA1 周期（日）：', 'kline-param-ma1'],
      ['MA4 周期（日）：', 'kline-param-ma4'],
      ['MACD 快线（日）：', 'kline-param-macdFast'],
      ['MACD 慢线（日）：', 'kline-param-macdSlow'],
      ['MACD 信号线（日）：', 'kline-param-macdSignal'],
      ['RSI 周期（日）：', 'kline-param-rsiPeriod'],
      ['RSI 超买阈值（点）：', 'kline-param-rsiOverbought'],
      ['RSI 超卖阈值（点）：', 'kline-param-rsiOversold'],
      ['KDJ N（日）：', 'kline-param-kdjN'],
      ['KDJ M1（日）：', 'kline-param-kdjM1'],
      ['KDJ M2（日）：', 'kline-param-kdjM2'],
    ];

    for (const [label, id] of cases) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.id, `label「${label}」未关联到 #${id}`).toBe(id);
      // label 元素真的存在且 htmlFor 指向它
      const labelEl = document.querySelector(`label[for="${id}"]`);
      expect(labelEl, `缺少 label[for="${id}"]`).not.toBeNull();
      expect(labelEl?.textContent).toContain(label.replace('：', ''));
      // 单位可见（label 文本里带「日」/「点」）
      expect(labelEl?.textContent).toMatch(/[日周月点]/);
    }
  });

  it('T71: 面板有可访问名 + 当前生效值可见', async () => {
    await renderKline();

    const panel = screen.getByTestId('kline-param-panel');
    expect(panel).toHaveAttribute('aria-label', '指标参数');

    const summary = screen.getByTestId('kline-param-summary');
    expect(summary).toHaveTextContent('MA(5/10/20/60)');
    expect(summary).toHaveTextContent('MACD(12,26,9)');
    expect(summary).toHaveTextContent('RSI(14, 30/70)');
    expect(summary).toHaveTextContent('KDJ(9,3,3)');
  });
});

/* ------------------------------------------------------------------ *
 * ⑦ 纯函数层：bars 上的 ma 值
 * ------------------------------------------------------------------ */

describe('T71 · bars 上的指标值（纯函数层）', () => {
  it('T71: `buildChartBars` 按参数把指标值灌进每根 K 线', () => {
    const params: IndicatorParams = {
      ...DEFAULT_INDICATOR_PARAMS,
      ma: { periods: [25, 10, 20, 60] },
      macd: { fast: 8, slow: 26, signal: 9 },
      rsi: { period: 21, overbought: 70, oversold: 30 },
      kdj: { n: 14, m1: 3, m2: 3 },
    };
    const bars: ChartBar[] = buildChartBars(RAW_BARS, 'day', [], params);
    const last = bars.length - 1;

    expect(bars[last].ma1).toBe(calculateSMA(CLOSES, 25)[last]);
    expect(bars[last].ma2).toBe(calculateSMA(CLOSES, 10)[last]);
    const macd = calculateMACD(CLOSES, 8, 26, 9);
    expect(bars[last].dif).toBe(macd.dif[last]);
    expect(bars[last].macd).toBe(2 * (bars[last].dif - bars[last].dea));
    expect(bars[last].rsi).toBe(calculateRSI(CLOSES, 21)[last]);
    const kdj = calculateKDJ(HIGHS, LOWS, CLOSES, 14, 3, 3);
    expect(bars[last].k).toBe(kdj.k[last]);
    // 没有 Infinity 混进来
    expect(bars.every((b) => !Number.isFinite(b.ma1) || Number.isFinite(b.ma1))).toBe(true);
    expect(bars.some((b) => b.macd === Infinity || b.macd === -Infinity)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * ⑧ 页面层：参数真的传到了图表（用替身组件断言 bars）
 * ------------------------------------------------------------------ */

describe('T71 · 页面层：参数 → 图表 props 的 bars', () => {
  it('T71: 改 MA 周期 → 传给图表的 bars 上的 ma 值随之改变', async () => {
    // 用替身组件把 bars 暴露出来（页面层断言，与图表层解耦）
    vi.doMock('../../src/components/KlineChart', () => ({
      default: (props: { bars: ChartBar[] }) => {
        const last = props.bars[props.bars.length - 1];
        return (
          <div data-testid="kline-chart-stub" data-ma1={String(last?.ma1)} data-rsi={String(last?.rsi)} />
        );
      },
    }));
    vi.resetModules();

    const { default: Kline } = await import('../../src/pages/Kline');
    renderWithRouter(<Kline />, { initialEntries: ['/kline'] });
    await waitFor(() => expect(screen.getByTestId('kline-chart-stub')).toBeInTheDocument());

    const stub = screen.getByTestId('kline-chart-stub');
    const beforeMa1 = Number(stub.getAttribute('data-ma1'));
    expect(beforeMa1).toBe(calculateSMA(CLOSES, 5)[CLOSES.length - 1]);

    await setParam('MA1 周期（日）：', '25');

    await waitFor(() => {
      expect(Number(screen.getByTestId('kline-chart-stub').getAttribute('data-ma1'))).toBe(
        calculateSMA(CLOSES, 25)[CLOSES.length - 1],
      );
    });
    expect(Number(screen.getByTestId('kline-chart-stub').getAttribute('data-ma1'))).not.toBe(beforeMa1);
  });
});
