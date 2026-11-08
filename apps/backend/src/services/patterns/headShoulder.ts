/**
 * 头肩顶 / 头肩底识别（ZigZag 枢轴 + ATR14，**颈线为两点连线带斜率**）
 *
 * 口径见 `docs/client/pattern_recognition_design.md` §8：
 *
 * ```
 * 头肩顶：High(左肩) → Low(颈1) → High(头) → Low(颈2) → High(右肩)
 * 头肩底：Low(左肩)  → High(颈1) → Low(头)  → High(颈2) → Low(右肩)
 * ```
 *
 * | 判据 | 口径 |
 * |---|---|
 * | 头必须最高/最低 | 头肩顶 `head > max(左肩, 右肩)`；头肩底 `head < min(左肩, 右肩)`（相等不算） |
 * | 两肩高度 | `|左肩 - 右肩| / min(左肩, 右肩) ≤ shoulderTolerancePct`（默认 5%） |
 * | 颈线 | `N(k) = N1.price + slope × (k - N1.index)`，`slope = (N2 - N1) / (i2 - i1)` |
 * | 确认 | 首个 `k ∈ (颈2, 颈2 + confirmWindowBars]` 收盘跌破/升破 `N(k)` 超过阈值 |
 *
 * 阈值与双顶/双底一致：`min(0.5% × N(k), 0.5 × ATR14[k])`（文档 §6.2 判据 7）。
 *
 * 实现补充（文档 §8 未逐条列出，单测已覆盖）：
 * - 两颈点距离必须 `≥ minSeparationBars`（与双顶/双底的间隔下限同一参数），防退化颈线；
 * - 右肩必须仍在线「未破」的一侧（`右肩 > N(右肩)` / `右肩 < N(右肩)`），
 *   否则该形态在右肩成立之前颈线就已被穿越，结构不成立。
 *
 * 输出只有**图上标注**语义 —— 无 direction、不写信号表、不进信号通道（文档 §9）。
 */
import type { DailyKline } from '@invest/core';
import { calculateATR } from './atr.js';
import { buildZigZag, type ZigZagPoint } from './zigzag.js';
import {
  DEFAULT_PATTERN_OPTIONS,
  type PatternBreakout,
  type PatternNeckline,
  type PatternOptions,
} from './reversal.js';

const EPS = 1e-9;

export interface HeadShoulderOptions extends PatternOptions {
  /** 两肩高度差上限（%）；文档 §8 草案 5%，待人工标注集校准 */
  shoulderTolerancePct?: number;
}

export type ResolvedHeadShoulderOptions = Required<HeadShoulderOptions>;

export const DEFAULT_HEAD_SHOULDER_OPTIONS: ResolvedHeadShoulderOptions = {
  ...DEFAULT_PATTERN_OPTIONS,
  shoulderTolerancePct: 5,
};

export type HeadShoulderKind = 'head_shoulders_top' | 'head_shoulders_bottom';

export type HeadShoulderRole = 'left_shoulder' | 'neck1' | 'head' | 'neck2' | 'right_shoulder';

/** 标注点（图上只画这五个点） */
export interface HeadShoulderPoint {
  role: HeadShoulderRole;
  index: number;
  date: string;
  price: number;
}

export interface HeadShoulderMetrics {
  /** 两肩高度差（%） */
  shoulderDiffPct: number;
  /** 头高出（顶）/低于（底）较高肩的幅度（%） */
  headHeightPct: number;
  /** 颈线斜率（每 bar 的百分比变化） */
  necklineSlopePctPerBar: number;
  /** 确认 bar 的 ATR14 / 颈线（%） */
  atrPct: number;
}

/** 头肩标注（仅用于图上画线，不携带交易方向） */
export interface HeadShoulderAnnotation {
  kind: HeadShoulderKind;
  startIndex: number;
  endIndex: number;
  confirmIndex: number;
  points: HeadShoulderPoint[];
  /** 颈线两点连线（`slope ≠ 0`） */
  neckline: PatternNeckline;
  breakout: PatternBreakout;
  metrics: HeadShoulderMetrics;
}

/** 颈线在任意 bar 上的取值（斜率外推） */
function necklineAt(neckline: PatternNeckline, index: number): number {
  return neckline.from.price + neckline.slope * (index - neckline.from.index);
}

/** 突破确认（收盘价 vs **带斜率的颈线**，阈值同双顶/双底） */
function findNecklineBreakout(
  bars: DailyKline[],
  atr: number[],
  fromIndex: number,
  opts: ResolvedHeadShoulderOptions,
  neckline: PatternNeckline,
  direction: 'down' | 'up',
): PatternBreakout | null {
  const last = Math.min(fromIndex + opts.confirmWindowBars, bars.length - 1);
  for (let k = fromIndex + 1; k <= last; k++) {
    const atrK = atr[k];
    // 预热不足 → 该判据不成立，不补零、不猜值
    if (!Number.isFinite(atrK)) continue;

    const neck = necklineAt(neckline, k);
    const threshold = Math.min((opts.breakoutMinPct / 100) * neck, opts.breakoutAtrMult * atrK);
    const penetrationAbs = direction === 'down' ? neck - bars[k].close : bars[k].close - neck;
    if (penetrationAbs + EPS >= threshold) {
      return {
        index: k,
        date: bars[k].date,
        close: bars[k].close,
        penetrationPct: (penetrationAbs / neck) * 100,
      };
    }
  }
  return null;
}

