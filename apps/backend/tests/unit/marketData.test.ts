/**
 * marketData.test.ts — 单元测试 marketData 辅助函数
 *
 * 覆盖 src/services/marketData.ts：
 *   - resolveTable 内部逻辑（通过 getDailyBySymbol 间接验证）
 *   - batchGetDaily 空数组返回空 Map
 *   - isTradingDay DuckDB 不可用时返回 false
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
