/**
 * K 线图数据准备（T70 · 前端算指标）
 *
 * ## 职责
 *
 * 把后端下发的**原始日线**（`GET /api/quote/:symbol/kline` 的 `klines[]`）加工成
 * klinecharts 能直接消费的 **KLineData**：
 *
 * 1. **周期聚合**（F-K7）：日线 → 周线 / 月线（PRD §5.2「周/月基于日线聚合」）。
 * 2. **前端算指标**（SDD §2.5「只画不算」）：MA(4 条，周期可编辑) / MACD / RSI / KDJ
 *    全部由**前端**计算后**灌进每根 K 线**（`KLineData` 允许挂任意扩展字段）。
 *    指标参数见 `chartParams.ts`（T71：参数实时生效，零网络请求）。
 * 3. **信号标记**：把后端信号按 `trade_date` 对齐到 K 线上（`signal` 字段）。
 *
 * ## 🔴 为什么指标在前端算（而不是用后端下发的 `indicators`）
 *
 * SDD §2.5 的「指标归属分界」：
 *
 * | 图上元素 | 计算方 | 理由 |
 * |---|---|---|
 * | MA / MACD / RSI / KDJ | **前端** | 参数固定、纯装饰；两端同为 JS（IEEE754）同公式必然逐位相同 |
 * | 成交量 | 后端下发原始 `volume` | 原始字段无需计算 |
 * | 信号标记 + hover 指标明细 | **后端** | 参数每用户可调，是决策依据 → 必须可追溯 |
 *
 * ⚠️ **绝不能用 klinecharts 的内置指标**（`MA` / `MACD` / `RSI` / `KDJ` 都是库自带的）
 *    —— 那会让「后端 core 算一套 + 前端库算一套」产生**双口径**。
 *    本项目一律 `registerIndicator` 注册**自定义**指标（名字统一带 `APP_` 前缀），
 *    `calc` 只做「把前端算好的值原样吐回去」，库不参与任何计算。
 *
 * ## 🔴 与 core 的口径一致性
 *
 * `technical.ts` 是 `packages/core/src/indicators/adapters.ts` 的**逐位等价副本**
 * （前端禁止 import `@invest/core`，故只能各存一份；与 `kdj.ts` / `bollinger.ts` 同款约定）。
 * 两份文件**必须保持字节一致** —— 由 `apps/frontend/tests/unit/kline-page.test.tsx` 断言。
 *
 * 指标数值口径：
 * - MA：库 `SMA`（尾部对齐短数组 → 适配层补齐成全长，头部 NaN）
 * - MACD：库 `MACD` + **柱值 ×2**（A 股通达信约定 `MACD = 2*(DIF-DEA)`）
 * - RSI：库 `RSI`（库内部已 2 位小数取整），数据不足期填 50
 * - KDJ：前端手写实现（A 股口径，`K₀ = D₀ = 50`；横盘除零沿用前值）
 */

import { calculateKDJ } from './kdj';
import { calculateMACD, calculateRSI, calculateSMA } from './technical';
import { DEFAULT_INDICATOR_PARAMS, type IndicatorParams } from './chartParams';

/** 后端 `klines[]` 的原始形状 */
export interface RawBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** K 线交易标记（T152 · SDD_v3 §9.9）*/
export interface TradeMarker {
  id: number;
  trade_date: string;
  trade_time: string | null;
  /** 原始录入 / 导入类型（buy/add/reduce/clear）*/
  trade_type: string;
  /** 按发生前持仓推导出的展示类型（open/add/reduce/close）*/
  marker_type: 'open' | 'add' | 'reduce' | 'close';
  quantity: number;
  price: number;
  /** 当前复权口径的显示价 */
  adj_price: number;
}

/** 图表周期（日 / 周 / 月） */
export type KlinePeriod = 'day' | 'week' | 'month';

/** 图表周期 → klinecharts 的 `Period.type` */
export const PERIOD_TO_KLINECHARTS: Record<KlinePeriod, 'day' | 'week' | 'month'> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/** 策略信号标记（后端供给，前端只画） */
export interface SignalMarker {
  /** 交易日（`YYYY-MM-DD`）—— 与 K 线的 `date` 对齐 */
  trade_date: string;
  /** `buy` / `sell` / 其它 */
  direction: string;
  /** 信号标签（如「超卖买入」）*/
  label: string;
  /** 强度 [0,1]，可空 */
  strength: number | null;
  /** 插件 id */
  plugin_id: string;
  /** `metrics_json` 解析结果（hover 明细用）；无则 `null` */
  metrics: Record<string, unknown> | null;
}

