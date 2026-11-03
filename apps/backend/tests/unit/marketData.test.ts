/**
 * marketData.test.ts — 单元测试 marketData 辅助函数
 *
 * 覆盖 src/services/marketData.ts：
 *   - resolveTable 内部逻辑（通过 getDailyBySymbol 间接验证）
 *   - batchGetDaily 空数组返回空 Map
 *   - isTradingDay DuckDB 不可用时返回 false
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-md-'));
const TEST_DB = path.join(tmpDir, 'md-test.db');
// T81：顶层写 env 必须留原值并在 afterAll 还原，否则会漏给下一个测试文件
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import {
  batchGetDaily,
  batchGetDailyRange,
  batchGetLatestAndPrevClose,
  batchGetLatestClose,
  isTradingDay,
  getLatestTradingDay,
  resolveTargetTradeDate,
  resolveLatestQuoteDate,
} from '../../src/services/marketData.js';
import * as duckdbMod from '../../src/db/duckdb.js';

/**
 * 🔴 这些用例**不依赖真实行情库**（2026-10-19 CI 教训）：
 *   CI 环境只有 12KB 空壳 `data/quotes.duckdb`（无 `v_stock_qfq` 等表），
 *   而本地指向 1.24GB 真库 → 依赖真库的断言在**本地全绿、CI 全红**
 *   （PR #15 的后续 24 个 commit 从未过 CI，正是这个原因）。
 *   → 改为 mock `queryDuckDB`，让行为在 CI 与本地**完全一致**。
 *
 * mock 按 **SQL 关键词**分派，不依赖完整 SQL 文本（改写实现时不易碎）。
 */
type Row = Record<string, unknown>;

/** mock 用的休市日黑名单（国庆 10-01~10-07） */
const HOLIDAYS = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'];
/** mock 用的有行情日期（数据口径：最新只到 10-12，用于体现「行情陈旧」） */
const QUOTE_DATES = ['2026-10-08', '2026-10-09', '2026-10-12'];

/** 日历口径：ref 往前回溯，找最近一个「工作日 且 非休市」的日期 */
function latestCalendarTradingDay(ref: string): string | null {
  const end = new Date(`${ref}T00:00:00Z`).getTime();
  for (let i = 0; i <= 30; i++) {
    const d = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && !HOLIDAYS.includes(d)) return d;
  }
  return null;
}

/** 数据口径：ref 之前最近一个有行情数据的日期 */
function latestQuoteDate(ref: string): string | null {
  return [...QUOTE_DATES].reverse().find((d) => d <= ref) ?? null;
}

function installDuckDBMock(): void {
  vi.spyOn(duckdbMod, 'queryDuckDB').mockImplementation(async (sql: string, params?: unknown[]) => {
    const p = params ?? [];
    if (sql.includes('raw_holidays')) {
      if (sql.includes('COUNT(*)')) {
        // isTradingDay：查某日是否在休市黑名单
        const date = String(p[0] ?? '');
        return [{ count: HOLIDAYS.includes(date) ? 1 : 0 }] as Row[];
      }
      if (sql.includes('generate_series')) {
        // resolveTargetTradeDate：日历口径
        return [{ d: latestCalendarTradingDay(String(p[1] ?? '')) }] as Row[];
      }
      return [] as Row[];
    }
    if (sql.includes('raw_kline_daily') || sql.includes('v_stock_qfq') || sql.includes('v_etf_qfq')) {
      // resolveLatestQuoteDate：数据口径
      return [{ d: latestQuoteDate(String(p[0] ?? '')) }] as Row[];
    }
    return [] as Row[];
  });
}
function cleanup(): void {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TEST_DB + ext);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    /* ignore */
  }
}

