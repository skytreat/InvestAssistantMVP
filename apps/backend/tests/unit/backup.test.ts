/**
 * backup.test.ts — 单元测试 src/services/backup.ts
 *
 * 覆盖：
 *   1. _deleteOldBackups：超过 RETENTION_DAYS 的文件被删除，过期阈值边界
 *   2. backupSQLite 成功路径：返回 { success: true, size } 且 writeSystemLog 调 INFO
 *   3. backupSQLite 失败降级：db.backup 抛错 → 返回 { success: false, error } 且 writeSystemLog 调 ERROR
 *
 * 关键：backup.ts 顶层有 `const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve('data', 'backup')`
 *       必须在 backup.ts 被 evaluate 之前设好 env，因此用动态 import + top-level await 保证时序。
 *       ConfigStore 构造是惰性的，静态 import 没问题。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// === 必须在 backup.ts 被加载前设好 env ===
const TEST_BACKUP_DIR = path.resolve('data', 'backup-test');
const TEST_DB = path.resolve('data', 'backup-test.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const ORIGINAL_BACKUP_DIR = process.env.BACKUP_DIR;

process.env.SQLITE_DB_PATH = TEST_DB;
process.env.BACKUP_DIR = TEST_BACKUP_DIR;

// 静态 import ConfigStore —— 构造惰性，getInstance 首次调用才 new，此时 env 已设好
import { ConfigStore } from '../../src/config/configStore.js';

// 静态 import logger 命名空间，用于 spyOn writeSystemLog
import * as loggerNs from '../../src/services/logger.js';

// 动态 import backup.js —— 此时 env 已设，backup.ts 内 BACKUP_DIR 会正确读到 TEST_BACKUP_DIR
const backupMod = await import('../../src/services/backup.js');
const { backupSQLite, _deleteOldBackups } = backupMod;

// ================================================================

/** 清理测试 db 及其 WAL / SHM 附属文件 */
function cleanupTestDb(): void {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const p = TEST_DB + ext;
    try { fs.unlinkSync(p); } catch { /* 文件被占用或不存在，忽略 */ }
  }
}

/** 清空备份临时目录 */
function cleanupBackupDir(): void {
  if (!fs.existsSync(TEST_BACKUP_DIR)) return;
  for (const name of fs.readdirSync(TEST_BACKUP_DIR)) {
    try { fs.unlinkSync(path.join(TEST_BACKUP_DIR, name)); } catch { /* 忽略 */ }
  }
}

