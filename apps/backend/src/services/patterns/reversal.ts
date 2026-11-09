/**
 * 双顶 / 双底识别（基于 ZigZag 枢轴 + ATR14 自适应阈值）
 *
 * 判据见 `docs/client/pattern_recognition_design.md` §6。
 * 输出只有**图上标注**语义 —— 无 direction、不写信号表、不进信号通道（§9 硬约束）。
 *
 * 滞后：枢轴本身滞后 floor(depth/2)=5 根，确认还需等颈线收盘突破（常见 1–3 根，
 * 最迟 confirmWindowBars=20 根）→ 典型 6–8 根，最坏 25 根（§10）。
 */
import type { DailyKline } from '@invest/core';
import { calculateATR, DEFAULT_ATR_PERIOD } from './atr.js';
import {
  buildZigZag,
  DEFAULT_DEPTH,
  DEFAULT_DEVIATION_PCT,
  type ZigZagOptions,
  type ZigZagPoint,
} from './zigzag.js';

export interface PatternOptions extends ZigZagOptions {
  atrPeriod?: number;
  /** 两顶/两底价差上限（%） */
  topTolerancePct?: number;
  minSeparationBars?: number;
  /** 上限必须有，否则隔半年的两个高点会被配成双顶 */
  maxSeparationBars?: number;
  /** 中间谷/峰的最小回撤（%），与 1×ATR14 取较大者 */
  valleyMinRetracePct?: number;
  /** 谷位相对两顶的下限（0–1） */
  valleyPositionMin?: number;
  /** 谷位相对两顶的上限（0–1） */
  valleyPositionMax?: number;
  confirmWindowBars?: number;
  /** 跌破/升破颈线的最小百分比幅度（%） */
  breakoutMinPct?: number;
  /** 跌破/升破颈线的最小 ATR 倍数 */
  breakoutAtrMult?: number;
}

export type ResolvedPatternOptions = Required<PatternOptions>;

export const DEFAULT_PATTERN_OPTIONS: ResolvedPatternOptions = {
  depth: DEFAULT_DEPTH,
  deviationPct: DEFAULT_DEVIATION_PCT,
  atrPeriod: DEFAULT_ATR_PERIOD,
  topTolerancePct: 2,
  minSeparationBars: 10,
  maxSeparationBars: 60,
  valleyMinRetracePct: 2,
  valleyPositionMin: 0.2,
  valleyPositionMax: 0.8,
  confirmWindowBars: 20,
  breakoutMinPct: 0.5,
  breakoutAtrMult: 0.5,
};

const EPS = 1e-9;

export type PatternKind = 'double_top' | 'double_bottom';

/** 标注点（图上只画这三个点） */
export interface PatternPoint {
  role: 'first' | 'middle' | 'second';
  index: number;
  date: string;
  price: number;
}

export interface PatternNeckline {
  from: { index: number; price: number };
  to: { index: number; price: number };
  /** 双顶/双底恒为 0（水平）；头肩会用斜率 */
  slope: number;
}

export interface PatternBreakout {
  index: number;
  date: string;
  close: number;
  /** 实际突破幅度（%） */
  penetrationPct: number;
}

export interface PatternMetrics {
  /** 两顶/两底价差（%） */
  peakDiffPct: number;
  /** 中间谷/峰的回撤（%） */
  middleDepthPct: number;
  /** 谷位相对两顶的位置（0–100） */
  middlePositionPct: number;
  /** 确认 bar 的 ATR14 / 颈线（%） */
  atrPct: number;
  /** 两顶/两底间隔（bar） */
  separationBars: number;
}

/** 形态标注（仅用于图上画线，不携带交易方向） */
export interface PatternAnnotation {
  kind: PatternKind;
  startIndex: number;
  endIndex: number;
  confirmIndex: number;
  points: PatternPoint[];
  neckline: PatternNeckline;
  breakout: PatternBreakout;
  metrics: PatternMetrics;
}

/** 突破确认（颈线用**收盘价**，阈值按「0.5% 或 0.5×ATR」取较小值，见文档 §6.2 判据 7） */
function findBreakout(
  bars: DailyKline[],
  atr: number[],
  fromIndex: number,
  opts: ResolvedPatternOptions,
  neckline: number,
  direction: 'down' | 'up',
): PatternBreakout | null {
  const last = Math.min(fromIndex + opts.confirmWindowBars, bars.length - 1);
  for (let k = fromIndex + 1; k <= last; k++) {
    const atrK = atr[k];
    // 预热不足 → 该判据不成立，不补零、不猜值
    if (!Number.isFinite(atrK)) continue;

    const threshold = Math.min((opts.breakoutMinPct / 100) * neckline, opts.breakoutAtrMult * atrK);
    const penetrationAbs = direction === 'down' ? neckline - bars[k].close : bars[k].close - neckline;
    if (penetrationAbs + EPS >= threshold) {
      return {
        index: k,
        date: bars[k].date,
        close: bars[k].close,
        penetrationPct: (penetrationAbs / neckline) * 100,
      };
    }
  }
  return null;
}

