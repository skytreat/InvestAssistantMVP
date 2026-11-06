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
