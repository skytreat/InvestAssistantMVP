/**
 * 动量打分 —— 逐位照抄 `五福轮动ETF_v5.2.py` L687-L711 `calculate_momentum_score`
 *
 * 🔴 **混合口径，不可「修正」**（golden 已锁死）：
 * - 斜率用**加权最小二乘**（W = `linspace(1,2,n)^2`），年化 `exp(slope*250)-1`；
 * - R² 的**残差平方和**用 weights 加权，**总平方和**却用**无权**均值 `mean(y)`；
 *   两者不同权，看起来像 bug，但这是 v5.2 原样，改成同权会让分数整体漂移。
 *
 * 时点口径（B1）：末点 = `asOf` 日收盘（决策发生在 T-1 收盘后），
 * 调用方传 `ctx.series(symbol, lookbackDays + 1, 'close')` 即可。
 */

/** v5.2 L717：`len(price_series) < g.lookback_days * 0.8` 直接判空（25 → 20） */
const MIN_POINT_RATIO = 0.8;
/** v5.2 L705：年化硬编码 250 个交易日 */
const ANNUALIZE_DAYS = 250;

export interface MomentumScore {
  /** v5.2 的 `momentum_score` = annualized × r² */
  score: number;
  /** `exp(slope*250) - 1` */
  annualized: number;
  /** 混合口径 R²（残差加权、总平方和无权） */
  r2: number;
}

/**
 * 计算动量打分；点数不足或价格非法时返回 null（该标的不参与排序）。
 *
 * 点数门槛（两条都照抄）：
 * 1. `prices.length < lookbackDays + 1`（26）→ null（L688）；
 * 2. `prices.length < lookbackDays * 0.8`（20）→ null（L717）。
 */
export function calculateMomentumScore(
  prices: readonly number[],
  lookbackDays: number,
): MomentumScore | null {
  if (prices.length < lookbackDays + 1) return null;
  if (prices.length < lookbackDays * MIN_POINT_RATIO) return null;

  const window = prices.slice(-(lookbackDays + 1));
  const n = window.length;
  // log 在 p<=0 时无定义；v5.2 会产 NaN 并被 `sort` 丢到末尾 + 分值区间过滤掉，此处等价提前返回
  if (window.some((p) => !(p > 0))) return null;

  const y = window.map((p) => Math.log(p));
  const x = Array.from({ length: n }, (_, i) => i);
  // np.linspace(1, 2, n)：首点 1、末点 2、等步长
  const weights = Array.from({ length: n }, (_, i) => 1 + i / (n - 1));
  const w = weights.map((v) => v * v);

  let wSum = 0;
  let wxSum = 0;
  let wySum = 0;
  for (let i = 0; i < n; i++) {
    wSum += w[i];
    wxSum += w[i] * x[i];
    wySum += w[i] * y[i];
  }
  const xBar = wxSum / wSum;
  const yBar = wySum / wSum;

  let varianceX = 0;
  let covariance = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - xBar;
    varianceX += w[i] * dx * dx;
    covariance += w[i] * dx * (y[i] - yBar);
  }
  // v5.2 L701-L702：`variance_x == 0` 时返回 (0, 0, 0)
  if (varianceX === 0) return { score: 0, annualized: 0, r2: 0 };

  const slope = covariance / varianceX;
  const intercept = yBar - slope * xBar;
  const annualized = Math.exp(slope * ANNUALIZE_DAYS) - 1;

  const yMean = y.reduce((acc, v) => acc + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * x[i] + intercept;
    ssRes += weights[i] * (y[i] - predicted) ** 2;
    ssTot += weights[i] * (y[i] - yMean) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const score = annualized * r2;

  if (!Number.isFinite(score) || !Number.isFinite(annualized) || !Number.isFinite(r2)) return null;
  return { score, annualized, r2 };
}
