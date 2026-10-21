/**
 * K 线图的自定义指标定义（T70 · SDD §2.5「只画不算」）
 *
 * ## 🔴 铁律：klinecharts 的**内置指标一律不用**
 *
 * klinecharts@10.1.0 自带 `MA` / `MACD` / `RSI` / `KDJ`（内部叫 `KDJ` 的那个是
 * 美式 Stochastic 口径，与 A 股通达信口径**不同**）。若直接 `createIndicator('MA')`，
 * 就会形成「后端 core 算一套 + 前端库算一套」的**双口径** —— 与当初否决
 * `technicalindicators` 是同一类问题。
 *
 * ⇒ 本文件注册**自定义**指标（名字统一 `APP_` 前缀），`calc` **只把前端算好的值原样吐回去**，
 *    库不参与任何计算。
 *
 * ```ts
 * calc: (dataList) => dataList.map((d) => ({ ma5: d.ma5, ... }))
 * ```
 *
 * ## 为什么 `calc` 里不自己算
 *
 * `calc(dataList, indicator)` 拿到的 `dataList` 就是我们经 `getBars` 灌进去的
 * **已加工 K 线**（每根都带 `ma5` / `dif` / `rsi` / `k` 等字段，见 `chartBars.ts`）。
 * 故 `calc` 只是一次「字段搬运」—— 数值口径由 `chartBars.ts` 统一负责，
 * 前后端一致性由 golden 断言兜底。
 *
 * ## 灌值契约（测试要点 ①「逐位相等」）
 *
 * `chart.getIndicators()` 读回的 `result[i][key]` 必须与**前端算出的值逐位相同**
 * （含 NaN 的位置）。故本文件**不做任何 NaN → undefined 的转换**：
 * klinecharts 内部的 `isNumber()` 判定为「有限数」，NaN 会被自动跳过
 * （既不进 y 轴范围，也不画线段）—— 这正是历史缺陷 I-23 的正解。
 */

import type { DeepPartial, IndicatorFigure, IndicatorTemplate, KLineData } from 'klinecharts';
import { COLORS } from '../theme/tokens';
import type { ChartBar } from './chartBars';
import { MA_FIELD_KEYS } from './chartParams';

/* ------------------------------------------------------------------ *
 * 结果类型
 * ------------------------------------------------------------------ */

/**
 * MA（4 条线）主图叠加
 *
 * ⚠️ 字段名是**线序号**（`ma1`~`ma4`）而不是周期 —— 周期可编辑（T71），
 *    写死成 `ma5` 会在周期被改后变成谎言。周期见 `IndicatorParams.ma.periods`。
 */
export interface MaIndicatorResult {
  ma1: number;
  ma2: number;
  ma3: number;
  ma4: number;
}

/** MACD(12,26,9) */
export interface MacdIndicatorResult {
  dif: number;
  dea: number;
  macd: number;
}

/** RSI(14) */
export interface RsiIndicatorResult {
  rsi: number;
}

/** KDJ(9,3,3) */
export interface KdjIndicatorResult {
  k: number;
  d: number;
  j: number;
}

/** 成交量 */
export interface VolIndicatorResult {
  volume: number;
  /** 当根的 open —— 只为柱子的涨跌配色（与蜡烛同色系）*/
  open: number;
  /** 当根的 close */
  close: number;
}

/* ------------------------------------------------------------------ *
 * 指标模板
 * ------------------------------------------------------------------ */

/**
 * MA 四条线 —— **主图叠加**（`series: 'price'`）
 *
 * ⚠️ 主图叠加的指标必须 `paneId: 'candle_pane'`（见 `KlineChart.tsx` 的创建处）。
 */

/**
 * 取值来源（**bars 提供者**）
 *
 * 指标值由页面算好后灌在 K 线的扩展字段里（`chartBars.buildChartBars`）。
 * 图表里的指标要读到**最新**那份值 ⇒ 需要一个能拿到最新 bars 的函数。
 *
 * ⚠️ **为什么不能直接读图表自己的数据列表**：
 *    图表的数据列表只在 `resetData`（换标的 / 换复权 / 换周期）时刷新；
 *    改指标参数时我们**刻意不重新取数**（PRD §5.2「零网络请求」）⇒
 *    数据列表里挂的还是**旧**的指标字段。
 *    ⇒ 模板必须绑定一个「最新 bars」提供者，否则会出现
 *    「参数改了但后来新建的指标（切副图 Tab）显示旧值」的缺陷。
 */