describe('backup — _deleteOldBackups & backupSQLite', () => {
  beforeAll(() => {
    // 确保 data 目录存在
    const dir = path.dirname(TEST_DB);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 清干净（防止上一次跑的残留）
    cleanupTestDb();
    cleanupBackupDir();
    if (!fs.existsSync(TEST_BACKUP_DIR)) {
      fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
    }

    // 触发 ConfigStore 初始化（首次 getInstance 会读 SQLITE_DB_PATH，创建 .db 文件 + DDL）
    ConfigStore.getInstance();
  });

  afterAll(() => {
    // 关闭 db 连接（Windows 上打开的文件无法 unlink）
    try {
      const store = ConfigStore.getInstance();
      (store.db as any).close();
    } catch { /* 忽略 */ }

    cleanupTestDb();
    cleanupBackupDir();
    try { fs.rmdirSync(TEST_BACKUP_DIR); } catch { /* 非空或不存在，忽略 */ }

    // 还原环境变量
    if (ORIGINAL_SQLITE_DB_PATH !== undefined) {
      process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
    } else {
      delete process.env.SQLITE_DB_PATH;
    }
    if (ORIGINAL_BACKUP_DIR !== undefined) {
      process.env.BACKUP_DIR = ORIGINAL_BACKUP_DIR;
    } else {
      delete process.env.BACKUP_DIR;
    }

    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------
  // 1. _deleteOldBackups 单元测试
  // ---------------------------------------------------------
  describe('_deleteOldBackups — 过期文件清理', () => {
    it('3 个文件（2 天前 / 4 天前 / 今天）→ 只删 4 天前的 → deleted=1', () => {
      // 先清目录
      cleanupBackupDir();

      const now = Date.now();
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
      const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000);
      const today = new Date(now);

      const file2 = path.join(TEST_BACKUP_DIR, 'backup.2days.db');
      const file4 = path.join(TEST_BACKUP_DIR, 'backup.4days.db');
      const file0 = path.join(TEST_BACKUP_DIR, 'backup.today.db');

      fs.writeFileSync(file2, '2days');
      fs.writeFileSync(file4, '4days');
      fs.writeFileSync(file0, 'today');

      fs.utimesSync(file2, twoDaysAgo, twoDaysAgo);
      fs.utimesSync(file4, fourDaysAgo, fourDaysAgo);
      fs.utimesSync(file0, today, today);

      const deleted = _deleteOldBackups();

      expect(deleted).toBe(1);

      // 4 天前的被删除
      expect(fs.existsSync(file4)).toBe(false);
      // 2 天前的保留（RETENTION_DAYS=3，2 < 3）
      expect(fs.existsSync(file2)).toBe(true);
      // 今天的保留
      expect(fs.existsSync(file0)).toBe(true);
    });

    it('目录为空 → deleted=0', () => {
      cleanupBackupDir();
      const deleted = _deleteOldBackups();
      expect(deleted).toBe(0);
    });

    it('目录中全是过期文件 → 全部删除', () => {
      cleanupBackupDir();
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);

      for (let i = 0; i < 3; i++) {
        const full = path.join(TEST_BACKUP_DIR, `old.${i}.db`);
        fs.writeFileSync(full, 'old');
        fs.utimesSync(full, tenDaysAgo, tenDaysAgo);
      }

      const deleted = _deleteOldBackups();
      expect(deleted).toBe(3);
      expect(fs.readdirSync(TEST_BACKUP_DIR).length).toBe(0);
    });
  });

  // ---------------------------------------------------------
  // 2. backupSQLite 成功路径
  // ---------------------------------------------------------
  describe('backupSQLite — 成功路径', () => {
    it('正常备份 → 返回 { success: true, size: number } 且 writeSystemLog 调 INFO', async () => {
      cleanupBackupDir();
      vi.restoreAllMocks();

      const logSpy = vi.spyOn(loggerNs, 'writeSystemLog');
      const result = await backupSQLite();

      expect(result.success).toBe(true);
      expect(typeof result.size).toBe('number');
      expect(result.size!).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();

      // writeSystemLog 应被调一次，level=INFO，logType=backup
      expect(logSpy).toHaveBeenCalled();
      const callArgs = logSpy.mock.calls.map((c) => c[0]);
      const backupInfoCalls = callArgs.filter(
        (arg) => arg?.logType === 'backup' && arg?.level === 'INFO',
      );
      expect(backupInfoCalls.length).toBeGreaterThanOrEqual(1);

      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------
  // 3. backupSQLite 失败降级（catch 分支）
  // ---------------------------------------------------------
  describe('backupSQLite — 失败降级', () => {
    it('db.backup 抛 Error("disk full") → 返回 { success: false, error: "disk full" }', async () => {
      vi.restoreAllMocks();

      // mock db.backup 抛错（db.backup 在 better-sqlite3 v13 起是 async，这里用 async throw 模拟）
      const db = ConfigStore.getInstance().db;
      vi.spyOn(db, 'backup').mockImplementation(async () => {
        throw new Error('disk full');
      });

      const logSpy = vi.spyOn(loggerNs, 'writeSystemLog');

      const result = await backupSQLite();

      expect(result.success).toBe(false);
      expect(result.error).toContain('disk full');
      expect(result.size).toBeUndefined();

      // writeSystemLog 应被调一次，level=ERROR，logType=backup
      expect(logSpy).toHaveBeenCalled();
      const callArgs = logSpy.mock.calls.map((c) => c[0]);
      const backupErrorCalls = callArgs.filter(
        (arg) => arg?.logType === 'backup' && arg?.level === 'ERROR',
      );
      expect(backupErrorCalls.length).toBeGreaterThanOrEqual(1);
      expect(backupErrorCalls[0]?.message).toContain('备份失败');

      vi.restoreAllMocks();
    });

    it('db.backup 抛非 Error 对象也能返回降级结果', async () => {
      vi.restoreAllMocks();

      const db = ConfigStore.getInstance().db;
      vi.spyOn(db, 'backup').mockImplementation(async () => {
        throw { code: 'EACCES', msg: 'permission denied' };
      });

      const logSpy = vi.spyOn(loggerNs, 'writeSystemLog');

      const result = await backupSQLite();

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');  // String(err) 对任何类型都安全
      expect(result.size).toBeUndefined();

      // 确保 ERROR 日志也被写了
      const callArgs = logSpy.mock.calls.map((c) => c[0]);
      const backupErrorCalls = callArgs.filter(
        (arg) => arg?.logType === 'backup' && arg?.level === 'ERROR',
      );
      expect(backupErrorCalls.length).toBeGreaterThanOrEqual(1);

      vi.restoreAllMocks();
    });
  });
});
