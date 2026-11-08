/**
 * kline-overlay-toolbar.test.tsx — 画线工具栏 + 创建/重放/删除的组件级单测
 *
 * `klinecharts` 被整体 mock：只验证我们对库的**调用契约**与 UI 行为，
 * 不验证库本身的绘制（那属于库的职责）。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import KlineChart from '../../src/components/KlineChart';
import type { ChartBar } from '../../src/indicators/chartBars';
import { DEFAULT_INDICATOR_PARAMS } from '../../src/indicators/chartParams';
import type { StoredOverlay } from '../../src/indicators/klineOverlays';

const chartMock = vi.hoisted(() => {
  const createOverlay = vi.fn();
  const removeOverlay = vi.fn();
  const chart = {
    setDataLoader: vi.fn(),
    setSymbol: vi.fn(),
    setPeriod: vi.fn(),
    resetData: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    getIndicators: vi.fn(() => []),
    overrideIndicator: vi.fn(),
    subscribeAction: vi.fn(),
    convertFromPixel: vi.fn(() => []),
    convertToPixel: vi.fn(() => [{ x: 0, y: 0, dataIndex: 0 }]),
    resize: vi.fn(),
    setPaneOptions: vi.fn(),
    getYAxes: vi.fn(() => [{ convertToPixel: () => 0 }]),
    createOverlay,
    removeOverlay,
  };
  return { chart, createOverlay, removeOverlay };
});

vi.mock('klinecharts', () => ({
  init: vi.fn(() => chartMock.chart),
  dispose: vi.fn(),
  registerIndicator: vi.fn(),
}));

const TS_A = Date.UTC(2026, 9, 12);
const TS_B = Date.UTC(2026, 9, 13);

function makeBar(date: string, timestamp: number, close: number): ChartBar {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    amount: 10000,
    timestamp,
    ma1: close,
    ma2: close,
    ma3: close,
    ma4: close,
    dif: 0,
    dea: 0,
    macd: 0,
    rsi: 50,
    k: 50,
    d: 50,
    j: 50,
    signal: null,
    trades: [],
    patterns: [],
  };
}

const BARS: ChartBar[] = [makeBar('2026-10-12', TS_A, 10.5), makeBar('2026-10-13', TS_B, 11)];

/** 收集 `chart.createOverlay` 的调用参数 */
function overlayConfigs(): Array<Record<string, unknown>> {
  return chartMock.createOverlay.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function lastOverlayConfig(): Record<string, unknown> {
  const configs = overlayConfigs();
  return configs[configs.length - 1];
}

async function renderReady(props: Partial<ComponentProps<typeof KlineChart>> = {}) {
  const view = render(
    <KlineChart
      symbol="sh600000"
      period="day"
      bars={BARS}
      dataSignature="sig-1"
      params={DEFAULT_INDICATOR_PARAMS}
      showMa
      subIndicator="macd"
      {...props}
    />,
  );
  await waitFor(() => expect(chartMock.chart.setDataLoader).toHaveBeenCalled());
  // 等一次「重放同步」跑完（effect 在 ready 之后才执行），避免断言早于 effect
  await waitFor(() => expect(chartMock.removeOverlay).toHaveBeenCalledWith({ paneId: 'candle_pane' }));
  return view;
}

/** 模拟 klinecharts 在取点结束后回调 `onDrawEnd` */
async function emitDrawEnd(
  config: Record<string, unknown>,
  overlay: { id: string; points: Array<{ timestamp?: number; value?: number }> },
) {
  const onDrawEnd = config.onDrawEnd as (event: { overlay: typeof overlay }) => void;
  await act(async () => {
    onDrawEnd({ overlay });
  });
}

describe('画线工具栏', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('提供 5 个工具入口，绘制结束回到空闲态', async () => {
    await renderReady();
    const toolbar = screen.getByTestId('kline-overlay-toolbar');
    expect(toolbar).toBeTruthy();
    for (const testId of [
      'kline-overlay-tool-rayLine',
      'kline-overlay-tool-horizontalStraightLine',
      'kline-overlay-tool-fibonacciLine',
      'kline-overlay-tool-priceChannelLine',
      'kline-overlay-tool-simpleAnnotation',
    ]) {
      expect(screen.getByTestId(testId)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('kline-overlay-tool-horizontalStraightLine'));
    expect(chartMock.createOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'horizontalStraightLine' }),
    );
    // 绘制态提示出现
    expect(screen.getByTestId('kline-overlay-hint')).toBeTruthy();

    const config = lastOverlayConfig();
    await emitDrawEnd(config, { id: 'tmp-1', points: [{ timestamp: TS_A, value: 10.5 }] });
    // 回到空闲态
    expect(screen.queryByTestId('kline-overlay-hint')).toBeNull();
  });

  it('水平线：落点合法 → 调用保存回调（timestamp + value）', async () => {
    const onCreateOverlay = vi.fn(async () => ({ ok: true, id: 11 }));
    await renderReady({ onCreateOverlay });

    fireEvent.click(screen.getByTestId('kline-overlay-tool-horizontalStraightLine'));
    await emitDrawEnd(lastOverlayConfig(), {
      id: 'tmp-1',
      points: [{ timestamp: TS_A, value: 10.5 }],
    });

    expect(onCreateOverlay).toHaveBeenCalledWith({
      symbol: 'sh600000',
      period: 'day',
      name: 'horizontalStraightLine',
      points: [{ timestamp: TS_A, value: 10.5 }],
      text: null,
    });
  });

  it('斐波那契：两点落库，分级位由库固定（只存两点）', async () => {
    const onCreateOverlay = vi.fn(async () => ({ ok: true, id: 12 }));
    await renderReady({ onCreateOverlay });

    fireEvent.click(screen.getByTestId('kline-overlay-tool-fibonacciLine'));
    expect(chartMock.createOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'fibonacciLine' }),
    );

    await emitDrawEnd(lastOverlayConfig(), {
      id: 'tmp-fib',
      points: [
        { timestamp: TS_A, value: 10 },
        { timestamp: TS_B, value: 11 },
      ],
    });

    expect(onCreateOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'fibonacciLine',
        points: [
          { timestamp: TS_A, value: 10 },
          { timestamp: TS_B, value: 11 },
        ],
      }),
    );
    expect(screen.queryByTestId('kline-overlay-notice')).toBeNull();
  });

  it('落点 timestamp 不在当前 bar 上 → 拒绝保存并提示，同时从图上移除', async () => {
    const onCreateOverlay = vi.fn(async () => ({ ok: true, id: 13 }));
    await renderReady({ onCreateOverlay });

    fireEvent.click(screen.getByTestId('kline-overlay-tool-horizontalStraightLine'));
    await emitDrawEnd(lastOverlayConfig(), {
      id: 'tmp-bad',
      points: [{ timestamp: Date.UTC(2020, 0, 1), value: 10 }],
    });

    expect(onCreateOverlay).not.toHaveBeenCalled();
    expect(screen.getByTestId('kline-overlay-notice').textContent).toContain('落点不在当前 K 线范围内');
    expect(chartMock.removeOverlay).toHaveBeenCalledWith({ id: 'tmp-bad' });
  });

  it('保存失败时从图上移除并提示', async () => {
    const onCreateOverlay = vi.fn(async () => ({ ok: false, message: '后端拒绝' }));
    await renderReady({ onCreateOverlay });

    fireEvent.click(screen.getByTestId('kline-overlay-tool-horizontalStraightLine'));
    await emitDrawEnd(lastOverlayConfig(), {
      id: 'tmp-fail',
      points: [{ timestamp: TS_A, value: 10.5 }],
    });

    expect(screen.getByTestId('kline-overlay-notice').textContent).toContain('后端拒绝');
    expect(chartMock.removeOverlay).toHaveBeenCalledWith({ id: 'tmp-fail' });
  });
});