export type BarsProvider = () => readonly ChartBar[];

/** 取值来源的缺省实现：直接用图表数据列表自带的那份（standalone / 单测场景）*/
function barsFromDataList(dataList: KLineData[]): readonly ChartBar[] {
  return dataList as unknown as ChartBar[];
}

/**
 * MA 的 figure 定义（标题里带**当前周期** —— 周期可编辑，故要能随参数重建）
 *
 * ⚠️ 泛型 `D` 只为同时满足两处类型：
 * - 指标模板要求 `IndicatorFigure<MaIndicatorResult>[]`；
 * - `chart.overrideIndicator` 的入参是 `IndicatorCreate`（默认泛型 `unknown`）⇒ 要求 `IndicatorFigure<unknown>[]`。
 *
 * klinecharts 的泛型在 `attrs`/`styles` 回调上是**不变**的（参数逆变），
 * 而本函数产出的对象**根本没有** `attrs`/`styles` ⇒ 这里的转换是安全的。
 */
export function maFigures<D = MaIndicatorResult>(periods: readonly number[]): IndicatorFigure<D>[] {
  const figures = periods.slice(0, MA_FIELD_KEYS.length).map((period, i) => ({
    key: MA_FIELD_KEYS[i],
    title: `MA${period}: `,
    type: 'line',
  }));
  return figures as IndicatorFigure<D>[];
}

/** 从 K 线数组里取 MA 值（**字段搬运**，数值由 `chartBars.buildChartBars` 算好）*/
export function calcMa(dataList: KLineData[], bars: readonly ChartBar[]): MaIndicatorResult[] {
  return dataList.map((bar, i) => {
    const b = bars[i] ?? (bar as unknown as ChartBar);
    return { ma1: b.ma1, ma2: b.ma2, ma3: b.ma3, ma4: b.ma4 };
  });
}

/**
 * MA 指标模板（周期可编辑 ⇒ 按周期重建；figure 标题里带周期）
 *
 * @param getBars 最新 bars 的提供者（缺省 = 图表数据列表自带的那份）
 */
export function createMaIndicator(
  periods: readonly number[],
  getBars?: BarsProvider,
): IndicatorTemplate<MaIndicatorResult> {
  return {
    name: 'APP_MA',
    shortName: `MA(${periods.join('/')})`,
    series: 'price',
    precision: 2,
    shouldOhlc: false,
    figures: maFigures(periods),
    calc: (dataList: KLineData[]) => calcMa(dataList, getBars ? getBars() : barsFromDataList(dataList)),
  };
}

/** MA 指标模板（默认周期 5/10/20/60）*/
export const MA_INDICATOR: IndicatorTemplate<MaIndicatorResult> = createMaIndicator([5, 10, 20, 60]);

/** 从 K 线数组里取 MACD 三线值（字段搬运）*/
export function calcMacd(dataList: KLineData[], bars: readonly ChartBar[]): MacdIndicatorResult[] {
  return dataList.map((bar, i) => {
    const b = bars[i] ?? (bar as unknown as ChartBar);
    return { dif: b.dif, dea: b.dea, macd: b.macd };
  });
}

/**
 * MACD 指标模板（副图）
 *
 * ⚠️ MACD 的**参数**（fast/slow/signal）不体现在 figure 上（标题恒为 `DIF/DEA/MACD`），
 *    但**数值**随参数变 ⇒ 取值来源必须绑定「最新 bars」（见 {@link BarsProvider}）。
 */
