import { describe, expect, it } from 'vitest';
// ⚠️ 必须排在 calendar 之前：`src/db/duckdb.ts` 在模块加载时快照 DUCKDB_PATH
import { marketDataAvailable } from '../_marketData.js';
import {
  CalendarOutOfRangeError,
  ForwardCalendar,
  isWeekday,
  loadForwardCalendar,
  loadHolidayList,
  loadTradingCalendar,
  nextTradingDay,
  TradingCalendar,
} from '../../src/services/backtest/calendar.js';
import { queryDuckDB } from '../../src/db/duckdb.js';

/** 故意乱序 + 含重复，验证构造时会去重排序 */
const RAW_DAYS = ['2026-10-09', '2026-10-12', '2026-10-08', '2026-10-07', '2026-10-09'];

describe('TradingCalendar —— 交易日历', () => {
  const cal = new TradingCalendar(RAW_DAYS);

  it('构造时去重 + 升序', () => {
    expect(cal.all).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']);
    expect(cal.length).toBe(4);
    expect(cal.has('2026-10-10')).toBe(false);
  });

  it('prev：date 是交易日 → 严格早于的第 n 个', () => {
    expect(cal.prev('2026-10-12')).toBe('2026-10-09');
    expect(cal.prev('2026-10-12', 2)).toBe('2026-10-08');
    expect(cal.prev('2026-10-07')).toBeNull();
  });

  it('prev：date 非交易日（周末）→ 回退到最后一个更早的交易日', () => {
    // 2026-10-10/11 是周末，不在日历里
    expect(cal.prev('2026-10-10')).toBe('2026-10-09');
    expect(cal.prev('2026-10-10', 2)).toBe('2026-10-08');
    expect(cal.prev('2026-10-06')).toBeNull();
  });

  it('next：date 是交易日 → 严格晚于的第 n 个', () => {
    expect(cal.next('2026-10-09')).toBe('2026-10-12');
    expect(cal.next('2026-10-09', 2)).toBeNull();
  });

  it('next：date 非交易日 → 其后的第一个交易日', () => {
    expect(cal.next('2026-10-10')).toBe('2026-10-12');
    expect(cal.next('2026-10-12')).toBeNull();
  });

  it('alignOrBefore：对齐到 ≤ date 的最近交易日', () => {
    expect(cal.alignOrBefore('2026-10-12')).toBe('2026-10-12');
    expect(cal.alignOrBefore('2026-10-11')).toBe('2026-10-09');
    expect(cal.alignOrBefore('2026-10-07')).toBe('2026-10-07');
    expect(cal.alignOrBefore('2026-10-06')).toBeNull();
  });

  it('lastN：截至 end 的最近 n 个交易日（含 end 当天）', () => {
    expect(cal.lastN('2026-10-12', 3)).toEqual(['2026-10-08', '2026-10-09', '2026-10-12']);
    expect(cal.lastN('2026-10-12', 30)).toEqual(cal.all);
    // 非交易日也要先对齐
    expect(cal.lastN('2026-10-11', 2)).toEqual(['2026-10-08', '2026-10-09']);
  });

  it('slice：闭区间内交易日', () => {
    expect(cal.slice('2026-10-08', '2026-10-09')).toEqual(['2026-10-08', '2026-10-09']);
    expect(cal.slice('2026-10-09', '2026-10-09')).toEqual(['2026-10-09']);
    expect(cal.slice('2026-10-10', '2026-10-12')).toEqual(['2026-10-12']);
    expect(cal.slice('2026-10-13', '2026-10-20')).toEqual([]);
  });

  it('n < 1 时抛错（避免静默返回错位日期）', () => {
    expect(() => cal.prev('2026-10-12', 0)).toThrow();
    expect(() => cal.next('2026-10-12', 0)).toThrow();
    expect(() => cal.lastN('2026-10-12', 0)).toThrow();
  });
});

describe('TradingCalendar —— 空日历边界', () => {
  const empty = new TradingCalendar([]);

  it('空日历不抛错，返回 null / 空数组', () => {
    expect(empty.length).toBe(0);
    expect(empty.prev('2026-10-12')).toBeNull();
    expect(empty.next('2026-10-12')).toBeNull();
    expect(empty.alignOrBefore('2026-10-12')).toBeNull();
    expect(empty.lastN('2026-10-12', 3)).toEqual([]);
    expect(empty.slice('2026-01-01', '2026-12-31')).toEqual([]);
  });
});

