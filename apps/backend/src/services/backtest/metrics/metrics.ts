/**
 * 回测指标（M2）—— 依据 proposal §3.6「核心指标」
 *
 * 🔴 **回撤是比率，不是金额**：对外字段名固定为 `maxDrawdownRatio`（0.25 = 25%），
 *   金额另用 `maxDrawdownAmount`（元）单列。混用一个 `maxDrawdown` 是历史事故源。
 *
 * 全部是纯函数：输入净值点 + 回合交易，输出指标对象；不读库、不写库。
 */
import type { RoundTrip } from '../account/portfolio.js';

/** 每日净值点（落 `bt_equity`） */
export interface EquityPoint {
  date: string;
  /** 权益 = cash + riskMv + cashMv（恒等式由引擎逐日核对） */
  equity: number;
  cash: number;
  /** 风险资产市值（现金类 ETF 之外） */
  riskMv: number;
  /** 现金类 ETF 市值（防御标的归此桶，见 §3.7） */
  cashMv: number;
  /** 基准收盘（bfq，缺失日沿用上一有效值；区间内完全缺失为 null） */
  benchmarkClose: number | null;
  /** riskMv / equity（0~1） */
  exposure: number;
  /** 当日的回撤比率：(峰值 - equity) / 峰值（0~1，正数） */
  drawdownRatio: number;
}

export interface MetricsOptions {
  /** 初始权益（默认取第一个净值点的 equity） */
  initialEquity?: number;
  /** 无风险利率（年化，默认 0） */
  riskFreeRate?: number;
  tradingDaysPerYear?: number;
  /** 区间内总成交额（元，双边累加），用于换手率 */
  tradedNotional?: number;
}

export interface MonthlyReturn {
  /** `YYYY-MM` */
  month: string;
  returnPct: number;
}

export interface DrawdownSummary {
  /** 最大回撤（**比率**，0.25 = 25%） */
  maxDrawdownRatio: number;
  /** 最大回撤（金额，元；仅供报告补充） */
  maxDrawdownAmount: number;
  /** 峰值日 / 谷底日（无回撤时为 null） */
  peakDate: string | null;
  troughDate: string | null;
  /** 峰值 → 谷底的日历天数 */
  maxDrawdownDays: number;
}

export interface BacktestMetrics extends DrawdownSummary {
  startDate: string;
  endDate: string;
  /** 日历天数（含头尾） */
  calendarDays: number;
  tradingDays: number;
  initialEquity: number;
  finalEquity: number;
  /** 累计收益（final / initial - 1） */
  cumulativeReturn: number;
  /** 年化收益（按日历天数，复利） */
  cagr: number;
  /** 年化波动率（日收益标准差 × sqrt(252)） */
  annualizedVolatility: number;
  sharpeRatio: number;
  calmarRatio: number;
  /** 年化换手率 = 总成交额 / 平均权益 / 年数 */
  turnoverAnnualized: number;
  /** 平均风险暴露（riskMv / equity 的日均值） */
  averageExposure: number;
  closedRoundTrips: number;
  winRate: number;
  /** 盈亏比 = 平均盈利 / 平均亏损绝对值；无亏损时为 null */
  profitLossRatio: number | null;
  /** 回合持有的平均日历天数 */
  averageHoldingDays: number;
  /** 相对基准的年化 alpha（基准缺失时为 null） */
  alphaAnnualized: number | null;
  beta: number | null;
  monthlyReturns: MonthlyReturn[];
}

/** 计算每日回撤序列（输入净值，输出每个点的 (peak-equity)/peak） */
export function computeDrawdownSeries(equities: readonly number[]): number[] {
  const out: number[] = [];
  let peak = -Infinity;
  for (const e of equities) {
    peak = Math.max(peak, e);
    out.push(peak > 0 ? (peak - e) / peak : 0);
  }
  return out;
}