/** 加工后的 K 线（= klinecharts 的 `KLineData` + 本项目扩展字段） */
export interface ChartBar extends RawBar {
  /** 毫秒时间戳（本地时区当日 00:00）*/
  timestamp: number;
  /**
   * MA 第 1~4 条线的值
   *
   * ⚠️ 字段名按**线序号**而非周期命名 —— MA 周期可编辑（T71），
   *    字段名若写死成 `ma5` 会在用户把周期改成 7 之后变成谎言。
   *    周期见 `IndicatorParams.ma.periods`（与下标一一对应）。
   */
  ma1: number;
  ma2: number;
  ma3: number;
  ma4: number;
  dif: number;
  dea: number;
  macd: number;
  rsi: number;
  k: number;
  d: number;
  j: number;
  /** 该交易日的信号（无则 `null`）*/
  signal: SignalMarker | null;
  /**
   * 该 K 线对应的交易标记（T152）
   *
   * ⚠️ 同一根 K 线可能对应**多笔**交易（同日多笔）⇒ 用数组，不是单值。
   *    周/月 K 下该数组包含**整根周期 K 线内**的全部交易（桶映射）。
   */
  trades: TradeMarker[];
  /** 相对前一根 K 线收盘价的涨跌幅（%），第一根为 null */
  changePct?: number | null;
}

/** 图表周期 → 参数面板里 K 线根数的单位（PRD §5.2「日 K / 周 K / 月 K」）*/
export function periodUnit(period: KlinePeriod): string {
  return period === 'day' ? '日' : period === 'week' ? '周' : '月';
}

/* ------------------------------------------------------------------ *
 * 周期聚合（F-K7）
 * ------------------------------------------------------------------ */

/**
 * ISO 周序号（周一为一周之首）
 *
 * 标准算法：把日期挪到本周周四，再算它与当年 1 月 1 日的天数差。
 */
function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const weekday = d.getUTCDay() || 7; // 周一=1 … 周日=7
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // 移到本周周四
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 年-月键 */
function monthKey(date: string): string {
  return date.slice(0, 7);
}

/** 周期 K 线桶（周/月由日线聚合出来的区间；日 K 是单日桶）*/
export interface BarBucket {
  /** 桶内首根日线日期 */
  startDate: string;
  /** 桶内末根日线日期 */
  endDate: string;
}

interface BarGroup {
  key: string;
  items: RawBar[];
}

/**
 * 把升序日线切成周期桶。
 *
 * 周/月 K 线聚合时，交易点不能只按聚合后 `bar.date`（末交易日）精确匹配；
 * 必须知道「这一根周期 K 线覆盖的首日～末日」，才能把桶内任意交易归入同一根。
 */
export function buildBarBuckets(bars: RawBar[], period: KlinePeriod): BarBucket[] {
  if (period === 'day') {
    return bars.map((bar) => ({ startDate: bar.date, endDate: bar.date }));
  }

  const keyOf = period === 'week' ? isoWeekKey : monthKey;
  const groups: BarGroup[] = [];

  for (const bar of bars) {
    const key = keyOf(bar.date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(bar);
    } else {
      groups.push({ key, items: [bar] });
    }
  }

  return groups.map(({ items }) => ({
    startDate: items[0]?.date ?? '',
    endDate: items[items.length - 1]?.date ?? '',
  }));
}

/**
 * 把日线聚合成周线 / 月线
 *
 * 聚合口径（业界通行）：
 * - `open` = 区间首根的 open
 * - `high` = 区间内最高 high
 * - `low`  = 区间内最低 low
 * - `close`= 区间末根的 close
 * - `volume` / `amount` = 区间内求和
 * - `date` = 区间内**最后一个交易日**（保证 x 轴显示的是真实交易日）
 *
 * @param bars 原始日线（**升序**：最早 → 最新）
 * @param period 目标周期；`'day'` 原样返回
 */
export function aggregateBars(bars: RawBar[], period: KlinePeriod): RawBar[] {
  if (period === 'day') return bars.slice();

  const groups: BarGroup[] = [];
  const keyOf = period === 'week' ? isoWeekKey : monthKey;

  for (const bar of bars) {
    const key = keyOf(bar.date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(bar);
    } else {
      groups.push({ key, items: [bar] });
    }
  }

  return groups.map(({ items }) => {
    const first = items[0];
    const last = items[items.length - 1];
    let high = first.high;
    let low = first.low;
    let volume = 0;
    let amount = 0;
    for (const it of items) {
      if (it.high > high) high = it.high;
      if (it.low < low) low = it.low;
      volume += it.volume ?? 0;
      amount += it.amount ?? 0;
    }
    return {
      date: last.date,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      amount,
    };
  });
}

