/**
 * 策略有效性统计（F4 Step B）—— 主口径「按信号 × 多周期 × 超额」
 *
 * 口径来源：`docs/audit/proposal-strategy-effectiveness-f4.md` §4 / §7.2（定稿）。
 *
 * 关键约束（不可自行放宽）：
 * 1. **批量 IN 取价**：一次查询按品种视图族批量取回，禁止逐信号查 DuckDB（SDD §5.3）。
 * 2. **费率必须可见**：每条结果/每组汇总都带实际生效的 `FeeRates` + `feeModelLabel`。
 *    真实费率打开后同策略半年 69 回合费用 1,761 → 10,472、收益 51.44% → 40.97%
 *    —— 这是结论级差异，不标费率的结果之间不可比。
 * 3. **样本门槛**：`sampleSize < 20` ⇒ `insufficientSample=true`，对外一律不输出百分比
 *    （业务库当前只有 3 条信号，任何比率都无统计意义）。
 * 4. 入场 = 信号日后第一个**可成交**交易日开盘（停牌/开盘涨停顺延）；出场 = 第 N 个交易日收盘
 *    （停牌顺延到下一有效 bar）；个股/ETF 用前复权，指数用原始收盘。
 * 5. 费用口径与 F4 Step A 的 `TradeRules` 一致：
 *    买入 = 名义本金 ×(1+滑点) + max(最低佣金, 本金×佣金率) + 过户费；
 *    卖出 = 名义本金×(1+毛收益)×(1−滑点) − 佣金 − 过户费 − 印花税（印花税仅卖出、过户费双边）。
 *
 * ⚠️ 本模块**只读**：业务库只 SELECT，行情库只 SELECT（AGENTS.md DuckDB 硬约束）。
 */
import { ConfigStore } from '../config/configStore.js';

// ════════════════════════════════════════════════════════════════════════
// 基础类型与常量
// ════════════════════════════════════════════════════════════════════════

/** 评估周期（交易日） */
export type Horizon = 't1' | 't5' | 't10';
export const HORIZONS: readonly Horizon[] = ['t1', 't5', 't10'];
/** 周期 → 交易日数（T+N 的 N） */
export const HORIZON_DAYS: Readonly<Record<Horizon, number>> = { t1: 1, t5: 5, t10: 10 };

/** 分组维度 */
export type GroupBy = 'plugin' | 'asset_type' | 'grade' | 'industry';
export const GROUP_BYS: readonly GroupBy[] = ['plugin', 'asset_type', 'grade', 'industry'];

/** 标的品种（与 `raw_symbol_class."class"` 对齐，只关心三类） */
export type AssetClass = 'etf' | 'stock' | 'index';

/** 样本状态（全部计数，分母可审计） */
export type SampleStatus = 'ok' | 'incomplete' | 'suspended' | 'no_entry' | 'excluded';
export const SAMPLE_STATUSES: readonly SampleStatus[] = [
  'ok',
  'incomplete',
  'suspended',
  'no_entry',
  'excluded',
];

/** 无成交金额时的名义本金（D2 默认 50,000 元；若改 1 万，最低佣金 5 元会占单边 0.05%） */
export const DEFAULT_NOTIONAL = 50_000;
/** 样本门槛（低于此值不输出百分比） */
export const MIN_SAMPLE_SIZE = 20;

/** 实际生效费率（回测/纸面/评估共用同一套字段） */
export interface FeeRates {
  commissionRate: number;
  minCommission: number;
  stampDutyRate: number;
  transferFeeRate: number;
  slippageRate: number;
}

/** ETF 口径：印花税 / 过户费均为 0（与现状逐位一致） */
export const ETF_FEES: Readonly<FeeRates> = Object.freeze({
  commissionRate: 0.0001,
  minCommission: 5,
  stampDutyRate: 0,
  transferFeeRate: 0,
  slippageRate: 0.0001,
});

/**
 * 股票口径预设（仅作评估层常量）
 *
 * 来源：`user_fee_config` DDL 默认值（`configStore.ts`），**不是实测账户费率**。
 * 如与真实账户不符，应在配置层覆盖（不改本常量）。
 */
export const STOCK_FEES: Readonly<FeeRates> = Object.freeze({
  ...ETF_FEES,
  stampDutyRate: 0.001,
  transferFeeRate: 0.00002,
});

/** 按品种选费率：股票用股票口径，其余（ETF / 指数）用 ETF 口径 */
export function feeRatesForClass(assetClass: AssetClass): FeeRates {
  return assetClass === 'stock' ? { ...STOCK_FEES } : { ...ETF_FEES };
}

