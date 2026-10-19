/**
 * 指标适配层（T51）
 *
 * 本文件**不实现任何 EMA / DIF / DEA / Wilder 算法** —— 全部由
 * `fast-technical-indicators@1.1.6`（精确锁版本，无 `^`）计算。
 * 适配层只做两件事：
 *
 * 1. **数组补齐**（§4.3.3 形状契约）
 *    库的 `calculate()` 返回**尾部对齐的短数组**（EMA 用前 N 期 SMA 播种，
 *    播种期无值）；而 core 对外契约是**与输入等长的全长数组**，
 *    因为 `Kline.tsx` 用同一 index 索引 `klines` 与 `indicators`，不对齐就整条线错位。
 *
 * 2. **柱值 `histogram × 2`**（§4.3.2 A 股约定）
 *    实测库的 `histogram === DIF - signal`（美式 Wilder 约定）；
 *    A 股通达信标准是 `MACD : 2*(DIF-DEA), COLORSTICK`。本产品是 A 股工具，
 *    故把库修正到 A 股约定。
 *
 * 版本锁定即一致性保障：core 与 frontend 依赖同一个库的同一个版本，
 * golden 数据集降级为**回归网**（防库升级 / 防适配层改错）。
 */

import { MACD, RSI, SMA } from 'fast-technical-indicators';

/** MACD 三线结果。`macd` 为 A 股口径柱值 `2 × (DIF - DEA)` */
export interface MACDResult {
  dif: number[];
  dea: number[];
  macd: number[];
}

export const RSI_DEFAULT_PERIOD = 14;
export const MACD_DEFAULT_FAST_PERIOD = 12;
export const MACD_DEFAULT_SLOW_PERIOD = 26;
export const MACD_DEFAULT_SIGNAL_PERIOD = 9;

/** RSI 数据不足期的占位值（中性 50）—— 保持既有对外契约，不改调用方语义 */
export const RSI_INSUFFICIENT_VALUE = 50;

/** A 股（通达信）柱值 = 2 × (DIF - DEA)，库给的是美式 1 × (DIF - DEA) */
export const A_SHARE_HISTOGRAM_SCALE = 2;

/**
 * 把库的尾部对齐短数组补齐成全长数组（头部填 fill）。
 * 库返回值长度不会超过入参长度；防御性处理负 pad，避免 pad + i 越界写出稀疏数组。
 */
function padFront(length: number, values: number[], fill: number): number[] {
  const pad = Math.max(0, length - values.length);
  const result = new Array<number>(length).fill(fill);
  for (let i = 0; i < values.length; i++) {
    const target = pad + i;
    if (target < length) result[target] = values[i];
  }
  return result;
}

/** 库的 `MACDOutput` 三个字段都是可选的（播种期无值）→ 统一转 NaN，绝不产出 undefined */
function orNaN(value: number | undefined): number {
  return value === undefined ? NaN : value;
}

/**
 * RSI 相对强弱指标（Wilder 平滑，口径由库保证）
 *
 * @returns 与 `closes` 等长的数组；数据不足期（前 `period` 个）填 {@link RSI_INSUFFICIENT_VALUE}
 */
export function calculateRSI(
  closes: number[],
  period: number = RSI_DEFAULT_PERIOD
): number[] {
  const values = RSI.calculate({ values: closes, period });
  if (values.length === 0) {
    return new Array<number>(closes.length).fill(RSI_INSUFFICIENT_VALUE);
  }
  // 库对每个 RSI 值做了 2 位小数取整（toFixed(2)）—— 这是库的口径，不是适配层引入的
  return padFront(closes.length, values, RSI_INSUFFICIENT_VALUE);
}

/**
 * MACD（12, 26, 9）
 *
 * 与库的差异只有两处，均为 §4.3 的形状/约定变换，**不是算法差异**：
 * - 库用前 N 期 SMA 播种 EMA，core 旧实现用首值播种 → warm-up 瞬态，会指数收敛
 * - 库返回短数组 → 补齐
 * - 库柱值是美式 `DIF - DEA` → ×2 转 A 股口径
 *
 * @returns 长度不足 `slowPeriod + signalPeriod` 时返回三个空数组（沿用既有对外契约）
 */
export function calculateMACD(
  closes: number[],
  fastPeriod: number = MACD_DEFAULT_FAST_PERIOD,
  slowPeriod: number = MACD_DEFAULT_SLOW_PERIOD,
  signalPeriod: number = MACD_DEFAULT_SIGNAL_PERIOD
): MACDResult {
  if (closes.length < slowPeriod + signalPeriod) {
    return { dif: [], dea: [], macd: [] };
  }

  const rows = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
  });
  if (rows.length === 0) {
    return { dif: [], dea: [], macd: [] };
  }

  return {
    // DIF 从 slowPeriod - 1 根起有值
    dif: padFront(closes.length, rows.map((r) => orNaN(r.MACD)), NaN),
    // DEA / 柱值还要再等 signalPeriod - 1 根
    dea: padFront(closes.length, rows.map((r) => orNaN(r.signal)), NaN),
    macd: padFront(
      closes.length,
      rows.map((r) => orNaN(r.histogram) * A_SHARE_HISTOGRAM_SCALE),
      NaN
    ),
  };
}

/**
 * SMA 简单移动平均
 *
 * @returns 与 `values` 等长的数组；前 `period - 1` 个为 NaN（数据不足期）
 */
export function calculateSMA(values: number[], period: number): number[] {
  const result = SMA.calculate({ period, values });
  if (result.length === 0) {
    return new Array<number>(values.length).fill(NaN);
  }
  return padFront(values.length, result, NaN);
}