/**
 * 把交易标记映射到每根图表 K 线上（T152）。
 *
 * - 日 K：交易日有对应 bar 直接映射；无对应 bar（周末/停牌）归入其后最近一根，不插值、不改写日期
 * - 周/月 K：按桶覆盖的 `startDate~endDate` 归入对应周期 K 线；跨桶交易归入后续桶
 * - 交易只追加到 `ChartBar.trades`，不改变 OHLCV 与既有指标值
 */
export function mapTradesToBars(bars: RawBar[], period: KlinePeriod, trades: TradeMarker[]): TradeMarker[][] {
  const buckets = buildBarBuckets(bars, period);
  const result: TradeMarker[][] = buckets.map(() => []);

  for (const trade of trades) {
    // 第一个 endDate >= trade_date 的桶 = 交易日所在桶（日 K 下即精确匹配 / 下一个交易日）
    const index = buckets.findIndex((bucket) => bucket.endDate >= trade.trade_date);
    if (index < 0) continue;
    if (buckets[index].startDate > trade.trade_date) continue;
    result[index].push(trade);
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 指标计算 + 灌值
 * ------------------------------------------------------------------ */

/** `YYYY-MM-DD` → 本地时区当日 00:00 的毫秒时间戳 */
export function toTimestamp(date: string): number {
  const ts = Date.parse(`${date}T00:00:00`);
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 计算全部图表指标并灌进每根 K 线
 *
 * ⚠️ **MACD 的特例**：`technical.ts` 的 `calculateMACD` 在
 *    `closes.length < slowPeriod + signalPeriod`（默认 = 35）时返回**三个空数组**
 *    （core 的既有对外契约）→ 此处补 NaN，避免出现 `undefined`。
 *
 * @param params 指标参数（T71）；缺省用默认参数（PRD §5.2 的 MA(5/10/20/60) 等）
 */
export function buildChartBars(
  bars: RawBar[],
  period: KlinePeriod,
  signals: SignalMarker[] = [],
  params: IndicatorParams = DEFAULT_INDICATOR_PARAMS,
  trades: TradeMarker[] = [],
): ChartBar[] {
  const aggregated = aggregateBars(bars, period);
  const tradesByBar = mapTradesToBars(bars, period, trades);

  const closes = aggregated.map((b) => b.close);
  const highs = aggregated.map((b) => b.high);
  const lows = aggregated.map((b) => b.low);

  // MA：4 条线，每条一个周期（周期可编辑 —— T71）
  const maLines = params.ma.periods.map((p) => calculateSMA(closes, p));
  const macd = calculateMACD(closes, params.macd.fast, params.macd.slow, params.macd.signal);
  const rsi = calculateRSI(closes, params.rsi.period);
  const kdj = calculateKDJ(highs, lows, closes, params.kdj.n, params.kdj.m1, params.kdj.m2);

  // 信号按交易日建索引（同一交易日可能有多条信号 → 取第一条「买入优先」）
  const signalByDate = new Map<string, SignalMarker>();
  for (const sig of signals) {
    if (!signalByDate.has(sig.trade_date)) signalByDate.set(sig.trade_date, sig);
  }

  return aggregated.map((bar, i) => ({
    ...bar,
    timestamp: toTimestamp(bar.date),
    ma1: maLines[0]?.[i] ?? NaN,
    ma2: maLines[1]?.[i] ?? NaN,
    ma3: maLines[2]?.[i] ?? NaN,
    ma4: maLines[3]?.[i] ?? NaN,
    dif: macd.dif[i] ?? NaN,
    dea: macd.dea[i] ?? NaN,
    macd: macd.macd[i] ?? NaN,
    rsi: rsi[i] ?? NaN,
    k: kdj.k[i] ?? NaN,
    d: kdj.d[i] ?? NaN,
    j: kdj.j[i] ?? NaN,
    signal: signalByDate.get(bar.date) ?? null,
    trades: tradesByBar[i] ?? [],
    changePct:
      i > 0 && aggregated[i - 1].close
        ? ((bar.close - aggregated[i - 1].close) / aggregated[i - 1].close) * 100
        : null,
  }));
}

/** 指标值 → 展示文本（NaN / 无限值显示 `--`）*/
export function formatIndicator(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

/**
 * 解析 `metrics_json`
 *
 * SQLite 里存的是 **JSON 字符串**（`signalService.serializeMetrics`），
 * 也可能已经是对象（测试替身）→ 两种都兼容。
 * 解析失败一律返回 `null`（**不抛异常** —— hover 明细不该因为脏数据炸掉整页）。
 */
export function parseMetricsJson(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