/** 最大回撤（比率 + 金额 + 峰谷日） */
export function computeMaxDrawdown(points: readonly Pick<EquityPoint, 'date' | 'equity'>[]): DrawdownSummary {
  if (points.length === 0) {
    return {
      maxDrawdownRatio: 0,
      maxDrawdownAmount: 0,
      peakDate: null,
      troughDate: null,
      maxDrawdownDays: 0,
    };
  }
  let peakValue = points[0].equity;
  let peakDate: string | null = null;
  let bestRatio = 0;
  let bestAmount = 0;
  let bestPeakDate: string | null = null;
  let bestTroughDate: string | null = null;

  for (const p of points) {
    if (p.equity >= peakValue) {
      peakValue = p.equity;
      peakDate = p.date;
      continue;
    }
    if (peakValue <= 0) continue;
    const ratio = (peakValue - p.equity) / peakValue;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestAmount = peakValue - p.equity;
      bestPeakDate = peakDate;
      bestTroughDate = p.date;
    }
  }

  const days =
    bestPeakDate && bestTroughDate
      ? Math.max(0, Math.round((Date.parse(bestTroughDate) - Date.parse(bestPeakDate)) / 86_400_000))
      : 0;

  return {
    maxDrawdownRatio: bestRatio,
    maxDrawdownAmount: bestAmount,
    peakDate: bestPeakDate,
    troughDate: bestTroughDate,
    maxDrawdownDays: days,
  };
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** 月度收益（按每月最后一个净值点对上一个月的最后一个；首月对初始权益） */
export function computeMonthlyReturns(
  points: readonly EquityPoint[],
  initialEquity: number,
): MonthlyReturn[] {
  if (points.length === 0) return [];
  const lastByMonth = new Map<string, number>();
  for (const p of points) lastByMonth.set(p.date.slice(0, 7), p.equity);

  const out: MonthlyReturn[] = [];
  let prev = initialEquity;
  for (const [month, equity] of [...lastByMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({ month, returnPct: prev > 0 ? equity / prev - 1 : 0 });
    prev = equity;
  }
  return out;
}

/**
 * 计算全套指标。
 *
 * @param points 按日期升序的每日净值点
 * @param roundTrips 已平仓回合（部分卖出也算一笔）
 */
export function computeMetrics(
  points: readonly EquityPoint[],
  roundTrips: readonly RoundTrip[],
  options: MetricsOptions = {},
): BacktestMetrics {
  const tradingDaysPerYear = options.tradingDaysPerYear ?? 252;
  const riskFreeRate = options.riskFreeRate ?? 0;

  if (points.length === 0) {
    return {
      startDate: '',
      endDate: '',
      calendarDays: 0,
      tradingDays: 0,
      initialEquity: options.initialEquity ?? 0,
      finalEquity: options.initialEquity ?? 0,
      cumulativeReturn: 0,
      cagr: 0,
      annualizedVolatility: 0,
      sharpeRatio: 0,
      maxDrawdownRatio: 0,
      maxDrawdownAmount: 0,
      peakDate: null,
      troughDate: null,
      maxDrawdownDays: 0,
      calmarRatio: 0,
      turnoverAnnualized: 0,
      averageExposure: 0,
      closedRoundTrips: 0,
      winRate: 0,
      profitLossRatio: null,
      averageHoldingDays: 0,
      alphaAnnualized: null,
      beta: null,
      monthlyReturns: [],
    };
  }

  const initialEquity = options.initialEquity ?? points[0].equity;
  const finalEquity = points[points.length - 1].equity;
  const startDate = points[0].date;
  const endDate = points[points.length - 1].date;
  const calendarDays = Math.max(1, Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000));
  const years = calendarDays / 365.25;

  const cumulativeReturn = initialEquity > 0 ? finalEquity / initialEquity - 1 : 0;
  const cagr =
    initialEquity > 0 && finalEquity > 0 ? Math.pow(finalEquity / initialEquity, 1 / years) - 1 : -1;

  const returns: number[] = [];
  const benchReturns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].equity;
    const cur = points[i].equity;
    if (prev > 0) returns.push(cur / prev - 1);
    const pb = points[i - 1].benchmarkClose;
    const cb = points[i].benchmarkClose;
    if (pb !== null && cb !== null && pb > 0) benchReturns.push(cb / pb - 1);
  }

  const annualizedVolatility = stdev(returns) * Math.sqrt(tradingDaysPerYear);
  const dailyExcess = mean(returns) - riskFreeRate / tradingDaysPerYear;
  const sharpeRatio = stdev(returns) > 0 ? (dailyExcess / stdev(returns)) * Math.sqrt(tradingDaysPerYear) : 0;

  const drawdown = computeMaxDrawdown(points);
  const calmarRatio = drawdown.maxDrawdownRatio > 0 ? cagr / drawdown.maxDrawdownRatio : 0;

  const avgEquity = mean(points.map((p) => p.equity));
  const tradedNotional = options.tradedNotional ?? 0;
  const turnoverAnnualized = avgEquity > 0 && years > 0 ? tradedNotional / avgEquity / years : 0;
  const averageExposure = mean(points.map((p) => p.exposure));

  const wins = roundTrips.filter((r) => r.pnl > 0);
  const losses = roundTrips.filter((r) => r.pnl < 0);
  const winRate = roundTrips.length > 0 ? wins.length / roundTrips.length : 0;
  const avgWin = mean(wins.map((r) => r.pnl));
  const avgLoss = mean(losses.map((r) => Math.abs(r.pnl)));
  const profitLossRatio = avgLoss > 0 ? avgWin / avgLoss : null;
  const averageHoldingDays = mean(
    roundTrips.map((r) =>
      Math.max(0, Math.round((Date.parse(r.closeDate) - Date.parse(r.openDate)) / 86_400_000)),
    ),
  );

  // 相对基准的 alpha / beta（成对日收益；样本不足 2 或无基准 → null）
  let beta: number | null = null;
  let alphaAnnualized: number | null = null;
  if (returns.length >= 2 && benchReturns.length === returns.length) {
    const bm = mean(benchReturns);
    const sm = mean(returns);
    const cov = mean(returns.map((r, i) => (r - sm) * (benchReturns[i] - bm)));
    const varB = mean(benchReturns.map((b) => (b - bm) ** 2));
    if (varB > 0) {
      beta = cov / varB;
      alphaAnnualized = (sm - beta * bm) * tradingDaysPerYear;
    }
  }

  return {
    startDate,
    endDate,
    calendarDays,
    tradingDays: points.length,
    initialEquity,
    finalEquity,
    cumulativeReturn,
    cagr,
    annualizedVolatility,
    sharpeRatio,
    ...drawdown,
    calmarRatio,
    turnoverAnnualized,
    averageExposure,
    closedRoundTrips: roundTrips.length,
    winRate,
    profitLossRatio,
    averageHoldingDays,
    alphaAnnualized,
    beta,
    monthlyReturns: computeMonthlyReturns(points, initialEquity),
  };
}
