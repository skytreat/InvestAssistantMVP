/**
 * validatorCoverage.test.ts — T86b 覆盖率补齐（C1-C12 校验引擎分支覆盖）
 *
 * 🔴 **为什么需要这个文件**：T86b 要恢复 SDD §12.2 的「数据校验引擎 ≥85% 行 / ≥80% 分支」门槛。
 * 实测（2026-10-21，`MARKET_DATA_MODE=mini`）：`validator.ts` 行覆盖 **85.14%**（刚过线）、
 * 分支覆盖 **81.32%**（刚过线）—— 两项都只有零点几个百分点的余量，任何一次改动都可能掉下去。
 *
 * 本文件覆盖的是 `validator_deep.test.ts` **没有覆盖**的两类路径：
 *   ① **DuckDB 无返回行** → 各校验判 `SKIP`（`if (!row)` 分支）
 *   ② **SQL 抛异常**     → 各校验走 catch 分支（C1/C9/C10 → ERROR；C3-C8 → WARN）
 *
 * ⚠️ **mock 要点**：`runAllChecks` 先跑「当日有无行情数据」探针
 *   （`SELECT COUNT(*) AS quote_rows FROM v_stock_qfq WHERE date = ?`）——
 *   探针失败 ⇒ `hasQuoteData=false` ⇒ 除 C2/C11/C12 外**全部被闸门 SKIP**，
 *   根本走不到各校验内部的 catch 分支。
 *   ⇒ mock 必须**只让探针通过**，其余 SQL 一律失败。
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-valcov-'));
const TEST_DB = path.join(tmpDir, 'valcov-test.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { runAllChecks } from '../../src/services/validator.js';
import { ConfigStore } from '../../src/config/configStore.js';

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  try {
    const store = (ConfigStore as any)._instance;
    if (store) (store.db as any).close();
  } catch {
    /* ignore */
  }
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TEST_DB + ext);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

/** 安装「探针通过 + 其余 SQL 无返回行」的 mock */
async function mockNoRows(): Promise<ReturnType<typeof vi.spyOn>> {
  const mockMod = await import('../../src/db/duckdb.js');
  return vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
    if (sql.includes('quote_rows')) return [{ quote_rows: 5000 }];
    return [];
  });
}

/** 安装「探针通过 + 其余 SQL 抛异常」的 mock */
async function mockSqlError(): Promise<ReturnType<typeof vi.spyOn>> {
  const mockMod = await import('../../src/db/duckdb.js');
  return vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
    if (sql.includes('quote_rows')) return [{ quote_rows: 5000 }];
    throw new Error('SQL boom');
  });
}

describe('validator 覆盖 — DuckDB 无返回行 → SKIP', () => {
  it('C1/C3/C4/C5/C6/C7/C9 无返回行 → 判 SKIP 且 detail 为「DuckDB 无返回行」', async () => {
    await mockNoRows();
    const summaries = await runAllChecks('2026-10-15');

    for (const id of ['C1', 'C3', 'C4', 'C5', 'C6', 'C7', 'C9']) {
      const s = summaries.find((x) => x.checkId === id);
      expect(s, `${id} 应有结果`).toBeDefined();
      expect(s!.result, `${id} 应判 SKIP`).toBe('SKIP');
      expect(s!.detail).toContain('DuckDB 无返回行');
    }

    // ⚠️ C10 的口径不同：它的 SQL 是聚合查询（LEFT JOIN），无行时按
    //    `row?.result ?? 'PASS'` 兜底 ⇒ 判 PASS、缺失标的=0（不是 SKIP）
    const c10 = summaries.find((x) => x.checkId === 'C10');
    expect(c10!.result).toBe('PASS');
    expect(c10!.detail).toContain('缺失标的=0');
  }, 60_000);
});

describe('validator 覆盖 — SQL 抛异常 → ERROR / WARN', () => {
  it('C1/C9/C10 判 ERROR，C3-C8 判 WARN（C2 判 ERROR）', async () => {
    await mockSqlError();
    const summaries = await runAllChecks('2026-10-15');

    const expectError = ['C1', 'C2', 'C9', 'C10'];
    const expectWarn = ['C3', 'C4', 'C5', 'C6', 'C7', 'C8'];

    for (const id of expectError) {
      const s = summaries.find((x) => x.checkId === id);
      expect(s, `${id} 应有结果`).toBeDefined();
      expect(s!.result, `${id} 应判 ERROR`).toBe('ERROR');
      expect(s!.detail).toContain('SQL 异常');
    }
    for (const id of expectWarn) {
      const s = summaries.find((x) => x.checkId === id);
      expect(s, `${id} 应有结果`).toBeDefined();
      expect(s!.result, `${id} 应判 WARN`).toBe('WARN');
      expect(s!.detail).toContain('SQL 异常');
    }
  }, 60_000);
});

describe('validator 覆盖 — C5 板块表为空的提示', () => {
  it('板块数为 0 → detail 追加「板块明细表为空」提示', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if (sql.includes('quote_rows')) return [{ quote_rows: 5000 }];
      if (sql.includes('today_blocks')) {
        return [{ today_cnt: 0, today_ref: 0, prev_ref: 0, prev_cnt: 0, result: 'SKIP' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c5 = summaries.find((s) => s.checkId === 'C5');
    expect(c5!.detail).toContain('板块明细表为空');
  }, 60_000);

  it('板块数不为 0 → detail 不含「板块明细表为空」', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if (sql.includes('quote_rows')) return [{ quote_rows: 5000 }];
      if (sql.includes('today_blocks')) {
        return [{ today_cnt: 120, today_ref: 300, prev_ref: 305, prev_cnt: 122, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c5 = summaries.find((s) => s.checkId === 'C5');
    expect(c5!.detail).not.toContain('板块明细表为空');
  }, 60_000);
});

describe('validator 覆盖 — C8 时间戳格式', () => {
  it('tdx2db_update 时间戳无法解析 → WARN', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if (sql.includes('quote_rows')) return [{ quote_rows: 5000 }];
      if (sql.includes('tdx2db_update')) {
        return [{ started_at: '2026/10/15 09:00:00', has_row: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c8 = summaries.find((s) => s.checkId === 'C8');
    expect(c8!.result).toBe('WARN');
    expect(c8!.detail).toContain('时间戳格式异常');
  }, 60_000);

  it('tdx2db_update 时间戳合法且耗时超上限 → WARN（执行时长超阈值）', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      if (sql.includes('quote_rows')) return [{ quote_rows: 5000 }];
      if (sql.includes('tdx2db_update')) {
        // 2020 年 ⇒ 距今远超 120s 上限
        return [{ started_at: '2020-01-01 09:00:00', has_row: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c8 = summaries.find((s) => s.checkId === 'C8');
    expect(c8!.result).toBe('WARN');
    expect(c8!.detail).toContain('行情更新开始于');
  }, 60_000);
});