export function createMacdIndicator(getBars?: BarsProvider): IndicatorTemplate<MacdIndicatorResult> {
  return {
    name: 'APP_MACD',
    shortName: 'MACD',
    series: 'normal',
    precision: 4,
    figures: [
      { key: 'dif', title: 'DIF: ', type: 'line' },
      { key: 'dea', title: 'DEA: ', type: 'line' },
      {
        key: 'macd',
        title: 'MACD: ',
        type: 'bar',
        baseValue: 0,
        // 正柱红 / 负柱绿（A 股口径，与蜡烛同色系）
        // ⚠️ 不给这个回调的话柱子会全灰（默认取 `noChangeColor`）
        styles: ({ data, indicator, defaultStyles }) => {
          const current = data.current as unknown as ChartBar | null;
          const prev = data.prev as unknown as ChartBar | null;
          const value = current && Number.isFinite(current.macd) ? current.macd : 0;
          const prevValue = prev && Number.isFinite(prev.macd) ? prev.macd : value;
          const upColor = indicator.styles?.bars?.[0]?.upColor ?? defaultStyles?.bars?.[0]?.upColor;
          const downColor = indicator.styles?.bars?.[0]?.downColor ?? defaultStyles?.bars?.[0]?.downColor;
          const color = value > 0 ? upColor : value < 0 ? downColor : COLORS.chartText;
          return { style: prevValue < value ? 'stroke' : 'fill', color, borderColor: color };
        },
      },
    ],
    calc: (dataList: KLineData[]) => calcMacd(dataList, getBars ? getBars() : barsFromDataList(dataList)),
  };
}

/** MACD 指标模板（默认：取图表数据列表自带的那份）*/
export const MACD_INDICATOR: IndicatorTemplate<MacdIndicatorResult> = createMacdIndicator();

/** 从 K 线数组里取 RSI 值（字段搬运）*/
export function calcRsi(dataList: KLineData[], bars: readonly ChartBar[]): RsiIndicatorResult[] {
  return dataList.map((bar, i) => {
    const b = bars[i] ?? (bar as unknown as ChartBar);
    return { rsi: b.rsi };
  });
}

/** RSI 超买参考线颜色（红 = 涨过头）*/
export const RSI_OVERBOUGHT_COLOR = COLORS.candleUp;
/** RSI 超卖参考线颜色（绿 = 跌过头）*/
export const RSI_OVERSOLD_COLOR = COLORS.candleDown;
/** RSI 参考线的虚线样式 */
export const RSI_THRESHOLD_DASH = [4, 4];

/**
 * 画 RSI 的超买 / 超卖参考线
 *
 * ⚠️ 阈值是**闭包捕获**的 ⇒ 阈值改了必须用新的 `draw` 重建指标（T71）。
 *
 * @returns 恒为 `false` —— 不拦截库的默认绘制
 */
export function drawRsiThresholds(
  ctx: CanvasRenderingContext2D,
  chart: { getVisibleRange: () => { from: number; to: number } },
  xAxis: { convertToPixel: (index: number) => number },
  yAxis: { convertToPixel: (value: number) => number },
  overbought: number,
  oversold: number,
): boolean {
  const visible = chart.getVisibleRange();
  const x1 = xAxis.convertToPixel(visible.from);
  const x2 = xAxis.convertToPixel(visible.to);
  if (!Number.isFinite(x1) || !Number.isFinite(x2)) return false;

  const lines: Array<{ value: number; color: string }> = [
    { value: overbought, color: RSI_OVERBOUGHT_COLOR },
    { value: oversold, color: RSI_OVERSOLD_COLOR },
  ];

  ctx.save();
  ctx.setLineDash(RSI_THRESHOLD_DASH);
  ctx.lineWidth = 1;
  for (const line of lines) {
    const y = yAxis.convertToPixel(line.value);
    if (!Number.isFinite(y)) continue;
    ctx.strokeStyle = line.color;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
  }
  ctx.restore();
  return false;
}

/**
 * RSI 指标模板（阈值可编辑 ⇒ 需要按阈值重建）
 *
 * `minValue: 0` / `maxValue: 100` —— RSI 取值域固定 0~100，
 * 固定住 y 轴才能保证超买/超卖参考线**始终可见**（否则线会跑到画布外）。
 */
export function createRsiIndicator(
  period: number,
  overbought: number,
  oversold: number,
  getBars?: BarsProvider,
): IndicatorTemplate<RsiIndicatorResult> {
  return {
    name: 'APP_RSI',
    shortName: `RSI(${period})`,
    series: 'normal',
    precision: 2,
    minValue: 0,
    maxValue: 100,
    figures: [{ key: 'rsi', title: 'RSI: ', type: 'line' }],
    calc: (dataList: KLineData[]) => calcRsi(dataList, getBars ? getBars() : barsFromDataList(dataList)),
    draw: ({ ctx, chart, xAxis, yAxis }) => drawRsiThresholds(ctx, chart, xAxis, yAxis, overbought, oversold),
  };
}

