import { describe, expect, it } from 'vitest';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';

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
