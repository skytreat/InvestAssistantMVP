/**
 * 布林带 Bollinger Bands（T52）
 *
 * 算法全部由 `fast-technical-indicators@1.1.6` 的 `BollingerBands` 计算，
 * 本文件只是形状适配层（补齐成全长数组），不实现任何统计算法。
 *
 * 库的口径（实测 `lib/volatility/bollinger-bands.js`）：
 * - 总体标准差（除以 N，不是 N-1）
 * - 返回尾部对齐的短数组，长度 = `values.length - period + 1`
 *
 * 🔒 `apps/frontend/src/indicators/bollinger.ts` 是本文件的**逐位等价副本**
 * （前端禁止 import @invest/core），两份必须保持字节一致。
 */

import { BollingerBands } from 'fast-technical-indicators';

export const BOLL_DEFAULT_PERIOD = 20;
export const BOLL_DEFAULT_STDDEV = 2;

export interface BollResult {
  upper: number[];
  middle: number[];
  lower: number[];
  /** %B：(close - lower) / (upper - lower) */
  pb: number[];
  /** 带宽：(upper - lower) / middle */
  width: number[];
}

/** 库的 `BollingerBandsOutput` 字段全为可选（播种期无值）→ 统一转 NaN，绝不产出 undefined */
function orNaN(value: number | undefined): number {
  return value === undefined ? NaN : value;
}

/** 把库的尾部对齐短数组补齐成全长数组（头部填 NaN） */
function padFront(length: number, values: number[], fill: number): number[] {
  const pad = Math.max(0, length - values.length);
  const result = new Array<number>(length).fill(fill);
  for (let i = 0; i < values.length; i++) {
    const target = pad + i;
    if (target < length) result[target] = values[i];
  }
  return result;
}

/**
 * 布林带
 *
 * @returns 与 `closes` 等长的数组；前 `period - 1` 个为 NaN（数据不足期）
 */
export function calculateBoll(
  closes: number[],
  period: number = BOLL_DEFAULT_PERIOD,
  stdDev: number = BOLL_DEFAULT_STDDEV,
): BollResult {
  const empty: BollResult = {
    upper: new Array<number>(closes.length).fill(NaN),
    middle: new Array<number>(closes.length).fill(NaN),
    lower: new Array<number>(closes.length).fill(NaN),
    pb: new Array<number>(closes.length).fill(NaN),
    width: new Array<number>(closes.length).fill(NaN),
  };

  const rows = BollingerBands.calculate({ period, values: closes, stdDev });
  if (rows.length === 0) return empty;

  return {
    upper: padFront(
      closes.length,
      rows.map((r) => orNaN(r.upper)),
      NaN,
    ),
    middle: padFront(
      closes.length,
      rows.map((r) => orNaN(r.middle)),
      NaN,
    ),
    lower: padFront(
      closes.length,
      rows.map((r) => orNaN(r.lower)),
      NaN,
    ),
    pb: padFront(
      closes.length,
      rows.map((r) => orNaN(r.pb)),
      NaN,
    ),
    width: padFront(
      closes.length,
      rows.map((r) => orNaN(r.width)),
      NaN,
    ),
  };
}
