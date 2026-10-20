/**
 * K 线图组件（T70 · 接入 `klinecharts@10.1.0`）
 *
 * ## 为什么单独一个组件
 *
 * - `klinecharts` 的 **类型定义**（`Chart` / `KLineData` / `IndicatorTemplate`）
 *   在本文件里是**纯类型导入**（`import type`）→ 编译后不产生任何运行时依赖；
 * - **运行时**通过 `await import('klinecharts')` 动态加载 ⇒ klinecharts 单独成 chunk，
 *   首屏（仪表盘）不会下载它（SDD §2.12.5「按需加载 klinecharts」）。
 *
 * ## 数据流
 *
 * ```
 * 后端 klines[] ──▶ chartBars.buildChartBars（前端算 MA/MACD/RSI/KDJ + 周期聚合）
 *                 ──▶ 每根 K 线挂上指标字段
 *                 ──▶ setDataLoader({ getBars }) 灌进图表
 *                 ──▶ registerIndicator 的自定义 calc 把字段原样吐回 result
 * ```
 *
 * 🔴 **库不参与任何计算**（SDD §2.5）—— 绝不使用 klinecharts 的内置指标。
 *
 * ## 交互
 *
 * - 十字光标：库内置（`subscribeAction('onCrosshairChange')`）
 * - 缩放 / 平移 / 拖拽：库内置（**不触发页面滚动** —— 库自己 `preventDefault`）
 * - hover 悬浮窗：**本组件自绘**（React 层）—— 显示当日 OHLCV + 指标值 + 当日信号
 * - 响应式：`ResizeObserver` + `window.resize` → `chart.resize()`
 */

import { useEffect, useRef, useState } from 'react';
import type { Chart, KLineData } from 'klinecharts';
import { COLORS, TYPO } from '../theme/tokens';
import { PERIOD_TO_KLINECHARTS, type ChartBar, type KlinePeriod } from '../indicators/chartBars';
import KlineHoverPanel from './KlineHoverPanel';
import {
  CHART_STYLES,
  KDJ_INDICATOR,
  KDJ_LINE_STYLES,
  MA_INDICATOR,
  MA_LINE_STYLES,
  MACD_BAR_STYLES,
  MACD_INDICATOR,
  MACD_LINE_STYLES,
  RSI_INDICATOR,
  RSI_LINE_STYLES,
  SIGNAL_INDICATOR,
  VOL_BAR_STYLES,
  VOL_INDICATOR,
} from '../indicators/chartIndicators';

/** klinecharts 的主图（蜡烛图）pane id */
export const CANDLE_PANE_ID = 'candle_pane';

/** 副图类型（MACD / RSI / KDJ）*/
export type SubIndicatorKind = 'macd' | 'rsi' | 'kdj';

/** 副图类型 → 注册的指标名 */
export const SUB_INDICATOR_NAME: Record<SubIndicatorKind, string> = {
  macd: 'APP_MACD',
  rsi: 'APP_RSI',
  kdj: 'APP_KDJ',
};

/** 副图类型 → 中文名 */
export const SUB_INDICATOR_LABEL: Record<SubIndicatorKind, string> = {
  macd: 'MACD',
  rsi: 'RSI',
  kdj: 'KDJ',
};

export interface KlineChartProps {
  /** 标的代码（显示在 tooltip 标题上）*/
  symbol: string;
  /** 图表周期 */
  period: KlinePeriod;
  /** 已加工的 K 线（含指标字段 + 信号标记）*/
  bars: ChartBar[];
  /** 主图是否叠加 MA(5/10/20/60) */
  showMa: boolean;
  /** 副图类型 */
  subIndicator: SubIndicatorKind;
  /** 图表总高度（px）*/
  height?: number;
  /** 主图高度（px）*/
  mainHeight?: number;
  /** 副图高度（px）*/
  subHeight?: number;
}

/** klinecharts 运行时模块（动态 import 的结果）*/
type KlineChartsModule = typeof import('klinecharts');

/** 注册全部自定义指标（幂等 —— 重复注册只是覆盖同名模板）*/
function registerCustomIndicators(kc: KlineChartsModule): void {
  kc.registerIndicator(MA_INDICATOR);
  kc.registerIndicator(MACD_INDICATOR);
  kc.registerIndicator(RSI_INDICATOR);
  kc.registerIndicator(KDJ_INDICATOR);
  kc.registerIndicator(VOL_INDICATOR);
  // 🔴 信号标记也必须注册 —— 未注册的名字 `createIndicator` 会静默返回 null
  kc.registerIndicator(SIGNAL_INDICATOR);
}