/** RSI 指标模板（默认周期 14 / 超买 70 / 超卖 30）*/
export const RSI_INDICATOR: IndicatorTemplate<RsiIndicatorResult> = createRsiIndicator(14, 70, 30);

/** 从 K 线数组里取 KDJ 三线值（字段搬运）*/
export function calcKdj(dataList: KLineData[], bars: readonly ChartBar[]): KdjIndicatorResult[] {
  return dataList.map((bar, i) => {
    const b = bars[i] ?? (bar as unknown as ChartBar);
    return { k: b.k, d: b.d, j: b.j };
  });
}

/**
 * KDJ 指标模板（副图，**A 股口径**，前端手写实现）
 *
 * ⚠️ 数值随 N/M1/M2 变 ⇒ 取值来源绑定「最新 bars」（见 {@link BarsProvider}）。
 */
export function createKdjIndicator(getBars?: BarsProvider): IndicatorTemplate<KdjIndicatorResult> {
  return {
    name: 'APP_KDJ',
    shortName: 'KDJ',
    series: 'normal',
    precision: 2,
    figures: [
      { key: 'k', title: 'K: ', type: 'line' },
      { key: 'd', title: 'D: ', type: 'line' },
      { key: 'j', title: 'J: ', type: 'line' },
    ],
    calc: (dataList: KLineData[]) => calcKdj(dataList, getBars ? getBars() : barsFromDataList(dataList)),
  };
}

/** KDJ 指标模板（默认：取图表数据列表自带的那份）*/
export const KDJ_INDICATOR: IndicatorTemplate<KdjIndicatorResult> = createKdjIndicator();

/** 成交量 —— 副图（原始字段，无需计算）*/
export const VOL_INDICATOR: IndicatorTemplate<VolIndicatorResult> = {
  name: 'APP_VOL',
  shortName: 'VOL',
  series: 'volume',
  precision: 0,
  figures: [
    {
      key: 'volume',
      title: '成交量: ',
      type: 'bar',
      baseValue: 0,
      // 涨跌配色（与蜡烛同色系：红涨绿跌）—— 不给 styles 回调的话柱子全是灰的
      styles: ({ data }) => {
        // ⚠️ `data.current` 是**指标 result**（不是原始 K 线）→ 必须由 calc 带出 open/close
        const current = data.current as unknown as VolIndicatorResult | null;
        const color = current && current.close >= current.open ? COLORS.candleUp : COLORS.candleDown;
        return { style: 'fill', color, borderColor: color };
      },
    },
  ],
  calc: (dataList: KLineData[]) =>
    dataList.map((bar) => {
      const b = bar as unknown as ChartBar;
      return { volume: b.volume ?? 0, open: b.open, close: b.close };
    }),
};

/**
 * 信号标记 —— **主图叠加**（不走 figures，走自定义 `draw`）
 *
 * ⚠️ **必须 `registerIndicator` 注册后才能 `createIndicator`** ——
 *    `createIndicator` 会先 `getIndicatorClass(name)`，未注册的名字直接返回 null
 *    （只打一条 warn，**不抛异常**）⇒ 标记**静默不显示**（实测踩过）。
 *
 * 用 `draw` 而不是 `figures` 的原因：信号要画成**三角形**（`figures` 只有
 * line / bar / circle / text / arc / polygon / path，其中 text 只能画文字）。
 */
export const SIGNAL_INDICATOR: IndicatorTemplate<Record<string, never>> = {
  name: 'APP_SIGNAL',
  shortName: 'SIGNAL',
  series: 'price',
  figures: [],
  calc: (dataList: KLineData[]) => dataList.map(() => ({})),
  draw: ({ ctx, chart, xAxis, yAxis }) => {
    const list = chart.getDataList() as unknown as ChartBar[];
    const markers = computeSignalMarkerPositions(
      list,
      (index) => xAxis.convertToPixel(index),
      (value) => yAxis.convertToPixel(value),
    );
    markers.forEach((marker) => drawSignalMarker(ctx, marker));
    return false;
  },
};

