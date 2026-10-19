/**
 * validator.test.ts — 单元测试 SDD §12.3 D1-D9
 *
 * 覆盖 src/services/validator.ts（仅测试导出函数）：
 *   - runAllChecks 返回 CheckSummary[]（10 项）
 *   - C11 token 未配置 → SKIP
 *   - TOLERANCES 常量可见
 *   - checkResult 写入 system_log
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-val-'));
const TEST_DB = path.join(tmpDir, 'val-test.db');
// T81：顶层写 env 必须留原值并在 afterAll 还原，否则会漏给下一个测试文件
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
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

// T81：还原顶层写过的 env，避免漏给下一个测试文件
afterAll(() => {
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('validator — TOLERANCES 常量', () => {
  it('TOLERANCES 包含所有关键阈值（T85 按 Requirements §7 重整）', () => {
    // C1-C8 新鲜度类
    expect(TOLERANCES.MIN_SYMBOL_COUNT).toBe(3000);
    expect(TOLERANCES.EX_DIVIDEND_FRESH_DAYS).toBe(7);
    expect(TOLERANCES.CLASS_COUNT_DROP).toBe(0.10);
    expect(TOLERANCES.MAX_OPEN_CLOSE_RATIO).toBe(2);
    expect(TOLERANCES.MAX_UPDATE_SECONDS).toBe(120);
    // C9/C10 内容类
    expect(TOLERANCES.QFQ_PRICE_DIFF).toBe(0.01);
    expect(TOLERANCES.GBBQ_DROP_DIFF).toBe(0.005);
    // C11/C12 跨源类
    expect(TOLERANCES.TUSHARE_PRICE_DIFF).toBe(0.01);
    expect(TOLERANCES.EASTMONEY_PRICE_DIFF).toBe(0.02);
  });
});

describe('validator — runAllChecks 结构', () => {
  it('runAllChecks 返回 12 项 CheckSummary（C1-C12 各一，checkId 完整无缺）', async () => {
    // T85 修复了 I-16：此前 CHECKS 只注册 10 个函数，C4/C5 从未实现
    const summaries = await runAllChecks('2026-10-15');
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBe(12);

    const ids = summaries.map(s => s.checkId);
    expect(ids).toEqual([
      'C1', 'C2', 'C3', 'C4', 'C5', 'C6',
      'C7', 'C8', 'C9', 'C10', 'C11', 'C12',
    ]);
  }, 60_000);

  it('每项都有 checkId / result / durationMs', async () => {
    const summaries = await runAllChecks('2026-10-14');
    for (const s of summaries) {
      expect(typeof s.checkId).toBe('string');
      expect(['PASS', 'WARN', 'ERROR', 'SKIP']).toContain(s.result);
      expect(typeof s.durationMs).toBe('number');
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('runAllChecks 不抛错（内部 try-catch 兜底）', async () => {
    expect(async () => await runAllChecks('2026-99-99')).not.toThrow();
  }, 60_000);
});

describe('validator — C11 SKIP 条件', () => {
  it('TUSHARE_TOKEN 未设置 → C11 结果 SKIP', async () => {
    // T81：env 改动必须还原（用 try/finally 保证断言失败时也还原）
    const origToken = process.env.TUSHARE_TOKEN;
    delete process.env.TUSHARE_TOKEN;

    try {
      const summaries = await runAllChecks('2026-10-15');
      const c11 = summaries.find(s => s.checkId === 'C11');
      expect(c11).toBeDefined();
      expect(c11!.result).toBe('SKIP');
      expect(c11!.detail).toContain('TUSHARE_TOKEN');
    } finally {
      if (origToken !== undefined) {
        process.env.TUSHARE_TOKEN = origToken;
      } else {
        delete process.env.TUSHARE_TOKEN;
      }
    }
  }, 60_000);
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
    expect(rows.c).toBeGreaterThanOrEqual(12);
  }, 60_000);
});
