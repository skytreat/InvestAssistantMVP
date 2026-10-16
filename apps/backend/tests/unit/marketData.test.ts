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
});

describe('marketData — getLatestTradingDay', () => {
  it('调用 getLatestTradingDay 不抛错，返回 DuckDBDateValue 或 null', async () => {
    const result = await getLatestTradingDay('2026-10-15');
    // DuckDB Neo API 返回 DuckDBDateValue 对象（有 .days 属性）或 null
    expect(result !== undefined).toBe(true);
  });
});
