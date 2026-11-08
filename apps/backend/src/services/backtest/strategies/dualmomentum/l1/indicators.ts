/**
 * DualMomentum L1 指标（DAS-2 §3.2），与 QuantInvest `indicators.py` 逐位对齐。
 *
 * 全部为纯函数：输入直接是**前复权到当日**的 `adj` 序列（`adj(T) == raw(T)`），
 * 不含复权换算逻辑（见 `series.ts`）。
 *
 * 失败/数据不足一律返回 `0.0`（不是 NaN / 空），与参考实现一致。
 */
import {
  INDICATOR_LOOKBACK,
  MA_PERIODS,
  NDAY_RETURN_ANNUALIZE,
  NDAY_RETURN_PERIOD,
  RSRS_ENABLE_QUALITY_FILTER,
  RSRS_PERIOD,
  RSRS_STD_PERIOD,
  USE_WSM_V2,
  WSM_PERIOD,
} from './params.js';

function allFinitePositive(values: readonly number[]): boolean {
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) return false;
  }
  return true;
}

/**
 * WSM V2：加权斜率动量。
 *
 * `w_i = linspace(1, 2, n)`，加权最小二乘拟合 `y = slope*x + intercept`。
 * `numpy.polyfit(x, y, 1, w=w)` 把**权重 w 直接乘在设计矩阵行上**，因此法方程里
 * 实际权重是 **w²**（DAS-2 §3.2(a) 的「注意是 w²，不是 w」）。
 * R² 取**一次方**加权残差平方和（`Σ w_i (y_i-ŷ_i)²`），但分母的 `ȳ` 是
 * **未加权均值**，都照抄参考实现。
 */
export function calcWeightedSlopeMomentum(closePrices: readonly number[], v2: boolean = USE_WSM_V2): number {
  const n = closePrices.length;
  if (n < 2) return 0;
  if (!allFinitePositive(closePrices)) return 0;

  const y = new Array<number>(n);
  const x = new Array<number>(n);
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    y[i] = Math.log(closePrices[i]);
    x[i] = i;
    w[i] = 1 + i / (n - 1); // linspace(1, 2, n)
  }

  // 加权最小二乘闭式解：polyfit 用 w 缩放设计矩阵 ⇒ 法方程权重是 w²
  let sw = 0;
  let swx = 0;
  let swxx = 0;
  let swy = 0;
  let swxy = 0;
  for (let i = 0; i < n; i++) {
    const w2 = w[i] * w[i];
    sw += w2;
    swx += w2 * x[i];
    swxx += w2 * x[i] * x[i];
    swy += w2 * y[i];
    swxy += w2 * x[i] * y[i];
  }
  const den = sw * swxx - swx * swx;
  if (den === 0 || !Number.isFinite(den)) return 0;

  const slope = (sw * swxy - swx * swy) / den;
  const intercept = (swxx * swy - swx * swxy) / den;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return 0;

  const annualized = Math.exp(slope * 250) - 1;
  if (!Number.isFinite(annualized)) return 0;

  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let ssResidual = 0;
  let ssTotal = 0;
  for (let i = 0; i < n; i++) {
    const fitted = slope * x[i] + intercept;
    const weighted = v2 ? w[i] : 1;
    ssResidual += weighted * (y[i] - fitted) ** 2;
    ssTotal += weighted * (y[i] - meanY) ** 2;
  }
  if (ssTotal === 0) return 0;

  const rSquared = 1 - ssResidual / ssTotal;
  if (!Number.isFinite(rSquared)) return 0;

  const score = annualized * rSquared;
  return Number.isFinite(score) ? score : 0;
}

/**
 * N 日涨幅（默认年化）。
 *
 * `ret = close[-1]/close[-period] - 1`，`annualized = (1+ret)^(250/period) - 1`。
 */
export function calcNdayReturnMomentum(
  closePrices: readonly number[],
  period: number = NDAY_RETURN_PERIOD,
  annualize: boolean = NDAY_RETURN_ANNUALIZE,
): number {
  if (period <= 0) return 0;
  const n = closePrices.length;
  if (n < period) return 0;
  const last = closePrices[n - 1];
  const base = closePrices[n - period];
  if (!Number.isFinite(last) || !Number.isFinite(base)) return 0;
  if (base <= 0) return 0;

  let ret = last / base - 1;
  if (annualize) {
    ret = (1 + ret) ** (250 / period) - 1;
  }
  return Number.isFinite(ret) ? ret : 0;
}

/**
 * RSRS Z-Score（质量过滤锁定关闭）。
 *
 * 每期窗口 `rsrs_period` 根做 low→high 回归，`raw = slope × r2`；
 * Z-Score 用**当前值之前** `std_period` 个历史 raw（剔除 NaN），总体标准差（ddof=0）。
 */
