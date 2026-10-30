/**
 * symbolDict.test.ts — 字典权威 & 孤儿软删（仅手动维护）
 * 验证：
 *  - ensureSymbolDict 不再自动软删 user_trade_record（防止误删历史交易）
 *  - 孤儿判定源 = 行情层 raw_symbol_class（mock 控制），symbol_dict 不再参与判定
 *  - softDeleteOrphanUserTradeRecords 仅软删 asset_code 不在行情层的记录；
 *    行情库不可读/无数据时返回 0（无法判定 → 禁止批量清理）
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-symbol-dict-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

// 行情层「已知标的」全集：mock 各用例按需控制
const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import {
  ensureSymbolDict,
  listOrphanUserTradeRecords,
  softDeleteOrphanUserTradeRecords,
} from '../../src/services/symbolDict.js';

let db: Database.Database;

/** mock 行情层 raw_symbol_class 全集 */
function mockMarket(codes: string[]): void {
  queryDuckDBMock.mockImplementation(async () => codes.map((c) => ({ symbol: c })));
}

/** mock 行情库不可读 */
function mockMarketUnavailable(): void {
  queryDuckDBMock.mockImplementation(async () => {
    throw new Error('duckdb unavailable');
  });
}

beforeAll(() => {
  db = ConfigStore.getInstance().db;
  // 种两个 user
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (7001, 'u7001', 'x', 'user'),
     (7002, 'u7002', 'x', 'user')`,
  ).run();
});

beforeEach(() => {
  db.prepare('DELETE FROM user_trade_record').run();
  db.prepare('DELETE FROM symbol_dict').run();
  queryDuckDBMock.mockReset();
});

afterAll(() => {
  try {
    (db as unknown as { close(): void }).close();
  } catch {
    /* ignore */
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

function helper() {
  const getIsDeleted = (id: number) =>
    Number(
      (
        db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(id) as {
          is_deleted: number;
        }
      ).is_deleted,
    );

  const insertTrade = (userId: number, assetCode: string, tradeType = 'buy', tradeDate = '2026-01-01') =>
    Number(
      db
        .prepare(
          `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_auto_import)
         VALUES (?, ?, ?, ?, '09:30:00', 100, 10, 0, 0)`,
        )
        .run(userId, assetCode, tradeType, tradeDate).lastInsertRowid,
    );

  return { getIsDeleted, insertTrade };
}

describe('symbol_dict · softDeleteOrphanUserTradeRecords（判定源 = raw_symbol_class）', () => {
  it('ensureSymbolDict 只同步字典，不再自动软删交易记录', async () => {
    const h = helper();
    mockMarket(['sh600000', 'sz000001']);
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, asset_class)
       VALUES ('sh600000','600000','浦发银行','','sh','risk')`,
    ).run();
    const idTrade = h.insertTrade(7002, 'sz000001', 'buy', '2026-01-31');
    expect(h.getIsDeleted(idTrade)).toBe(0);

    await ensureSymbolDict();

    expect(h.getIsDeleted(idTrade)).toBe(0);
    const orphans = await listOrphanUserTradeRecords();
    expect(orphans).toHaveLength(0); // sz000001 在行情层 → 非孤儿
  });

  it('支持按 userId 限定，仅软删目标用户的孤儿记录', async () => {
    const h = helper();
    mockMarket(['sh600000']);
    const id7001 = h.insertTrade(7001, 'sh600000', 'buy', '2026-01-30');
    const id7002 = h.insertTrade(7002, 'sz000002', 'buy', '2026-01-30');

    const n = await softDeleteOrphanUserTradeRecords({ userId: 7002 });
    expect(n).toBe(1);
    expect(h.getIsDeleted(id7001)).toBe(0); // 非目标用户，不动
    expect(h.getIsDeleted(id7002)).toBe(1);
  });

  it('行情库不可读（无法判定）时直接跳过，不软删任何记录', async () => {
    const h = helper();
    mockMarketUnavailable();
    const id1 = h.insertTrade(7001, 'sh600000', 'buy', '2026-02-01');
    const id2 = h.insertTrade(7002, 'sz000001', 'buy', '2026-02-01');
    expect(h.getIsDeleted(id1)).toBe(0);
    expect(h.getIsDeleted(id2)).toBe(0);
    const n = await softDeleteOrphanUserTradeRecords();
    expect(n).toBe(0);
    expect(h.getIsDeleted(id1)).toBe(0);
    expect(h.getIsDeleted(id2)).toBe(0);
  });

  it('行情层有数据时，raw_symbol_class 中不存在的 asset_code 被软删', async () => {
    const h = helper();
    mockMarket(['sh600000']);

    const idExists = h.insertTrade(7001, 'sh600000', 'buy', '2026-02-02');
    const idOrphan = h.insertTrade(7002, 'sz000001', 'buy', '2026-02-02'); // 不在行情层

    expect(h.getIsDeleted(idExists)).toBe(0);
    expect(h.getIsDeleted(idOrphan)).toBe(0);

    const n = await softDeleteOrphanUserTradeRecords();
    expect(n).toBe(1); // 只软删孤儿记录

    expect(h.getIsDeleted(idExists)).toBe(0);
    expect(h.getIsDeleted(idOrphan)).toBe(1);
  });

  it('重复调用幂等：已软删的记录不会被二次软删', async () => {
    const h = helper();
    mockMarket(['sh600000']);
    const idOrphan = h.insertTrade(7002, 'sz000001', 'buy', '2026-02-03'); // 不在行情层
    // 手动软删一次
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(idOrphan);

    const n = await softDeleteOrphanUserTradeRecords();
    // 已软删记录不在 is_deleted=0 范围 → n=0
    expect(n).toBe(0);
    expect(h.getIsDeleted(idOrphan)).toBe(1);
  });

  it('unknown 类标的（回购/黄金等）在行情层 → 对应交易不再被判孤儿', async () => {
    const h = helper();
    // 回归点：raw_symbol_class 含 unknown 类（如 sz131810 国债回购）
    mockMarket(['sz131810']);
    const idBond = h.insertTrade(7001, 'sz131810', 'buy', '2026-03-01');

    const orphans = await listOrphanUserTradeRecords();
    expect(orphans).toHaveLength(0);
    expect(h.getIsDeleted(idBond)).toBe(0);
  });
});
