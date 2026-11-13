/**
 * K 线图组件（T70 · 接入 `klinecharts@10.1.0`；T71 · 指标参数实时生效）
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
 * ## T71：改参数 → 即时重绘，**零网络请求**
 *
 * 两条路径**严格分开**：
 *
 * | 变化 | 动作 | 取数 |
 * |---|---|---|
 * | **原始数据变了**（换标的 / 换复权 / 换周期 / 重新加载）| `chart.resetData()` | 内存 loader（`getBars`）|
 * | **只有指标参数变了**（MA 周期 / MACD / RSI / KDJ）| `chart.overrideIndicator({ calc, figures, draw })` | **完全不取数** |
 *
 * ⇒ 改参数时**不会**再次调用数据加载器，更不会发任何网络请求
 *    （PRD §5.2「零网络请求」+ §6.3「重绘 ≤ 300ms」）。
 *
 * ⚠️ **为什么 `overrideIndicator` 里要传一个「新函数」**：
 *    klinecharts 的默认 `shouldUpdate` 用 `prev.calc !== current.calc` 判断是否重算，
 *    传同一个函数引用会被判定为「没变」⇒ **不重算**。
 *    故每次都新建闭包（闭包里读 `barsRef.current` = 最新算好的 bars）。
 *
 * ## 交互
 *
 * - 十字光标：库内置（`subscribeAction('onCrosshairChange')`）
 * - 缩放 / 平移 / 拖拽：库内置（**不触发页面滚动** —— 库自己 `preventDefault`）
 * - hover 悬浮窗：**本组件自绘**（React 层）—— 显示当日 OHLCV + 指标值 + 当日信号
 * - 响应式：`ResizeObserver` + `window.resize` → `chart.resize()`
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Chart, KLineData } from 'klinecharts';
import { COLORS, TYPO } from '../theme/tokens';
import { PERIOD_TO_KLINECHARTS, type ChartBar, type KlinePeriod } from '../indicators/chartBars';
import type { IndicatorParams } from '../indicators/chartParams';
import {
  DEFAULT_ANNOTATION_TEXT,
  OVERLAY_TOOLS,
  buildOverlayCreate,
  collectBarTimestamps,
  filterReplayableOverlays,
  countSkippedOverlays,
  getOverlayTool,
  overlayPointsFromChart,
  validateOverlayDraft,
  type OverlayDraft,
  type OverlaySaveResult,
  type OverlayToolName,
  type StoredOverlay,
} from '../indicators/klineOverlays';
import KlineHoverPanel from './KlineHoverPanel';
import KlineTradePanel from './KlineTradePanel';
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
  TRADE_INDICATOR,
  VOL_BAR_STYLES,
  VOL_INDICATOR,
  calcKdj,
  calcMacd,
  calcMa,
  calcRsi,
  computeTradeMarkerPositions,
  createKdjIndicator,
  createMacdIndicator,
  createMaIndicator,
  createRsiIndicator,
  drawRsiThresholds,
  findTradeMarkerAtPoint,
  maFigures,
  PATTERN_INDICATOR_NAME,
  calcPatterns,
  createPatternIndicator,
  type TradeMarkerGeometry,
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
  /**
   * 原始数据指纹（T71）
   *
   * ⚠️ **只有它变了才重新取数**（`resetData`）；参数变了但它没变 ⇒ **不取数**，
   *    只重算指标（`overrideIndicator`）⇒ 零网络请求。
   */
  dataSignature: string;
  /** 指标参数（T71：改参数即时重绘）*/
  params: IndicatorParams;
  /** 主图是否叠加 MA(4 条) */
  showMa: boolean;
  /** 是否显示交易点（T152；默认开）*/
  showTrades?: boolean;
  /** 副图类型 */
  subIndicator: SubIndicatorKind;
  /** 图表总高度（px）*/
  height?: number;
  /** 主图高度（px）*/
  mainHeight?: number;
  /** 副图高度（px）*/
  subHeight?: number;
  /** 当前标的/周期已持久化的画线（页面按 **不复权（bfq）** 口径拉取）*/
  overlays?: StoredOverlay[];
  /** 画线是否可用：仅**不复权（bfq）**口径下可用（点位存的是当时成交价）*/
  overlaysEnabled?: boolean;
  /** 保存新画线（页面负责落库）；返回保存后的记录 id */
  onCreateOverlay?: (draft: OverlayDraft) => Promise<OverlaySaveResult>;
  /** 删除画线（软删除）*/
  onDeleteOverlay?: (id: number) => Promise<OverlaySaveResult>;
}

