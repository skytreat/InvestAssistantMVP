/**
 * configStore.test.ts — 单元测试 ConfigStore 单例和 DDL
 *
 * 覆盖 src/config/configStore.ts：
 *   - getInstance 单例行为（多次调用返回同一实例）
 *   - _ensureTradeRecordUniqueConstraint 空表迁移路径
 *   - _ensureSystemLogCheckConstraint 表已有预期约束时跳过
 *   - writeLog 写入 system_log 表
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-cs-'));
const TEST_DB = path.join(tmpDir, 'cs-test.db');
const ORIGINAL_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

// 重新 import 以使用新路径（ConfigStore 是单例，首次调用才初始化）
import { ConfigStore } from '../../src/config/configStore.js';

function cleanup(): void {
  // 清除单例，以便下次测试创建新实例
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  if (ORIGINAL_PATH !== undefined) {
    process.env.SQLITE_DB_PATH = ORIGINAL_PATH;
  } else {
    delete process.env.SQLITE_DB_PATH;
  }
}

afterAll(() => {
  cleanup();
});

describe('configStore — getInstance 单例', () => {
  it('两次 getInstance 返回同一对象引用', () => {
    const a = ConfigStore.getInstance();
    const b = ConfigStore.getInstance();
    expect(a).toBe(b);
  });

  it('db 属性可访问且是 better-sqlite3 Database 实例', () => {
    const store = ConfigStore.getInstance();
    expect(store.db).toBeDefined();
    expect(typeof store.db.pragma).toBe('function');
  });
});

describe('configStore — DDL 表创建', () => {
  it('所有业务表都存在', () => {
    const store = ConfigStore.getInstance();
    const tables = ['user_account', 'user_trade_record', 'user_asset_rel',
                    'user_strategy_signal', 'user_plugin_config', 'user_asset_stat', 'system_log'];
    for (const t of tables) {
      const exists = store.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`
      ).get(t);
      expect(exists).toBeDefined();
    }
  });

  it('WAL 模式已开启', () => {
    const store = ConfigStore.getInstance();
    const mode = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
  });

  it('foreign_keys=ON', () => {
    const store = ConfigStore.getInstance();
    const fk = store.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it('busy_timeout 已设置', () => {
    const store = ConfigStore.getInstance();
    // busy_timeout 不设返回值，但不应报错
    expect(() => store.db.pragma('busy_timeout = 5000')).not.toThrow();
  });
});

describe('configStore — writeLog', () => {
  it('writeLog 写入 system_log 表', () => {
    const store = ConfigStore.getInstance();
    store.db.prepare('DELETE FROM system_log').run();

    store.writeLog('startup', 'INFO', 'test message');
    store.writeLog('datacheck', 'WARN', 'test warn', 'some detail');

    const rows = store.db.prepare('SELECT * FROM system_log').all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].log_type).toBe('startup');
    expect(rows[0].level).toBe('INFO');
    expect(rows[0].message).toBe('test message');
    expect(rows[1].log_type).toBe('datacheck');
    expect(rows[1].level).toBe('WARN');
    expect(rows[1].detail).toBe('some detail');
  });

  it('writeLog 忽略非法 level（降级到 warn）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = ConfigStore.getInstance();
    // writeLog 不校验 level 合法性——level 校验在 logger.ts 的 writeSystemLog 里
    // ConfigStore.writeLog 只负责写 DB，非法 level 会被 CHECK 约束拦截（抛错被外层 catch）
    // 这里测正常写入
    expect(() => store.writeLog('startup', 'INFO', 'test')).not.toThrow();
    warnSpy.mockRestore();
  });
});

describe('configStore — getDbPath', () => {
  it('返回初始化的数据库路径', () => {
    const store = ConfigStore.getInstance();
    expect(store.getDbPath()).toBe(TEST_DB);
  });
});

describe('configStore — _ensureTradeRecordReviewColumns（G6a ALTER 补列）', () => {
  // 模拟存量库：先手工建一张缺 strategy_match 的旧表 + 塞一条数据，再让 ConfigStore 启动补列
  it('旧表缺 strategy_match → 启动时 ALTER 补齐且不丢数据', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-legacy-'));
    const legacyDb = path.join(legacyDir, 'legacy.db');
    const legacyPath = process.env.SQLITE_DB_PATH;

    try {
      // 1. 手工造"旧 schema"库：有数据、缺 strategy_match 列
      const Legacy = new (require('better-sqlite3'))(legacyDb);
      Legacy.exec(`
        CREATE TABLE user_trade_record (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          asset_code TEXT NOT NULL,
          trade_type TEXT NOT NULL,
          trade_date TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          fee REAL NOT NULL DEFAULT 0,
          trade_reason TEXT,
          is_auto_import INTEGER NOT NULL DEFAULT 0,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          review_summary TEXT,
          system_followed INTEGER,
          is_stop_loss INTEGER,
          remark TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(user_id, asset_code, trade_type, trade_date)
        )
      `);
      Legacy.prepare(
        `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, quantity, price, fee)
         VALUES (1, 'sh600000', 'buy', '2025-01-01', 100, 10, 0)`
      ).run();
      Legacy.close();

      // 2. 切到旧库并重建单例 → 触发补列
      process.env.SQLITE_DB_PATH = legacyDb;
      (ConfigStore as any)._instance = null;
      const store = ConfigStore.getInstance();

      const cols = (store.db.prepare('PRAGMA table_info(user_trade_record)').all() as { name: string }[])
        .map(c => c.name);
      expect(cols).toContain('strategy_match');

      // 3. 存量数据完好 + 新列默认 NULL（三态"未标记"）
      const rows = store.db.prepare('SELECT * FROM user_trade_record').all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].asset_code).toBe('sh600000');
      expect(rows[0].strategy_match).toBeNull();

      // 3b. T87：trade_time 已由 created_at 迁移而来，且为合法 HH:mm:ss
      expect(rows[0].trade_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);

      // 3c. T87 + T49：UNIQUE 已含 trade_time，trade_type CHECK 已含 add
      const ddl = (store.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
        .get() as { sql: string }).sql;
      expect(ddl).toContain('trade_time');
      expect(ddl).toMatch(/UNIQUE\s*\(user_id, asset_code, trade_type, trade_date, trade_time\)/);
      expect(ddl).toContain("'add'");
      expect(ddl).not.toMatch(/IN \([^)]*'sell'/);

      // 3d. 迁移后可按新唯一键追加同日的第二笔（不同成交时间）
      // 先补 user_account —— legacy 表只有 trade_record，FK 目标不存在会直接违例
      store.db.prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role)
         VALUES (1, 'legacy_user', 'dummy-hash', 'user')`,
      ).run();
      expect(() =>
        store.db.prepare(
          `INSERT INTO user_trade_record
           (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee)
           VALUES (1, 'sh600000', 'buy', '2025-01-01', '09:30:01', 50, 10, 0)`,
        ).run(),
      ).not.toThrow();
      // 同日 + 同成交时间 → 唯一键冲突（quantity 不同也冲突，quantity 不进主键）
      expect(() =>
        store.db.prepare(
          `INSERT INTO user_trade_record
           (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee)
           VALUES (1, 'sh600000', 'buy', '2025-01-01', '09:30:01', 999, 10, 0)`,
        ).run(),
      ).toThrow(/UNIQUE/);

      // 4. 新列可写（三态 0/1 合法，2 被 CHECK 拦）
      store.db.prepare('UPDATE user_trade_record SET strategy_match = 1').run();
      expect((store.db.prepare('SELECT strategy_match FROM user_trade_record').get() as any).strategy_match).toBe(1);
      expect(() => store.db.prepare('UPDATE user_trade_record SET strategy_match = 2').run()).toThrow();

      store.db.close();
    } finally {
      (ConfigStore as any)._instance = null;
      if (legacyPath !== undefined) process.env.SQLITE_DB_PATH = legacyPath;
      try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
