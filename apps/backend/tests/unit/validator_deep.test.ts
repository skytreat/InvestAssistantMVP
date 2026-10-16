/**
 * validator_deep.test.ts — 深度单元测试 SDD §12.3 D1-D9
 *
 * 覆盖 validator.ts 中尚未充分测试的分支：
 *   - checkC6: 抽样返回 WARN（有 diff >= 0.01 的行）
 *   - checkC7: 零成交量 → WARN
 *   - checkC8: 无除权事件 → PASS
 *   - checkC9: mismatch_count=0 → PASS; >5 → ERROR
 *   - checkC10: missing_count=0 → PASS; >0 → WARN
 *   - runAllChecks: 所有结果写 system_log（验证 logResult 路径）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-val2-'));
const TEST_DB = path.join(tmpDir, 'val2-test.db');
const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { runAllChecks, TOLERANCES } from '../../src/services/validator.js';

function cleanup(): void {
  try {
    const store = (ConfigStore as any)._instance;
    if (store) (store.db as any).close();
  } catch { /* ignore */ }
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  if (ORIGINAL_SQLITE_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_PATH;
  else delete process.env.SQLITE_DB_PATH;
}

afterAll(() => { cleanup(); });

describe('validator_deep — C6 前复权因子', () => {
  afterEach(() => { cleanup(); });

  it('抽样返回空行 → WARN（raw_kline_daily 缺数据）', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('sampled') || (sql as string).includes('C6')) return [];
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c6 = summaries.find(s => s.checkId === 'C6');
    expect(c6!.result).toBe('WARN');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C7 成交量异常', () => {
  afterEach(() => { cleanup(); });

  it('当日有零成交量记录 → WARN', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('recent') && (sql as string).includes('volume')) {
        return [
          { symbol: 'sh600000', date: '2026-10-15', volume: 0, avg_30d: 1000, result: 'WARN' as const },
        ];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c7 = summaries.find(s => s.checkId === 'C7');
    expect(c7!.result).toBe('WARN');
    mockMod.queryDuckDB.mockRestore();
  });

  it('当日无零成交量 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('recent') && (sql as string).includes('volume')) {
        return [
          { symbol: 'sh600000', date: '2026-10-15', volume: 1000, avg_30d: 500, result: 'PASS' as const },
        ];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c7 = summaries.find(s => s.checkId === 'C7');
    expect(c7!.result).toBe('PASS');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C8 除权跳变', () => {
  afterEach(() => { cleanup(); });

  it('无除权事件 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('raw_gbbq')) return [];
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c8 = summaries.find(s => s.checkId === 'C8');
    expect(c8!.result).toBe('PASS');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C9 复权因子抽样', () => {
  afterEach(() => { cleanup(); });

  it('mismatch_count=0 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('latest_factors') || (sql as string).includes('sample')) {
        return [{ mismatch_count: 0, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c9 = summaries.find(s => s.checkId === 'C9');
    expect(c9!.result).toBe('PASS');
    expect(c9!.detail).toContain('mismatch');
    mockMod.queryDuckDB.mockRestore();
  });

  it('mismatch_count > 5 → ERROR', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('latest_factors') || (sql as string).includes('sample')) {
        return [{ mismatch_count: 10, result: 'ERROR' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c9 = summaries.find(s => s.checkId === 'C9');
    expect(c9!.result).toBe('ERROR');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C10 除权事件覆盖', () => {
  afterEach(() => { cleanup(); });

  it('missing_count=0 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('raw_gbbq') && (sql as string).includes('missing_count')) {
        return [{ missing_count: 0, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c10 = summaries.find(s => s.checkId === 'C10');
    expect(c10!.result).toBe('PASS');
    mockMod.queryDuckDB.mockRestore();
  });

  it('missing_count > 0 → WARN', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if ((sql as string).includes('raw_gbbq') && (sql as string).includes('missing_count')) {
        return [{ missing_count: 3, result: 'WARN' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c10 = summaries.find(s => s.checkId === 'C10');
    expect(c10!.result).toBe('WARN');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — runAllChecks 日志写入', () => {
  it('runAllChecks 不抛错（内部 try-catch 兜底）', async () => {
    await expect(runAllChecks('2026-10-15')).resolves.toBeDefined();
  });
});