describe('重放与删除', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const valid: StoredOverlay = {
    id: 7,
    symbol: 'sh600000',
    period: 'day',
    name: 'horizontalStraightLine',
    points: [{ timestamp: TS_A, value: 10 }],
    text: null,
  };
  const timestampMismatch: StoredOverlay = {
    id: 8,
    symbol: 'sh600000',
    period: 'day',
    name: 'fibonacciLine',
    points: [
      { timestamp: TS_A, value: 10 },
      { timestamp: Date.UTC(2020, 0, 1), value: 12 },
    ],
    text: null,
  };

  it('只重放 timestamp 能对上的标注，对不上的跳过', async () => {
    await renderReady({ overlays: [valid, timestampMismatch] });

    const ids = overlayConfigs().map((config) => config.id);
    expect(ids).toContain('7');
    expect(ids).not.toContain('8');
  });

  it('被跳过的标注有可见提示（role=status），下次全部适用后提示消失', async () => {
    const view = await renderReady({ overlays: [valid, timestampMismatch] });

    const hint = screen.getByTestId('kline-overlay-skip-hint');
    expect(hint).toHaveAttribute('role', 'status');
    expect(hint.textContent).toBe('当前周期有 1 条标注不适用已隐藏');

    // 下一次成功重放（只剩全部适用的标注）⇒ 提示自然清空，不堆积
    view.rerender(
      <KlineChart
        symbol="sh600000"
        period="day"
        bars={BARS}
        dataSignature="sig-1"
        params={DEFAULT_INDICATOR_PARAMS}
        showMa
        subIndicator="macd"
        overlays={[valid]}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('kline-overlay-skip-hint')).toBeNull());
  });

  it('点选已持久化标注后可删除（id 映射回记录 id）', async () => {
    const onDeleteOverlay = vi.fn(async () => ({ ok: true }));
    await renderReady({ overlays: [valid], onDeleteOverlay });

    const deleteButton = screen.getByTestId('kline-overlay-delete') as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    const config = overlayConfigs().find((item) => item.id === '7')!;
    const onSelected = config.onSelected as (event: { overlay: { id: string } }) => void;
    await act(async () => {
      onSelected({ overlay: { id: '7' } });
    });

    expect(deleteButton.disabled).toBe(false);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(onDeleteOverlay).toHaveBeenCalledWith(7));
    expect(chartMock.removeOverlay).toHaveBeenCalledWith({ id: '7' });
  });

  it('不复权以外口径下工具按钮禁用', async () => {
    await renderReady({ overlays: [valid], overlaysEnabled: false });
    expect(
      (screen.getByTestId('kline-overlay-tool-horizontalStraightLine') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('kline-overlay-disabled-hint')).toBeTruthy();
    // 禁用时不重放
    expect(chartMock.createOverlay).not.toHaveBeenCalled();
  });
});
