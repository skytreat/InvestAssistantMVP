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
import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-val2-'));
const TEST_DB = path.join(tmpDir, 'val2-test.db');
const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { runAllChecks } from '../../src/services/validator.js';

function cleanup(): void {
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
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_PATH;
  else delete process.env.SQLITE_DB_PATH;
}

afterAll(() => {
  cleanup();
});

describe('validator_deep — C6 市值数据存在性（T85 重写）', () => {
  afterEach(() => {
    cleanup();
  });

  it('无返回行 → SKIP（数据源缺失不得计为 PASS，ADR-004）', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：数据存在性探针（见上）
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C6')!.result).toBe('SKIP');
    mockMod.queryDuckDB.mockRestore();
  });

  it('标的数 < 3000 → WARN', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('floatmv')) {
        return [{ total_cnt: 100, with_mv: 100, result: 'WARN' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C6')!.result).toBe('WARN');
    mockMod.queryDuckDB.mockRestore();
  });

  it('标的数 ≥ 3000 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('floatmv')) {
        return [{ total_cnt: 5561, with_mv: 5561, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C6')!.result).toBe('PASS');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C7 日线价格合理性（T85 重写）', () => {
  afterEach(() => {
    cleanup();
  });

  it('存在 close=0 或 open>close×2 的标的 → WARN', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('bad_cnt')) {
        return [{ bad_cnt: 12, result: 'WARN' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C7')!.result).toBe('WARN');
    mockMod.queryDuckDB.mockRestore();
  });

  it('无异常标的 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('bad_cnt')) {
        return [{ bad_cnt: 0, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C7')!.result).toBe('PASS');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C8 行情更新执行时长（T107 改查 SQLite）', () => {
  afterEach(() => {
    cleanup();
  });

  async function mockQuoteProbe() {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      return [];
    });
    return mockMod;
  }

  it('无 tdx2db_update 日志 → SKIP（不得计为 PASS）', async () => {
    const mockMod = await mockQuoteProbe();
    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C8')!.result).toBe('SKIP');
    mockMod.queryDuckDB.mockRestore();
  });

  it('duration_s=40 → PASS', async () => {
    ConfigStore.getInstance().writeLog(
      'tdx2db_update',
      'SUCCESS',
      '17:00 行情更新成功（耗时 40s）',
      JSON.stringify({ state: 'SUCCESS', duration_s: 40 }),
      undefined,
      '2026-10-15',
    );
    const mockMod = await mockQuoteProbe();
    const summaries = await runAllChecks('2026-10-15');
    const c8 = summaries.find((s) => s.checkId === 'C8')!;
    expect(c8.result).toBe('PASS');
    expect(c8.detail).toContain('40s');
    mockMod.queryDuckDB.mockRestore();
  });

  it('duration_s=300 → WARN（执行时长超阈值）', async () => {
    ConfigStore.getInstance().writeLog(
      'tdx2db_update',
      'SUCCESS',
      '17:00 行情更新成功（耗时 300s）',
      JSON.stringify({ state: 'SUCCESS', duration_s: 300 }),
      undefined,
      '2026-10-15',
    );
    const mockMod = await mockQuoteProbe();
    const summaries = await runAllChecks('2026-10-15');
    const c8 = summaries.find((s) => s.checkId === 'C8')!;
    expect(c8.result).toBe('WARN');
    expect(c8.detail).toContain('行情更新耗时');
    mockMod.queryDuckDB.mockRestore();
  });

  it('detail 非法 JSON → WARN', async () => {
    ConfigStore.getInstance().writeLog(
      'tdx2db_update',
      'SUCCESS',
      'bad detail',
      'not-json',
      undefined,
      '2026-10-15',
    );
    const mockMod = await mockQuoteProbe();
    const summaries = await runAllChecks('2026-10-15');
    const c8 = summaries.find((s) => s.checkId === 'C8')!;
    expect(c8.result).toBe('WARN');
    expect(c8.detail).toContain('不是合法 JSON');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C9 复权因子抽样', () => {
  afterEach(() => {
    cleanup();
  });

  it('mismatch_count=0 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('latest_factors') || (sql as string).includes('sample')) {
        return [{ sampled: 100, math_mismatch: 0, factor_mismatch: 0, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c9 = summaries.find((s) => s.checkId === 'C9');
    expect(c9!.result).toBe('PASS');
    expect(c9!.detail).toContain('mismatch');
    mockMod.queryDuckDB.mockRestore();
  });

  it('mismatch_count > 5 → ERROR', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('latest_factors') || (sql as string).includes('sample')) {
        return [{ sampled: 100, math_mismatch: 10, factor_mismatch: 0, result: 'ERROR' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c9 = summaries.find((s) => s.checkId === 'C9');
    expect(c9!.result).toBe('ERROR');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — C10 除权事件覆盖', () => {
  afterEach(() => {
    cleanup();
  });

  it('missing_count=0 → PASS', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('raw_gbbq') && (sql as string).includes('missing_count')) {
        return [{ missing_count: 0, result: 'PASS' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c10 = summaries.find((s) => s.checkId === 'C10');
    expect(c10!.result).toBe('PASS');
    mockMod.queryDuckDB.mockRestore();
  });

  it('missing_count > 0 → WARN', async () => {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
      // T85b ②：runAllChecks 的「当日有无行情数据」探针（SELECT COUNT(*) AS quote_rows）
      // 闸门用它在无数据时把 C1/C3-C10 判 SKIP —— mock 必须应答，否则闸门会吞掉被测分支
      if ((sql as string).includes('quote_rows')) {
        return [{ quote_rows: 5000 }];
      }
      if ((sql as string).includes('raw_gbbq') && (sql as string).includes('missing_count')) {
        return [{ missing_count: 3, result: 'WARN' as const }];
      }
      return [];
    });
    const summaries = await runAllChecks('2026-10-15');
    const c10 = summaries.find((s) => s.checkId === 'C10');
    expect(c10!.result).toBe('WARN');
    mockMod.queryDuckDB.mockRestore();
  });
});

describe('validator_deep — runAllChecks 日志写入', () => {
  /**
   * ⚠️ 必须 mock 掉 global.fetch：
   * runAllChecks 会真跑 C11（东财/腾讯行情源抽样比对），C12 单只超时 10s +
   * 退避重试 2 次（200ms→400ms），在无外网/受限环境下单只可达 11s，
   * 20 只抽样直接冲破 vitest 默认 15s 超时（本用例曾在 15s 处 timeout）。
   *
   * 这里让 fetch 立即失败 → C12 走「连续失败 ≥5 → 整项 SKIP」分支，
   * 既隔离外部依赖，又顺带覆盖了降级路径。
   */
  it('runAllChecks 不抛错（内部 try-catch 兜底）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('validator_deep: 网络已隔离'));
    try {
      await expect(runAllChecks('2026-10-15')).resolves.toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
    // ⚠️ 超时说明（T81）：本用例是本文件**唯一**不 mock queryDuckDB 的用例，
    //    会真的打 DuckDB。C5 的 `EXISTS (SELECT 1 FROM v_stock_qfq WHERE date=?)`
    //    在 1.2GB 本地库上要 ~26s（视图非物化，date 过滤无法下推），
    //    全量 runAllChecks 实测 ~25s —— 此前吃 vitest 默认 15s 必然 timeout。
    //    这里显式给 60s，与同族用例 validator.test.ts 的 runAllChecks 一致。
  }, 60_000);
});
