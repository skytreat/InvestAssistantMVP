/**
 * K 线指标参数（T71 · 参数实时生效，零网络请求）
 *
 * ## 本文件是「参数口径」的唯一真相源
 *
 * - **参数结构**（`IndicatorParams`）
 * - **默认值**（`DEFAULT_INDICATOR_PARAMS` —— 与 PRD §5.2 的 MA(5/10/20/60)、
 *   MACD(12,26,9)、RSI(14, 30/70)、KDJ(9,3,3) 一致）
 * - **合法区间**（`PARAM_RANGES`）与**夹取逻辑**（`clampIndicatorParams`）
 * - **面板字段定义**（`PARAM_FIELDS` —— 面板按它渲染，避免 UI 与口径两处各写一份）
 *
 * ## 🔴 为什么参数要有区间（且越界必须夹取而不是照单全收）
 *
 * 参数会**直接喂给指标算法**：
 * - `period = 0` → 除零 → `NaN` / `Infinity` 污染整条线；
 * - `fast > slow` → MACD 库直接抛错或返回空数组；
 * - `oversold > overbought` → RSI 阈值线画反。
 *
 * ⇒ **越界不生效**：一律夹到合法区间 + 提示用户（面板里显示「已取 X」）。
 *    这样**永远不会**把 NaN / Infinity 塞进图表。
 *
 * ## 与 PRD 的关系
 *
 * - PRD §5.2「参数实时生效：改 RSI period 或超买阈值 → 图表即时重绘，**零网络请求**」
 * - PRD §6.3「策略参数调整后重绘 ≤ 300ms（**客户端计算**）」
 *
 * ⇒ 本文件的参数**只在浏览器里生效**，不发任何请求（复算走 `technical.ts` / `kdj.ts`）。
 */

/** 主图叠加的 MA 线条数 */
export const MA_LINE_COUNT = 4;

/** MA 的默认周期（PRD §5.2：MA(5/10/20/60)）*/
export const DEFAULT_MA_PERIODS: readonly number[] = [5, 10, 20, 60];

/** MA 四条线在图表数据里的字段名（**按线序号**，不按周期 —— 周期可编辑，字段名不能跟着变）*/
export const MA_FIELD_KEYS = ['ma1', 'ma2', 'ma3', 'ma4'] as const;

/* ------------------------------------------------------------------ *
 * 参数结构
 * ------------------------------------------------------------------ */

/** MA 参数（4 条线，每条一个周期）*/
export interface MaParams {
  /** 4 条线的周期（与 {@link MA_FIELD_KEYS} 一一对应）*/
  periods: number[];
}

/** MACD 参数 */
export interface MacdParams {
  /** 快线周期 */
  fast: number;
  /** 慢线周期 */
  slow: number;
  /** 信号线周期 */
  signal: number;
}

/** RSI 参数 */
export interface RsiParams {
  /** RSI 周期 */
  period: number;
  /** 超买阈值 */
  overbought: number;
  /** 超卖阈值 */
  oversold: number;
}

/** KDJ 参数 */
export interface KdjParams {
  /** RSV 回看根数 */
  n: number;
  /** K 的平滑周期 */
  m1: number;
  /** D 的平滑周期 */
  m2: number;
}

/** 全部指标参数 */
export interface IndicatorParams {
  ma: MaParams;
  macd: MacdParams;
  rsi: RsiParams;
  kdj: KdjParams;
}

/** 默认参数（与 PRD §5.2 一致）*/
export const DEFAULT_INDICATOR_PARAMS: IndicatorParams = {
  ma: { periods: [...DEFAULT_MA_PERIODS] },
  macd: { fast: 12, slow: 26, signal: 9 },
  rsi: { period: 14, overbought: 70, oversold: 30 },
  kdj: { n: 9, m1: 3, m2: 3 },
};

/** 深拷贝一份默认参数（「恢复默认」用，避免共享引用被改）*/
export function cloneIndicatorParams(params: IndicatorParams): IndicatorParams {
  return {
    ma: { periods: [...params.ma.periods] },
    macd: { ...params.macd },
    rsi: { ...params.rsi },
    kdj: { ...params.kdj },
  };
}

