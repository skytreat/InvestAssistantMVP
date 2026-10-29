/**
 * symbolDict.test.ts — 字典权威 & 孤儿软删（仅手动维护）
 * 验证：
 *  - ensureSymbolDict 不再自动软删 user_trade_record（防止误删历史交易）
 *  - softDeleteOrphanUserTradeRecords 仅软删 asset_code 不在 symbol_dict 的记录
 *  - 支持按 userId 限定范围；幂等；字典为空时跳过
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-symbol-dict-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import {
  ensureSymbolDict,
  listOrphanUserTradeRecords,
  softDeleteOrphanUserTradeRecords,
} from '../../src/services/symbolDict.js';

let db: Database.Database;

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
      (db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(id) as { is_deleted: number })
        .is_deleted,
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

describe('symbol_dict · softDeleteOrphanUserTradeRecords', () => {
  it('ensureSymbolDict 只同步字典，不再自动软删交易记录', async () => {
    const h = helper();
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES ('sh600000','600000','浦发银行','','sh','unknown','risk')`,
    ).run();
    const idOrphan = h.insertTrade(7002, 'sz000001', 'buy', '2026-01-31');
    expect(h.getIsDeleted(idOrphan)).toBe(0);

    await ensureSymbolDict();

    expect(h.getIsDeleted(idOrphan)).toBe(0);
    expect(listOrphanUserTradeRecords()).toHaveLength(1);
  });

  it('支持按 userId 限定，仅软删目标用户的孤儿记录', () => {
    const h = helper();
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES ('sh600000','600000','浦发银行','','sh','unknown','risk')`,
    ).run();
    const id7001 = h.insertTrade(7001, 'sz000001', 'buy', '2026-01-30');
    const id7002 = h.insertTrade(7002, 'sz000002', 'buy', '2026-01-30');

    const n = softDeleteOrphanUserTradeRecords({ userId: 7002 });
    expect(n).toBe(1);
    expect(h.getIsDeleted(id7001)).toBe(0);
    expect(h.getIsDeleted(id7002)).toBe(1);
  });

  it('字典未同步（dictCount=0）时直接跳过，不软删任何记录', () => {
    const h = helper();
    // 确保字典为空
    db.prepare('DELETE FROM symbol_dict').run();
    const id1 = h.insertTrade(7001, 'sh600000', 'buy', '2026-02-01');
    const id2 = h.insertTrade(7002, 'sz000001', 'buy', '2026-02-01');
    expect(h.getIsDeleted(id1)).toBe(0);
    expect(h.getIsDeleted(id2)).toBe(0);
    const n = softDeleteOrphanUserTradeRecords();
    expect(n).toBe(0);
    expect(h.getIsDeleted(id1)).toBe(0);
    expect(h.getIsDeleted(id2)).toBe(0);
  });

  it('字典同步后，symbol_dict 中不存在的 asset_code 被软删', () => {
    const h = helper();
    // 清理前一条用例遗留
    db.prepare('DELETE FROM symbol_dict').run();

    // 插入两条：一条在字典中（sh600000），一条不在（sz000001）
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES ('sh600000','600000','浦发银行','','sh','unknown','risk'),
              ('sh000001','000001','平安银行','','sh','unknown','risk')`,
    ).run();

    const idExists = h.insertTrade(7001, 'sh600000', 'buy', '2026-02-02');
    const idOrphan = h.insertTrade(7002, 'sz000001', 'buy', '2026-02-02'); // sz000001 不在字典中

    expect(
      Number(
        (
          db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(idExists) as {
            is_deleted: number;
          }
        ).is_deleted,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(idOrphan) as {
            is_deleted: number;
          }
        ).is_deleted,
      ),
    ).toBe(0);

    const n = softDeleteOrphanUserTradeRecords();
    expect(n).toBe(1); // 只软删孤儿记录

    expect(
      Number(
        (
          db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(idExists) as {
            is_deleted: number;
          }
        ).is_deleted,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(idOrphan) as {
            is_deleted: number;
          }
        ).is_deleted,
      ),
    ).toBe(1);
  });

  it('重复调用幂等：已软删的记录不会被二次软删', () => {
    const h = helper();
    const idOrphan = h.insertTrade(7002, 'sz000001', 'buy', '2026-02-03'); // 仍不在字典中
    // 手动软删一次
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(idOrphan);

    const n = softDeleteOrphanUserTradeRecords();
    // 已经软删的记录不在 COUNT(*) 范围内，所以 n=0
    expect(n).toBe(0);
    expect(
      Number(
        (
          db.prepare('SELECT is_deleted FROM user_trade_record WHERE id = ?').get(idOrphan) as {
            is_deleted: number;
          }
        ).is_deleted,
      ),
    ).toBe(1);
  });
});
