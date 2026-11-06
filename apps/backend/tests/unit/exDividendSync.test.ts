/**
 * exDividendSync.test.ts — 单元测试 SDD §12.3 B5
 *
 * 覆盖 src/services/exDividendSync.ts：
 *   - getHoldingBeforeDate 空表返回 0
 *   - getHoldingBeforeDate buy-only → 正确持股数
 *   - getHoldingBeforeDate reduce 类型交易 → 负向计入持仓
 *   - importDividendEvents 无除权事件（mock DuckDB 空）→ eventsProcessed=0
 */
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-div-'));
const TEST_DB = path.join(tmpDir, 'div-test.db');
const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { getHoldingBeforeDate, importDividendEvents } from '../../src/services/exDividendSync.js';

function cleanup(): void {
  // Windows 下未关闭的连接会锁住 db 文件，导致 unlink 静默失败、用例间数据串场
  const inst = (ConfigStore as any)._instance;
  try {
    inst?.db?.close();
  } catch {
    /* ignore */
  }
  // 重置 ConfigStore 单例
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
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    ).run(uid, 'div_user_101', 'dummy');
    db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', '2026-10-01', '09:30:00', 100, 10.0, 0, 'test', 0)`,
    ).run(uid, 'sh600000');

    const holding = getHoldingBeforeDate(db, uid, 'sh600000', '2026-10-30');
    expect(holding).toBe(100);
  });

  it('buy + reduce 类型 → reduce 负向计入持仓', () => {
    const db = ConfigStore.getInstance().db;
    const uid = 102;
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    ).run(uid, 'div_user_102', 'dummy');
    db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', '2026-10-01', '09:30:00', 200, 10.0, 0, 'b', 0)`,
    ).run(uid, 'sh600000');
    db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'reduce', '2026-10-10', '09:30:00', 50, 12.0, 0, 'r', 0)`,
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

/**
 * 防重复计账（owner 口径：手动优先）
 *
 * 背景：手动补录行 broker_code 非空、自动行 broker_code 为空；两条部分唯一索引
 * A（broker_code IS NULL）/ C（broker_code IS NOT NULL）的 WHERE 互斥 ⇒ 同一事件
 * 可各落一行。故在自动插入前按 (user, asset_code, trade_type, trade_date) 预检活记录。
 */
describe('exDividendSync — 手动优先防重预检', () => {
  const uid = 201;
  const asset = 'sh600001';

  afterEach(async () => {
    vi.restoreAllMocks();
    cleanup();
  });

  /** 建用户 + 除权日前的 200 股底仓（保证 holding > 0） */
  function seedHolding(userId = uid, code = asset): void {
    const db = ConfigStore.getInstance().db;
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    ).run(userId, `div_user_${userId}`, 'dummy');
    db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', '2026-10-01', '09:30:00', 200, 10.0, 0, 'test', 0)`,
    ).run(userId, code);
  }

  /** 插入一条人工补录行（broker_code 非空，模拟 confirm 产物；source 置 NULL 以避开事实表外键） */
  function seedManual(
    type: 'dividend' | 'bonus',
    opts: { date?: string; time?: string; qty?: number; price?: number; deleted?: boolean } = {},
  ): void {
    const db = ConfigStore.getInstance().db;
    db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
        trade_reason, is_auto_import, is_deleted, broker_code, broker_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '券商补录', 1, ?, '华宝证券', 0)`,
    ).run(
      uid,
      asset,
      type,
      opts.date ?? '2026-10-30',
      opts.time ?? '00:00:00',
      opts.qty ?? 200,
      opts.price ?? 0.5,
      opts.deleted ? 1 : 0,
    );
  }

  async function mockEvents(rows: Array<{ symbol: string; c1: number; c3: number }>): Promise<void> {
    const mockMod = await import('../../src/db/duckdb.js');
    vi.spyOn(mockMod, 'queryDuckDB').mockResolvedValue(rows);
  }

  const countRows = (type: 'dividend' | 'bonus', includeDeleted = false): number =>
    (
      ConfigStore.getInstance()
        .db.prepare(
          `SELECT COUNT(*) n FROM user_trade_record
            WHERE user_id = ? AND asset_code = ? AND trade_type = ? ${includeDeleted ? '' : 'AND is_deleted = 0'}`,
        )
        .get(uid, asset, type) as { n: number }
    ).n;

  it('已有人工 dividend 行 → 自动跳过，不新增行', async () => {
    seedHolding();
    seedManual('dividend');
    await mockEvents([{ symbol: asset, c1: 5, c3: 0 }]); // c1/10 = 0.5 元/股

    const result = await importDividendEvents('2026-10-30');

    expect(result.eventsProcessed).toBe(1);
    expect(result.importedDividend).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
    expect(countRows('dividend')).toBe(1);

    // 系统日志需体现「跳过」量
    const log = ConfigStore.getInstance()
      .db.prepare(
        `SELECT message, detail FROM system_log WHERE log_type = 'dividend_import' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { message: string; detail: string };
    expect(log.message).toContain('跳过 1 条已存在');
    expect(JSON.parse(log.detail).duplicatesSkipped).toBe(1);
  });

  it('无人工行 → 正常插入 dividend 与 bonus', async () => {
    seedHolding();
    await mockEvents([{ symbol: asset, c1: 5, c3: 2 }]); // 0.5 元/股 + 0.2 送转

    const result = await importDividendEvents('2026-10-30');

    expect(result.importedDividend).toBe(1);
    expect(result.importedBonus).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(countRows('dividend')).toBe(1);
    expect(countRows('bonus')).toBe(1);
  });

  it('不同 trade_type 不互相干扰：已有 bonus → dividend 仍可插入', async () => {
    seedHolding();
    seedManual('bonus', { qty: 40, price: 0 });
    await mockEvents([{ symbol: asset, c1: 5, c3: 2 }]);

    const result = await importDividendEvents('2026-10-30');

    expect(result.importedDividend).toBe(1);
    expect(result.importedBonus).toBe(0);
    expect(result.duplicatesSkipped).toBe(1); // 只有 bonus 被跳过
    expect(countRows('dividend')).toBe(1);
    expect(countRows('bonus')).toBe(1);
  });

  it('同日两笔合法记录不受影响：预检只拦插入，不合并/不改既有行', async () => {
    seedHolding();
    seedManual('dividend', { time: '09:30:00' });
    seedManual('dividend', { time: '10:00:00' });
    await mockEvents([{ symbol: asset, c1: 5, c3: 0 }]);

    const result = await importDividendEvents('2026-10-30');

    expect(result.importedDividend).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
    // 既有两笔保持原样（判据是「存在任一活记录即不新增」，从不 merge/delete）
    expect(countRows('dividend')).toBe(2);
    const times = ConfigStore.getInstance()
      .db.prepare(
        `SELECT trade_time FROM user_trade_record WHERE user_id = ? AND asset_code = ? AND trade_type = 'dividend' ORDER BY trade_time`,
      )
      .all(uid, asset) as Array<{ trade_time: string }>;
    expect(times.map((t) => t.trade_time)).toEqual(['09:30:00', '10:00:00']);
  });

  it('幂等：同一天连跑两次不产生新行', async () => {
    seedHolding();
    await mockEvents([{ symbol: asset, c1: 5, c3: 0 }]);

    const first = await importDividendEvents('2026-10-30');
    const second = await importDividendEvents('2026-10-30');

    expect(first.importedDividend).toBe(1);
    expect(second.importedDividend).toBe(0);
    expect(second.duplicatesSkipped).toBe(1);
    expect(countRows('dividend')).toBe(1);
  });

  it('已软删除的同键行不算「活记录」→ 自动仍插入', async () => {
    seedHolding();
    seedManual('dividend', { deleted: true });
    await mockEvents([{ symbol: asset, c1: 5, c3: 0 }]);

    const result = await importDividendEvents('2026-10-30');

    expect(result.importedDividend).toBe(1);
    expect(countRows('dividend')).toBe(1); // 活行只有新插入的 1 条
    expect(countRows('dividend', true)).toBe(2); // 加上软删除的 1 条
  });
});