/* ------------------------------------------------------------------ *
 * 合法区间
 * ------------------------------------------------------------------ */

/** 单个参数的合法区间 */
export interface ParamRange {
  /** 最小值（含）*/
  min: number;
  /** 最大值（含）*/
  max: number;
  /** 步长（整数参数 = 1）*/
  step: number;
}

/**
 * 各参数的合法区间
 *
 * 依据：
 * - **MA 周期 2~250**：<2 无意义（1 周期 = 原始价）；>250 超出单页最多 500 根日线的一半，
 *   再大也画不出有效均线段。
 * - **MACD fast 2~60 / slow 5~120 / signal 2~60**：慢线必须显著大于快线，
 *   且 slow + signal 不能超过数据长度（否则 `technical.calculateMACD` 按既有契约返回空数组）。
 * - **RSI 周期 2~100**：>100 在 120~500 根的图上几乎全是预热期。
 * - **RSI 阈值 超买 50~100 / 超卖 0~50**：RSI 取值域是 0~100；
 *   超买必须 > 超卖（交叉时夹取超卖 = 超买 - 1）。
 * - **KDJ N 2~100 / M1、M2 1~50**：`SMA(X,1,1)` 合法（M=1 即取当期值），
 *   但 N=1 会让 RSV 退化为「当前价在当根高低点中的位置」，无参考价值。
 */
export const PARAM_RANGES = {
  maPeriod: { min: 2, max: 250, step: 1 },
  macdFast: { min: 2, max: 60, step: 1 },
  macdSlow: { min: 5, max: 120, step: 1 },
  macdSignal: { min: 2, max: 60, step: 1 },
  rsiPeriod: { min: 2, max: 100, step: 1 },
  rsiOverbought: { min: 50, max: 100, step: 1 },
  rsiOversold: { min: 0, max: 50, step: 1 },
  kdjN: { min: 2, max: 100, step: 1 },
  kdjM1: { min: 1, max: 50, step: 1 },
  kdjM2: { min: 1, max: 50, step: 1 },
} as const satisfies Record<string, ParamRange>;

/* ------------------------------------------------------------------ *
 * 夹取（越界不生效）
 * ------------------------------------------------------------------ */

/** 夹取结果里的问题（面板据此提示用户）*/
export interface ParamIssue {
  /** 出问题的字段 */
  key: ParamFieldKey;
  /** 中文提示 */
  message: string;
}

/** 把数值夹到区间内并按步长取整 */
function clampToRange(value: number, range: ParamRange): number {
  if (!Number.isFinite(value)) return range.min;
  const stepped = Math.round(value / range.step) * range.step;
  const min = Math.ceil(range.min / range.step) * range.step;
  const max = Math.floor(range.max / range.step) * range.step;
  return Math.min(max, Math.max(min, stepped));
}

/**
 * 把用户填的参数夹到合法区间
 *
 * @returns `params` = 夹取后的**生效参数**；`issues` = 被夹取的字段与提示文案
 */
