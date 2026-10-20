import { COLORS } from '../theme/tokens';

/**
 * K 线 Canvas 绘制函数（T67 · Wave 3 卡 6 · 建议 C「标的详情 Modal + K 线小图」）
 *
 * ## 🔴 与 `pages/Kline.tsx` 的关系（同源，Wave 5 / T70 重写 Kline 时应合并）
 *
 * 本文件的绘制逻辑**逐字复制自 `pages/Kline.tsx`**（`setupCanvas` / `drawMain` /
 * `drawMACD` / `drawRSI` + `KlineBar` / `Indicators` 类型），
 * **不是**从 `pages/Kline.tsx` import 出来的 —— 理由有二：
 *
 * 1. **依赖方向**：组件层（`components/`）反向依赖页面层（`pages/`）是依赖倒置，
 *    与 T66 的分层收口（`components/` → `theme/`，绝不 → `pages/`）冲突。
 * 2. **代码分割（T66 的验收项）**：`pages/Kline.tsx` 是 `React.lazy` 的独立 chunk
 *    （`App.tsx` 的 `React.lazy(() => import('./pages/Kline'))`）。
 *    若 `components/KlineMiniChart.tsx` 从 `pages/Kline.tsx` import，
 *    打包器会把 **Kline 整页代码拉进 Dashboard 首屏 chunk** → 破坏 T66 的
 *    「首屏 chunk 不含 Kline」不变量（回归用例：`tests/unit/lazyLoading.test.tsx`）。
 *    ⇒ 正确做法（任务卡裁决 **D-8**）是：**两边都从本模块 import**。
 *
 * ⚠️ **本卡（卡 6）没有改 `pages/Kline.tsx`** —— 卡 6 明确要求
 *    「不改 Kline 页的行为」，而 Kline 页是 **Wave 5 / T70** 的重写目标，
 *    此刻改它会制造合并冲突。故此处**先落地独立模块**，Wave 5 重写 Kline 时
 *    应把 `pages/Kline.tsx` 的三个绘制函数改为从本文件 import（行为零变化），
 *    并在重写完成后**删除本文件里的重复实现**（避免两处真理）。
 *
 * ## 🔴 与原版的**唯一**行为差异：`getContext('2d')` 返回 `null` 时不抛异常
 *
 * 原版 `pages/Kline.tsx:59` 写的是 `canvas.getContext('2d')!`（非空断言）——
 * 在 **jsdom 下 `getContext` 返回 `null`**（jsdom 未装 `canvas` 包），
 * 随后 `ctx.scale(...)` 会抛 `TypeError: Cannot read properties of null`。
 * 故本模块所有绘制函数：
 * - `setupCanvas` 返回 `CanvasRenderingContext2D | null`；
 * - 拿不到 context 时**直接返回 `false`**，由调用方显示降级提示（不白屏、不抛未捕获异常）。
 */

/* ------------------------------------------------------------------ *
 * 类型（从 `pages/Kline.tsx` 复制 —— 那里是模块私有类型，抽到这里必须一并导出）
 * ------------------------------------------------------------------ */

/** 单根日线 */
export interface KlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** MACD 指标（三条线）*/
export interface MacdIndicator {
  dif: number[];
  dea: number[];
  macd: number[];
}

/** 指标集合（MA5/10/20 + MACD + RSI）*/
export interface KlineIndicators {
  macd: MacdIndicator;
  rsi: number[];
  ma5: number[];
  ma10: number[];
  ma20: number[];
}

/** 策略信号标记（画在 K 线上的 ▲ / ▼）*/
export interface KlineSignalMarker {
  trade_date: string;
  direction: string;
  label: string;
  plugin_id?: string;
}

/* ------------------------------------------------------------------ *
 * 画布尺寸常量（与 `pages/Kline.tsx` 的同名常量取值一致）
 * ------------------------------------------------------------------ */

/** 主图高度（px）—— 与 `pages/Kline.tsx` 的 `MAIN_HEIGHT` 同值 */
export const KLINE_MAIN_HEIGHT = 400;
/** MACD 副图高度（px）—— 与 `pages/Kline.tsx` 的 `MACD_HEIGHT` 同值 */
export const KLINE_MACD_HEIGHT = 160;
/** RSI 副图高度（px）—— 与 `pages/Kline.tsx` 的 `RSI_HEIGHT` 同值 */
export const KLINE_RSI_HEIGHT = 160;

/* ------------------------------------------------------------------ *
 * 绘制函数
 * ------------------------------------------------------------------ */