/* ------------------------------------------------------------------ *
 * 信号标记几何计算（可单测的纯函数）
 * ------------------------------------------------------------------ */

/** 一个信号标记的绘制位置 */
export interface SignalMarkerGeometry {
  /** 在 K 线数组中的下标（= 与 `trade_date` 对齐的那一根）*/
  index: number;
  /** 交易日 */
  date: string;
  /** 屏幕 x 坐标 */
  x: number;
  /** 屏幕 y 坐标 */
  y: number;
  /** `buy` / `sell` / 其它 */
  direction: string;
  /** 标记颜色（PRD §5.2：买入绿 / 卖出红）*/
  color: string;
}

/** 买入标记颜色（绿）*/
export const SIGNAL_BUY_COLOR = COLORS.success;
/** 卖出标记颜色（红）*/
export const SIGNAL_SELL_COLOR = COLORS.danger;

/**
 * 计算所有信号标记的绘制位置
 *
 * - 买入（buy）画在**最低价下方**，卖出（sell）画在**最高价上方**（不遮挡蜡烛实体）
 * - `toX(index)` / `toY(value)` 由调用方注入（生产环境传 klinecharts 的坐标转换）
 *
 * ⚠️ **只认 `trade_date` 精确对齐的那一根 K 线** —— 对不上就不画（**不猜、不近似**）。
 */
export function computeSignalMarkerPositions(
  bars: ChartBar[],
  toX: (index: number) => number,
  toY: (value: number) => number,
): SignalMarkerGeometry[] {
  const result: SignalMarkerGeometry[] = [];
  bars.forEach((bar, index) => {
    const signal = bar.signal;
    if (!signal) return;
    const isBuy = signal.direction === 'buy';
    const isSell = signal.direction === 'sell';
    if (!isBuy && !isSell) return;
    const anchor = isBuy ? bar.low : bar.high;
    result.push({
      index,
      date: bar.date,
      x: toX(index),
      y: toY(anchor),
      direction: signal.direction,
      color: isBuy ? SIGNAL_BUY_COLOR : SIGNAL_SELL_COLOR,
    });
  });
  return result;
}

/** 标记三角形的半宽（px）*/
export const SIGNAL_MARKER_HALF_WIDTH = 5;
/** 标记三角形的高度（px）*/
export const SIGNAL_MARKER_HEIGHT = 7;
/** 标记与 K 线之间的偏移（px）*/
export const SIGNAL_MARKER_OFFSET = 8;

/**
 * 在 canvas 上画一个信号标记（▲ / ▼）
 *
 * 抽成独立函数是为了**可单测**（几何计算与绘制分离）。
 */
export function drawSignalMarker(ctx: CanvasRenderingContext2D, marker: SignalMarkerGeometry): void {
  const half = SIGNAL_MARKER_HALF_WIDTH;
  const height = SIGNAL_MARKER_HEIGHT;
  const isBuy = marker.direction === 'buy';
  // 买入：标记在最低价**下方**（y 增大）；卖出：标记在最高价**上方**（y 减小）
  const tipY = isBuy ? marker.y + SIGNAL_MARKER_OFFSET : marker.y - SIGNAL_MARKER_OFFSET;
  const baseY = isBuy ? tipY + height : tipY - height;

  ctx.save();
  ctx.fillStyle = marker.color;
  ctx.beginPath();
  if (isBuy) {
    // ▲
    ctx.moveTo(marker.x, tipY);
    ctx.lineTo(marker.x - half, baseY);
    ctx.lineTo(marker.x + half, baseY);
  } else {
    // ▼
    ctx.moveTo(marker.x, tipY);
    ctx.lineTo(marker.x - half, baseY);
    ctx.lineTo(marker.x + half, baseY);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * 指标样式（按 ui-spec 的 token 配色）
 * ------------------------------------------------------------------ */

/**
 * MA 四条线的样式
 *
 * ⚠️ **MA60 没有专属 token** —— `theme/tokens.ts` 只有 `ma5` / `ma10` / `ma20`
 * （且该文件不在 T70 的可改范围内）→ MA60 复用 `COLORS.accentPurple`。
 * 若要独立配色，需在 ui-spec §1 补 `ma60` token 后再改这里。
 */
export const MA_LINE_STYLES = [
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.ma5 },
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.ma10 },
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.ma20 },
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.accentPurple },
];