export function calcRsrsZ(
  highPrices: readonly number[],
  lowPrices: readonly number[],
  rsrsPeriod: number = RSRS_PERIOD,
  stdPeriod: number = RSRS_STD_PERIOD,
  enableQualityFilter: boolean = RSRS_ENABLE_QUALITY_FILTER,
): number {
  const n = highPrices.length;
  if (n !== lowPrices.length) return 0;
  if (n < rsrsPeriod + stdPeriod) return 0;
  if (!allFinite(highPrices) || !allFinite(lowPrices)) return 0;

  const raw = new Array<number>(n).fill(Number.NaN);
  for (let i = rsrsPeriod - 1; i < n; i++) {
    const start = i - rsrsPeriod + 1;
    let meanLow = 0;
    let meanHigh = 0;
    for (let k = start; k <= i; k++) {
      meanLow += lowPrices[k];
      meanHigh += highPrices[k];
    }
    meanLow /= rsrsPeriod;
    meanHigh /= rsrsPeriod;

    let cov = 0;
    let varLow = 0;
    for (let k = start; k <= i; k++) {
      const dLow = lowPrices[k] - meanLow;
      cov += dLow * (highPrices[k] - meanHigh);
      varLow += dLow * dLow;
    }
    cov /= rsrsPeriod;
    varLow /= rsrsPeriod;
    if (varLow === 0) continue;

    const slope = cov / varLow;
    let ssRes = 0;
    let ssTot = 0;
    for (let k = start; k <= i; k++) {
      const fitted = meanHigh + slope * (lowPrices[k] - meanLow);
      ssRes += (highPrices[k] - fitted) ** 2;
      ssTot += (highPrices[k] - meanHigh) ** 2;
    }
    if (ssTot === 0) continue;

    const rSquared = 1 - ssRes / ssTot;
    if (enableQualityFilter) continue; // 锁定关闭，分支仅为契约完整性
    raw[i] = slope * rSquared;
  }

  const current = raw[n - 1];
  if (!Number.isFinite(current)) return 0;

  const historyStart = n - 1 - stdPeriod;
  const valid: number[] = [];
  for (let i = historyStart; i < n - 1; i++) {
    if (i >= 0 && Number.isFinite(raw[i])) valid.push(raw[i]);
  }
  if (valid.length < 2) return 0;

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  let variance = 0;
  for (const v of valid) variance += (v - mean) ** 2;
  variance /= valid.length;
  const std = Math.sqrt(variance);
  if (std === 0 || !Number.isFinite(std)) return 0;

  const z = (current - mean) / std;
  return Number.isFinite(z) ? z : 0;
}

/** 简单移动平均（末尾 `period` 根）；不足或非有限 → 0。 */
export function calcMa(closePrices: readonly number[], period: number): number {
  if (period <= 0) return 0;
  const n = closePrices.length;
  if (n < period) return 0;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const v = closePrices[i];
    if (!Number.isFinite(v)) return 0;
    sum += v;
  }
  return sum / period;
}

export interface IndicatorSet {
  wsm: number;
  nday: number;
  rsrs: number;
  /** 短路时为空（对应 CSV 空字段），不是 0 */
  ma: Partial<Record<number, number>>;
}

/**
 * `precalc_all_indicators_local` 的复刻：**不足 60 根整体短路**（§3.2(d)）。
 *
 * 注意：这不是「逐指标退化」。`ma` 在短路时返回空对象，因此后续
 * `price > MA20` / `MA 多头` 必然失败 → 预热段原因码固定为 `BELOW_MA20`。
 */
export function precalcIndicators(
  adjClose: readonly number[],
  adjHigh: readonly number[],
  adjLow: readonly number[],
): IndicatorSet {
  if (adjClose.length < INDICATOR_LOOKBACK) {
    return { wsm: 0, nday: 0, rsrs: 0, ma: {} };
  }
  const wsm = calcWeightedSlopeMomentum(adjClose.slice(-WSM_PERIOD));
  const nday = calcNdayReturnMomentum(adjClose, NDAY_RETURN_PERIOD, NDAY_RETURN_ANNUALIZE);
  const rsrs = calcRsrsZ(
    adjHigh.slice(-(RSRS_PERIOD + RSRS_STD_PERIOD)),
    adjLow.slice(-(RSRS_PERIOD + RSRS_STD_PERIOD)),
    RSRS_PERIOD,
    RSRS_STD_PERIOD,
  );
  const ma: Partial<Record<number, number>> = {};
  for (const p of MA_PERIODS) ma[p] = calcMa(adjClose, p);
  return { wsm, nday, rsrs, ma };
}

function allFinite(values: readonly number[]): boolean {
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}