/** 口径标签，如「ETF 口径（印花税 0 / 过户费 0）」 */
export function feeModelLabel(rates: FeeRates): string {
  const kind = rates.stampDutyRate > 0 || rates.transferFeeRate > 0 ? '股票' : 'ETF';
  return `${kind} 口径（印花税 ${rates.stampDutyRate} / 过户费 ${rates.transferFeeRate}）`;
}

/** 一组费率的口径信息（meta / 行内元信息都用它） */
export interface FeeModelInfo {
  assetClass: AssetClass;
  label: string;
  rates: FeeRates;
}

// ════════════════════════════════════════════════════════════════════════
// 行情 / 信号输入
// ════════════════════════════════════════════════════════════════════════

/** 复权后的价格 bar（amount 不参与计算，故意不取） */
export interface PriceBar {
  date: string;
  open: number;
  close: number;
  volume: number;
}

/** 参与评估的信号（已按 §4.1 口径筛选） */
export interface SignalRecord {
  id: number;
  assetCode: string;
  pluginId: string;
  tradeDate: string;
  /** F1 分级（只读，不参与分级逻辑） */
  grade: string | null;
  origin: string;
}

/** 计算需要的行情上下文（装载层与纯计算层之间的唯一边界） */
export interface MarketContext {
  barsBySymbol: Map<string, PriceBar[]>;
  classBySymbol: Map<string, AssetClass>;
  industryBySymbol: Map<string, string>;
  benchmarkCode: string;
  benchmarkClass: AssetClass;
  benchmarkBars: PriceBar[];
}

/** 评估参数 */
export interface EvaluateOptions {
  from: string;
  to: string;
  horizons: Horizon[];
  groupBy: GroupBy;
  notional: number;
  /** 涨跌停幅度（默认 0.10，与回测 `TradeRules.priceLimit` 一致） */
  priceLimit: number;
}

// ════════════════════════════════════════════════════════════════════════
// 费用与收益（纯函数，单测直接调）
// ════════════════════════════════════════════════════════════════════════