/**
 * 按 devicePixelRatio 设置画布尺寸并取 2D context
 *
 * ⚠️ **拿不到 context 时返回 `null`（不抛异常）** —— jsdom / 老旧浏览器都可能返回 `null`。
 *    调用方据此显示降级提示（见 `KlineMiniChart.tsx`）。
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  return ctx;
}

/**
 * 画主图（蜡烛 + MA5/MA10/MA20 + 信号标记）
 *
 * @param height 主图高度（px）—— 传入小图的 220，小图与整页共用同一套绘制逻辑
 * @returns 是否真的画上去了（`false` = 无 2D context 或无数据）
 */
export function drawMain(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: KlineIndicators,
  signals: KlineSignalMarker[] | undefined,
  width: number,
  height: number = KLINE_MAIN_HEIGHT,
): boolean {
  const W = width;
  const H = height;
  const ctx = setupCanvas(canvas, W, H);
  if (!ctx) return false;
  if (klines.length === 0) return false;

  const pad = { top: 20, right: 60, bottom: 30, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / klines.length;

  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(0, 0, W, H);

  const allValues: number[] = [];
  klines.forEach((k) => {
    allValues.push(k.high, k.low);
  });
  [indicators.ma5, indicators.ma10, indicators.ma20].forEach((ma) => {
    ma.forEach((v) => {
      if (!isNaN(v)) allValues.push(v);
    });
  });
  const max = Math.max(...allValues);
  const min = Math.min(...allValues);
  const range = max - min || 1;

  ctx.strokeStyle = COLORS.chartGrid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (chartH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    const price = max - (range / 5) * i;
    ctx.fillStyle = COLORS.chartText;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(2), W - pad.right + 4, y + 4);
  }

  const dateStep = Math.max(1, Math.floor(klines.length / 8));
  ctx.fillStyle = COLORS.chartText;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  klines.forEach((k, i) => {
    if (i % dateStep !== 0) return;
    const x = pad.left + i * barW + barW / 2;
    ctx.fillText(k.date.slice(5), x, H - pad.bottom + 16);
  });

  klines.forEach((k, i) => {
    const x = pad.left + i * barW + barW / 2;
    const yHigh = pad.top + ((max - k.high) / range) * chartH;
    const yLow = pad.top + ((max - k.low) / range) * chartH;
    const yOpen = pad.top + ((max - k.open) / range) * chartH;
    const yClose = pad.top + ((max - k.close) / range) * chartH;
    const color = k.close >= k.open ? COLORS.candleUp : COLORS.candleDown;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    const top = Math.min(yOpen, yClose);
    const bot = Math.max(yOpen, yClose);
    const bodyH = Math.max(1, bot - top);
    ctx.fillStyle = color;
    ctx.fillRect(x - barW * 0.35, top, barW * 0.7, bodyH);
  });

  const drawMA = (ma: number[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    ma.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = pad.left + i * barW + barW / 2;
      const y = pad.top + ((max - v) / range) * chartH;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };
  drawMA(indicators.ma5, COLORS.ma5);
  drawMA(indicators.ma10, COLORS.ma10);
  drawMA(indicators.ma20, COLORS.ma20);

  const drawLegend = (label: string, value: string, x: number, y: number, color: string) => {
    ctx.fillStyle = COLORS.chartText;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x + 20, y);
  };
  drawLegend(
    'MA5',
    indicators.ma5[indicators.ma5.length - 1]?.toFixed(2) ?? '--',
    pad.left + 4,
    pad.top - 6,
    COLORS.ma5,
  );
  drawLegend(
    'MA10',
    indicators.ma10[indicators.ma10.length - 1]?.toFixed(2) ?? '--',
    pad.left + 100,
    pad.top - 6,
    COLORS.ma10,
  );
  drawLegend(
    'MA20',
    indicators.ma20[indicators.ma20.length - 1]?.toFixed(2) ?? '--',
    pad.left + 210,
    pad.top - 6,
    COLORS.ma20,
  );

  // 绘制策略信号标记（买入绿▲ / 卖出红▼）
  if (signals && signals.length > 0) {
    const dateIndex = new Map<string, number>();
    klines.forEach((k, i) => dateIndex.set(k.date, i));
    ctx.font = '14px sans-serif';
    for (const sig of signals) {
      const idx = dateIndex.get(sig.trade_date);
      if (idx === undefined) continue;
      const x = pad.left + idx * barW + barW / 2;
      const yHigh = pad.top + ((max - klines[idx].high) / range) * chartH;
      const color =
        sig.direction === 'buy'
          ? COLORS.success
          : sig.direction === 'sell'
            ? COLORS.danger
            : COLORS.textSecondary;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(sig.direction === 'buy' ? '▲' : sig.direction === 'sell' ? '▼' : '●', x, yHigh - 6);
      ctx.font = '9px sans-serif';
      ctx.fillStyle = COLORS.chartLabel;
      ctx.fillText(sig.plugin_id ?? '', x, yHigh - 18);
      ctx.font = '14px sans-serif';
    }
  }

  return true;
}

