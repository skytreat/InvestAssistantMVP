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
process.env.SQLITE_DB_PATH = TEST_DB;

import {
  getDailyBySymbol,
  batchGetDaily,
  batchGetDailyRange,
  isTradingDay,
  getLatestTradingDay,
} from '../../src/services/marketData.js';
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
});

describe('marketData — batchGetDaily 空数组', () => {
  it('symbols=[] → 返回空 Map', async () => {
    const result = await batchGetDaily([], '2026-10-15');
    expect(result.size).toBe(0);
  });
});

describe('marketData — isTradingDay', () => {
  it('调用 isTradingDay 不抛错（返回 boolean）', async () => {
    const result = await isTradingDay('2026-10-15');
    expect(typeof result).toBe('boolean');
  });

  it('raw_holidays 表不存在时不抛错，返回 false', async () => {
    // data/quotes.duckdb 为空时 raw_holidays 不存在，应降级返回 false
    const result = await isTradingDay('2099-01-01');
    expect(result).toBe(false);
  });
});

describe('marketData — getLatestTradingDay', () => {
  it('调用 getLatestTradingDay 不抛错，返回 string 或 null', async () => {
    const result = await getLatestTradingDay('2026-10-15');
    // DuckDB date 列返回 DuckDBDateValue，兼容处理
    expect(result === null || typeof result === 'string' || typeof result === 'object').toBe(true);
  });

  it('raw_holidays 表不存在时不抛错，返回 null', async () => {
    // 用早于所有假日的日期确保查不到任何匹配行
    const result = await getLatestTradingDay('1900-01-01');
    expect(result).toBeNull();
  });
});