export interface FeeComputation {
  notional: number;
  /** 买入总支出（本金 + 滑点 + 佣金 + 过户费） */
  buyTotal: number;
  /** 卖出净额（成交额 − 滑点 − 佣金 − 过户费 − 印花税） */
  sellNet: number;
  buyCommission: number;
  buyTransfer: number;
  sellCommission: number;
  sellTransfer: number;
  sellStampDuty: number;
  /** 双边总费用（元） */
  totalFees: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 按定稿口径计算买入支出与卖出净额。
 *
 * @param grossReturn 价格毛收益（卖出价/买入价 − 1）
 */
export function computeFees(notional: number, grossReturn: number, rates: FeeRates): FeeComputation {
  const buyCommission = round2(Math.max(rates.minCommission, notional * rates.commissionRate));
  const buyTransfer = round2(notional * rates.transferFeeRate);
  const buyTotal = round2(notional * (1 + rates.slippageRate) + buyCommission + buyTransfer);

  const sellBase = notional * (1 + grossReturn);
  const sellCommission = round2(Math.max(rates.minCommission, sellBase * rates.commissionRate));
  const sellTransfer = round2(sellBase * rates.transferFeeRate);
  const sellStampDuty = round2(sellBase * rates.stampDutyRate);
  const sellNet = round2(
    sellBase * (1 - rates.slippageRate) - sellCommission - sellTransfer - sellStampDuty,
  );

  return {
    notional,
    buyTotal,
    sellNet,
    buyCommission,
    buyTransfer,
    sellCommission,
    sellTransfer,
    sellStampDuty,
    totalFees: round2(buyCommission + buyTransfer + sellCommission + sellTransfer + sellStampDuty),
  };
}

/** 单周期结果（detail 行 / CSV 一行） */
export interface SignalOutcome {
  signalId: number;
  assetCode: string;
  assetClass: AssetClass;
  pluginId: string;
  tradeDate: string;
  grade: string | null;
  industry: string | null;
  origin: string;
  horizon: Horizon;
  status: SampleStatus;
  entryDate: string | null;
  entryPrice: number | null;
  exitDate: string | null;
  exitPrice: number | null;
  grossReturn: number | null;
  /** 扣费后净收益（买卖双边费用） */
  netReturn: number | null;
  benchmarkReturn: number | null;
  /** 超额 = (1+净)/(1+基准) − 1（几何） */
  excessReturn: number | null;
  /** 实际生效费率（**每条结果都带**，否则结果之间不可比） */
  fees: FeeRates;
  feeModelLabel: string;
  notional: number;
}

/** 状态计数 */
export interface StatusCounts {
  ok: number;
  incomplete: number;
  suspended: number;
  no_entry: number;
  excluded: number;
}

/** 单周期汇总 */
export interface HorizonStats {
  horizon: Horizon;
  /** ok 样本数（百分比分母） */
  sampleSize: number;
  /** 有基准、可算超额的样本数 */
  excessSampleSize: number;
  statusCounts: StatusCounts;
  insufficientSample: boolean;
  winRateAbsolute: number | null;
  winRateExcess: number | null;
  avgNetReturn: number | null;
  avgBenchmarkReturn: number | null;
  avgExcessReturn: number | null;
}

/** 分组结果 */
export interface EffectivenessGroup {
  groupBy: GroupBy;
  value: string;
  stats: HorizonStats[];
  /** 组内出现过的费率口径（混合品种时会有多项） */
  feeModels: FeeModelInfo[];
}

/** 接口返回体（`GET /api/strategy/effectiveness`） */
export interface EffectivenessReport {
  meta: {
    from: string;
    to: string;
    benchmark: string;
    benchmarkClass: AssetClass;
    groupBy: GroupBy;
    horizons: Horizon[];
    notional: number;
    /** 主周期（t5 优先）的 ok 样本数 */
    sampleSize: number;
    insufficientSample: boolean;
    statusCounts: StatusCounts;
    /** 主导口径的费率（无信号时给 ETF 默认） */
    fees: FeeRates;
    feeModelLabel: string;
    /** 本次实际出现过的口径列表 */
    feeModels: FeeModelInfo[];
    generatedAt: string;
  };
  summary: HorizonStats[];
  groups: EffectivenessGroup[];
  details: SignalOutcome[];
}

// ════════════════════════════════════════════════════════════════════════
// 纯计算
// ════════════════════════════════════════════════════════════════════════

function emptyCounts(): StatusCounts {
  return { ok: 0, incomplete: 0, suspended: 0, no_entry: 0, excluded: 0 };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 开盘涨停判定（买不进）
 *
 * ⚠️ 前复权价有取整（stock 2 位 / etf 3 位），故留 0.1% 相对容差，
 * 避免把「恰好接近涨停」的样本误判为买不进。
 */
function isLimitUpOpen(open: number, prevClose: number | null, priceLimit: number): boolean {
  if (prevClose === null || prevClose <= 0 || open <= 0) return false;
  return open >= prevClose * (1 + priceLimit) * 0.999;
}

/** 在日期序列里找「当天」的字段；缺失则取之前最近一根（沿用收盘，标记 stale 由调用方决定） */
function priceAtOrBefore(
  bars: PriceBar[],
  date: string,
  field: 'open' | 'close',
): { value: number | null; exact: boolean } {
  let lo = 0;
  let hi = bars.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return { value: null, exact: false };
  const bar = bars[idx];
  if (bar.date === date) {
    const v = field === 'open' ? bar.open : bar.close;
    return { value: v > 0 ? v : null, exact: true };
  }
  // 基准 bar 缺失：沿用上一有效收盘（与 metrics.ts 的 benchmark_stale 同思路）
  const v = bar.close;
  return { value: v > 0 ? v : null, exact: false };
}

/**
 * 单信号 × N 周期评估
 *
 * 入场与出场口径见文件头；所有周期共享同一次入场选择。
 */
export function evaluateSignal(
  signal: SignalRecord,
  context: MarketContext,
  options: EvaluateOptions,
): SignalOutcome[] {
  const assetClass = context.classBySymbol.get(signal.assetCode) ?? 'stock';
  const fees = feeRatesForClass(assetClass);
  const label = feeModelLabel(fees);
  const bars = context.barsBySymbol.get(signal.assetCode) ?? [];

  // 拆分「信号日及之前」与「信号日之后」；prevClose 用于首个候选 bar 的涨停判定
  let startIdx = 0;
  let prevClose: number | null = null;
  while (startIdx < bars.length && bars[startIdx].date <= signal.tradeDate) {
    const c = bars[startIdx].close;
    if (c > 0) prevClose = c;
    startIdx++;
  }
  const after = bars.slice(startIdx);
  const industry = context.industryBySymbol.get(signal.assetCode) ?? null;

  const base = {
    signalId: signal.id,
    assetCode: signal.assetCode,
    assetClass,
    pluginId: signal.pluginId,
    tradeDate: signal.tradeDate,
    grade: signal.grade,
    industry,
    origin: signal.origin,
    fees,
    feeModelLabel: label,
    notional: options.notional,
  };

  // ── 入场：信号日后第一个可成交交易日的开盘价（停牌 / 开盘涨停顺延）──
  let entryIdx = -1;
  let suspendedSeen = false;
  let limitUpSeen = false;
  for (let i = 0; i < after.length; i++) {
    const bar = after[i];
    if (bar.volume <= 0 || bar.open <= 0) {
      suspendedSeen = true;
      continue;
    }
    const prev = i > 0 ? (after[i - 1].close > 0 ? after[i - 1].close : null) : prevClose;
    if (isLimitUpOpen(bar.open, prev, options.priceLimit)) {
      limitUpSeen = true;
      continue;
    }
    entryIdx = i;
    break;
  }

  if (entryIdx < 0) {
    // 无后续 bar = no_entry；有 bar 但都不可成交 = suspended / excluded
    const status: SampleStatus = after.length === 0 ? 'no_entry' : limitUpSeen && !suspendedSeen ? 'excluded' : 'suspended';
    return options.horizons.map((h) => ({
      ...base,
      horizon: h,
      status,
      entryDate: null,
      entryPrice: null,
      exitDate: null,
      exitPrice: null,
      grossReturn: null,
      netReturn: null,
      benchmarkReturn: null,
      excessReturn: null,
    }));
  }

  const entryBar = after[entryIdx];
  const outcomes: SignalOutcome[] = [];

  for (const horizon of options.horizons) {
    const n = HORIZON_DAYS[horizon];
    // 第 N 个交易日 = 信号日后第 (N-1) 根；入场延迟时至少持有到入场当日收盘
    const need = Math.max(n - 1, entryIdx);
    let exitIdx = -1;
    for (let i = need; i < after.length; i++) {
      if (after[i].volume > 0 && after[i].close > 0) {
        exitIdx = i;
        break;
      }
    }

    if (exitIdx < 0) {
      outcomes.push({
        ...base,
        horizon,
        status: 'incomplete',
        entryDate: entryBar.date,
        entryPrice: entryBar.open,
        exitDate: null,
        exitPrice: null,
        grossReturn: null,
        netReturn: null,
        benchmarkReturn: null,
        excessReturn: null,
      });
      continue;
    }

    const exitBar = after[exitIdx];
    const grossReturn = exitBar.close / entryBar.open - 1;
    const feeComputation = computeFees(options.notional, grossReturn, fees);
    const netReturn = feeComputation.sellNet / feeComputation.buyTotal - 1;

    const benchEntry = priceAtOrBefore(context.benchmarkBars, entryBar.date, 'open');
    const benchExit = priceAtOrBefore(context.benchmarkBars, exitBar.date, 'close');
    const benchmarkReturn =
      benchEntry.value !== null && benchExit.value !== null && benchEntry.value > 0
        ? benchExit.value / benchEntry.value - 1
        : null;
    const excessReturn =
      benchmarkReturn !== null ? (1 + netReturn) / (1 + benchmarkReturn) - 1 : null;

    outcomes.push({
      ...base,
      horizon,
      status: 'ok',
      entryDate: entryBar.date,
      entryPrice: entryBar.open,
      exitDate: exitBar.date,
      exitPrice: exitBar.close,
      grossReturn,
      netReturn,
      benchmarkReturn,
      excessReturn,
    });
  }

  return outcomes;
}

/** 单周期汇总（返回**未脱敏**数值；对外输出前须经 {@link finalizeHorizonStats}） */
export function summarizeHorizon(outcomes: SignalOutcome[], horizon: Horizon): HorizonStats {
  const filtered = outcomes.filter((o) => o.horizon === horizon);
  const statusCounts = emptyCounts();
  for (const o of filtered) statusCounts[o.status] += 1;

  const okRows = filtered.filter((o) => o.status === 'ok' && o.netReturn !== null);
  const sampleSize = okRows.length;
  const excessRows = okRows.filter((o) => o.excessReturn !== null);
  const benchRows = okRows.filter((o) => o.benchmarkReturn !== null);

  const winRateAbsolute =
    sampleSize > 0 ? okRows.filter((o) => (o.netReturn as number) > 0).length / sampleSize : null;
  const winRateExcess =
    excessRows.length > 0
      ? excessRows.filter((o) => (o.excessReturn as number) > 0).length / excessRows.length
      : null;

  return {
    horizon,
    sampleSize,
    excessSampleSize: excessRows.length,
    statusCounts,
    insufficientSample: sampleSize < MIN_SAMPLE_SIZE,
    winRateAbsolute,
    winRateExcess,
    avgNetReturn: mean(okRows.map((o) => o.netReturn as number)),
    avgBenchmarkReturn: mean(benchRows.map((o) => o.benchmarkReturn as number)),
    avgExcessReturn: mean(excessRows.map((o) => o.excessReturn as number)),
  };
}

/**
 * 对外输出前脱敏：`sampleSize < 20` 时清空全部百分比/均值，**只保留样本数与状态计数**。
 *
 * 业务库当前只有 3 条信号 —— 任何比率都不构成结论（proposal §9.1）。
 */
export function finalizeHorizonStats(stats: HorizonStats): HorizonStats {
  if (!stats.insufficientSample) return stats;
  return {
    ...stats,
    winRateAbsolute: null,
    winRateExcess: null,
    avgNetReturn: null,
    avgBenchmarkReturn: null,
    avgExcessReturn: null,
  };
}

function groupValueOf(o: SignalOutcome, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'plugin':
      return o.pluginId;
    case 'asset_type':
      return o.assetClass;
    case 'grade':
      return o.grade ?? '未分级';
    case 'industry':
      return o.industry ?? '未分类';
  }
}

function collectFeeModels(outcomes: SignalOutcome[]): FeeModelInfo[] {
  const seen = new Map<AssetClass, FeeModelInfo>();
  for (const o of outcomes) {
    if (seen.has(o.assetClass)) continue;
    seen.set(o.assetClass, { assetClass: o.assetClass, label: o.feeModelLabel, rates: o.fees });
  }
  return [...seen.values()];
}

/** 无信号 / 空报告（保持字段完整，避免前端判空分支分叉） */
export function emptyReport(options: EvaluateOptions, benchmark: string, benchmarkClass: AssetClass): EffectivenessReport {
  const rates = feeRatesForClass(benchmarkClass === 'stock' ? 'stock' : 'etf');
  return {
    meta: {
      from: options.from,
      to: options.to,
      benchmark,
      benchmarkClass,
      groupBy: options.groupBy,
      horizons: options.horizons,
      notional: options.notional,
      sampleSize: 0,
      insufficientSample: true,
      statusCounts: emptyCounts(),
      fees: rates,
      feeModelLabel: feeModelLabel(rates),
      feeModels: [],
      generatedAt: new Date().toISOString(),
    },
    summary: options.horizons.map((h) => finalizeHorizonStats(summarizeHorizon([], h))),
    groups: [],
    details: [],
  };
}

/**
 * 报告构建（纯函数）—— 装载层只负责准备 {@link MarketContext}。
 *
 * 这样单测可以完全不依赖 DuckDB / SQLite（CI 无真实行情库）。
 */
export function buildReport(input: {
  signals: SignalRecord[];
  context: MarketContext;
  options: EvaluateOptions;
}): EffectivenessReport {
  const { signals, context, options } = input;
  const all = signals.flatMap((s) => evaluateSignal(s, context, options));

  const summary = options.horizons.map((h) => finalizeHorizonStats(summarizeHorizon(all, h)));
  const primary = summary.find((s) => s.horizon === 't5') ?? summary[0];
  const feeModels = collectFeeModels(all);

  // meta.fees = 样本最多的品种口径；无样本时退回 ETF 默认
  const dominant = new Map<AssetClass, number>();
  for (const o of all) dominant.set(o.assetClass, (dominant.get(o.assetClass) ?? 0) + 1);
  let dominantClass: AssetClass = 'etf';
  let dominantCount = -1;
  for (const [cls, count] of dominant) {
    if (count > dominantCount) {
      dominantClass = cls;
      dominantCount = count;
    }
  }
  const dominantFees = feeRatesForClass(dominantClass);
  const dominantLabel =
    feeModels.length > 1
      ? feeModels.map((m) => m.label).join(' + ')
      : feeModelLabel(dominantFees);

  const groups: EffectivenessGroup[] = [];
  const values = [...new Set(all.map((o) => groupValueOf(o, options.groupBy)))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  for (const value of values) {
    const rows = all.filter((o) => groupValueOf(o, options.groupBy) === value);
    groups.push({
      groupBy: options.groupBy,
      value,
      stats: options.horizons.map((h) => finalizeHorizonStats(summarizeHorizon(rows, h))),
      feeModels: collectFeeModels(rows),
    });
  }

  return {
    meta: {
      from: options.from,
      to: options.to,
      benchmark: context.benchmarkCode,
      benchmarkClass: context.benchmarkClass,
      groupBy: options.groupBy,
      horizons: options.horizons,
      notional: options.notional,
      sampleSize: primary?.sampleSize ?? 0,
      insufficientSample: primary?.insufficientSample ?? true,
      statusCounts: primary?.statusCounts ?? emptyCounts(),
      fees: dominantFees,
      feeModelLabel: dominantLabel,
      feeModels,
      generatedAt: new Date().toISOString(),
    },
    summary,
    groups,
    details: all,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 装载（SQLite 信号 + DuckDB 行情，批量 IN）
// ════════════════════════════════════════════════════════════════════════

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

interface SignalRowDb {
  id: number;
  asset_code: string;
  plugin_id: string;
  trade_date: string;
  grade: string | null;
  origin: string;
}

async function fetchClassMap(symbols: string[]): Promise<Map<string, AssetClass>> {
  const result = new Map<string, AssetClass>();
  if (symbols.length === 0) return result;
  // ⚠️ **动态导入**：`src/db/duckdb.ts` 在模块加载时快照 `DUCKDB_PATH`，
  // 测试的档位切换（tests/_marketData.ts）必须先于它求值 ⇒ 不能在模块顶层静态 import。
  const { queryDuckDB } = await import('../db/duckdb.js');
  const rows = await queryDuckDB<{ symbol: string; asset_class: string }>(
    `SELECT symbol, "class" AS asset_class FROM raw_symbol_class WHERE symbol IN (${placeholders(symbols.length)})`,
    symbols,
  );
  for (const r of rows) {
    const cls = String(r.asset_class);
    if (cls === 'etf' || cls === 'stock' || cls === 'index') result.set(String(r.symbol), cls);
  }
  return result;
}

/**
 * 品种识别兜底：`raw_symbol_class` 缺失时按代码形态推断
 * （`sh000xxx` / `sz399xxx` 为指数，`sh51` / `sz15` / `sz16` 为 ETF，其余按股票）。
 */
function guessClass(symbol: string): AssetClass {
  if (/^(sh000|sz399)/.test(symbol)) return 'index';
  if (/^(sh51|sz15|sz16)/.test(symbol)) return 'etf';
  return 'stock';
}

type BarView = 'v_stock_qfq' | 'v_etf_qfq' | 'raw_kline_daily';

async function fetchBars(
  symbols: string[],
  view: BarView,
  fromDate: string,
  toDate: string,
): Promise<Map<string, PriceBar[]>> {
  const result = new Map<string, PriceBar[]>();
  if (symbols.length === 0) return result;
  const { queryDuckDB } = await import('../db/duckdb.js');
  const rows = await queryDuckDB<{
    symbol: string;
    date: string;
    open: number;
    close_price: number;
    volume: number;
  }>(
    `SELECT symbol, date, open, "close" AS close_price, volume
       FROM ${view}
      WHERE date BETWEEN ? AND ? AND symbol IN (${placeholders(symbols.length)})
      ORDER BY symbol, date ASC`,
    [fromDate, toDate, ...symbols],
  );
  for (const row of rows) {
    const bar: PriceBar = {
      date: String(row.date),
      open: Number(row.open),
      close: Number(row.close_price),
      volume: Number(row.volume),
    };
    const list = result.get(String(row.symbol));
    if (list) list.push(bar);
    else result.set(String(row.symbol), [bar]);
  }
  return result;
}

async function fetchIndustryMap(symbols: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (symbols.length === 0) return result;
  const { queryDuckDB } = await import('../db/duckdb.js');
  const rows = await queryDuckDB<{ symbol: string; industry: string }>(
    `SELECT m.stock_symbol AS symbol, i.block_name AS industry
       FROM raw_tdx_blocks_member m
       JOIN raw_tdx_blocks_info i ON i.block_code = m.block_code
      WHERE i.block_type = 'tdx_research' AND i.block_level = 1
        AND m.stock_symbol IN (${placeholders(symbols.length)})`,
    symbols,
  );
  for (const r of rows) {
    if (!result.has(String(r.symbol))) result.set(String(r.symbol), String(r.industry));
  }
  return result;
}

/** 查询信号（§4.1 口径：buy / final / 未删除 / 非风险） */
export function loadSignals(
  userId: number,
  options: { from: string; to: string; pluginId?: string; origin?: string },
): SignalRecord[] {
  const db = ConfigStore.getInstance().db;
  const clauses = [
    'user_id = ?',
    'is_deleted = 0',
    'is_final = 1',
    "direction = 'buy'",
    "COALESCE(sub_category, '') <> 'risk'",
    'trade_date BETWEEN ? AND ?',
  ];
  const params: unknown[] = [userId, options.from, options.to];
  if (options.pluginId) {
    clauses.push('plugin_id = ?');
    params.push(options.pluginId);
  }
  if (options.origin) {
    clauses.push('origin = ?');
    params.push(options.origin);
  }
  const rows = db
    .prepare(
      `SELECT id, asset_code, plugin_id, trade_date, grade, origin
         FROM user_strategy_signal
        WHERE ${clauses.join(' AND ')}
        ORDER BY trade_date ASC, id ASC`,
    )
    .all(...params) as SignalRowDb[];

  return rows.map((r) => ({
    id: Number(r.id),
    assetCode: String(r.asset_code),
    pluginId: String(r.plugin_id),
    tradeDate: String(r.trade_date).slice(0, 10),
    grade: r.grade ?? null,
    origin: String(r.origin),
  }));
}

/**
 * 装载并计算（路由唯一入口）
 *
 * 行情取数窗口：`[from − 30 天, to + 45 天]` —— 覆盖信号日前的 prevClose 与
 * 末端信号 T+10 的顺延窗口。所有品种**各一次 IN 查询**。
 */
export async function loadEffectivenessReport(
  userId: number,
  options: EvaluateOptions & { pluginId?: string; origin?: string; benchmark: string },
): Promise<EffectivenessReport> {
  const signals = loadSignals(userId, options);
  const benchmark = options.benchmark || 'sh510300';

  if (signals.length === 0) {
    const cls = await fetchClassMap([benchmark]).then((m) => m.get(benchmark) ?? guessClass(benchmark));
    return emptyReport(options, benchmark, cls);
  }

  const symbols = [...new Set(signals.map((s) => s.assetCode))];
  const classMap = await fetchClassMap([...symbols, benchmark]);
  for (const symbol of symbols) {
    if (!classMap.has(symbol)) classMap.set(symbol, guessClass(symbol));
  }
  if (!classMap.has(benchmark)) classMap.set(benchmark, guessClass(benchmark));
  const benchmarkClass = classMap.get(benchmark) as AssetClass;

  const fromDate = addDays(options.from, -30);
  const toDate = addDays(options.to, 45);

  const stockSymbols = symbols.filter((s) => (classMap.get(s) ?? 'stock') === 'stock');
  const etfSymbols = symbols.filter((s) => classMap.get(s) === 'etf');
  const indexSymbols = symbols.filter((s) => classMap.get(s) === 'index');

  const stockBars = await fetchBars(stockSymbols, 'v_stock_qfq', fromDate, toDate);
  const etfBars = await fetchBars(etfSymbols, 'v_etf_qfq', fromDate, toDate);
  const indexBars = await fetchBars(indexSymbols, 'raw_kline_daily', fromDate, toDate);

  const barsBySymbol = new Map<string, PriceBar[]>();
  for (const [symbol, bars] of stockBars) barsBySymbol.set(symbol, bars);
  for (const [symbol, bars] of etfBars) barsBySymbol.set(symbol, bars);
  for (const [symbol, bars] of indexBars) barsBySymbol.set(symbol, bars);

  const benchView: BarView =
    benchmarkClass === 'etf' ? 'v_etf_qfq' : benchmarkClass === 'index' ? 'raw_kline_daily' : 'v_stock_qfq';
  const benchBars = (await fetchBars([benchmark], benchView, fromDate, toDate)).get(benchmark) ?? [];

  const industryBySymbol =
    options.groupBy === 'industry' ? await fetchIndustryMap(symbols) : new Map<string, string>();

  return buildReport({
    signals,
    context: {
      barsBySymbol,
      classBySymbol: classMap,
      industryBySymbol,
      benchmarkCode: benchmark,
      benchmarkClass,
      benchmarkBars: benchBars,
    },
    options,
  });
}

// ════════════════════════════════════════════════════════════════════════
// CSV（BOM + CRLF，每行带费率；沿用 I8 的既有约定）
// ════════════════════════════════════════════════════════════════════════

function csvCell(value: unknown, text = false): string {
  if (value == null) return '';
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 小数 → 百分比（2 位）；null 输出空单元格（**样本不足时不写百分比**） */
function pct(value: number | null): string {
  return value == null ? '' : (value * 100).toFixed(2);
}

const FEE_COLUMNS = [
  'fee_model_label',
  'commission_rate',
  'min_commission',
  'stamp_duty_rate',
  'transfer_fee_rate',
  'slippage_rate',
  'notional',
] as const;

function feeCells(rates: FeeRates, label: string, notional: number): string[] {
  return [
    csvCell(label, true),
    csvCell(rates.commissionRate),
    csvCell(rates.minCommission),
    csvCell(rates.stampDutyRate),
    csvCell(rates.transferFeeRate),
    csvCell(rates.slippageRate),
    csvCell(notional),
  ];
}

export type ExportLevel = 'summary' | 'detail';

/**
 * 导出 CSV（默认 detail）
 *
 * - `summary`：每周期一行 + 每组每周期一行
 * - `detail`：每个 signal × horizon 一行
 * - **每行都带费率列**（口径标签 + 五项费率 + 名义本金），满足「不同结果可比」
 * - UTF-8 BOM + CRLF（Excel 直接打开）
 */
export function buildEffectivenessCsv(report: EffectivenessReport, level: ExportLevel = 'detail'): string {
  const lines: string[] = [];

  if (level === 'summary') {
    lines.push(
      [
        'level',
        'horizon',
        'group_by',
        'group_value',
        'sample_size',
        'excess_sample_size',
        'insufficient_sample',
        'ok',
        'incomplete',
        'suspended',
        'no_entry',
        'excluded',
        'win_rate_absolute_pct',
        'win_rate_excess_pct',
        'avg_net_return_pct',
        'avg_benchmark_return_pct',
        'avg_excess_return_pct',
        'benchmark',
        ...FEE_COLUMNS,
      ].join(','),
    );
    const emit = (groupBy: string, groupValue: string, stats: HorizonStats, rates: FeeRates, label: string) => {
      lines.push(
        [
          'summary',
          stats.horizon,
          csvCell(groupBy, true),
          csvCell(groupValue, true),
          csvCell(stats.sampleSize),
          csvCell(stats.excessSampleSize),
          csvCell(stats.insufficientSample ? 1 : 0),
          csvCell(stats.statusCounts.ok),
          csvCell(stats.statusCounts.incomplete),
          csvCell(stats.statusCounts.suspended),
          csvCell(stats.statusCounts.no_entry),
          csvCell(stats.statusCounts.excluded),
          csvCell(pct(stats.winRateAbsolute)),
          csvCell(pct(stats.winRateExcess)),
          csvCell(pct(stats.avgNetReturn)),
          csvCell(pct(stats.avgBenchmarkReturn)),
          csvCell(pct(stats.avgExcessReturn)),
          csvCell(report.meta.benchmark, true),
          ...feeCells(rates, label, report.meta.notional),
        ].join(','),
      );
    };
    for (const s of report.summary) {
      emit(report.meta.groupBy, '全部', s, report.meta.fees, report.meta.feeModelLabel);
    }
    for (const g of report.groups) {
      for (const s of g.stats) {
        const model = g.feeModels.length === 1 ? g.feeModels[0] : null;
        emit(g.groupBy, g.value, s, model?.rates ?? report.meta.fees, model?.label ?? report.meta.feeModelLabel);
      }
    }
  } else {
    lines.push(
      [
        'signal_id',
        'asset_code',
        'asset_class',
        'plugin_id',
        'trade_date',
        'grade',
        'industry',
        'origin',
        'horizon',
        'status',
        'entry_date',
        'entry_price',
        'exit_date',
        'exit_price',
        'gross_return_pct',
        'net_return_pct',
        'benchmark_return_pct',
        'excess_return_pct',
        'benchmark',
        ...FEE_COLUMNS,
      ].join(','),
    );
    const details = [...report.details].sort(
      (a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.signalId - b.signalId || a.horizon.localeCompare(b.horizon),
    );
    for (const d of details) {
      lines.push(
        [
          csvCell(d.signalId),
          csvCell(d.assetCode, true),
          csvCell(d.assetClass, true),
          csvCell(d.pluginId, true),
          csvCell(d.tradeDate),
          csvCell(d.grade, true),
          csvCell(d.industry, true),
          csvCell(d.origin, true),
          csvCell(d.horizon),
          csvCell(d.status),
          csvCell(d.entryDate),
          csvCell(d.entryPrice),
          csvCell(d.exitDate),
          csvCell(d.exitPrice),
          csvCell(pct(d.grossReturn)),
          csvCell(pct(d.netReturn)),
          csvCell(pct(d.benchmarkReturn)),
          csvCell(pct(d.excessReturn)),
          csvCell(report.meta.benchmark, true),
          ...feeCells(d.fees, d.feeModelLabel, d.notional),
        ].join(','),
      );
    }
  }

  return `\uFEFF${lines.join('\r\n')}`;
}