/** MACD 的线 / 柱样式（A 股口径：正柱红、负柱绿 —— 与蜡烛同色系）*/
export const MACD_LINE_STYLES = [
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.difLine },
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.deaLine },
];

/** MACD 柱样式 */
export const MACD_BAR_STYLES = [
  {
    style: 'fill' as const,
    borderStyle: 'solid' as const,
    borderSize: 1,
    borderDashedValue: [2, 2],
    upColor: COLORS.macdBarPos,
    downColor: COLORS.macdBarNeg,
    noChangeColor: COLORS.chartText,
  },
];

/** RSI 线样式 */
export const RSI_LINE_STYLES = [
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.rsiLine },
];

/** KDJ 三条线的样式 */
export const KDJ_LINE_STYLES = [
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.ma5 },
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.ma10 },
  { style: 'solid' as const, size: 1, smooth: false, dashedValue: [2, 2], color: COLORS.ma20 },
];

/** 成交量柱样式 */
export const VOL_BAR_STYLES = [
  {
    style: 'fill' as const,
    borderStyle: 'solid' as const,
    borderSize: 1,
    borderDashedValue: [2, 2],
    upColor: COLORS.candleUp,
    downColor: COLORS.candleDown,
    noChangeColor: COLORS.chartText,
  },
];