beforeAll(() => {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  cleanup();
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('marketData — batchGetDaily 空数组', () => {
  it('symbols=[] → 返回空 Map', async () => {
    const result = await batchGetDaily([], '2026-10-15');
    expect(result.size).toBe(0);
  });
});

describe('marketData — isTradingDay（2026-10-19 实测修正口径）', () => {
  // 🔴 T85b ②（I-20）：`raw_holidays` 存的是**休市日**黑名单，不是交易日。
  //    原实现的注释「有行 = 交易日」是错的 → 判定改为「工作日 且 不在休市黑名单中」。
  //    下面的用例直接用真实行情库断言，不再是「返回 boolean」这种同义反复。

  it('交易日（工作日且非休市）→ true', async () => {
    installDuckDBMock();
    // 2026-10-12 周一，raw_holidays 无此日，且 v_stock_qfq 有 5561 行行情
    expect(await isTradingDay('2026-10-12')).toBe(true);
  });

  it('法定休市日 → false', async () => {
    installDuckDBMock();
    // 2026-10-07 在 raw_holidays（国庆假期）
    expect(await isTradingDay('2026-10-07')).toBe(false);
  });

  it('周末 → false（raw_holidays 不含周末，需单独排除）', async () => {
    installDuckDBMock();
    // 2026-10-11 周日，不在休市黑名单里，但不是交易日
    expect(await isTradingDay('2026-10-11')).toBe(false);
  });

  it('DuckDB 不可用时降级返回 false（不抛错）', async () => {
    vi.spyOn(duckdbMod, 'queryDuckDB').mockRejectedValue(new Error('duckdb down'));
    try {
      expect(await isTradingDay('2026-10-12')).toBe(false);
    } finally {
      duckdbMod.queryDuckDB.mockRestore();
    }
  });
});

describe('marketData — resolveTargetTradeDate / resolveLatestQuoteDate', () => {
  it('resolveTargetTradeDate —— 日历口径：最近一个交易日（跨周末回退到周五）', async () => {
    installDuckDBMock();
    // 2026-10-18 是周日 → 日历口径应回退到 2026-10-16（周五）
    expect(await resolveTargetTradeDate('2026-10-18')).toBe('2026-10-16');
  });

  it('resolveTargetTradeDate —— 休市日同样回退（2026-10-07 国庆 → 09-30）', async () => {
    installDuckDBMock();
    expect(await resolveTargetTradeDate('2026-10-07')).toBe('2026-09-30');
  });

  it('resolveLatestQuoteDate —— 数据口径：最近一个【有行情数据】的日期', async () => {
    installDuckDBMock();
    const d = await resolveLatestQuoteDate('2026-10-19');
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d!).not.toBe('2026-10-19'); // 当日无数据（行情陈旧），不应返回当天
  });

  it('两个口径的差值即「行情陈旧度」，数据陈旧时二者不相等', async () => {
    installDuckDBMock();
    const cal = await resolveTargetTradeDate('2026-10-19');
    const data = await resolveLatestQuoteDate('2026-10-19');
    // 本机行情最新到 2026-10-12，日历口径是 2026-10-19 → 陈旧
    expect(cal).toBe('2026-10-19');
    expect(data).toBe('2026-10-12');
  });
});

describe('marketData — getLatestTradingDay（@deprecated 别名）', () => {
  it('等价于 resolveLatestQuoteDate（数据口径）', async () => {
    installDuckDBMock();
    expect(await getLatestTradingDay('2026-10-19')).toBe(await resolveLatestQuoteDate('2026-10-19'));
  });

  it('DuckDB 不可用时降级返回 null（不抛错）', async () => {
    vi.spyOn(duckdbMod, 'queryDuckDB').mockRejectedValue(new Error('duckdb down'));
    try {
      expect(await getLatestTradingDay('1900-01-01')).toBeNull();
    } finally {
      duckdbMod.queryDuckDB.mockRestore();
    }
  });
});

describe('marketData — 批量取价按品种拆分 stock/etf（ETF 修复）', () => {
  /**
   * 回归背景（2026-11-01）：批量取价 SQL 硬编码 `raw_symbol_class."class" = 'stock'`，
   * ETF/LOF 标的（sh51xxxx / sz15xxxx / sz16xxxx）恒查不到价 ⇒ 仪表盘「资产组成」
   * ETF 段 0%。修复 = 先 1 次 IN 查品种，再 stock / etf 两组各 1 条取价查询并合并。
   */
  const CLASSES: Record<string, string> = {
    sh600000: 'stock',
    sh510300: 'etf',
    sz159915: 'etf',
  };

  interface CallRec {
    sql: string;
    params: unknown[];
  }

  function installPriceMock(opts: { classQueryFails?: boolean } = {}): { calls: () => CallRec[] } {
    const calls: CallRec[] = [];
    vi.spyOn(duckdbMod, 'queryDuckDB').mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      // ① 品种表（fetchAssetClasses）
      if (sql.includes('FROM raw_symbol_class')) {
        if (opts.classQueryFails) throw new Error('duckdb down');
        return (params ?? [])
          .filter((s) => typeof s === 'string' && CLASSES[s] !== undefined)
          .map((s) => ({ symbol: s, class: CLASSES[s] })) as Row[];
      }
      // ② 基表最新/昨收（buildBatchLatestCloseSql）—— 按 SQL 里的品种字面量分派
      if (sql.includes('FROM raw_kline_daily')) {
        if (sql.includes("'etf'")) {
          const etfSyms = (params ?? []).filter((s) => CLASSES[s] === 'etf');
          return etfSyms.flatMap((sym) => [
            { symbol: sym, date: '2026-10-12', close: 4.321, rn: 1 },
            { symbol: sym, date: '2026-10-11', close: 4.3, rn: 2 },
          ]) as Row[];
        }
        const stockSyms = (params ?? []).filter((s) => CLASSES[s] === 'stock');
        return stockSyms.flatMap((sym) => [
          { symbol: sym, date: '2026-10-12', close: 10.5, rn: 1 },
          { symbol: sym, date: '2026-10-11', close: 10.4, rn: 2 },
        ]) as Row[];
      }
      // ③ 视图日 K（batchGetDaily / batchGetDailyRange）
      // 参数形状：batchGetDaily = [date, ...symbols]；batchGetDailyRange = [from, to, ...symbols]
      const isRange = sql.includes('BETWEEN');
      const symOffset = isRange ? 2 : 1;
      const viewSymbols = (params ?? []).slice(symOffset).filter((s) => typeof s === 'string');
      if (sql.includes('FROM v_etf_qfq')) {
        return viewSymbols
          .filter((s) => CLASSES[s] === 'etf')
          .map((sym) => ({
            symbol: sym,
            date: String((params ?? [])[symOffset - 1] ?? '2026-10-12'),
            open: 4.2,
            high: 4.4,
            low: 4.1,
            close: 4.321,
            volume: 1000,
            amount: 4321,
          })) as Row[];
      }
      if (sql.includes('FROM v_stock_qfq')) {
        return viewSymbols
          .filter((s) => CLASSES[s] === 'stock')
          .map((sym) => ({
            symbol: sym,
            date: String((params ?? [])[symOffset - 1] ?? '2026-10-12'),
            open: 10,
            high: 11,
            low: 9.9,
            close: 10.5,
            volume: 2000,
            amount: 21000,
          })) as Row[];
      }
      return [] as Row[];
    });
    return {
      calls: () => calls,
    };
  }

  afterEach(() => {
    duckdbMod.queryDuckDB.mockRestore();
  });

  it('batchGetLatestClose：stock + etf 两组各 1 条查询，结果合并', async () => {
    const { calls } = installPriceMock();
    const result = await batchGetLatestClose(['sh600000', 'sh510300']);
    expect(result.get('sh600000')).toEqual({ date: '2026-10-12', close: 10.5 });
    expect(result.get('sh510300')).toEqual({ date: '2026-10-12', close: 4.321 });
    // 1 条品种查询 + 2 条取价查询（stock 组 / etf 组）
    const groupQueries = calls().filter((c) => c.sql.includes('FROM raw_kline_daily'));
    expect(groupQueries).toHaveLength(2);
    expect(groupQueries.some((c) => c.sql.includes("'etf'"))).toBe(true);
    expect(groupQueries.some((c) => c.sql.includes("'stock'"))).toBe(true);
  });

  it('batchGetLatestAndPrevClose：两组各自的最新 + 昨收都取到', async () => {
    const { calls } = installPriceMock();
    const result = await batchGetLatestAndPrevClose(['sh600000', 'sz159915']);
    const stock = result.get('sh600000');
    const etf = result.get('sz159915');
    expect(stock).toEqual({ date: '2026-10-12', close: 10.5, prevDate: '2026-10-11', prevClose: 10.4 });
    expect(etf).toEqual({ date: '2026-10-12', close: 4.321, prevDate: '2026-10-11', prevClose: 4.3 });
    void calls;
  });

  it('batchGetDaily：etf 标的走 v_etf_qfq 视图，stock 走 v_stock_qfq', async () => {
    const { calls } = installPriceMock();
    const result = await batchGetDaily(['sh600000', 'sh510300'], '2026-10-12');
    expect(result.get('sh600000')?.close).toBe(10.5);
    expect(result.get('sh510300')?.close).toBe(4.321);
    const viewQueries = calls().filter((c) => c.sql.includes('v_etf_qfq') || c.sql.includes('v_stock_qfq'));
    expect(viewQueries.some((c) => c.sql.includes('v_etf_qfq'))).toBe(true);
    expect(viewQueries.some((c) => c.sql.includes('v_stock_qfq'))).toBe(true);
  });

  it('batchGetDailyRange：区间日线按品种拆两组视图并合并', async () => {
    const { calls } = installPriceMock();
    const result = await batchGetDailyRange(['sh600000', 'sh510300'], '2026-10-01', '2026-10-12');
    expect(result.get('sh600000')?.[0]?.close).toBe(10.5);
    expect(result.get('sh510300')?.[0]?.close).toBe(4.321);
    expect(calls().some((c) => c.sql.includes('v_etf_qfq'))).toBe(true);
  });

  it('品种查询失败 → 全部落 stock 组（= 改动前的既有降级行为，不更差）', async () => {
    const { calls } = installPriceMock({ classQueryFails: true });
    const result = await batchGetLatestClose(['sh600000', 'sh510300']);
    // stock 组查询把两个代码都带上（etf 组不产生）
    const groupQueries = calls().filter((c) => c.sql.includes('FROM raw_kline_daily'));
    expect(groupQueries).toHaveLength(1);
    expect(groupQueries[0].sql).toContain("'stock'");
    expect(groupQueries[0].params).toContain('sh510300');
    // ETF 在 stock 组查不到 ⇒ 不在结果里（与修复前行为一致）
    expect(result.get('sh600000')?.close).toBe(10.5);
    expect(result.get('sh510300')).toBeUndefined();
  });
});
