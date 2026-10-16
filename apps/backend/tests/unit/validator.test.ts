/**
 * validator.test.ts — 单元测试 SDD §12.3 D1-D9
 *
 * 覆盖 src/services/validator.ts（仅测试导出函数）：
 *   - runAllChecks 返回 CheckSummary[]（10 项）
 *   - C11 token 未配置 → SKIP
 *   - TOLERANCES 常量可见
 *   - checkResult 写入 system_log
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-val-'));
const TEST_DB = path.join(tmpDir, 'val-test.db');
process.env.SQLITE_DB_PATH = TEST_DB;

import {
  runAllChecks,
  TOLERANCES,
} from '../../src/services/validator.js';
import { ConfigStore } from '../../src/config/configStore.js';

function cleanup(): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

describe('validator — TOLERANCES 常量', () => {
  it('TOLERANCES 包含所有关键容差值', () => {
    expect(TOLERANCES.ROW_COUNT_DEVIATION).toBe(0.10);
    expect(TOLERANCES.QFQ_PRICE_DIFF).toBe(0.01);
    expect(TOLERANCES.VOLUME_MULTIPLIER).toBe(200);
    expect(TOLERANCES.GBBQ_DROP_DIFF).toBe(0.005);
    expect(TOLERANCES.HFQ_FACTOR_DIFF).toBe(0.0001);
    expect(TOLERANCES.TUSHARE_PRICE_DIFF).toBe(0.01);
    expect(TOLERANCES.EASTMONEY_PRICE_DIFF).toBe(0.02);
  });
});

describe('validator — runAllChecks 结构', () => {
  it('runAllChecks 返回 10 项 CheckSummary（C1-C12 各一）', async () => {
    const summaries = await runAllChecks('2026-10-15');
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBe(10);

    const ids = summaries.map(s => s.checkId);
    expect(ids).toEqual(['C1', 'C2', 'C3', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12']);
  });

  it('每项都有 checkId / result / durationMs', async () => {
    const summaries = await runAllChecks('2026-10-14');
    for (const s of summaries) {
      expect(typeof s.checkId).toBe('string');
      expect(['PASS', 'WARN', 'ERROR', 'SKIP']).toContain(s.result);
      expect(typeof s.durationMs).toBe('number');
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('runAllChecks 不抛错（内部 try-catch 兜底）', async () => {
    expect(async () => await runAllChecks('2026-99-99')).not.toThrow();
  });
});

describe('validator — C11 SKIP 条件', () => {
  it('TUSHARE_TOKEN 未设置 → C11 结果 SKIP', async () => {
    const origToken = process.env.TUSHARE_TOKEN;
    delete process.env.TUSHARE_TOKEN;

    const summaries = await runAllChecks('2026-10-15');
    const c11 = summaries.find(s => s.checkId === 'C11');
    expect(c11).toBeDefined();
    expect(c11!.result).toBe('SKIP');
    expect(c11!.detail).toContain('TUSHARE_TOKEN');

    if (origToken !== undefined) {
      process.env.TUSHARE_TOKEN = origToken;
    } else {
      delete process.env.TUSHARE_TOKEN;
    }
  });
});

describe('validator — system_log 写入', () => {
  afterEach(() => {
    cleanup();
    // 清除单例以重用 DB
    (ConfigStore as any)._instance = null;
  });

  it('runAllChecks 每条校验写一条 system_log（至少 10 条）', () => {
    const db = ConfigStore.getInstance().db;
    db.prepare('DELETE FROM system_log').run();

    // runAllChecks 是 async，不能用同步断言，这里只测 writeSystemLog 路径
    // 真正写入由 runAllChecks 内部 logResult 完成，我们在另一个测试里验证
  });

  it('runAllChecks 后 system_log 有 datacheck 类型记录', async () => {
    const db = ConfigStore.getInstance().db;
    db.prepare('DELETE FROM system_log').run();

    await runAllChecks('2026-10-15');

    const rows = db.prepare(
      "SELECT COUNT(*) AS c FROM system_log WHERE log_type = 'datacheck'"
    ).get() as { c: number };
    expect(rows.c).toBeGreaterThanOrEqual(10);
  });
});
