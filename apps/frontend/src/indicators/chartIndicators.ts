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
import type { ChartBar, TradeMarker } from './chartBars';
import { MA_FIELD_KEYS } from './chartParams';
import { toPatternGeometry, type ChartPattern } from './klinePatterns';

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

/** 交易标记 */
export interface TradeMarkerIndicatorResult {
  /** 该 K 线的交易标记（没有就是空数组；同一根可多笔）*/
  trades: TradeMarker[];
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

/**
 * 交易标记 —— 主图叠加（T152 / SDD_v3 §9.9）
 *
 * 视觉规格（ui-spec §7）：
 * - 圆形（区别于信号三角形）；半径 4px
 * - 建仓 / 清仓 = 实心圆；加仓 / 减仓 = 空心圆
 * - 建仓 / 加仓 = 红 `COLORS.candleUp`；减仓 / 清仓 = 绿 `COLORS.candleDown`
 * - 外描边 1px `COLORS.cardBg`
 * - 同日多笔聚合成 1 个 9px 空心圆环；同向取方向色，混合方向用 `COLORS.info`
 */
export const TRADE_INDICATOR: IndicatorTemplate<TradeMarkerIndicatorResult> = {
  name: 'APP_TRADE',
  shortName: 'TRADE',
  series: 'price',
  figures: [],
  calc: (dataList: KLineData[]) =>
    dataList.map((bar) => ({ trades: (bar as unknown as ChartBar).trades ?? [] })),
  draw: ({ ctx, chart, xAxis, yAxis }) => {
    const list = chart.getDataList() as unknown as ChartBar[];
    const markers = computeTradeMarkerPositions(
      list,
      (index) => xAxis.convertToPixel(index),
      (value) => yAxis.convertToPixel(value),
    );
    markers.forEach((marker) => drawTradeMarker(ctx, marker));

    // 标记旁的中文单字（建 / 加 / 减 / 清）—— 右边界取**最后一根可见 K 线**，
    // 越过它就会压到右侧价格轴 ⇒ 交给布局函数自动改到标记左侧。
    const visible = chart.getVisibleRange();
    const rightBoundary = xAxis.convertToPixel(visible.to) - 6;
    computeTradeMarkerLabels(markers, { rightBoundary }).forEach((label) => drawTradeMarkerLabel(ctx, label));
    return false;
  },
};

/* ------------------------------------------------------------------ *
 * K 线形态标注（双顶 / 双底）—— 后端算、前端只画
 * ------------------------------------------------------------------ */

/** 形态点标记半径（px） */
export const PATTERN_MARKER_RADIUS = 3;
/** 颈线虚线节奏（px） */
export const PATTERN_LINE_DASH: [number, number] = [4, 3];
/** 形态标注颜色（中性 info，不暗示买卖方向） */
export const PATTERN_COLOR = COLORS.info;

/** 形态结果类型（calc 只搬运，不在前端计算） */
export interface PatternIndicatorResult {
  patterns: ChartPattern[];
}

/** 指标名（注册 / 覆盖 / 移除都用它） */
export const PATTERN_INDICATOR_NAME = 'APP_PATTERN';

/** 从 K 线数组里取形态（**字段搬运**，形态由后端算好、`buildChartBars` 映射到桶） */
export function calcPatterns(dataList: KLineData[], bars: readonly ChartBar[]): PatternIndicatorResult[] {
  return dataList.map((bar, i) => ({
    patterns: bars[i]?.patterns ?? (bar as unknown as ChartBar).patterns ?? [],
  }));
}

/**
 * `APP_PATTERN`：把后端识别好的双顶/双底画到主图
 *
 * 画什么：两个顶/底的圆点、中间谷/峰的圆点、水平颈线（虚线到确认 bar）、文字标签。
 * 没有形态时**不画任何占位**（`draw` 直接遍历到空数组）。
 *
 * ⚠️ `draw` 必须从 `getBars` 取**最新** bars，而不是 `chart.getDataList()`：
 *    形态请求晚于 K 线请求返回，图表内部数据列表不会因此刷新
 *    （`resetData` 只由数据指纹触发）⇒ 读 dataList 会一直画「还没有形态」的旧快照。
 */
export function createPatternIndicator(getBars?: BarsProvider): IndicatorTemplate<PatternIndicatorResult> {
  return {
    name: PATTERN_INDICATOR_NAME,
    shortName: 'PATTERN',
    series: 'price',
    figures: [],
    calc: (dataList: KLineData[]) => calcPatterns(dataList, getBars?.() ?? barsFromDataList(dataList)),
    draw: ({ ctx, chart, xAxis, yAxis }) => {
      const list = getBars ? getBars() : (chart.getDataList() as unknown as ChartBar[]);
      const seen = new Set<string>();

      for (const bar of list) {
        const patterns = bar.patterns;
        if (!patterns || patterns.length === 0) continue;

        for (const pattern of patterns) {
          // 同一形态只画一次（形态统一挂在 confirm bar 上，扫全量时兜底去重）
          const key = `${pattern.kind}:${pattern.firstIndex}:${pattern.secondIndex}:${pattern.confirmIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const geometry = toPatternGeometry(pattern);
          const [p1, p2, p3] = geometry.points;
          const x1 = xAxis.convertToPixel(p1.index);
          const x2 = xAxis.convertToPixel(p2.index);
          const x3 = xAxis.convertToPixel(p3.index);
          const xc = xAxis.convertToPixel(geometry.neckline.toIndex);
          const y1 = yAxis.convertToPixel(p1.price);
          const y2 = yAxis.convertToPixel(p2.price);
          const y3 = yAxis.convertToPixel(p3.price);
          const yNeck = yAxis.convertToPixel(geometry.neckline.price);
          if (![x1, x2, x3, xc, y1, y2, y3, yNeck].every((v) => Number.isFinite(v))) continue;

          // 视口外整体跳过（避免每帧画不可见形态）
          const width = ctx.canvas?.width ?? 0;
          if (Math.max(x1, x2, x3, xc) < -20 || Math.min(x1, x2, x3, xc) > width + 20) continue;

          ctx.save();

          // 颈线：水平虚线，从第一根顶/底延伸到确认 bar
          ctx.strokeStyle = PATTERN_COLOR;
          ctx.lineWidth = 1;
          ctx.setLineDash(PATTERN_LINE_DASH);
          ctx.beginPath();
          ctx.moveTo(x1, yNeck);
          ctx.lineTo(xc, yNeck);
          ctx.stroke();
          ctx.setLineDash([]);

          // 三个关键点：小圆点（外描边压住 K 线）
          ctx.fillStyle = PATTERN_COLOR;
          ctx.strokeStyle = COLORS.cardBg;
          ctx.lineWidth = 1;
          for (const [x, y] of [
            [x1, y1],
            [x2, y2],
            [x3, y3],
          ]) {
            ctx.beginPath();
            ctx.arc(x, y, PATTERN_MARKER_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }

          // 文字标签（半透明底色，避免压在蜡烛上读不清）
          const label = geometry.label;
          const labelX = (x1 + xc) / 2;
          const labelY = pattern.kind === 'double_top' ? yNeck - 7 : yNeck + 7;
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = pattern.kind === 'double_top' ? 'bottom' : 'top';
          const textWidth = ctx.measureText(label).width;
          ctx.globalAlpha = 0.82;
          ctx.fillStyle = COLORS.chartBg;
          ctx.fillRect(labelX - textWidth / 2 - 2, labelY - 12, textWidth + 4, 14);
          ctx.globalAlpha = 1;
          ctx.fillStyle = PATTERN_COLOR;
          ctx.fillText(label, labelX, labelY);

          ctx.restore();
        }
      }
      return false;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 交易标记几何计算（可单测的纯函数）
 * ------------------------------------------------------------------ */

export type TradeMarkerShape = 'solid' | 'hollow' | 'aggregated';

export interface TradeMarkerGeometry {
  index: number;
  date: string;
  x: number;
  y: number;
  color: string;
  /** 单个标记：实心 / 空心；聚合标记：aggregated */
  shape: TradeMarkerShape;
  radius: number;
  /** 这根 K 线里全部交易（明细面板 / hover 用）*/
  trades: TradeMarker[];
}

/** 交易标记半径（px）*/
export const TRADE_MARKER_RADIUS = 4;
/** 同日多笔聚合圆环半径（px）*/
export const TRADE_AGGREGATED_RADIUS = 9;
/** 交易标记外描边宽度（px）*/
export const TRADE_MARKER_STROKE_WIDTH = 1;
/** 点击命中交易标记的像素容差（移动端手指更大，取 14）*/
export const TRADE_MARKER_HIT_RADIUS = 14;

/** 买入侧颜色（建仓 / 加仓 = 红）*/
export const TRADE_BUY_COLOR = COLORS.candleUp;
/** 卖出侧颜色（减仓 / 清仓 = 绿）*/
export const TRADE_SELL_COLOR = COLORS.candleDown;
/** 混合方向（同日既有买又有卖）颜色 */
export const TRADE_MIXED_COLOR = COLORS.info;

const TRADE_SOLID_MARKER_TYPES: ReadonlySet<TradeMarker['marker_type']> = new Set(['open', 'close']);
const TRADE_BUY_MARKER_TYPES: ReadonlySet<TradeMarker['marker_type']> = new Set(['open', 'add']);

function tradeMarkerDirectionColor(trades: TradeMarker[]): string {
  const hasBuy = trades.some((trade) => TRADE_BUY_MARKER_TYPES.has(trade.marker_type));
  const hasSell = trades.some((trade) => !TRADE_BUY_MARKER_TYPES.has(trade.marker_type));
  if (hasBuy && hasSell) return TRADE_MIXED_COLOR;
  return hasBuy ? TRADE_BUY_COLOR : TRADE_SELL_COLOR;
}

function tradeMarkerAnchorPrice(trades: TradeMarker[]): number {
  // 单笔用该笔复权价；多笔聚合成一个锚点时取算术平均（不能只取第一笔，否则同日第二笔的价格会被吞掉）
  const valid = trades.filter((trade) => Number.isFinite(trade.adj_price));
  if (valid.length === 0) return Number.NaN;
  const sum = valid.reduce((acc, trade) => acc + trade.adj_price, 0);
  return sum / valid.length;
}

/**
 * 计算所有交易标记的绘制位置（同日多笔聚合为一个 9px 空心圆环）
 *
 * @param toX 下标 → 屏幕 x（klinecharts 的 xAxis.convertToPixel）
 * @param toY 价格 → 屏幕 y（klinecharts 的 yAxis.convertToPixel）
 */
export function computeTradeMarkerPositions(
  bars: ChartBar[],
  toX: (index: number) => number,
  toY: (value: number) => number,
): TradeMarkerGeometry[] {
  const result: TradeMarkerGeometry[] = [];
  bars.forEach((bar, index) => {
    const trades = bar.trades ?? [];
    if (trades.length === 0) return;

    const anchor = tradeMarkerAnchorPrice(trades);
    if (!Number.isFinite(anchor)) return;

    const isSingle = trades.length === 1;
    const shape: TradeMarkerShape = isSingle
      ? TRADE_SOLID_MARKER_TYPES.has(trades[0]?.marker_type)
        ? 'solid'
        : 'hollow'
      : 'aggregated';

    result.push({
      index,
      date: bar.date,
      x: toX(index),
      y: toY(anchor),
      color: tradeMarkerDirectionColor(trades),
      shape,
      radius: isSingle ? TRADE_MARKER_RADIUS : TRADE_AGGREGATED_RADIUS,
      trades,
    });
  });
  return result;
}

/** 在 canvas 上画一个交易标记（实心圆 / 空心圆 / 聚合圆环）*/
export function drawTradeMarker(ctx: CanvasRenderingContext2D, marker: TradeMarkerGeometry): void {
  ctx.save();
  ctx.lineWidth = TRADE_MARKER_STROKE_WIDTH;
  ctx.strokeStyle = COLORS.cardBg;
  ctx.beginPath();
  ctx.arc(marker.x, marker.y, marker.radius, 0, Math.PI * 2);

  if (marker.shape === 'solid') {
    ctx.fillStyle = marker.color;
    ctx.fill();
    ctx.stroke();
  } else if (marker.shape === 'hollow') {
    ctx.fillStyle = COLORS.chartBg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = marker.color;
    ctx.stroke();
  } else {
    ctx.fillStyle = COLORS.chartBg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = marker.color;
    ctx.stroke();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * 交易标记旁的中文文字（owner 定稿：只用单字「建 / 加 / 减 / 清」）
 * ------------------------------------------------------------------ */

/**
 * 标记类型 → **单字**文字
 *
 * ⚠️ owner 明确要求**不带「仓」字**（即 `建/加/减/清`，不是 `建仓/加仓/…`）——
 *    图上文字要短，才能贴在标记旁而不挤占蜡烛。
 */
export const TRADE_MARKER_LABELS: Record<TradeMarker['marker_type'], string> = {
  open: '建',
  add: '加',
  reduce: '减',
  close: '清',
};

/** 文字字号（px）*/
export const TRADE_LABEL_FONT_SIZE = 11;
/** 单字宽度估算（px）—— 布局避让用，无需真实 measureText */
export const TRADE_LABEL_CHAR_WIDTH = 11;
/** 文字底色块高度（px）*/
export const TRADE_LABEL_HEIGHT = 13;
/** 文字与标记边缘的间距（px）*/
export const TRADE_LABEL_GAP = 3;

/**
 * 发生横向重叠时依次尝试的**纵向偏移**（px）—— 上下错行避让
 *
 * 第 0 项 -1 是「与标记圆心基本齐平」（视觉上贴在标记旁），
 * 后面几项按 ±15px 逐层错开；仍全部冲突时退回第一项（宁可叠，也不丢信息）。
 */
export const TRADE_LABEL_LANE_OFFSETS: readonly number[] = [-1, -16, 16, -31, 31];

/** 一条待绘制的标记文字 */
export interface TradeMarkerLabel {
  index: number;
  text: string;
  /** 文字锚点 x：`align === 'left'` 是左边界，`right` 是右边界 */
  x: number;
  /** 文字垂直中心 y */
  y: number;
  align: 'left' | 'right';
  color: string;
  /** 估算宽度（px）*/
  width: number;
}

/**
 * 标记对应的文字
 *
 * - 单笔：`建 / 加 / 减 / 清`
 * - 同日多笔（聚合圆环）：**笔数**（例如 `3`）—— 此时没有单一方向字可用
 */
export function tradeMarkerLabelText(marker: TradeMarkerGeometry): string {
  if (marker.shape === 'aggregated') return String(marker.trades.length);
  const type = marker.trades[0]?.marker_type;
  return type ? (TRADE_MARKER_LABELS[type] ?? '') : '';
}

/** 文字的包围盒（碰撞检测用）*/
function labelRect(label: Pick<TradeMarkerLabel, 'x' | 'y' | 'align' | 'width'>): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const left = label.align === 'left' ? label.x : label.x - label.width;
  return {
    left,
    right: left + label.width,
    top: label.y - TRADE_LABEL_HEIGHT / 2,
    bottom: label.y + TRADE_LABEL_HEIGHT / 2,
  };
}

function rectsOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * 计算标记文字的绘制位置（**纯函数**，便于单测）
 *
 * 规则：
 * 1. 默认贴在标记**右侧**；若文字右边界会越过 `rightBoundary`（最后一根可见 K 线，
 *    再往右就是价格轴）⇒ 改到标记**左侧**（`align: 'right'`）；
 * 2. 与已放置的文字包围盒冲突 ⇒ 依次换用 `TRADE_LABEL_LANE_OFFSETS` 的上下错行；
 * 3. 没有文字（例如脏数据里的未知 `marker_type`）直接跳过。
 *
 * ⚠️ 设计取舍：文字**常显**而不是 hover 才显示 ——
 *    买点标记本身就是「复盘时一眼要看见」的信息，藏到 hover 等于没有；
 *    用「小字号 + 半透明底色 + 上下错行」解决密集区的可读性。
 */
export function computeTradeMarkerLabels(
  markers: readonly TradeMarkerGeometry[],
  options: { rightBoundary?: number } = {},
): TradeMarkerLabel[] {
  const rightBoundary = Number.isFinite(options.rightBoundary)
    ? (options.rightBoundary as number)
    : Number.POSITIVE_INFINITY;
  const labels: TradeMarkerLabel[] = [];

  markers.forEach((marker) => {
    const text = tradeMarkerLabelText(marker);
    if (!text) return;

    const width = text.length * TRADE_LABEL_CHAR_WIDTH;
    const gap = marker.radius + TRADE_LABEL_GAP;
    const useRight = marker.x + gap + width <= rightBoundary;
    const align: 'left' | 'right' = useRight ? 'left' : 'right';
    const x = useRight ? marker.x + gap : marker.x - gap;

    let y = marker.y + TRADE_LABEL_LANE_OFFSETS[0];
    for (const offset of TRADE_LABEL_LANE_OFFSETS) {
      const candidate = { x, y: marker.y + offset, align, width };
      if (!labels.some((placed) => rectsOverlap(labelRect(candidate), labelRect(placed)))) {
        y = candidate.y;
        break;
      }
    }

    labels.push({ index: marker.index, text, x, y, align, color: marker.color, width });
  });

  return labels;
}

/** 在 canvas 上画一条标记文字（半透明底色 + 标记同色文字）*/
export function drawTradeMarkerLabel(ctx: CanvasRenderingContext2D, label: TradeMarkerLabel): void {
  const left = label.align === 'left' ? label.x : label.x - label.width;
  const top = label.y - TRADE_LABEL_HEIGHT / 2;

  ctx.save();
  // 半透明底色：压住背后的蜡烛 / 网格线，避免文字与 K 线图形打架
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(left - 1, top, label.width + 2, TRADE_LABEL_HEIGHT);
  ctx.globalAlpha = 1;
  ctx.fillStyle = label.color;
  ctx.font = `${TRADE_LABEL_FONT_SIZE}px sans-serif`;
  ctx.textAlign = label.align;
  ctx.textBaseline = 'middle';
  ctx.fillText(label.text, label.x, label.y);
  ctx.restore();
}

/**
 * 点击命中判定（K 线容器 click 用；与 hover 同一套几何）
 *
 * ⚠️ 只命中「有交易标记的那一根 + 标记圆心附近」，避免整列点击都弹明细面板。
 *
 * @param clickX / clickY 点击点（**相对图表容器**的像素坐标）
 * @param getMarkers 当前可见 bars 的标记几何（调用方注入，生产环境来自 klinecharts 坐标转换）
 */
export function findTradeMarkerAtPoint(
  clickX: number,
  clickY: number,
  getMarkers: () => TradeMarkerGeometry[],
): TradeMarkerGeometry | null {
  const markers = getMarkers();
  let best: TradeMarkerGeometry | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const dx = marker.x - clickX;
    const dy = marker.y - clickY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const hitRadius = marker.radius + TRADE_MARKER_HIT_RADIUS;
    if (dist <= hitRadius && dist < bestDist) {
      best = marker;
      bestDist = dist;
    }
  }

  return best;
}

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
