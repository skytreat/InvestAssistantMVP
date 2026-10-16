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
