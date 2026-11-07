/**
 * 交易日历（M1）—— 口径：`raw_kline_daily` 里 `sh000001`（上证指数）的 `date` 集合
 *
 * 为什么用 `sh000001` 而不是 `raw_holidays`：
 *   - `raw_holidays`（680 行 1991–2030）只是「休市日清单」，工作日 − 节假日 ≠ 交易日
 *     （还差临时休市 / 数据缺失日）；
 *   - `sh000001` 每个交易日照常生成一根日线，天然是「全市场实际有行情的日子」，
 *     与 `raw_kline_daily` 的 date 域**逐日一致**（这是回测对齐成交日的前提）。
 *   故本模块**只**以 `sh000001` 为准（见 proposal §3.1）。
 */
import { queryDuckDB } from '../../db/duckdb.js';

/** 日历基准标的：上证指数 */
export const CALENDAR_SYMBOL = 'sh000001';

/**
 * 交易日历（纯函数容器，便于单测直接构造）
 *
 * 约定：内部日期一律 `YYYY-MM-DD` 字符串（字典序 == 时间序），不引入 Date 对象
 * （避免时区把 UTC 日期移一天，这是本项目已踩过的坑）。
 */
export class TradingCalendar {
  private readonly days: readonly string[];
  private readonly index: Map<string, number>;

  constructor(days: readonly string[]) {
    const unique = [...new Set(days)].sort();
    this.days = unique;
    this.index = new Map(unique.map((d, i) => [d, i]));
  }

  get all(): readonly string[] {
    return this.days;
  }

  get length(): number {
    return this.days.length;
  }

  has(date: string): boolean {
    return this.index.has(date);
  }

  indexOf(date: string): number {
    return this.index.get(date) ?? -1;
  }

  /** 第一个 `>= date` 的下标（不存在则返回 length） */
  private lowerBound(date: string): number {
    let lo = 0;
    let hi = this.days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid] < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * `date` 之前（**严格早于**）的第 n 个交易日
   * @returns 越界时返回 null
   */
  prev(date: string, n = 1): string | null {
    if (n < 1) throw new Error(`TradingCalendar.prev: n 必须 ≥ 1（收到 ${n}）`);
    // lowerBound(date) = 第一个 ≥ date 的下标：
    //   - date 是交易日 → 指向它本身，再退 n 格即「严格早于」的第 n 个；
    //   - date 非交易日 → 指向它之后的第一个交易日，退 n 格恰好是「最后一个 < date」及其前 n-1 个。
    // 两种情况公式相同。
    const idx = this.lowerBound(date) - n;
    return idx >= 0 ? this.days[idx] : null;
  }

  /** `date` 之后（**严格晚于**）的第 n 个交易日；越界返回 null */
  next(date: string, n = 1): string | null {
    if (n < 1) throw new Error(`TradingCalendar.next: n 必须 ≥ 1（收到 ${n}）`);
    const atOrAfter = this.lowerBound(date);
    // date 是交易日：第 n 个 = 下标 + n；date 非交易日：atOrAfter 本身就是第 1 个 → 下标 + n - 1
    const idx = this.days[atOrAfter] === date ? atOrAfter + n : atOrAfter + n - 1;
    return idx < this.days.length ? this.days[idx] : null;
  }

  /**
   * 把任意日期对齐到「≤ date 的最近交易日」
   * - date 本身是交易日 → 原样返回
   * - 非交易日（周末/节假日）→ 回退到上一个交易日
   * @returns 早于日历起点时返回 null
   */
  alignOrBefore(date: string): string | null {
    const atOrAfter = this.lowerBound(date);
    if (this.days[atOrAfter] === date) return date;
    return atOrAfter > 0 ? this.days[atOrAfter - 1] : null;
  }

  /** 闭区间 [start, end] 内的交易日（不含两端之外的日期） */
  slice(start: string, end: string): string[] {
    const from = this.lowerBound(start);
    const to = this.lowerBound(end + '\uffff'); // '\uffff' 保证包含 end 当天
    return this.days.slice(from, to);
  }

  /** 截至 endDate（含，若 endDate 非交易日则对齐到前一个）的最近 n 个交易日 */
  lastN(endDate: string, n: number): string[] {
    if (n < 1) throw new Error(`TradingCalendar.lastN: n 必须 ≥ 1（收到 ${n}）`);
    const end = this.alignOrBefore(endDate);
    if (end === null) return [];
    const endIdx = this.indexOf(end);
    const startIdx = Math.max(0, endIdx - n + 1);
    return this.days.slice(startIdx, endIdx + 1);
  }
}

/** 从 DuckDB 读取交易日历（只读；`sh000001` 的 date 集合） */
export async function loadTradingCalendar(): Promise<TradingCalendar> {
  const rows = await queryDuckDB<{ date: string }>(
    `SELECT DISTINCT date FROM raw_kline_daily WHERE symbol = ? ORDER BY date ASC`,
    [CALENDAR_SYMBOL],
  );
  return new TradingCalendar(rows.map((r) => r.date));
}

