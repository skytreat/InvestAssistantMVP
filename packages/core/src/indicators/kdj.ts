/**
 * KDJ 随机指标（A 股通达信口径，T52）
 *
 * ⚠️ 库里**没有 KDJ**（实测 `fast-technical-indicators@1.1.6` 全部导出符号中
 * 不含 `KDJ`，只有美式 `Stochastic`）。**不得用 `Stochastic` 替代**：
 * 美式随机指标与 A 股 KDJ 口径不同（实测 K=78.58/D=76.05 vs A 股 K=72.05/D=65.24）。
 *
 * 通达信公式原文：
 * ```
 * RSV:=(CLOSE-LVN(LOW,N))/(HVN(HIGH,N)-LVN(LOW,N))*100;
 * K:SMA(RSV,M1,1);
 * D:SMA(K,M2,1);
 * J:3*K-2*D;
 * ```
 * 其中 `SMA(X,N,M) = (M*X + (N-M)*X')/N`。
 *
 * **初值 K₀ = D₀ = 50** 与 `1/3` 的递归权重是 A 股 KDJ 与美式 Stochastic 的分水岭，
 * 由 `tests/fixtures/golden/kdj.json` 锁定。
 *
 * KDJ 是**唯一的递归平滑指标**，累加顺序即结果，故
 * `apps/frontend/src/indicators/kdj.ts` 是本文件的**逐位等价副本**
 * （前端禁止 import @invest/core，故只能各存一份）。
 *
 * 🔒 **两份文件必须保持字节一致** —— 由 `tests/kdj.frontend-parity.test.ts`
 * 断言。改其中一份必须同步另一份，否则 K/D/J 会出现末位差异，
 * 而 KDJ 在本项目里**不允许任何容差**。
 */

import { Highest, Lowest } from 'fast-technical-indicators';

/** N：RSV 回看的 K 线根数（HVN/LVN 的周期） */
export const KDJ_DEFAULT_N = 9;
/** M1：K 的平滑周期（`K:SMA(RSV,M1,1)`） */
export const KDJ_DEFAULT_M1 = 3;
/** M2：D 的平滑周期（`D:SMA(K,M2,1)`） */
export const KDJ_DEFAULT_M2 = 3;
/** K₀ / D₀ 的初值；同时作为 RSV 无前值可沿用时的填充值 */
export const KDJ_INITIAL_VALUE = 50;
/** RSV 的百分比刻度：`*100` */
export const RSV_PERCENT_SCALE = 100;
/** `SMA(X,N,M)` 中 M = 1，即当期权重 1、前期权重 N-1 */
export const SMA_WEIGHT_CURRENT = 1;
/** `J = 3K - 2D` 中 K 的系数 */
export const J_K_COEFFICIENT = 3;
/** `J = 3K - 2D` 中 D 的系数 */
export const J_D_COEFFICIENT = 2;

export interface KDJResult {
  k: number[];
  d: number[];
  j: number[];
}

/**
 * KDJ（A 股口径）
 *
 * 边界约定：
 * - **数据不足期**（前 `n - 1` 根，凑不满一个 RSV 窗口）→ K/D/J 均为 NaN
 * - **`Hn === Ln`（窗口横盘，除零）** → RSV 沿用前值；尚无前值时取 {@link KDJ_INITIAL_VALUE}
 * - 输入含 NaN → 该点及其后全部为 NaN（不做异常兜底，静默兜底会掩盖脏数据）
 *
 * @param highs / lows / closes 必须等长，按时间**升序**（最早 → 最新）
 */
export function calculateKDJ(
  highs: number[],
  lows: number[],
  closes: number[],
  n: number = KDJ_DEFAULT_N,
  m1: number = KDJ_DEFAULT_M1,
  m2: number = KDJ_DEFAULT_M2
): KDJResult {
  const len = closes.length;
  const k = new Array<number>(len).fill(NaN);
  const d = new Array<number>(len).fill(NaN);
  const j = new Array<number>(len).fill(NaN);

  if (len === 0) return { k, d, j };
  if (highs.length !== len || lows.length !== len) {
    throw new RangeError(
      `calculateKDJ: highs/lows/closes 长度必须一致，实际 ${highs.length}/${lows.length}/${len}`
    );
  }

  // 库的 Highest/Lowest 返回尾部对齐的短数组：hh[i] 对应 bar i + (n - 1)
  const hh = Highest.calculate({ period: n, values: highs });
  const ll = Lowest.calculate({ period: n, values: lows });

  const windowOffset = n - 1;
  let prevRsv = KDJ_INITIAL_VALUE;

  for (let i = 0; i < hh.length; i++) {
    const high = hh[i];
    const low = ll[i];
    const range = high - low;

    // 横盘（分母为 0）→ RSV 沿用前值，避免 Infinity/NaN 污染整条线
    const rsv =
      range === 0
        ? prevRsv
        : (RSV_PERCENT_SCALE * (closes[i + windowOffset] - low)) / range;
    prevRsv = rsv;

    const idx = i + windowOffset;
    const prevK = i === 0 ? KDJ_INITIAL_VALUE : k[idx - 1];
    const prevD = i === 0 ? KDJ_INITIAL_VALUE : d[idx - 1];

    // SMA(X, m, 1) = (1*X + (m-1)*X') / m
    k[idx] = (SMA_WEIGHT_CURRENT * rsv + (m1 - SMA_WEIGHT_CURRENT) * prevK) / m1;
    d[idx] = (SMA_WEIGHT_CURRENT * k[idx] + (m2 - SMA_WEIGHT_CURRENT) * prevD) / m2;
    j[idx] = J_K_COEFFICIENT * k[idx] - J_D_COEFFICIENT * d[idx];
  }

  return { k, d, j };
}