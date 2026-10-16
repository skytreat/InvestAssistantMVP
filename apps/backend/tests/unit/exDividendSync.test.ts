/**
 * exDividendSync.test.ts — 单元测试 SDD §12.3 B5
 *
 * 覆盖 src/services/exDividendSync.ts：
 *   - getHoldingBeforeDate 空表返回 0
 *   - getHoldingBeforeDate buy-only → 正确持股数
 *   - getHoldingBeforeDate reduce 类型交易 → 负向计入持仓
 *   - importDividendEvents 无除权事件（mock DuckDB 空）→ eventsProcessed=0
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-div-'));
const TEST_DB = path.join(tmpDir, 'div-test.db');
const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import {
  getHoldingBeforeDate,
  importDividendEvents,
} from '../../src/services/exDividendSync.js';

function cleanup(): void {
  // 重置 ConfigStore 单例
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  if (ORIGINAL_SQLITE_PATH !== undefined) {
    process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_PATH;
  } else {
    delete process.env.SQLITE_DB_PATH;
  }
}

afterAll(() => {
  cleanup();
});

describe('exDividendSync — getHoldingBeforeDate', () => {
  it('无交易记录 → 持仓 = 0', () => {
    const db = ConfigStore.getInstance().db;
    const holding = getHoldingBeforeDate(db, 999, 'sh600000', '2026-10-30');
    expect(holding).toBe(0);
  });

  it('有 buy 记录 → 正确返回持股数', () => {
    const db = ConfigStore.getInstance().db;
    const uid = 101;
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
    ).run(uid, 'div_user_101', 'dummy');
    db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', '2026-10-01', 100, 10.0, 0, 'test', 0)`
    ).run(uid, 'sh600000');

    const holding = getHoldingBeforeDate(db, uid, 'sh600000', '2026-10-30');
    expect(holding).toBe(100);
  });

  it('buy + reduce 类型 → reduce 负向计入持仓', () => {
    const db = ConfigStore.getInstance().db;
    const uid = 102;
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
    ).run(uid, 'div_user_102', 'dummy');
    db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', '2026-10-01', 200, 10.0, 0, 'b', 0)`
    ).run(uid, 'sh600000');
    db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'reduce', '2026-10-10', 50, 12.0, 0, 'r', 0)`
    ).run(uid, 'sh600000');

    // reduce 在公式里是 -quantity，所以 200 - 50 = 150
    const holding = getHoldingBeforeDate(db, uid, 'sh600000', '2026-10-30');
    expect(holding).toBe(150);
  });
});

describe('exDividendSync — importDividendEvents', () => {
  afterEach(() => {
    cleanup();
  });

  it('无除权事件（DuckDB mock 空）→ eventsProcessed=0', async () => {
    // 需要在 import 之前设置 mock
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockResolvedValue([]);

    const result = await importDividendEvents('2026-10-30');
    expect(result.eventsProcessed).toBe(0);
    expect(result.importedDividend).toBe(0);
    expect(result.importedBonus).toBe(0);

    mockMod.queryDuckDB.mockRestore();
  });
});
