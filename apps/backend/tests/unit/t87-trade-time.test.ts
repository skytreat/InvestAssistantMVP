/**
 * T87 `trade_time` 必填 + UNIQUE 改为「同日同标的同类型分笔可追加」
 *
 * 业务口径（Requirements §5.1 / §13.4 B-11 裁决）：
 * - 唯一键 = (user_id, asset_code, trade_type, trade_date, trade_time)
 * - **quantity 不进主键** —— 交易笔数与成交时间唯一
 * - 同日同标的同类型**不同成交时间** → 201（追加成功）
 * - 同日同标的同类型**相同成交时间** → 409 TRADE_DUPLICATE
 * - 存量数据 `trade_time` 迁移时取 `created_at` 时间部分
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// T81：顶层写 env 必须留原值并在 afterAll 还原，否则会漏给下一个测试文件
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-t87-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { validateTradeTime, nowTradeTime } from '../../src/routes/trade.js';

let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(() => {
  db = ConfigStore.getInstance();
});

afterAll(() => {
  try {
    (db.db as any).close();
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

describe('T87 trade_time 格式校验', () => {
  it('合法 HH:mm:ss（秒级）通过', () => {
    expect(validateTradeTime('09:30:00')).toBe(true);
    expect(validateTradeTime('00:00:00')).toBe(true);
    expect(validateTradeTime('23:59:59')).toBe(true);
  });

  it('缺秒 / 缺位 / 非数字 → 拒绝', () => {
    expect(validateTradeTime('09:30')).toBe(false);
    expect(validateTradeTime('9:30:00')).toBe(false);
    expect(validateTradeTime('09:30:0')).toBe(false);
    expect(validateTradeTime('abc')).toBe(false);
    expect(validateTradeTime('')).toBe(false);
  });

  it('越界时间 → 拒绝', () => {
    expect(validateTradeTime('24:00:00')).toBe(false);
    expect(validateTradeTime('25:00:00')).toBe(false);
    expect(validateTradeTime('09:60:00')).toBe(false);
    expect(validateTradeTime('09:30:60')).toBe(false);
  });

  it('nowTradeTime() 返回合法的当前时间', () => {
    const t = nowTradeTime();
    expect(validateTradeTime(t)).toBe(true);
  });
});

describe('T87 DDL：trade_time 列与 UNIQUE 约束', () => {
  it('trade_time 列为 NOT NULL', () => {
    const cols = db.db.prepare('PRAGMA table_info(user_trade_record)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'trade_time');
    expect(col).toBeTruthy();
    expect(col!.notnull).toBe(1);
  });

  it('UNIQUE 键包含 trade_time（5 列），不含 quantity', () => {
    const rows = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
      .all() as Array<{ sql: string }>;
    const m = rows[0].sql.match(/UNIQUE\s*\(([^)]*)\)/);
    expect(m).toBeTruthy();
    const cols = m![1].split(',').map((s) => s.trim());
    expect(cols).toEqual(['user_id', 'asset_code', 'trade_type', 'trade_date', 'trade_time']);
    expect(cols).not.toContain('quantity');
  });

  it('CHECK 已含 add（7 种交易类型，T49 目标，预置以免二次重建）', () => {
    const rows = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
      .all() as Array<{ sql: string }>;
    const m = rows[0].sql.match(/trade_type IN \(([^)]*)\)/);
    expect(m).toBeTruthy();
    const types = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(types).toHaveLength(7);
    expect(types).toContain('add');
    expect(types).not.toContain('sell');
    expect(types).toContain('reduce');
  });
});

describe('T87 唯一键行为：同日分笔可追加', () => {
  const uid = 9001,
    code = 'sh600000';
  let userId: number;

  beforeAll(() => {
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    userId = uid;
  });

  function ins(time: string, qty: number, price = 10) {
    return db.db
      .prepare(
        `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, 'buy', '2026-09-01', ?, ?, ?, 0, 0)`,
      )
      .run(userId, code, time, qty, price);
  }

  // ⚠️ T81：下面每个用例都自带**独立的成交时间**（10:00/11:00/12:00/13:00/14:00 段），
  //    不再依赖「上一个用例先插过 09:30:00」——否则打乱用例顺序就会互相撞 UNIQUE。
  it('同日同标的同类型、不同成交时间 → 均插入成功', () => {
    ins('10:00:00', 100);
    expect(() => ins('10:01:00', 200)).not.toThrow();
    expect(() => ins('10:02:00', 300)).not.toThrow();
  });

  it('同日同标的同类型、相同成交时间 → UNIQUE 冲突', () => {
    ins('11:00:00', 100);
    expect(() => ins('11:00:00', 100)).toThrow(/UNIQUE/);
  });

  it('不同 quantity 不影响唯一性（quantity 不进主键）', () => {
    ins('12:00:00', 100);
    expect(() => ins('12:00:00', 999)).toThrow(/UNIQUE/);
  });

  it('不同 trade_type → 不冲突', () => {
    ins('13:00:00', 100);
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
         VALUES (?, ?, 'reduce', '2026-09-01', '13:00:00', 50, 10, 0, 0)`,
        )
        .run(userId, code),
    ).not.toThrow();
  });

  it('不同 trade_date → 不冲突', () => {
    ins('14:00:00', 100);
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
         VALUES (?, ?, 'buy', '2026-09-02', '14:00:00', 100, 10, 0, 0)`,
        )
        .run(userId, code),
    ).not.toThrow();
  });
});