/**
 * 画 MACD 副图（柱 + DIF/DEA 两条线）
 *
 * @returns 是否真的画上去了（`false` = 无 2D context）
 */
export function drawMACD(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: KlineIndicators,
  width: number,
  height: number = KLINE_MACD_HEIGHT,
): boolean {
  const W = width;
  const H = height;
  const ctx = setupCanvas(canvas, W, H);
  if (!ctx) return false;

  const pad = { top: 10, right: 60, bottom: 12, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = klines.length > 0 ? chartW / klines.length : 0;

  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(0, 0, W, H);

  const { dif, dea, macd } = indicators.macd;
  const all: number[] = [];
  dif.forEach((v) => !isNaN(v) && all.push(v));
  dea.forEach((v) => !isNaN(v) && all.push(v));
  macd.forEach((v) => !isNaN(v) && all.push(v));
  const maxAbs = Math.max(...all.map(Math.abs), 0.0001);
  const zeroY = pad.top + chartH / 2;

  ctx.strokeStyle = COLORS.chartAxis;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(W - pad.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  macd.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const h = (v / maxAbs) * (chartH / 2 - 4);
    ctx.fillStyle = v >= 0 ? COLORS.macdBarPos : COLORS.macdBarNeg;
    ctx.fillRect(x - barW * 0.4, zeroY - h, barW * 0.8, Math.abs(h) || 1);
  });

  const drawLine = (vals: number[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (isNaN(v)) return;
      const x = pad.left + i * barW + barW / 2;
      const y = zeroY - (v / maxAbs) * (chartH / 2 - 4);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  };
  drawLine(dif, COLORS.difLine);
  drawLine(dea, COLORS.deaLine);

  ctx.fillStyle = COLORS.chartLabel;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('MACD(12,26,9)', pad.left + 4, pad.top + 4);
  ctx.fillStyle = COLORS.difLine;
  ctx.fillText(`DIF ${dif[dif.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 100, pad.top + 4);
  ctx.fillStyle = COLORS.deaLine;
  ctx.fillText(`DEA ${dea[dea.length - 1]?.toFixed(4) ?? '--'}`, pad.left + 220, pad.top + 4);

  return true;
}

/**
 * 画 RSI 副图
 *
 * ⚠️ 小图（卡 6）只画 MA + MACD，**不画 RSI**（ux_v2 行 433「只画 MA + 一个副图」）。
 *    本函数保留在此，是为了让 Wave 5 / T70 重写 `pages/Kline.tsx` 时
 *    能把三个绘制函数**一次性**改为从本模块 import（D-8 裁决的本意）。
 *
 * @returns 是否真的画上去了（`false` = 无 2D context）
 */
export function drawRSI(
  canvas: HTMLCanvasElement,
  klines: KlineBar[],
  indicators: KlineIndicators,
  width: number,
  height: number = KLINE_RSI_HEIGHT,
): boolean {
  const W = width;
  const H = height;
  const ctx = setupCanvas(canvas, W, H);
  if (!ctx) return false;

  const pad = { top: 10, right: 60, bottom: 12, left: 10 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = klines.length > 0 ? chartW / klines.length : 0;

  ctx.fillStyle = COLORS.chartBg;
  ctx.fillRect(0, 0, W, H);

  [30, 50, 70].forEach((level) => {
    const y = pad.top + ((100 - level) / 100) * chartH;
    ctx.strokeStyle = level === 50 ? COLORS.chartAxisStrong : COLORS.chartAxis;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.textTertiary;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(level), W - pad.right + 4, y + 4);
  });

  const rsi = indicators.rsi;
  ctx.strokeStyle = COLORS.rsiLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  rsi.forEach((v, i) => {
    if (isNaN(v)) return;
    const x = pad.left + i * barW + barW / 2;
    const y = pad.top + ((100 - v) / 100) * chartH;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.fillStyle = COLORS.chartLabel;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('RSI(14)', pad.left + 4, pad.top + 4);
  const lastRSI = rsi[rsi.length - 1];
  ctx.fillStyle = COLORS.rsiLine;
  ctx.fillText(`${isNaN(lastRSI) ? '--' : lastRSI.toFixed(2)}`, pad.left + 70, pad.top + 4);

  return true;
}