describe('ForwardCalendar —— 前向交易日历（PA-04）', () => {
  const none = new Set<string>();

  it('工作日判定（周一~周五）', () => {
    expect(isWeekday('2024-01-05')).toBe(true); // 周五
    expect(isWeekday('2024-01-06')).toBe(false); // 周六
    expect(isWeekday('2024-01-07')).toBe(false); // 周日
    expect(isWeekday('2024-01-08')).toBe(true); // 周一
  });

  it('周五 → 下周一（周末自动跳过）', () => {
    expect(nextTradingDay('2024-01-05', none)).toBe('2024-01-08');
    expect(nextTradingDay('2024-01-05', none, 2)).toBe('2024-01-09');
    expect(nextTradingDay('2024-01-05', none, 3)).toBe('2024-01-10');
    // 输入日即使本身是周末，也严格晚于输入日
    expect(nextTradingDay('2024-01-06', none)).toBe('2024-01-08');
  });

  it('节假日前夕：跳过休市日（raw_holidays 黑名单）', () => {
    // 2024 春节：02-09（周五）后 02-12~02-16 休市，02-17/18 是周末
    const holidays = new Set(['2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16']);
    expect(nextTradingDay('2024-02-09', holidays)).toBe('2024-02-19');
    expect(nextTradingDay('2024-02-09', none)).toBe('2024-02-12');
  });

  it('长假 + 跨年', () => {
    // 国庆：10-01~10-07（周二~周一）休市
    const nationalDay = new Set(['2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-07']);
    expect(nextTradingDay('2024-09-30', nationalDay)).toBe('2024-10-08');
    // 元旦（周三）休市 → 跨年顺延到 01-02
    expect(nextTradingDay('2024-12-31', new Set(['2025-01-01']))).toBe('2025-01-02');
    expect(nextTradingDay('2024-12-31', none)).toBe('2025-01-01');
  });

  it('覆盖范围之外一律抛 CALENDAR_OUT_OF_RANGE，不猜', () => {
    const cal = new ForwardCalendar(none, '2025-01-03');
    expect(() => cal.next('2025-01-03')).toThrow(CalendarOutOfRangeError);
    expect(() => cal.next('2025-01-03')).toThrow(/超出/);
    expect(cal.next('2025-01-02')).toBe('2025-01-03');
    try {
      cal.next('2025-01-03');
    } catch (e) {
      expect((e as CalendarOutOfRangeError).code).toBe('CALENDAR_OUT_OF_RANGE');
    }
    // 黑名单最大日期自动成为覆盖终点
    const auto = new ForwardCalendar(['2030-12-31']);
    expect(() => auto.next('2030-12-31')).toThrow(CalendarOutOfRangeError);
  });

  it('非法输入直接抛错', () => {
    expect(() => nextTradingDay('2024-1-5', none)).toThrow(/YYYY-MM-DD/);
    expect(() => nextTradingDay('2024-02-31', none)).toThrow(/非法日期/);
    expect(() => nextTradingDay('2024-01-05', none, 0)).toThrow(/n 必须/);
    expect(() => isWeekday('2024-13-01')).toThrow(/非法日期/);
  });

  it('n 个交易日与逐次调用一致', () => {
    let cursor = '2024-01-05';
    for (let i = 0; i < 10; i++) cursor = nextTradingDay(cursor, none);
    expect(cursor).toBe(nextTradingDay('2024-01-05', none, 10));
  });
});

const hasMarket = await marketDataAvailable();

