/**
 * ZigZag 摆动点识别（TradingView 官方 ZigZag 库口径）
 *
 * 两段式：
 *   ① findRawPivots —— 按 `depth` 找局部极值（每侧 `floor(depth/2)` 根）；
 *   ② filterPivotsByDeviation —— 按 `deviationPct` 做增量过滤，合并过小的反向摆动。
 *
 * 口径与默认值见 `docs/client/pattern_recognition_design.md` §4。
 *
 * ⚠️ 滞后是**固有**的：枢轴需要右侧 `half` 根已收盘 bar 才能确认，
 *    本模块**不做未来数据回填**（第 t 根只能看到 t-half 及更早的枢轴）。
 */
import type { DailyKline } from '@invest/core';

/** 枢轴类型 */
export type PivotType = 'high' | 'low';

/** ZigZag 输出点 */
export interface ZigZagPoint {
  /** 在输入 bars 数组中的下标（不是日期） */
  index: number;
  date: string;
  /** 顶用 high，底用 low */
  price: number;
  type: PivotType;
}

export interface ZigZagOptions {
  /** 枢轴窗口（偶数更好理解）；默认 10 → 每侧 5 根 */
  depth?: number;
  /** 最小反向幅度（百分比）；默认 2.5（TradingView 原默认 5 面向加密/外汇量级） */
  deviationPct?: number;
}

export const DEFAULT_DEPTH = 10;
export const DEFAULT_DEVIATION_PCT = 2.5;

/** 浮点边界容差（恰好等于阈值时应判「成立」） */
const EPS = 1e-9;

/** 第 i 根是否为枢轴高点：左侧允许相等、右侧必须严格更低（平顶取最后一个） */
function isPivotHigh(bars: DailyKline[], i: number, half: number): boolean {
  const hi = bars[i].high;
  for (let k = 1; k <= half; k++) {
    if (hi < bars[i - k].high) return false;
    if (hi <= bars[i + k].high) return false;
  }
  return true;
}

/** 第 i 根是否为枢轴低点：左侧允许相等、右侧必须严格更高（平底取最后一个） */
function isPivotLow(bars: DailyKline[], i: number, half: number): boolean {
  const lo = bars[i].low;
  for (let k = 1; k <= half; k++) {
    if (lo > bars[i - k].low) return false;
    if (lo >= bars[i + k].low) return false;
  }
  return true;
}

/**
 * 原始枢轴（未做 deviation 过滤）
 *
 * 同一根 bar 同时满足 High / Low（外包日）时，取离窗口中枢更远的一侧；距离相等取 High。
 * 该规则只影响外包日的标注点位置，不改变顶/底交替性质。
 */
export function findRawPivots(bars: DailyKline[], depth: number = DEFAULT_DEPTH): ZigZagPoint[] {
  const half = Math.max(1, Math.floor(depth / 2));
  const n = bars.length;
  if (n < 2 * half + 1) return [];

  const out: ZigZagPoint[] = [];
  for (let i = half; i <= n - 1 - half; i++) {
    const high = isPivotHigh(bars, i, half);
    const low = isPivotLow(bars, i, half);
    if (!high && !low) continue;

    let type: PivotType;
    if (high && low) {
      // 外包日：用窗口中枢判断哪一侧的摆动更显著
      let winHigh = -Infinity;
      let winLow = Infinity;
      for (let k = -half; k <= half; k++) {
        if (bars[i + k].high > winHigh) winHigh = bars[i + k].high;
        if (bars[i + k].low < winLow) winLow = bars[i + k].low;
      }
      const mid = (winHigh + winLow) / 2;
      type = bars[i].high - mid >= mid - bars[i].low ? 'high' : 'low';
    } else {
      type = high ? 'high' : 'low';
    }

    out.push({
      index: i,
      date: bars[i].date,
      price: type === 'high' ? bars[i].high : bars[i].low,
      type,
    });
  }
  return out;
}

/**
 * deviation 增量过滤（§4.2 状态机）
 *
 * - 同类型候选：更极端则替换上一个，否则丢弃；
 * - 异类型候选：与上一个价差 ≥ deviation 才接受，否则丢弃。
 *
 * 流式版本可在逐 bar 复现时不使用未来数据；`deviationPct` 越大，输出枢轴数单调不增。
 */
export function filterPivotsByDeviation(pivots: ZigZagPoint[], deviationPct: number): ZigZagPoint[] {
  const thresholdPct = Math.max(0, deviationPct);
  const out: ZigZagPoint[] = [];

  for (const p of pivots) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }

    if (p.type === last.type) {
      const moreExtreme = p.type === 'high' ? p.price > last.price : p.price < last.price;
      if (moreExtreme) out[out.length - 1] = p;
      continue;
    }

    const changePct = (Math.abs(p.price - last.price) / last.price) * 100;
    if (changePct + EPS >= thresholdPct) out.push(p);
  }

  return out;
}

/** 完整 ZigZag（枢轴 + deviation 过滤） */
export function buildZigZag(bars: DailyKline[], options: ZigZagOptions = {}): ZigZagPoint[] {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const deviationPct = options.deviationPct ?? DEFAULT_DEVIATION_PCT;
  return filterPivotsByDeviation(findRawPivots(bars, depth), deviationPct);
}