export function clampIndicatorParams(input: IndicatorParams): {
  params: IndicatorParams;
  issues: ParamIssue[];
} {
  const issues: ParamIssue[] = [];
  const params = cloneIndicatorParams(input);

  /* ---------- MA ---------- */
  const maPeriods: number[] = [];
  for (let i = 0; i < MA_LINE_COUNT; i++) {
    const raw = input.ma.periods[i] ?? DEFAULT_MA_PERIODS[i];
    const value = clampToRange(raw, PARAM_RANGES.maPeriod);
    if (value !== raw) {
      issues.push({
        key: MA_FIELD_KEYS[i] as ParamFieldKey,
        message: `MA${i + 1} 周期需在 ${PARAM_RANGES.maPeriod.min}~${PARAM_RANGES.maPeriod.max} 之间，已取 ${value}`,
      });
    }
    maPeriods.push(value);
  }
  params.ma.periods = maPeriods;

  /* ---------- MACD ---------- */
  const slow = clampToRange(input.macd.slow, PARAM_RANGES.macdSlow);
  if (slow !== input.macd.slow) {
    issues.push({
      key: 'macdSlow',
      message: `MACD 慢线需在 ${PARAM_RANGES.macdSlow.min}~${PARAM_RANGES.macdSlow.max} 之间，已取 ${slow}`,
    });
  }
  // 快线必须小于慢线（MACD 的定义）
  const fastBase = clampToRange(input.macd.fast, PARAM_RANGES.macdFast);
  let fast = fastBase;
  if (fast >= slow) {
    fast = Math.max(PARAM_RANGES.macdFast.min, slow - 1);
    issues.push({
      key: 'macdFast',
      message: `MACD 快线需小于慢线 ${slow}，已取 ${fast}`,
    });
  } else if (fastBase !== input.macd.fast) {
    issues.push({
      key: 'macdFast',
      message: `MACD 快线需在 ${PARAM_RANGES.macdFast.min}~${PARAM_RANGES.macdFast.max} 之间，已取 ${fastBase}`,
    });
  }
  const signal = clampToRange(input.macd.signal, PARAM_RANGES.macdSignal);
  if (signal !== input.macd.signal) {
    issues.push({
      key: 'macdSignal',
      message: `MACD 信号线需在 ${PARAM_RANGES.macdSignal.min}~${PARAM_RANGES.macdSignal.max} 之间，已取 ${signal}`,
    });
  }
  params.macd = { fast, slow, signal };

  /* ---------- RSI ---------- */
  const rsiPeriod = clampToRange(input.rsi.period, PARAM_RANGES.rsiPeriod);
  if (rsiPeriod !== input.rsi.period) {
    issues.push({
      key: 'rsiPeriod',
      message: `RSI 周期需在 ${PARAM_RANGES.rsiPeriod.min}~${PARAM_RANGES.rsiPeriod.max} 之间，已取 ${rsiPeriod}`,
    });
  }
  const overbought = clampToRange(input.rsi.overbought, PARAM_RANGES.rsiOverbought);
  if (overbought !== input.rsi.overbought) {
    issues.push({
      key: 'rsiOverbought',
      message: `RSI 超买阈值需在 ${PARAM_RANGES.rsiOverbought.min}~${PARAM_RANGES.rsiOverbought.max} 之间，已取 ${overbought}`,
    });
  }
  // 超卖必须小于超买（否则两条阈值线交叉，语义反了）
  const oversoldBase = clampToRange(input.rsi.oversold, PARAM_RANGES.rsiOversold);
  let oversold = oversoldBase;
  if (oversold >= overbought) {
    oversold = Math.max(PARAM_RANGES.rsiOversold.min, overbought - 1);
    issues.push({
      key: 'rsiOversold',
      message: `RSI 超卖阈值需小于超买阈值 ${overbought}，已取 ${oversold}`,
    });
  } else if (oversoldBase !== input.rsi.oversold) {
    issues.push({
      key: 'rsiOversold',
      message: `RSI 超卖阈值需在 ${PARAM_RANGES.rsiOversold.min}~${PARAM_RANGES.rsiOversold.max} 之间，已取 ${oversoldBase}`,
    });
  }
  params.rsi = { period: rsiPeriod, overbought, oversold };

  /* ---------- KDJ ---------- */
  const kdjN = clampToRange(input.kdj.n, PARAM_RANGES.kdjN);
  if (kdjN !== input.kdj.n) {
    issues.push({
      key: 'kdjN',
      message: `KDJ N 需在 ${PARAM_RANGES.kdjN.min}~${PARAM_RANGES.kdjN.max} 之间，已取 ${kdjN}`,
    });
  }
  const kdjM1 = clampToRange(input.kdj.m1, PARAM_RANGES.kdjM1);
  if (kdjM1 !== input.kdj.m1) {
    issues.push({
      key: 'kdjM1',
      message: `KDJ M1 需在 ${PARAM_RANGES.kdjM1.min}~${PARAM_RANGES.kdjM1.max} 之间，已取 ${kdjM1}`,
    });
  }
  const kdjM2 = clampToRange(input.kdj.m2, PARAM_RANGES.kdjM2);
  if (kdjM2 !== input.kdj.m2) {
    issues.push({
      key: 'kdjM2',
      message: `KDJ M2 需在 ${PARAM_RANGES.kdjM2.min}~${PARAM_RANGES.kdjM2.max} 之间，已取 ${kdjM2}`,
    });
  }
  params.kdj = { n: kdjN, m1: kdjM1, m2: kdjM2 };

  return { params, issues };
}

