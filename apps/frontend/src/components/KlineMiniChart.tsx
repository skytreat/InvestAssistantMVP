import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { extractErrorMessage } from '../api/errors';
import { COLORS, TYPO } from '../theme/tokens';
import Spinner from './Spinner';
import {
  drawMACD,
  drawMain,
  type KlineBar,
  type KlineIndicators,
  type KlineSignalMarker,
} from './klineCanvas';

/**
 * K 线小图（T67 · Wave 3 卡 6 · ux_v2 建议 C）
 *
 * 依据 ux_v2 行 433-434：「Modal 里展示的是**压缩版 K 线**（只画 **MA + 一个副图**，
 * 时间范围默认 **120 天**）」。
 *
 * ## 画布逻辑的来源（D-8 裁决）
 *
 * 绘制函数全部来自 **`./klineCanvas`**（该模块与 `pages/Kline.tsx` 的绘制逻辑**同源**，
 * 是从那里**复制**出来的独立模块 —— 详见 `klineCanvas.ts` 顶部注释）。
 * 🔴 **禁止**从 `../pages/Kline` import —— 那会把 Kline 整页代码拉进 Dashboard 首屏 chunk，
 *    破坏 T66 的「首屏 chunk 不含 Kline」不变量。
 *
 * ## 降级（**硬要求**，卡 6「风险与坑」第 1 条）
 *
 * jsdom（以及未安装 `canvas` 包的环境）里 `canvas.getContext('2d')` 返回 `null`。
 * `klineCanvas` 的绘制函数对此**返回 `false` 而不是抛异常**，
 * 本组件据此渲染**降级提示文案**（不白屏、不抛未捕获异常）。
 */

/** 小图默认展示天数（ux_v2 行 434「默认 120 天」）*/
export const MINI_CHART_DEFAULT_DAYS = 120;

/** 小图默认复权口径（与整页 K 线页默认一致：`qfq`）*/
export const MINI_CHART_DEFAULT_FQ = 'qfq';

/** 小图画布基准宽度（容器测不到宽度时的兜底）*/
export const MINI_CHART_WIDTH = 840;

/** 小图主图高度（**小图自己的常量**，不改 `pages/Kline.tsx` 的 `MAIN_HEIGHT = 400`）*/
export const MINI_CHART_MAIN_HEIGHT = 220;

/** 小图副图（MACD）高度（**小图自己的常量**，不改 `pages/Kline.tsx` 的 `MACD_HEIGHT = 160`）*/
export const MINI_CHART_SUB_HEIGHT = 100;

export interface KlineMiniChartProps {
  /** 标的代码（如 `sh600000`）*/
  symbol: string;
  /** 回溯天数，默认 120 */
  days?: number;
  /** 复权口径，默认 `qfq` */
  fq?: 'qfq' | 'raw';
  /** 画布基准宽度（容器更窄时以容器宽为准）*/
  width?: number;
  /** 主图高度（px）*/
  mainHeight?: number;
  /** 副图高度（px）*/
  subHeight?: number;
}

/** 后端 `GET /api/quote/:symbol/kline` 的响应体（envelope 内层）*/
interface KlineApiResponse {
  success?: boolean;
  code?: number;
  message?: string;
  data?: {
    symbol: string;
    fq: string;
    klines: KlineBar[];
    indicators: KlineIndicators | null;
    signals?: KlineSignalMarker[];
  };
}

/**
 * 判断 envelope 是否成功
 *
 * ⚠️ `success` 是 T89a 的**过渡字段**（T89b 会删）。故优先看 `code === 0`，
 *    `code` 不存在时回落到 `success === true` —— 两种形态都能判对。
 */
function isOkEnvelope(body: KlineApiResponse): boolean {
  if (typeof body.code === 'number') return body.code === 0;
  return body.success === true;
}

/** 容器宽度（测不到就用基准宽度；并**封顶**在基准宽度内）*/
function measureWidth(el: HTMLElement | null, fallback: number): number {
  const w = el?.clientWidth ?? 0;
  if (w <= 0) return fallback;
  return Math.min(Math.floor(w), fallback);
}

