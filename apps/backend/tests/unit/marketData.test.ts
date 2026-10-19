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
  getDailyBySymbol,
  batchGetDaily,
  batchGetDailyRange,
  isTradingDay,
  getLatestTradingDay,
  resolveTargetTradeDate,
  resolveLatestQuoteDate,
} from '../../src/services/marketData.js';
import * as duckdbMod from '../../src/db/duckdb.js';
import { ConfigStore } from '../../src/config/configStore.js';

function cleanup(): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
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
    // 2026-10-12 周一，raw_holidays 无此日，且 v_stock_qfq 有 5561 行行情
    expect(await isTradingDay('2026-10-12')).toBe(true);
  });

  it('法定休市日 → false', async () => {
    // 2026-10-07 在 raw_holidays（国庆假期）
    expect(await isTradingDay('2026-10-07')).toBe(false);
  });

  it('周末 → false（raw_holidays 不含周末，需单独排除）', async () => {
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
    // 2026-10-18 是周日 → 日历口径应回退到 2026-10-16（周五）
    expect(await resolveTargetTradeDate('2026-10-18')).toBe('2026-10-16');
  });

  it('resolveTargetTradeDate —— 休市日同样回退（2026-10-07 国庆 → 09-30）', async () => {
    expect(await resolveTargetTradeDate('2026-10-07')).toBe('2026-09-30');
  });

  it('resolveLatestQuoteDate —— 数据口径：最近一个【有行情数据】的日期', async () => {
    const d = await resolveLatestQuoteDate('2026-10-19');
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d!).not.toBe('2026-10-19'); // 当日无数据（行情陈旧），不应返回当天
  });

  it('两个口径的差值即「行情陈旧度」，数据陈旧时二者不相等', async () => {
    const cal = await resolveTargetTradeDate('2026-10-19');
    const data = await resolveLatestQuoteDate('2026-10-19');
    // 本机行情最新到 2026-10-12，日历口径是 2026-10-19 → 陈旧
    expect(cal).toBe('2026-10-19');
    expect(data).toBe('2026-10-12');
  });
});

describe('marketData — getLatestTradingDay（@deprecated 别名）', () => {
  it('等价于 resolveLatestQuoteDate（数据口径）', async () => {
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