/* ------------------------------------------------------------------ *
 * 面板字段定义
 * ------------------------------------------------------------------ */

/** 参数分组 */
export type ParamGroup = 'ma' | 'macd' | 'rsi' | 'kdj';

/** 参数字段的唯一 key */
export type ParamFieldKey =
  | 'ma1'
  | 'ma2'
  | 'ma3'
  | 'ma4'
  | 'macdFast'
  | 'macdSlow'
  | 'macdSignal'
  | 'rsiPeriod'
  | 'rsiOverbought'
  | 'rsiOversold'
  | 'kdjN'
  | 'kdjM1'
  | 'kdjM2';

/** 单位类型：`bar` = K 线根数（单位随图表周期变：日/周/月）；`point` = 指标点值 */
export type ParamUnit = 'bar' | 'point';

/** 单个可编辑字段的定义 */
export interface ParamFieldDef {
  key: ParamFieldKey;
  group: ParamGroup;
  /** 标签（不含单位与冒号）*/
  label: string;
  unit: ParamUnit;
  range: ParamRange;
  /** 读当前生效值 */
  get(params: IndicatorParams): number;
  /** 写一个新值（**不夹取** —— 夹取统一由 `clampIndicatorParams` 负责）*/
  with(params: IndicatorParams, value: number): IndicatorParams;
  /**
   * 该指标**至少需要**多少根 K 线才有有效值
   *
   * ⚠️ 不足时不是「算错」，而是**预热期没有值**（SMA 的前 period-1 根是 NaN，
   *    MACD 需要 slow+signal 根，KDJ 需要 n 根）。
   *    面板据此提示「数据不足」，避免用户以为图坏了。
   */
  minBars(params: IndicatorParams): number;
}

/** 面板分组定义 */
export const PARAM_GROUPS: ReadonlyArray<{ key: ParamGroup; label: string }> = [
  { key: 'ma', label: 'MA 均线' },
  { key: 'macd', label: 'MACD' },
  { key: 'rsi', label: 'RSI' },
  { key: 'kdj', label: 'KDJ' },
];