export function KlineMiniChart({
  symbol,
  days = MINI_CHART_DEFAULT_DAYS,
  fq = MINI_CHART_DEFAULT_FQ,
  width = MINI_CHART_WIDTH,
  mainHeight = MINI_CHART_MAIN_HEIGHT,
  subHeight = MINI_CHART_SUB_HEIGHT,
}: KlineMiniChartProps) {
  const [klines, setKlines] = useState<KlineBar[]>([]);
  const [indicators, setIndicators] = useState<KlineIndicators | null>(null);
  const [signals, setSignals] = useState<KlineSignalMarker[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 画布是否真的画上去了（`false` = 环境不支持 2D context → 显示降级提示）*/
  const [canvasDrawn, setCanvasDrawn] = useState(true);

  const wrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const subRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<KlineApiResponse>(`/quote/${symbol}/kline`, { params: { days, fq } })
      .then((res) => {
        if (cancelled) return;
        const body = res.data;
        if (isOkEnvelope(body) && body.data) {
          setKlines(body.data.klines ?? []);
          setIndicators(body.data.indicators ?? null);
          setSignals(body.data.signals ?? []);
        } else {
          setError(body.message ?? 'K 线数据加载失败');
          setKlines([]);
          setIndicators(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError('K 线数据加载失败：' + extractErrorMessage(err, '请求失败'));
        setKlines([]);
        setIndicators(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, days, fq]);

  const redraw = useCallback(() => {
    if (klines.length === 0 || !indicators) return;
    const mainEl = mainRef.current;
    const subEl = subRef.current;
    if (!mainEl || !subEl) return;
    const w = measureWidth(wrapRef.current, width);
    const okMain = drawMain(mainEl, klines, indicators, signals, w, mainHeight);
    const okSub = drawMACD(subEl, klines, indicators, w, subHeight);
    setCanvasDrawn(okMain && okSub);
  }, [klines, indicators, signals, width, mainHeight, subHeight]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // 窗口尺寸变化（旋转屏幕 / 拖窗口）重画
  useEffect(() => {
    const onResize = () => redraw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [redraw]);

  const hintStyle: React.CSSProperties = {
    fontSize: TYPO.smallSize,
    color: COLORS.textSecondary,
  };

  return (
    <div data-testid="kline-mini-chart">
      {loading && klines.length === 0 && <Spinner label="加载 K 线..." />}

      {!loading && error && (
        <div data-testid="kline-mini-chart-error" style={{ ...hintStyle, color: COLORS.danger }}>
          {error}
        </div>
      )}

      {!loading && !error && klines.length === 0 && (
        <div data-testid="kline-mini-chart-empty" style={hintStyle}>
          暂无 K 线数据
        </div>
      )}

      {/*
        🔴 画布分支**只以「有没有数据」为条件**，**不看 `loading`**。
        原因（实测踩到的坑）：请求的 `setKlines` 与 `setLoading(false)` 落在**两个不同的
        microtask**（`then` 与 `finally`）里 —— 若把画布挂在 `!loading` 之下，
        则「数据已到、loading 还没落」的那一次渲染里画布**还没挂载**，
        绘制 effect 先跑（`mainRef.current === null` → 直接 return），
        随后 loading 落下来画布才挂上 —— 而绘制 effect 的依赖没变 → **再也不重画**
        ⇒ 图表永远空白。
        改成「有数据就渲染画布」后：数据到达的那一次提交里画布已挂载，
        ref 在 commit 阶段就绪，绘制 effect 拿到 ref → 画得出来。
      */}
      {klines.length > 0 && (
        <>
          <div ref={wrapRef} style={{ width: '100%', overflow: 'hidden' }}>
            <canvas
              ref={mainRef}
              data-testid="kline-mini-chart-canvas"
              aria-label="K 线小图（主图）"
              style={{
                border: `1px solid ${COLORS.chartBorder}`,
                display: 'block',
                maxWidth: '100%',
              }}
            />
            <div style={{ height: 6 }} />
            <canvas
              ref={subRef}
              data-testid="kline-mini-chart-sub-canvas"
              aria-label="K 线小图（MACD 副图）"
              style={{
                border: `1px solid ${COLORS.chartBorder}`,
                display: 'block',
                maxWidth: '100%',
              }}
            />
          </div>
          {/*
            🔴 降级提示：环境不支持 2D context（jsdom / 老旧浏览器）时，
               画布画不出来 —— **必须给用户看得见的文案**，不许白屏。
          */}
          {!canvasDrawn && (
            <div data-testid="kline-mini-chart-unsupported" style={hintStyle}>
              当前环境不支持 Canvas，无法显示 K 线小图
            </div>
          )}
          <div style={{ ...hintStyle, marginTop: 4 }}>
            近 {days} 天 · {klines.length} 根K线 · {klines[0].date} ~ {klines[klines.length - 1].date}
          </div>
        </>
      )}
    </div>
  );
}

export default KlineMiniChart;