/** 双顶：High(1) → Low(谷) → High(2)，颈线 = 谷价（水平） */
function checkDoubleTop(
  bars: DailyKline[],
  atr: number[],
  a: ZigZagPoint,
  b: ZigZagPoint,
  c: ZigZagPoint,
  opts: ResolvedPatternOptions,
): PatternAnnotation | null {
  const p1 = a.price;
  const v = b.price;
  const p2 = c.price;
  const lowerPeak = Math.min(p1, p2);

  const peakDiffPct = (Math.abs(p2 - p1) / lowerPeak) * 100;
  if (peakDiffPct > opts.topTolerancePct + EPS) return null;

  const separationBars = c.index - a.index;
  if (separationBars < opts.minSeparationBars || separationBars > opts.maxSeparationBars) return null;

  const atrValley = atr[b.index];
  if (!Number.isFinite(atrValley)) return null;
  const atrPctAtValley = (atrValley / lowerPeak) * 100;
  const requiredDepthPct = Math.max(opts.valleyMinRetracePct, atrPctAtValley);
  const middleDepthPct = ((lowerPeak - v) / lowerPeak) * 100;
  if (middleDepthPct + EPS < requiredDepthPct) return null;

  const middlePosition = (b.index - a.index) / separationBars;
  if (middlePosition + EPS < opts.valleyPositionMin || middlePosition - EPS > opts.valleyPositionMax) {
    return null;
  }

  const breakout = findBreakout(bars, atr, c.index, opts, v, 'down');
  if (!breakout) return null;

  return {
    kind: 'double_top',
    startIndex: a.index,
    endIndex: breakout.index,
    confirmIndex: breakout.index,
    points: [
      { role: 'first', index: a.index, date: a.date, price: p1 },
      { role: 'middle', index: b.index, date: b.date, price: v },
      { role: 'second', index: c.index, date: c.date, price: p2 },
    ],
    neckline: {
      from: { index: a.index, price: v },
      to: { index: c.index, price: v },
      slope: 0,
    },
    breakout,
    metrics: {
      peakDiffPct,
      middleDepthPct,
      middlePositionPct: middlePosition * 100,
      atrPct: (atr[breakout.index] / v) * 100,
      separationBars,
    },
  };
}

/** 双底：Low(1) → High(峰) → Low(2)，颈线 = 峰价（水平） */
function checkDoubleBottom(
  bars: DailyKline[],
  atr: number[],
  a: ZigZagPoint,
  b: ZigZagPoint,
  c: ZigZagPoint,
  opts: ResolvedPatternOptions,
): PatternAnnotation | null {
  const p1 = a.price;
  const v = b.price;
  const p2 = c.price;
  const higherBottom = Math.max(p1, p2);

  const peakDiffPct = (Math.abs(p2 - p1) / higherBottom) * 100;
  if (peakDiffPct > opts.topTolerancePct + EPS) return null;

  const separationBars = c.index - a.index;
  if (separationBars < opts.minSeparationBars || separationBars > opts.maxSeparationBars) return null;

  const atrValley = atr[b.index];
  if (!Number.isFinite(atrValley)) return null;
  const atrPctAtValley = (atrValley / higherBottom) * 100;
  const requiredDepthPct = Math.max(opts.valleyMinRetracePct, atrPctAtValley);
  const middleDepthPct = ((v - higherBottom) / higherBottom) * 100;
  if (middleDepthPct + EPS < requiredDepthPct) return null;

  const middlePosition = (b.index - a.index) / separationBars;
  if (middlePosition + EPS < opts.valleyPositionMin || middlePosition - EPS > opts.valleyPositionMax) {
    return null;
  }

  const breakout = findBreakout(bars, atr, c.index, opts, v, 'up');
  if (!breakout) return null;

  return {
    kind: 'double_bottom',
    startIndex: a.index,
    endIndex: breakout.index,
    confirmIndex: breakout.index,
    points: [
      { role: 'first', index: a.index, date: a.date, price: p1 },
      { role: 'middle', index: b.index, date: b.date, price: v },
      { role: 'second', index: c.index, date: c.date, price: p2 },
    ],
    neckline: {
      from: { index: a.index, price: v },
      to: { index: c.index, price: v },
      slope: 0,
    },
    breakout,
    metrics: {
      peakDiffPct,
      middleDepthPct,
      middlePositionPct: middlePosition * 100,
      atrPct: (atr[breakout.index] / v) * 100,
      separationBars,
    },
  };
}

/**
 * 识别双顶 / 双底（只返回**已收盘确认**的形态）
 *
 * 未在第二顶/底之后 `confirmWindowBars` 根内收盘突破颈线的，一律不输出
 * （不存在「待确认」态，避免前端把未成立形态当成事实）。
 */
export function detectDoubleTopBottom(bars: DailyKline[], options: PatternOptions = {}): PatternAnnotation[] {
  const opts: ResolvedPatternOptions = { ...DEFAULT_PATTERN_OPTIONS, ...options };
  const half = Math.max(1, Math.floor(opts.depth / 2));
  if (bars.length < 2 * half + 1) return [];

  const zigzag = buildZigZag(bars, { depth: opts.depth, deviationPct: opts.deviationPct });
  const atr = calculateATR(bars, opts.atrPeriod);
  const out: PatternAnnotation[] = [];

  for (let i = 0; i + 2 < zigzag.length; i++) {
    const a = zigzag[i];
    const b = zigzag[i + 1];
    const c = zigzag[i + 2];
    if (a.type === 'high' && b.type === 'low' && c.type === 'high') {
      const pattern = checkDoubleTop(bars, atr, a, b, c, opts);
      if (pattern) out.push(pattern);
    } else if (a.type === 'low' && b.type === 'high' && c.type === 'low') {
      const pattern = checkDoubleBottom(bars, atr, a, b, c, opts);
      if (pattern) out.push(pattern);
    }
  }

  return out;
}