describe('ForwardCalendar —— 与历史交易日历交叉验证', () => {
  it.skipIf(!hasMarket)('历史日期上 nextTradingDay 等于下一根 sh000001 bar', async () => {
    const history = await loadTradingCalendar();
    const forward = await loadForwardCalendar();
    expect(history.length).toBeGreaterThan(100);

    let checked = 0;
    // 每 29 个交易日抽一个，覆盖跨月/跨年/长假
    for (let i = 0; i + 1 < history.all.length; i += 29) {
      const d = history.all[i];
      const want = history.all[i + 1];
      // 覆盖范围内才比对（超出 raw_holidays 覆盖终点按设计抛错）
      let got: string;
      try {
        got = forward.next(d);
      } catch (e) {
        if (e instanceof CalendarOutOfRangeError) continue;
        throw e;
      }
      expect(got, `历史 ${d} 的下一个交易日`).toBe(want);
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });
});

/**
 * 黑名单完整性对账（一次性自查，2026-11-08 用户要求「只验不改」）
 *
 * 口径：`sh000001` 的**每一根 bar** 就是那一天真实开过市；`raw_holidays` 是休市日黑名单。
 * 故在 bar 覆盖区间内，`工作日 − raw_holidays` 必须与 bar 集**逐日相等**。
 *
 * 实测基线（2026-11-08，真库 `data/quotes.duckdb` 只读）：
 * bar 8758 根（1990-12-19 → 2026-11-06），`raw_holidays` 680 行（1991-01-01 → 2030-10-07，
 * 无周末条目）⇒ 三类差异均为 0 ⇒ **`raw_holidays` 完整，无需改用 bar 日历做前向判定**。
 * 迷你库（`MARKET_DATA_MODE=ci`，729 根 bar / 2023-11-03 → 2026-11-06）同为零差异。
 */
describe('ForwardCalendar —— 黑名单完整性对账（全区间）', () => {
  const addOneDay = (date: string): string => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  };

  /** 某日全市场是否有任何一根日线 —— 用来区分「黑名单漏登记」与「指数缺 bar」 */
  const marketHasAnyBar = async (date: string): Promise<boolean> => {
    const rows = await queryDuckDB<{ c: number }>(
      `SELECT COUNT(*) AS c FROM raw_kline_daily WHERE CAST(date AS VARCHAR) = ?`,
      [date],
    );
    return Number(rows[0]?.c ?? 0) > 0;
  };

  it.skipIf(!hasMarket)('sh000001 bar 集与「工作日 − raw_holidays」逐日一致', async () => {
    const history = await loadTradingCalendar();
    const holidays = await loadHolidayList();
    expect(history.length).toBeGreaterThan(100);

    const start = history.all[0];
    const end = history.all[history.all.length - 1];
    // 覆盖终点对齐到 bar 区间末端：对账要判「黑名单是否完整」，不能被黑名单自身的覆盖终点截断
    const forward = new ForwardCalendar(holidays, end);
    const barDates = new Set(history.all);
    const holidayDates = new Set(holidays);

    const missingBar: string[] = []; // 日历判交易日、却无 bar
    const barOnHoliday: string[] = []; // 黑名单日却有 bar
    const barOnWeekend: string[] = []; // 周末却有 bar

    for (let cursor = start; cursor <= end; cursor = addOneDay(cursor)) {
      const hasBar = barDates.has(cursor);
      if (forward.isTradingDay(cursor)) {
        if (!hasBar) missingBar.push(cursor);
        continue;
      }
      if (!hasBar) continue;
      if (isWeekday(cursor) && holidayDates.has(cursor)) barOnHoliday.push(cursor);
      else barOnWeekend.push(cursor);
    }

    // 差异必须自解释：同日全市场有 bar ⇒ 是 sh000001 缺 bar；全市场都无 bar ⇒ 是黑名单漏登记
    const classified: { date: string; kind: string }[] = [];
    for (const d of missingBar) {
      const kind = (await marketHasAnyBar(d)) ? 'bar 缺失（市场有交易）' : '黑名单漏登记（全市场无 bar）';
      classified.push({ date: d, kind });
    }

    const range = `${start} → ${end}（${history.all.length} 根 bar，黑名单 ${holidays.length} 行）`;
    expect(classified, `对账区间 ${range}：日历判交易日但无 bar`).toEqual([]);
    expect(
      barOnHoliday.map((d) => ({ date: d, kind: '黑名单误登记（登记为休市但当天开市）' })),
      `对账区间 ${range}`,
    ).toEqual([]);
    expect(
      barOnWeekend.map((d) => ({ date: d, kind: 'bar 异常（周末出现 bar）' })),
      `对账区间 ${range}`,
    ).toEqual([]);
  });
});