// ════════════════════════════════════════════════════════════════════════
// 前向交易日历（PA-04）
//
// 🔴 **为什么不能用 `TradingCalendar`**：它只含**历史**日期（由 `sh000001` 的 bar 派生），
// 「明天」没有 bar，`has/next` 无从判断。纸面决策要算 `nextTradingDay(T)`，
// 口径只能是「工作日（周一~周五）− `raw_holidays`（休市日黑名单）」。
//
// ⚠️ 这只是**日历**口径，不等于「当天一定有行情」：
//    临时休市 / 数据缺失日不在 `raw_holidays` 里，仍会判成交易日 ——
//    那一类由「全市场未更新」的阻塞逻辑处理（方案 §7.3），不在这里猜。
// ════════════════════════════════════════════════════════════════════════

/** 前向日历越界（超出 `raw_holidays` 覆盖范围，或扫描安全上限） */
export class CalendarOutOfRangeError extends Error {
  readonly code = 'CALENDAR_OUT_OF_RANGE';
  constructor(message: string) {
    super(message);
    this.name = 'CalendarOutOfRangeError';
  }
}

const ISO_DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
/** 扫描安全上限（约两年）；正常情况下由 `coverageEnd` 先拦住 */
const MAX_SCAN_DAYS = 800;

/** 严格校验 `YYYY-MM-DD`（并用 UTC 往返排除 2024-02-31 这类假日期） */
function assertIsoDate(date: string, who: string): void {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`${who}: 日期必须是 YYYY-MM-DD（收到 ${date}）`);
  const [, y, mo, d] = m;
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(mo) - 1 ||
    probe.getUTCDate() !== Number(d)
  ) {
    throw new Error(`${who}: 非法日期 ${date}`);
  }
}

/** 日历上加减天数（`Date.UTC` 运算，不经过本地时区） */
function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** 周一~周五（不含周末；节假日另外排除） */
export function isWeekday(date: string): boolean {
  assertIsoDate(date, 'isWeekday');
  const [y, mo, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * 前向交易日历：`工作日 && 不在 raw_holidays`
 *
 * `coverageEnd` 缺省 = 休市日黑名单里的最大日期（`raw_holidays` 覆盖到该日）；
 * 越过它**一律抛 `CALENDAR_OUT_OF_RANGE`，不猜**（方案 §7.3）。
 */
export class ForwardCalendar {
  private readonly holidays: ReadonlySet<string>;
  private readonly coverageEnd: string | null;

  constructor(holidays: Iterable<string>, coverageEnd?: string | null) {
    this.holidays = new Set(holidays);
    if (coverageEnd !== undefined) {
      this.coverageEnd = coverageEnd;
    } else {
      const sorted = [...this.holidays].sort();
      this.coverageEnd = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    }
  }

  /** 是否交易日（超出覆盖范围抛错，而不是默默返回 false） */
  isTradingDay(date: string): boolean {
    assertIsoDate(date, 'ForwardCalendar.isTradingDay');
    this.assertInCoverage(date);
    return isWeekday(date) && !this.holidays.has(date);
  }

  /**
   * `date` 之后（**严格晚于**）的第 n 个交易日
   * @throws CalendarOutOfRangeError 越过 `coverageEnd` / 扫描超上限
   */
  next(date: string, n = 1): string {
    assertIsoDate(date, 'ForwardCalendar.next');
    if (n < 1) throw new Error(`ForwardCalendar.next: n 必须 ≥ 1（收到 ${n}）`);
    this.assertInCoverage(date);

    let cursor = date;
    let found = 0;
    for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
      cursor = addDays(cursor, 1);
      this.assertInCoverage(cursor);
      if (!isWeekday(cursor) || this.holidays.has(cursor)) continue;
      found++;
      if (found === n) return cursor;
    }
    throw new CalendarOutOfRangeError(
      `ForwardCalendar.next: 从 ${date} 起 ${MAX_SCAN_DAYS} 天内找不到第 ${n} 个交易日（休市日数据可能异常）`,
    );
  }

  private assertInCoverage(date: string): void {
    if (this.coverageEnd !== null && date > this.coverageEnd) {
      throw new CalendarOutOfRangeError(
        `ForwardCalendar: ${date} 超出 raw_holidays 覆盖范围（${this.coverageEnd}），不猜`,
      );
    }
  }
}

/**
 * 便捷函数：`工作日 − holidays` 口径下严格晚于 `date` 的第 n 个交易日
 *
 * @example nextTradingDay('2024-01-05', new Set()) === '2024-01-08'（周五 → 周一）
 */
export function nextTradingDay(
  date: string,
  holidays: Iterable<string>,
  n = 1,
  coverageEnd: string | null = null,
): string {
  return new ForwardCalendar(holidays, coverageEnd).next(date, n);
}

/** 从 DuckDB 读取前向日历（只读；`raw_holidays` = 休市日黑名单） */
export async function loadForwardCalendar(): Promise<ForwardCalendar> {
  const rows = await queryDuckDB<{ date: string }>(
    `SELECT CAST(date AS VARCHAR) AS date FROM raw_holidays ORDER BY date ASC`,
  );
  return new ForwardCalendar(rows.map((r) => r.date));
}