/** 全部可编辑字段（面板按它渲染 —— UI 与口径不两处各写一份）*/
export const PARAM_FIELDS: readonly ParamFieldDef[] = [
  ...MA_FIELD_KEYS.map((key, i) => ({
    key: key as ParamFieldKey,
    group: 'ma' as ParamGroup,
    label: `MA${i + 1} 周期`,
    unit: 'bar' as ParamUnit,
    range: PARAM_RANGES.maPeriod,
    get: (p: IndicatorParams) => p.ma.periods[i],
    with: (p: IndicatorParams, value: number) => {
      const periods = [...p.ma.periods];
      periods[i] = value;
      return { ...p, ma: { periods } };
    },
    // SMA 的前 period-1 根没有值 ⇒ 至少要 period 根
    minBars: (p: IndicatorParams) => p.ma.periods[i],
  })),
  {
    key: 'macdFast',
    group: 'macd',
    label: 'MACD 快线',
    unit: 'bar',
    range: PARAM_RANGES.macdFast,
    get: (p) => p.macd.fast,
    with: (p, value) => ({ ...p, macd: { ...p.macd, fast: value } }),
    // MACD 需要 slow + signal 根才有值（`technical.calculateMACD` 的既有契约）
    minBars: (p: IndicatorParams) => p.macd.slow + p.macd.signal,
  },
  {
    key: 'macdSlow',
    group: 'macd',
    label: 'MACD 慢线',
    unit: 'bar',
    range: PARAM_RANGES.macdSlow,
    get: (p) => p.macd.slow,
    with: (p, value) => ({ ...p, macd: { ...p.macd, slow: value } }),
    // MACD 需要 slow + signal 根才有值（`technical.calculateMACD` 的既有契约）
    minBars: (p: IndicatorParams) => p.macd.slow + p.macd.signal,
  },
  {
    key: 'macdSignal',
    group: 'macd',
    label: 'MACD 信号线',
    unit: 'bar',
    range: PARAM_RANGES.macdSignal,
    get: (p) => p.macd.signal,
    with: (p, value) => ({ ...p, macd: { ...p.macd, signal: value } }),
    // MACD 需要 slow + signal 根才有值（`technical.calculateMACD` 的既有契约）
    minBars: (p: IndicatorParams) => p.macd.slow + p.macd.signal,
  },
  {
    key: 'rsiPeriod',
    group: 'rsi',
    label: 'RSI 周期',
    unit: 'bar',
    range: PARAM_RANGES.rsiPeriod,
    get: (p) => p.rsi.period,
    with: (p, value) => ({ ...p, rsi: { ...p.rsi, period: value } }),
    // RSI 需要 period + 1 根（涨跌幅序列）
    minBars: (p: IndicatorParams) => p.rsi.period + 1,
  },
  {
    key: 'rsiOverbought',
    group: 'rsi',
    label: 'RSI 超买阈值',
    unit: 'point',
    range: PARAM_RANGES.rsiOverbought,
    get: (p) => p.rsi.overbought,
    with: (p, value) => ({ ...p, rsi: { ...p.rsi, overbought: value } }),
    minBars: (p: IndicatorParams) => p.rsi.period + 1,
  },
  {
    key: 'rsiOversold',
    group: 'rsi',
    label: 'RSI 超卖阈值',
    unit: 'point',
    range: PARAM_RANGES.rsiOversold,
    get: (p) => p.rsi.oversold,
    with: (p, value) => ({ ...p, rsi: { ...p.rsi, oversold: value } }),
    minBars: (p: IndicatorParams) => p.rsi.period + 1,
  },
  {
    key: 'kdjN',
    group: 'kdj',
    label: 'KDJ N',
    unit: 'bar',
    range: PARAM_RANGES.kdjN,
    get: (p) => p.kdj.n,
    with: (p, value) => ({ ...p, kdj: { ...p.kdj, n: value } }),
    // KDJ 需要 n 根才凑满一个 RSV 窗口
    minBars: (p: IndicatorParams) => p.kdj.n,
  },
  {
    key: 'kdjM1',
    group: 'kdj',
    label: 'KDJ M1',
    unit: 'bar',
    range: PARAM_RANGES.kdjM1,
    get: (p) => p.kdj.m1,
    with: (p, value) => ({ ...p, kdj: { ...p.kdj, m1: value } }),
    // KDJ 需要 n 根才凑满一个 RSV 窗口
    minBars: (p: IndicatorParams) => p.kdj.n,
  },
  {
    key: 'kdjM2',
    group: 'kdj',
    label: 'KDJ M2',
    unit: 'bar',
    range: PARAM_RANGES.kdjM2,
    get: (p) => p.kdj.m2,
    with: (p, value) => ({ ...p, kdj: { ...p.kdj, m2: value } }),
    // KDJ 需要 n 根才凑满一个 RSV 窗口
    minBars: (p: IndicatorParams) => p.kdj.n,
  },
];

/** 按 key 取字段定义 */
export function findParamField(key: ParamFieldKey): ParamFieldDef | undefined {
  return PARAM_FIELDS.find((f) => f.key === key);
}

/* ------------------------------------------------------------------ *
 * 展示
 * ------------------------------------------------------------------ */

/** 参数摘要（一行显示当前生效值）*/
export function formatParamsSummary(params: IndicatorParams): string {
  return [
    `MA(${params.ma.periods.join('/')})`,
    `MACD(${params.macd.fast},${params.macd.slow},${params.macd.signal})`,
    `RSI(${params.rsi.period}, ${params.rsi.oversold}/${params.rsi.overbought})`,
    `KDJ(${params.kdj.n},${params.kdj.m1},${params.kdj.m2})`,
  ].join(' · ');
}