/** 用五个枢轴判定一次头肩（`direction` 决定顶/底方向） */
function checkHeadShoulders(
  bars: DailyKline[],
  atr: number[],
  left: ZigZagPoint,
  neck1: ZigZagPoint,
  head: ZigZagPoint,
  neck2: ZigZagPoint,
  right: ZigZagPoint,
  opts: ResolvedHeadShoulderOptions,
  direction: 'top' | 'bottom',
): HeadShoulderAnnotation | null {
  const isTop = direction === 'top';
  const minShoulder = Math.min(left.price, right.price);
  const maxShoulder = Math.max(left.price, right.price);

  // ① 头必须严格最高/最低（与肩相等不算）
  if (isTop) {
    if (!(head.price > maxShoulder + EPS)) return null;
  } else if (!(head.price < minShoulder - EPS)) return null;

  // ② 两肩高度差
  const shoulderDiffPct = (Math.abs(left.price - right.price) / minShoulder) * 100;
  if (shoulderDiffPct > opts.shoulderTolerancePct + EPS) return null;

  // ③ 颈线：两点连线带斜率（两点距离过近视为退化）
  if (neck2.index - neck1.index < opts.minSeparationBars) return null;
  const neckline: PatternNeckline = {
    from: { index: neck1.index, price: neck1.price },
    to: { index: neck2.index, price: neck2.price },
    slope: (neck2.price - neck1.price) / (neck2.index - neck1.index),
  };

  // ④ 右肩仍在线「未破」的一侧
  const neckAtRight = necklineAt(neckline, right.index);
  if (isTop ? !(right.price > neckAtRight) : !(right.price < neckAtRight)) return null;

  // ⑤ 颈线突破确认（窗口从右颈点开始，收盘价口径）
  const breakout = findNecklineBreakout(bars, atr, neck2.index, opts, neckline, isTop ? 'down' : 'up');
  if (!breakout) return null;

  const headHeightPct = isTop
    ? ((head.price - maxShoulder) / maxShoulder) * 100
    : ((minShoulder - head.price) / minShoulder) * 100;

  return {
    kind: isTop ? 'head_shoulders_top' : 'head_shoulders_bottom',
    startIndex: left.index,
    endIndex: breakout.index,
    confirmIndex: breakout.index,
    points: [
      { role: 'left_shoulder', index: left.index, date: left.date, price: left.price },
      { role: 'neck1', index: neck1.index, date: neck1.date, price: neck1.price },
      { role: 'head', index: head.index, date: head.date, price: head.price },
      { role: 'neck2', index: neck2.index, date: neck2.date, price: neck2.price },
      { role: 'right_shoulder', index: right.index, date: right.date, price: right.price },
    ],
    neckline,
    breakout,
    metrics: {
      shoulderDiffPct,
      headHeightPct,
      necklineSlopePctPerBar: (neckline.slope / neck1.price) * 100,
      atrPct: (atr[breakout.index] / necklineAt(neckline, breakout.index)) * 100,
    },
  };
}

/**
 * 识别头肩顶 / 头肩底（只返回**已收盘确认**的形态）
 *
 * 未在右颈点之后 `confirmWindowBars` 根内收盘突破颈线的，一律不输出
 * （不存在「待确认」态）。
 */
export function detectHeadShoulders(
  bars: DailyKline[],
  options: HeadShoulderOptions = {},
): HeadShoulderAnnotation[] {
  const opts: ResolvedHeadShoulderOptions = { ...DEFAULT_HEAD_SHOULDER_OPTIONS, ...options };
  const half = Math.max(1, Math.floor(opts.depth / 2));
  if (bars.length < 2 * half + 1) return [];

  const zigzag = buildZigZag(bars, { depth: opts.depth, deviationPct: opts.deviationPct });
  const atr = calculateATR(bars, opts.atrPeriod);
  const out: HeadShoulderAnnotation[] = [];

  for (let i = 0; i + 4 < zigzag.length; i++) {
    const a = zigzag[i];
    const b = zigzag[i + 1];
    const c = zigzag[i + 2];
    const d = zigzag[i + 3];
    const e = zigzag[i + 4];

    if (a.type === 'high' && b.type === 'low' && c.type === 'high' && d.type === 'low' && e.type === 'high') {
      const pattern = checkHeadShoulders(bars, atr, a, b, c, d, e, opts, 'top');
      if (pattern) out.push(pattern);
    } else if (
      a.type === 'low' &&
      b.type === 'high' &&
      c.type === 'low' &&
      d.type === 'high' &&
      e.type === 'low'
    ) {
      const pattern = checkHeadShoulders(bars, atr, a, b, c, d, e, opts, 'bottom');
      if (pattern) out.push(pattern);
    }
  }

  return out;
}