/** 图表整体样式（ui-spec §1 的 chart palette）*/
export const CHART_STYLES: DeepPartial<import('klinecharts').Styles> = {
  grid: {
    show: true,
    horizontal: { show: true, style: 'solid', size: 1, color: COLORS.chartGrid, dashedValue: [2, 2] },
    vertical: { show: true, style: 'solid', size: 1, color: COLORS.chartGrid, dashedValue: [2, 2] },
  },
  candle: {
    type: 'candle_solid',
    bar: {
      compareRule: 'current_open',
      // A 股口径：**红涨绿跌**（勿改反）
      upColor: COLORS.candleUp,
      downColor: COLORS.candleDown,
      noChangeColor: COLORS.chartText,
      upBorderColor: COLORS.candleUp,
      downBorderColor: COLORS.candleDown,
      noChangeBorderColor: COLORS.chartText,
      upWickColor: COLORS.candleUp,
      downWickColor: COLORS.candleDown,
      noChangeWickColor: COLORS.chartText,
    },
    priceMark: {
      show: true,
      high: {
        show: true,
        color: COLORS.chartText,
        textOffset: 5,
        textSize: 10,
        textFamily: 'inherit',
        textWeight: 'normal',
      },
      low: {
        show: true,
        color: COLORS.chartText,
        textOffset: 5,
        textSize: 10,
        textFamily: 'inherit',
        textWeight: 'normal',
      },
      last: {
        show: true,
        compareRule: 'current_open',
        upColor: COLORS.candleUp,
        downColor: COLORS.candleDown,
        noChangeColor: COLORS.chartText,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: null },
        text: {
          show: true,
          style: 'fill',
          size: 11,
          paddingLeft: 4,
          paddingTop: 2,
          paddingRight: 4,
          paddingBottom: 2,
          borderColor: 'transparent',
          borderStyle: 'solid',
          borderSize: 0,
          borderDashedValue: [2, 2],
          color: COLORS.chartText,
          family: 'inherit',
          weight: 'normal',
          borderRadius: 2,
          backgroundColor: null,
        },
        extendTexts: [],
      },
    },
    tooltip: {
      offsetLeft: 8,
      offsetTop: 8,
      offsetRight: 8,
      offsetBottom: 8,
      /**
       * ⚠️ **关掉库自带的蜡烛 tooltip**（`showRule: 'none'`）
       *
       * 原因：库自带的 tooltip 固定画在**左上角**，而本项目的悬浮窗
       * （`KlineHoverPanel`，含**策略信号明细** —— 库不认识信号）也在左上角
       * ⇒ 两者**重叠**，文字叠成一团（真浏览器实测截图确认）。
       *
       * ⇒ 悬浮窗统一由 `KlineHoverPanel` 提供（OHLCV + 指标值 + 信号明细），
       *    库的 tooltip 只保留十字光标自身的坐标轴价格标签。
       */
      showRule: 'none',
      showType: 'standard',
      rect: {
        position: 'fixed',
        paddingLeft: 6,
        paddingRight: 6,
        paddingTop: 4,
        paddingBottom: 4,
        offsetLeft: 4,
        offsetTop: 4,
        offsetRight: 4,
        offsetBottom: 4,
        borderRadius: 4,
        borderSize: 1,
        borderColor: COLORS.chartBorder,
        color: COLORS.chartBg,
      },
      title: {
        show: true,
        size: 12,
        family: 'inherit',
        weight: 'normal',
        color: COLORS.chartText,
        marginLeft: 8,
        marginTop: 2,
        marginRight: 8,
        marginBottom: 2,
        template: '{ticker} · {period}',
      },
      legend: {
        size: 11,
        family: 'inherit',
        weight: 'normal',
        color: COLORS.chartText,
        marginLeft: 8,
        marginTop: 2,
        marginRight: 8,
        marginBottom: 2,
        defaultValue: 'n/a',
        template: [
          { title: 'time', value: '{time}' },
          { title: 'open', value: '{open}' },
          { title: 'high', value: '{high}' },
          { title: 'low', value: '{low}' },
          { title: 'close', value: '{close}' },
          { title: 'volume', value: '{volume}' },
        ],
      },
      features: [],
    },
  },
  xAxis: {
    show: true,
    // ⚠️ `AxisLineStyle` **不含** `style` / `dashedValue`（`Omit<StateLineStyle, ...>`）
    axisLine: { show: true, size: 1, color: COLORS.chartGrid },
    tickLine: { show: false, size: 1, color: COLORS.chartGrid, length: 3 },
    tickText: {
      show: true,
      color: COLORS.chartText,
      weight: 'normal',
      family: 'inherit',
      size: 11,
      marginStart: 4,
      marginEnd: 4,
    },
  },
  yAxis: {
    show: true,
    axisLine: { show: true, size: 1, color: COLORS.chartGrid },
    tickLine: { show: false, size: 1, color: COLORS.chartGrid, length: 3 },
    tickText: {
      show: true,
      color: COLORS.chartText,
      weight: 'normal',
      family: 'inherit',
      size: 11,
      marginStart: 4,
      marginEnd: 4,
    },
  },
  crosshair: {
    show: true,
    horizontal: {
      show: true,
      line: { show: true, style: 'dashed', size: 1, color: COLORS.chartText, dashedValue: [4, 4] },
      text: {
        show: true,
        style: 'fill',
        size: 11,
        paddingLeft: 4,
        paddingTop: 2,
        paddingRight: 4,
        paddingBottom: 2,
        borderColor: 'transparent',
        borderStyle: 'solid',
        borderSize: 0,
        borderDashedValue: [2, 2],
        color: COLORS.chartBg,
        family: 'inherit',
        weight: 'normal',
        borderRadius: 2,
        backgroundColor: COLORS.chartText,
      },
      features: [],
    },
    vertical: {
      show: true,
      line: { show: true, style: 'dashed', size: 1, color: COLORS.chartText, dashedValue: [4, 4] },
      text: {
        show: true,
        style: 'fill',
        size: 11,
        paddingLeft: 4,
        paddingTop: 2,
        paddingRight: 4,
        paddingBottom: 2,
        borderColor: 'transparent',
        borderStyle: 'solid',
        borderSize: 0,
        borderDashedValue: [2, 2],
        color: COLORS.chartBg,
        family: 'inherit',
        weight: 'normal',
        borderRadius: 2,
        backgroundColor: COLORS.chartText,
      },
    },
  },
  separator: {
    size: 1,
    color: COLORS.chartGrid,
    fill: true,
    activeBackgroundColor: COLORS.brandBg,
  },
  indicator: {
    /**
     * ⚠️ **关掉库自带的指标 tooltip**（`showRule: 'none'`）
     *
     * 库的指标 tooltip（MA5/MA10/... 的图例行）固定画在**窗格左上角**，
     * 与本项目的悬浮窗（`KlineHoverPanel`，左上角）**重叠**（真浏览器实测确认）。
     * ⇒ 统一由 `KlineHoverPanel` 提供「指标值 + 信号明细」，库里不再重复画。
     */
    tooltip: {
      showRule: 'none',
    },
  },
};