/** 创建一个指标（若已存在则先移除，保证幂等）*/
function ensureIndicator(
  chart: Chart,
  name: string,
  create: (chart: Chart) => void,
  shouldExist: boolean,
): void {
  const exists = chart.getIndicators({ name }).length > 0;
  if (shouldExist && !exists) create(chart);
  if (!shouldExist && exists) chart.removeIndicator({ name });
}

export default function KlineChart({
  symbol,
  period,
  bars,
  showMa,
  subIndicator,
  height = 560,
  mainHeight = 380,
  subHeight = 140,
}: KlineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const kcRef = useRef<KlineChartsModule | null>(null);
  /** 最新数据（数据加载器的闭包读它，避免每次数据变化都重建 loader）*/
  const barsRef = useRef<ChartBar[]>(bars);
  barsRef.current = bars;

  /** 当前 hover 的 K 线下标 */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /** 图表初始化失败时的降级提示（jsdom / 无 canvas 环境）*/
  const [chartError, setChartError] = useState<string | null>(null);
  /** 图表是否已就绪 */
  const [ready, setReady] = useState(false);

  /* ---------------- 初始化（只跑一次） ---------------- */
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const onWindowResize = () => chartRef.current?.resize();

    const bootstrap = async () => {
      try {
        // 🔴 动态导入 ⇒ klinecharts 独立 chunk，首屏不下载
        const kc = await import('klinecharts');
        if (disposed) return;
        kcRef.current = kc;

        const container = containerRef.current;
        if (!container) return;

        registerCustomIndicators(kc);

        const chart = kc.init(container, { styles: CHART_STYLES, locale: 'zh-CN' });
        if (!chart) throw new Error('klinecharts init 未返回实例');
        chartRef.current = chart;

        // 🔒 **仅开发模式**暴露图表实例（浏览器探针用）
        //
        // G5.6「K 线价格轴范围正确」需要在**真浏览器**里读主图 y 轴的 min/max 标注，
        // 而 klinecharts 把坐标轴画在 **canvas** 上 ⇒ DOM 里读不到文字。
        // ⇒ 开发模式下把实例挂到 `window.__investKlineChart`，探针即可调
        //    `getYAxes()` / `getRange()` 读出真实轴范围（生产构建里 `import.meta.env.DEV` 为 false，
        //    这段代码会被 tree-shake 掉，不留任何全局副作用）。
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__investKlineChart = chart;
        }

        // 数据加载器：只在 `init` 时给全量数据；前后翻页没有更多数据
        chart.setDataLoader({
          getBars: (params) => {
            if (params.type !== 'init') {
              params.callback([], false);
              return;
            }
            params.callback(barsRef.current as unknown as KLineData[], false);
          },
        });
        chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 });
        chart.setPeriod({ type: PERIOD_TO_KLINECHARTS[period], span: 1 });
        chart.resetData();

        // 主图叠加 MA（`series: 'price'` + `paneId: candle_pane` ⇒ 画在蜡烛图上）
        ensureIndicator(
          chart,
          MA_INDICATOR.name,
          (c) => {
            c.createIndicator(
              {
                name: MA_INDICATOR.name,
                paneId: CANDLE_PANE_ID,
                series: 'price',
                styles: { lines: MA_LINE_STYLES },
              },
              true,
            );
          },
          showMa,
        );

        // 信号标记（自绘：走指标的自定义 draw 回调）
        ensureIndicator(
          chart,
          SIGNAL_INDICATOR.name,
          (c) => {
            c.createIndicator(
              {
                name: SIGNAL_INDICATOR.name,
                paneId: CANDLE_PANE_ID,
                series: 'price',
              },
              true,
            );
          },
          true,
        );

        // 副图（MACD / RSI / KDJ 三选一）
        ensureIndicator(
          chart,
          SUB_INDICATOR_NAME[subIndicator],
          (c) => {
            if (subIndicator === 'macd') {
              c.createIndicator({
                name: MACD_INDICATOR.name,
                styles: { lines: MACD_LINE_STYLES, bars: MACD_BAR_STYLES },
              });
            } else if (subIndicator === 'rsi') {
              c.createIndicator({
                name: RSI_INDICATOR.name,
                styles: { lines: RSI_LINE_STYLES },
              });
            } else {
              c.createIndicator({
                name: KDJ_INDICATOR.name,
                styles: { lines: KDJ_LINE_STYLES },
              });
            }
          },
          true,
        );

        // 成交量副图
        ensureIndicator(
          chart,
          VOL_INDICATOR.name,
          (c) => {
            c.createIndicator({
              name: VOL_INDICATOR.name,
              styles: { bars: VOL_BAR_STYLES },
            });
          },
          true,
        );

        // 十字光标 → hover 悬浮窗
        chart.subscribeAction('onCrosshairChange', (data) => {
          const crosshair = data as { x?: number } | undefined;
          if (!crosshair || typeof crosshair.x !== 'number') {
            setHoverIndex(null);
            return;
          }
          const points = chart.convertFromPixel([{ x: crosshair.x }], { paneId: CANDLE_PANE_ID }) as Array<{
            dataIndex?: number;
          }>;
          const index = points[0]?.dataIndex;
          setHoverIndex((_prev) =>
            typeof index === 'number' && index >= 0 && index < barsRef.current.length ? index : null,
          );
        });

        // 响应式：容器尺寸变化 → 重绘
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => chart.resize());
          resizeObserver.observe(container);
        }
        window.addEventListener('resize', onWindowResize);
        setReady(true);
      } catch (err) {
        if (disposed) return;
        setChartError(err instanceof Error ? err.message : String(err));
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWindowResize);
      resizeObserver?.disconnect();
      const chart = chartRef.current;
      chartRef.current = null;
      if (chart && kcRef.current) kcRef.current.dispose(chart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 标的 / 周期变化 ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 });
    chart.setPeriod({ type: PERIOD_TO_KLINECHARTS[period], span: 1 });
    chart.resetData();
  }, [symbol, period, ready]);

  /* ---------------- 数据变化 → 重新灌值 ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    chart.resetData();
  }, [bars, ready]);

  /* ---------------- MA 显隐（F-K3） ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    ensureIndicator(
      chart,
      MA_INDICATOR.name,
      (c) => {
        c.createIndicator(
          {
            name: MA_INDICATOR.name,
            paneId: CANDLE_PANE_ID,
            series: 'price',
            styles: { lines: MA_LINE_STYLES },
          },
          true,
        );
      },
      showMa,
    );
  }, [showMa, ready]);

  /* ---------------- 副图切换（F-K5） ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    (Object.keys(SUB_INDICATOR_NAME) as SubIndicatorKind[]).forEach((kind) => {
      const name = SUB_INDICATOR_NAME[kind];
      const shouldExist = kind === subIndicator;
      ensureIndicator(
        chart,
        name,
        (c) => {
          if (kind === 'macd') {
            c.createIndicator({ name, styles: { lines: MACD_LINE_STYLES, bars: MACD_BAR_STYLES } });
          } else if (kind === 'rsi') {
            c.createIndicator({ name, styles: { lines: RSI_LINE_STYLES } });
          } else {
            c.createIndicator({ name, styles: { lines: KDJ_LINE_STYLES } });
          }
        },
        shouldExist,
      );
    });
  }, [subIndicator, ready]);

  /* ---------------- 窗格高度 ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    chart.setPaneOptions({ id: CANDLE_PANE_ID, height: mainHeight });
    chart.setPaneOptions({ height: subHeight });
  }, [mainHeight, subHeight, ready, subIndicator]);

  const hovered = hoverIndex !== null ? bars[hoverIndex] : null;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        ref={containerRef}
        data-testid="kline-chart-container"
        aria-label="K 线图"
        style={{
          width: '100%',
          height,
          background: COLORS.chartBg,
          border: `1px solid ${COLORS.chartBorder}`,
          borderRadius: 4,
          overflow: 'hidden',
          touchAction: 'none',
        }}
      />

      {chartError && (
        <div
          data-testid="kline-chart-unsupported"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: COLORS.chartText,
            fontSize: TYPO.smallSize,
            background: COLORS.chartBg,
          }}
        >
          当前环境不支持 Canvas，无法显示 K 线图（{chartError}）
        </div>
      )}

      {/* 十字光标 hover 悬浮窗：当日 OHLCV + 指标值 + 当日信号（F-K6 / F-K8）*/}
      <KlineHoverPanel bar={hovered} showMa={showMa} subIndicator={subIndicator} />
    </div>
  );
}