/** klinecharts 运行时模块（动态 import 的结果）*/
type KlineChartsModule = typeof import('klinecharts');

/**
 * 注册全部自定义指标（幂等 —— 重复注册只是覆盖同名模板）
 *
 * ⚠️ MA / RSI 的模板**带参数**（周期 / 阈值）⇒ 参数变了要重新注册，
 *    否则后续 `createIndicator`（例如切副图 Tab）会拿到旧参数的模板。
 *
 * ⚠️ 模板的取值来源绑定 `getBars`（**最新**的 bars）——
 *    改参数时我们**不重新取数**（PRD §5.2「零网络请求」），
 *    图表内部的数据列表里挂的还是旧指标字段 ⇒ 只能从 `getBars` 取最新值。
 */
function registerCustomIndicators(
  kc: KlineChartsModule,
  params: IndicatorParams,
  getBars: () => readonly ChartBar[],
): void {
  kc.registerIndicator(createMaIndicator(params.ma.periods, getBars));
  kc.registerIndicator(createMacdIndicator(getBars));
  kc.registerIndicator(
    createRsiIndicator(params.rsi.period, params.rsi.overbought, params.rsi.oversold, getBars),
  );
  kc.registerIndicator(createKdjIndicator(getBars));
  kc.registerIndicator(VOL_INDICATOR);
  // 🔴 信号标记也必须注册 —— 未注册的名字 `createIndicator` 会静默返回 null
  kc.registerIndicator(SIGNAL_INDICATOR);
  // T152：交易标记也必须注册（未注册时 createIndicator 会静默返回 null）
  kc.registerIndicator(TRADE_INDICATOR);
  // K 线形态标注（双顶/双底，后端算、前端只画；无形态时不画任何占位）
  kc.registerIndicator(createPatternIndicator(getBars));
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
  dataSignature,
  params,
  showMa,
  showTrades = true,
  subIndicator,
  height = 560,
  mainHeight = 380,
  subHeight = 140,
  overlays = [],
  overlaysEnabled = true,
  onCreateOverlay,
  onDeleteOverlay,
}: KlineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const kcRef = useRef<KlineChartsModule | null>(null);
  /** 最新数据（数据加载器的闭包读它，避免每次数据变化都重建 loader）*/
  const barsRef = useRef<ChartBar[]>(bars);
  barsRef.current = bars;
  /** 最新 bars 的提供者（指标模板绑定它 ⇒ 改参数时能读到**新**值）*/
  const getBars = useCallback(() => barsRef.current, []);
  /** 最新参数（指标闭包读它）*/
  const paramsRef = useRef<IndicatorParams>(params);
  paramsRef.current = params;
  /** 最新数据指纹（渲染期同步，避免闭包拿到过期值）*/
  const signatureRef = useRef(dataSignature);
  signatureRef.current = dataSignature;
  /** 图表里当前装着的**原始数据**的指纹 —— 与它不同才需要重新取数 */
  const loadedSignatureRef = useRef<string | null>(null);
  /** 是否显示交易点（prop 默认值，避免初始化闭包里拿不到最新值）*/
  const showTradesRef = useRef(showTrades);
  showTradesRef.current = showTrades;
  /** 当前交易标记几何（点击命中用；与 draw 同一套几何）*/
  const tradeMarkersRef = useRef<TradeMarkerGeometry[]>([]);

  /** 当前 hover 的 K 线下标 */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /** 被点中的 K 线（T152 交易明细面板；null = 未点中）*/
  const [selectedTradeBarIndex, setSelectedTradeBarIndex] = useState<number | null>(null);
  /** 图表初始化失败时的降级提示（jsdom / 无 canvas 环境）*/
  const [chartError, setChartError] = useState<string | null>(null);
  /** 图表是否已就绪 */
  const [ready, setReady] = useState(false);
  /** 是否处于**浏览器全屏**（Fullscreen API；Esc 退出也会回到 false）*/
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** 全屏的根元素：包含图表 + hover 浮窗 + 交易明细面板 + 全屏按钮 */
  const wrapperRef = useRef<HTMLDivElement>(null);
  /** 当前绘制态工具（null = 空闲）*/
  const [activeTool, setActiveTool] = useState<OverlayToolName | null>(null);
  /** 被选中的画线 overlay id（图表 overlay id == 持久化记录 id 的字符串形式）*/
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  /** 画线提示（落点非法 / 保存失败等）*/
  const [overlayNotice, setOverlayNotice] = useState<string | null>(null);
  /** 本次重放被跳过的标注条数（timestamp 不在当前 bar 集合）；0 ⇒ 不渲染提示 */
  const [skippedOverlayCount, setSkippedOverlayCount] = useState(0);
  /** 文字标注输入内容（仅 `simpleAnnotation` 使用）*/
  const [annotationText, setAnnotationText] = useState('');
  /** 正在绘制中的 overlay id（切换工具 / 取消时移除）*/
  const drawingOverlayIdRef = useRef<string | null>(null);
  /** 页面注入的落库回调（避免绘制回调闭包拿到过期引用）*/
  const overlayHandlersRef = useRef({ onCreateOverlay, onDeleteOverlay });
  overlayHandlersRef.current = { onCreateOverlay, onDeleteOverlay };

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

        registerCustomIndicators(kc, paramsRef.current, getBars);

        const chart = kc.init(container, { styles: CHART_STYLES, locale: 'zh-CN' });
        if (!chart) throw new Error('klinecharts init 未返回实例');
        chartRef.current = chart;

        // 🔴 Wave 7 卡 6：修正**库注入**的图表容器的两个 a11y 缺陷（**不改库**）
        //
        // ① klinecharts 在 `_createContainer()` 里给自己的容器设了 `tabIndex = 1`
        //    ⇒ 正数 tabindex 会**打断浏览器的自然 Tab 顺序**（axe 规则 `tabindex`：
        //    「tabindex attribute values are not greater than 0」—— **serious**）。
        // ② 该容器是**无 role 的裸 `<div>`** ⇒ 给它一个图形语义（`role="img"`）+
        //    可访问名，读屏聚焦时能听到「K 线图，图像」而不是一个无名 group。
        //
        // ⚠️ **不修改 node_modules 里的库**，只在包装层修正它创建出来的 DOM 属性
        //    （库不提供该选项，改库会让升级即丢）。
        const libChartContainer = container.firstElementChild as HTMLElement | null;
        if (libChartContainer) {
          if (libChartContainer.hasAttribute('tabindex')) {
            libChartContainer.setAttribute('tabindex', '0');
          }
          if (!libChartContainer.getAttribute('role')) {
            libChartContainer.setAttribute('role', 'img');
            libChartContainer.setAttribute('aria-label', 'K 线图');
          }
        }

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
        // 图表里装的就是当前这份原始数据 ⇒ 记下指纹（之后只有指纹变了才重新取数）
        loadedSignatureRef.current = signatureRef.current;

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

        // 交易标记（T152；自绘圆点，走指标的自定义 draw 回调）
        ensureIndicator(
          chart,
          TRADE_INDICATOR.name,
          (c) => {
            c.createIndicator(
              {
                name: TRADE_INDICATOR.name,
                paneId: CANDLE_PANE_ID,
                series: 'price',
              },
              true,
            );
          },
          showTrades,
        );

        // 形态标注（双顶/双底；由 bars[].patterns 驱动，无形态时不绘制）
        ensureIndicator(
          chart,
          PATTERN_INDICATOR_NAME,
          (c) => {
            c.createIndicator(
              {
                name: PATTERN_INDICATOR_NAME,
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
    loadedSignatureRef.current = signatureRef.current;
  }, [symbol, period, ready]);

  /**
   * 🔴 T71：数据变化 vs 参数变化 —— **两条路径严格分开**
   *
   * - **原始数据变了**（`dataSignature` 变了）→ `chart.resetData()`
   *   ⇒ 重新走一次内存数据加载器（`getBars`）—— 这是「换标的 / 换复权 / 换周期」。
   * - **只有指标参数变了**（`dataSignature` 没变）→ **不取数**，
   *   只用 `chart.overrideIndicator(...)` 覆盖各指标的 `calc` / `figures` / `draw`
   *   ⇒ 库在微任务里重算并重绘。
   *
   * ⇒ **改参数不会再次调用数据加载器，更不会发网络请求**（PRD §5.2「零网络请求」）。
   */
  const applyIndicatorParams = useCallback(
    (chart: Chart, next: IndicatorParams) => {
      // ① 重新注册带参数的模板（MA 周期 / RSI 阈值）—— 后续 `createIndicator` 用新参数
      const kc = kcRef.current;
      if (kc) {
        kc.registerIndicator(createMaIndicator(next.ma.periods, getBars));
        kc.registerIndicator(createMacdIndicator(getBars));
        kc.registerIndicator(
          createRsiIndicator(next.rsi.period, next.rsi.overbought, next.rsi.oversold, getBars),
        );
        kc.registerIndicator(createKdjIndicator(getBars));
      }

      // ② 覆盖已存在的指标 ⇒ 重算 + 重绘
      //    ⚠️ 每次都新建闭包：klinecharts 用 `prev.calc !== current.calc` 判断是否重算，
      //       传同一个函数引用会被判成「没变」⇒ 不重算。
      chart.overrideIndicator({
        name: MA_INDICATOR.name,
        calc: (dataList: KLineData[]) => calcMa(dataList, barsRef.current),
        figures: maFigures(next.ma.periods),
      });
      chart.overrideIndicator({
        name: MACD_INDICATOR.name,
        calc: (dataList: KLineData[]) => calcMacd(dataList, barsRef.current),
      });
      chart.overrideIndicator({
        name: RSI_INDICATOR.name,
        calc: (dataList: KLineData[]) => calcRsi(dataList, barsRef.current),
        draw: ({ ctx, chart: c, xAxis, yAxis }) =>
          drawRsiThresholds(ctx, c, xAxis, yAxis, next.rsi.overbought, next.rsi.oversold),
      });
      chart.overrideIndicator({
        name: KDJ_INDICATOR.name,
        calc: (dataList: KLineData[]) => calcKdj(dataList, barsRef.current),
      });
      // 形态标注：形态请求**晚于** K 线返回，不会改变数据指纹（不触发 `resetData`），
      // 故必须在这里用新闭包覆盖 calc 触发重算 + 重绘（`draw` 内部读 `getBars` 取最新形态）。
      chart.overrideIndicator({
        name: PATTERN_INDICATOR_NAME,
        calc: (dataList: KLineData[]) => calcPatterns(dataList, barsRef.current),
      });
    },
    [getBars],
  );

  /* ---------------- 数据变化 → 重新灌值；参数变化 → 只重算指标 ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    // ① 原始数据变了 ⇒ 重新取数（内存 loader）
    if (loadedSignatureRef.current !== dataSignature) {
      loadedSignatureRef.current = dataSignature;
      chart.resetData();
    }

    // ② 参数可能也变了 ⇒ 重算指标（**不碰数据加载器** ⇒ 零网络请求）
    applyIndicatorParams(chart, params);
  }, [bars, dataSignature, params, ready, applyIndicatorParams]);

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

  /** 交易标记几何（点击命中用；与自绘 draw 使用同一套计算） */
  const _tradeMarkers = useMemo(() => {
    if (!showTrades || !chartRef.current) {
      tradeMarkersRef.current = [];
      return [];
    }
    try {
      const chart = chartRef.current;
      const yAxis = chart.getYAxes({ paneId: CANDLE_PANE_ID })[0];
      if (!yAxis) {
        tradeMarkersRef.current = [];
        return [];
      }
      const result = computeTradeMarkerPositions(
        bars,
        (index) => {
          const converted = chart.convertToPixel(
            { dataIndex: index, value: 0 },
            { paneId: CANDLE_PANE_ID },
          ) as Partial<import('klinecharts').Coordinate>;
          return converted.x ?? Number.NaN;
        },
        (value) => yAxis.convertToPixel(value),
      );
      tradeMarkersRef.current = result;
      return result;
    } catch {
      // jsdom / fakeCanvas 环境 getYAxes / convertToPixel 不可用，静默降级
      tradeMarkersRef.current = [];
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, showTrades, ready]);

  const hovered = hoverIndex !== null ? bars[hoverIndex] : null;
  const selectedTradeBar = selectedTradeBarIndex !== null ? bars[selectedTradeBarIndex] : null;

  const handleChartClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // 用 getBoundingClientRect 取容器在视口中的绝对坐标，
    // 再换算为容器内的局部坐标，避免 canvas 因 padding/margin 与容器原点不一致
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const marker = findTradeMarkerAtPoint(localX, localY, () => tradeMarkersRef.current);
    if (marker) {
      setSelectedTradeBarIndex(marker.index);
      return;
    }
    setSelectedTradeBarIndex(null);
  }, []);

  const closeTradePanel = useCallback(() => {
    setSelectedTradeBarIndex(null);
  }, []);

  /* ---------------- 全屏（原生 Fullscreen API，不引入第三方库） ---------------- */

  /** 进入 / 退出全屏；浏览器拒绝（非用户手势、iframe 策略）时保持原布局 */
  const toggleFullscreen = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      if (document.fullscreenElement === wrapper) {
        await document.exitFullscreen();
        return;
      }
      if (typeof wrapper.requestFullscreen !== 'function') return;
      await wrapper.requestFullscreen();
    } catch {
      // 全屏不可用/被拒绝：不做任何事（按钮仍显示「全屏」）
    }
  }, []);

  // 用 `fullscreenchange` 同步状态 —— **Esc 退出、浏览器自身退出**都会走到这里，
  // 因此不能只靠按钮点击来翻转 `isFullscreen`。
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 进出全屏后容器尺寸变了：显式 `resize()` 兜底
  // （组件内已有 ResizeObserver，但全屏切换在部分浏览器里不触发它）
  useEffect(() => {
    if (!ready) return;
    chartRef.current?.resize();
  }, [isFullscreen, ready]);

  /* ---------------- 手工画线（5 个内置模板） ---------------- */

  /** 「删除选中标注」只对已落库的记录可用（绘制中的临时 overlay id 不在 overlays 里）*/
  const selectedIsPersisted = overlays.some((item) => String(item.id) === selectedOverlayId);
  /** 当前工具需要的落点数（提示文案用）*/
  const activePointCount = activeTool ? (getOverlayTool(activeTool)?.pointCount ?? 0) : 0;

  /**
   * 绘制结束：落点校验（**timestamp 必须落在已有 bar 上**）→ 落库；失败则从图上移除
   *
   * 🔒 复权口径写死不复权（bfq）：`points.value` 就是图上当时显示的成交价。
   */
  const finishOverlayDrawing = useCallback(
    async (
      tool: OverlayToolName,
      overlay: { id: string; points?: ReadonlyArray<{ timestamp?: number; value?: number }> },
    ) => {
      const chart = chartRef.current;
      setActiveTool(null);
      drawingOverlayIdRef.current = null;
      // 测试环境可能存在不完整的 chart 替身：缺 removeOverlay 时只做提示，不炸页面
      const removeChartOverlay = (id: string) => {
        if (typeof chart?.removeOverlay === 'function') chart.removeOverlay({ id });
      };

      const points = overlayPointsFromChart(overlay);
      const text = tool === 'simpleAnnotation' ? annotationText.trim() || DEFAULT_ANNOTATION_TEXT : null;
      const draft: OverlayDraft = {
        symbol,
        period,
        name: tool,
        points: points ?? [],
        text,
      };
      const error = validateOverlayDraft(draft, collectBarTimestamps(barsRef.current));
      if (error) {
        removeChartOverlay(overlay.id);
        setOverlayNotice(error);
        return;
      }

      const handler = overlayHandlersRef.current.onCreateOverlay;
      if (!handler) {
        removeChartOverlay(overlay.id);
        setOverlayNotice('画线保存不可用');
        return;
      }

      const result = await handler(draft);
      if (!result.ok) {
        removeChartOverlay(overlay.id);
        setOverlayNotice(result.message ?? '画线保存失败');
        return;
      }
      setOverlayNotice(null);
    },
    [annotationText, period, symbol],
  );

  /** 点击工具 → 进入绘制态（`createOverlay` 不传 `points` 即开始取点）*/
  const startOverlayDrawing = useCallback(
    (tool: OverlayToolName) => {
      const chart = chartRef.current;
      if (!chart || !overlaysEnabled || typeof chart.createOverlay !== 'function') return;
      if (drawingOverlayIdRef.current) {
        chart.removeOverlay({ id: drawingOverlayIdRef.current });
        drawingOverlayIdRef.current = null;
      }
      setSelectedOverlayId(null);
      setOverlayNotice(null);
      setActiveTool(tool);
      const createdId = chart.createOverlay({
        name: tool,
        paneId: CANDLE_PANE_ID,
        needDefaultPointFigure: true,
        onDrawEnd: (event) => {
          void finishOverlayDrawing(
            tool,
            event.overlay as unknown as {
              id: string;
              points?: ReadonlyArray<{ timestamp?: number; value?: number }>;
            },
          );
        },
      });
      drawingOverlayIdRef.current = typeof createdId === 'string' ? createdId : null;
    },
    [finishOverlayDrawing, overlaysEnabled],
  );

  /** 删除选中的已持久化标注（后端软删除）*/
  const deleteSelectedOverlay = useCallback(async () => {
    if (!selectedOverlayId) return;
    const handler = overlayHandlersRef.current.onDeleteOverlay;
    const id = Number(selectedOverlayId);
    if (!handler || !Number.isInteger(id)) return;
    const result = await handler(id);
    if (!result.ok) {
      setOverlayNotice(result.message ?? '删除画线失败');
      return;
    }
    const chart = chartRef.current;
    if (typeof chart?.removeOverlay === 'function') chart.removeOverlay({ id: selectedOverlayId });
    setSelectedOverlayId(null);
    setOverlayNotice(null);
  }, [selectedOverlayId]);

  /**
   * 重放已持久化的画线
   *
   * - 只重放 `timestamp` 能对应当前 bar 集合的标注（对不上的**跳过**，不删除）；
   * - 标的 / 周期 / 原始数据变化后重新同步（先清主图 overlay，再按可重放列表重建）。
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;
    // 测试替身可能不完整：缺 overlay 能力时直接跳过重放（不影响 K 线渲染）
    if (typeof chart.removeOverlay !== 'function' || typeof chart.createOverlay !== 'function') {
      return;
    }
    chart.removeOverlay({ paneId: CANDLE_PANE_ID });
    setSelectedOverlayId(null);
    if (!overlaysEnabled) {
      setSkippedOverlayCount(0);
      return;
    }

    const barTimestamps = collectBarTimestamps(barsRef.current);
    // 跳过条数随每次重放自然更新（含清空），不额外弹窗，避免「每次绘制都弹」
    setSkippedOverlayCount(countSkippedOverlays(overlays, barTimestamps, { symbol, period }));
    const replayable = filterReplayableOverlays(overlays, barTimestamps);
    for (const item of replayable) {
      chart.createOverlay({
        ...buildOverlayCreate(item, CANDLE_PANE_ID),
        onSelected: (event) => setSelectedOverlayId(event.overlay.id),
        onDeselected: (event) => setSelectedOverlayId((prev) => (prev === event.overlay.id ? null : prev)),
      });
    }
  }, [ready, symbol, period, dataSignature, overlays, overlaysEnabled]);

  return (
    <div
      ref={wrapperRef}
      data-testid="kline-chart-wrapper"
      style={{
        position: 'relative',
        width: '100%',
        // 全屏元素默认铺满屏幕；显式给 `100%` 保证内部容器能拿到可用高度
        height: isFullscreen ? '100%' : undefined,
        background: isFullscreen ? COLORS.chartBg : undefined,
      }}
    >
      {/* 手工画线工具栏（5 个内置模板）：仅**不复权（bfq）**口径可用 */}
      <div
        data-testid="kline-overlay-toolbar"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary }}>画线：</span>
        {OVERLAY_TOOLS.map((tool) => {
          const active = activeTool === tool.name;
          return (
            <button
              key={tool.name}
              type="button"
              data-testid={`kline-overlay-tool-${tool.name}`}
              aria-pressed={active}
              disabled={!overlaysEnabled}
              onClick={() => startOverlayDrawing(tool.name)}
              title={
                overlaysEnabled ? `点击后在图上按 ${tool.pointCount} 个落点` : '画线仅支持「不复权」口径'
              }
              style={{
                padding: '2px 8px',
                fontSize: TYPO.captionSize,
                color: active ? COLORS.brand : COLORS.textSecondary,
                background: active ? COLORS.brandBg : 'transparent',
                border: `1px solid ${active ? COLORS.brand : COLORS.borderMedium}`,
                borderRadius: 4,
                cursor: overlaysEnabled ? 'pointer' : 'not-allowed',
                opacity: overlaysEnabled ? 1 : 0.55,
              }}
            >
              {tool.label}
            </button>
          );
        })}
        {activeTool === 'simpleAnnotation' && (
          <input
            data-testid="kline-overlay-text"
            aria-label="标注文字"
            placeholder="标注文字（留空用默认）"
            value={annotationText}
            maxLength={120}
            onChange={(event) => setAnnotationText(event.target.value)}
            style={{
              width: 160,
              padding: '2px 6px',
              fontSize: TYPO.captionSize,
              color: COLORS.textPrimary,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.borderMedium}`,
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        )}
        <button
          type="button"
          data-testid="kline-overlay-delete"
          disabled={!selectedIsPersisted}
          onClick={() => void deleteSelectedOverlay()}
          title="在图上点选一条标注后删除"
          style={{
            padding: '2px 8px',
            fontSize: TYPO.captionSize,
            color: selectedIsPersisted ? COLORS.danger : COLORS.textTertiary,
            background: 'transparent',
            border: `1px solid ${selectedIsPersisted ? COLORS.danger : COLORS.borderMedium}`,
            borderRadius: 4,
            cursor: selectedIsPersisted ? 'pointer' : 'not-allowed',
            opacity: selectedIsPersisted ? 1 : 0.55,
          }}
        >
          删除选中标注
        </button>
        {activeTool && (
          <span
            data-testid="kline-overlay-hint"
            style={{ fontSize: TYPO.captionSize, color: COLORS.textSecondary }}
          >
            绘制中：请在图上按 {activePointCount} 个落点
          </span>
        )}
        {!overlaysEnabled && (
          <span
            data-testid="kline-overlay-disabled-hint"
            style={{ fontSize: TYPO.captionSize, color: COLORS.textTertiary }}
          >
            画线仅支持「不复权」口径
          </span>
        )}
        {overlaysEnabled && skippedOverlayCount > 0 && (
          <span
            // 信息性提示 ⇒ `status`（不是 `alert`：不打断屏幕阅读器朗读，也不与错误提示抢角色）
            role="status"
            data-testid="kline-overlay-skip-hint"
            style={{ fontSize: TYPO.captionSize, color: COLORS.textTertiary }}
          >
            当前周期有 {skippedOverlayCount} 条标注不适用已隐藏
          </span>
        )}
        {overlayNotice && (
          <span
            role="alert"
            data-testid="kline-overlay-notice"
            style={{ fontSize: TYPO.captionSize, color: COLORS.danger }}
          >
            {overlayNotice}
          </span>
        )}
      </div>

      {/*
        🔴 **图表区容器**（`position: relative`）
        —— 十字光标 hover 浮窗**必须定位在这里**（而不是外层 wrapper）：
        外层 wrapper 的顶部是「画线工具栏」，浮窗若挂在 wrapper 上（`top: 8`）
        会**盖住画线工具按钮**（窄屏时工具栏还会折行 ⇒ 盖得更狠）。
        挂到图表区容器上 ⇒ 浮窗永远落在**画布左上角**，工具栏始终可点。
      */}
      <div
        data-testid="kline-chart-area"
        style={{
          position: 'relative',
          width: '100%',
          // 全屏时与图表容器同高（退出后随容器高度自适应）
          height: isFullscreen ? '100%' : undefined,
        }}
      >
        <div
          ref={containerRef}
          data-testid="kline-chart-container"
          onClick={handleChartClick}
          // 🔴 `role="figure"` —— 裸 `<div aria-label="K 线图">` 上挂 `aria-label` 会踩
          //    axe 规则 `aria-prohibited-attr`（serious）：
          //    「aria-label attribute cannot be used on "div" elements with no valid role attribute」。
          //    `figure` 允许「作者提供的可访问名」，且**不会**把子节点整体设为 presentational
          //    （不像 `role="img"`），故图表容器内部仍可保留自己的语义。
          role="figure"
          aria-label="K 线图"
          style={{
            width: '100%',
            // 全屏时跟随 `wrapperRef`（:fullscreen ⇒ 100vh），退出后复原为 prop 高度
            height: isFullscreen ? '100%' : height,
            background: COLORS.chartBg,
            border: `1px solid ${COLORS.chartBorder}`,
            borderRadius: 4,
            overflow: 'hidden',
            touchAction: 'none',
            boxSizing: 'border-box',
          }}
        />

        {/* 十字光标 hover 悬浮窗：当日 OHLCV + 指标值 + 当日信号（F-K6 / F-K8）*/}
        <KlineHoverPanel
          bar={hovered}
          showMa={showMa}
          subIndicator={subIndicator}
          maPeriods={params.ma.periods}
        />

        {/* T152：点击交易圆点后的交易明细（移动端也通过点击打开）*/}
        <KlineTradePanel bar={selectedTradeBar} onClose={closeTradePanel} />

        {/*
          全屏切换（浏览器 Fullscreen API）：Esc 退出由 `fullscreenchange` 同步布局

          ⚠️ **样式必须是「实心品牌色 + 白字」** —— 旧实现是
          `rgba(0,0,0,0.45)` 底 + `#888` 灰字 + 11px 小字，压在深色画布上**几乎看不见**。
          现在改成实心蓝底 + 白字 + 阴影，图表右上角一眼可辨。

          ⚠️ **挂在图表区容器里**（不是外层 wrapper）⇒ 按钮浮在**画布**右上角，
          不会压住上方那排「画线」工具按钮（挂 wrapper 上时它与工具栏同高、会盖住右端的提示文字）。
        */}
        <button
          type="button"
          data-testid="kline-fullscreen-toggle"
          aria-label={isFullscreen ? '退出全屏' : '全屏'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? '退出全屏（Esc）' : '全屏查看'}
          onClick={() => void toggleFullscreen()}
          style={{
            position: 'absolute',
            top: 8,
            // 让开右侧价格轴（约 60px 宽），避免按钮盖住刻度文字
            right: 68,
            zIndex: 20,
            padding: '6px 14px',
            fontSize: TYPO.smallSize,
            fontWeight: 600,
            color: COLORS.cardBg,
            background: COLORS.brand,
            border: 'none',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.45)',
            cursor: 'pointer',
          }}
        >
          {isFullscreen ? '退出全屏' : '全屏'}
        </button>
      </div>

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
    </div>
  );
}
