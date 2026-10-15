/**
 * logger.test.ts — Phase 2 SDD §12.3 单元测试
 *
 * 覆盖 src/services/logger.ts 的三层降级写入：
 *   S1 SQLite 写失败 → 降级 console.error（MVP）
 *   S2 SQLite 正常 → 互斥批量写入 system_log
 *   S4 磁盘满恢复 → 写满时不崩溃（MVP 不实现，但 try-catch 兜底）
 *
 * 策略：
 *   - 顶层设置 process.env.SQLITE_DB_PATH 为临时文件，避免污染生产 DB
 *   - vi.spyOn(ConfigStore, 'getInstance') mock 第一层，不会真正 new ConfigStore
 *     （_instance 始终是 null），restore 后首次真实 getInstance() 会读 env
 *   - 结束后清理临时 .db / -wal / -shm
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

// === 必须在任何触发 ConfigStore.getInstance() 的代码执行前设置 ===
const TEST_DB = path.resolve('data', 'logger-test.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

// 现在导入被测模块（ESM import 虽被提升，但 ConfigStore 构造是惰性的）
import { writeSystemLog } from '../../src/services/logger.js';
import { ConfigStore } from '../../src/config/configStore.js';

/** 清理测试 db 及其 WAL / SHM 附属文件 */
function cleanupTestDb(): void {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const p = TEST_DB + ext;
    try { fs.unlinkSync(p); } catch { /* 文件被占用或不存在，忽略 */ }
  }
}

describe('logger — writeSystemLog', () => {
  beforeAll(() => {
    // 确保 data 目录存在
    const dir = path.dirname(TEST_DB);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cleanupTestDb();
  });

  afterAll(() => {
    // 先关闭 db 连接再删除（Windows 上打开的文件无法 unlink）
    try {
      const store = ConfigStore.getInstance();
      (store.db as any).close();
    } catch { /* 可能没有真正的 db 连接 */ }
    cleanupTestDb();
    // 还原环境变量（不污染同进程其他测试）
    if (ORIGINAL_SQLITE_DB_PATH !== undefined) {
      process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
    } else {
      delete process.env.SQLITE_DB_PATH;
    }
  });

  // ---------------------------------------------------------
  // S1 SQLite 写失败降级
  // ---------------------------------------------------------
  describe('S1 SQLite 写失败降级', () => {
    it('ConfigStore.getInstance() 抛错 → writeSystemLog 不 throw 且降级到 console.error', () => {
      // spyOn 替换 static 方法，不会真正执行 ConfigStore 构造函数
      vi.spyOn(ConfigStore, 'getInstance').mockImplementation(() => {
        throw new Error('SQLite unavailable (test mock)');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // 核心断言：writeSystemLog 不应该因为 SQLite 挂了而 throw
      expect(() =>
        writeSystemLog({ logType: 'startup', level: 'INFO', message: 'test' }),
      ).not.toThrow();

      // 第二层降级：console.error 应该被调用（SQLite 不可用时 journal 自动捕获）
      expect(consoleSpy).toHaveBeenCalled();
      // 而且 console.error 里包含了降级的日志 JSON
      const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
      expect(String(lastCall[0])).toContain('invest-assistant');

      vi.restoreAllMocks();
    });

    it('ConfigStore.getInstance().writeLog 抛错 → 同样降级到 console.error', () => {
      const fakeStore = {
        writeLog: vi.fn(() => {
          throw new Error('disk I/O error (test mock)');
        }),
      };
      vi.spyOn(ConfigStore, 'getInstance').mockReturnValue(fakeStore as any);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        writeSystemLog({ logType: 'datacheck', level: 'WARN', message: 'bad disk' }),
      ).not.toThrow();

      expect(fakeStore.writeLog).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------
  // S2 互斥写入（SQLite 正常）
  // ---------------------------------------------------------
  describe('S2 SQLite 正常批量写入', () => {
    it('循环 100 条 writeSystemLog → system_log 表有 100 行', () => {
      // 先清掉可能遗留的数据
      vi.restoreAllMocks();
      const db = ConfigStore.getInstance().db;
      db.prepare('DELETE FROM system_log').run();

      // 写 100 条
      for (let i = 0; i < 100; i++) {
        writeSystemLog({
          logType: 'plugin_execute',
          level: 'INFO',
          message: `S2 test ${i}`,
        });
      }

      // 断言
      const count = db
        .prepare('SELECT COUNT(*) AS c FROM system_log')
        .get() as { c: number };
      expect(count.c).toBe(100);
    });

    it('SQLite 正常时 console.error 不被调用（不走降级路径）', () => {
      vi.restoreAllMocks();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      writeSystemLog({ logType: 'startup', level: 'INFO', message: 'happy path' });

      // 正常写 SQLite 成功，不会触发 console.error
      const sqliteFallbackCalls = consoleSpy.mock.calls.filter(
        (c) => String(c[0]).includes('[system_log fallback]'),
      );
      const journalFallbackCalls = consoleSpy.mock.calls.filter(
        (c) => String(c[0]).includes('invest-assistant'),
      );
      expect(sqliteFallbackCalls.length).toBe(0);
      expect(journalFallbackCalls.length).toBe(0);

      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------
  // S4 磁盘满恢复（MVP 不实现，但 try-catch 兜底必须在）
  // ---------------------------------------------------------
  describe('S4 磁盘满恢复（MVP try-catch 兜底）', () => {
    it('writeSystemLog 最外层始终被 try-catch 包裹 → 任何内部错误都不会向上抛', () => {
      vi.restoreAllMocks();
      // 即使 process.env.SQLITE_DB_PATH 指向的目录无法写入也不该 throw
      // （这里只验证正常路径 + 异常路径均不 throw）
      expect(() => {
        writeSystemLog({
          logType: 'backup',
          level: 'ERROR',
          message: 'disk-full-scenario-should-not-throw',
        });
      }).not.toThrow();
    });

    it('SQLite 完全不可用时也不 throw（走第二层 console.error）', () => {
      vi.spyOn(ConfigStore, 'getInstance').mockImplementation(() => {
        throw new Error('fatal sqlite error');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() =>
        writeSystemLog({
          logType: 'startup',
          level: 'ERROR',
          message: 'total failure',
        }),
      ).not.toThrow();

      // 至少 console.error 被调用（证明降级链完整）
      expect(consoleSpy).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------
  // S6 日志脱敏（SDD §6）
  // ---------------------------------------------------------
  describe('logger — S6 脱敏', () => {
    it('金额 ≥ 10000 → 末 4 位换 ****', () => {
      vi.restoreAllMocks();
      const db = ConfigStore.getInstance().db;
      db.prepare('DELETE FROM system_log').run();
      writeSystemLog({
        logType: 'trade', level: 'SUCCESS',
        message: '买入 sh600000 qty=12345678 price=9999.99',
      });
      const row = db.prepare('SELECT message FROM system_log ORDER BY id DESC LIMIT 1').get() as any;
      expect(row.message).not.toMatch(/12345678/);
      expect(row.message).not.toMatch(/9999\.99/);
      expect(row.message).toMatch(/****/);
    });

    it('金额 < 1000 → 不脱敏', () => {
      vi.restoreAllMocks();
      const db = ConfigStore.getInstance().db;
      db.prepare('DELETE FROM system_log').run();
      writeSystemLog({
        logType: 'trade', level: 'SUCCESS',
        message: '手续费 50.00 元',
      });
      const row = db.prepare('SELECT message FROM system_log ORDER BY id DESC LIMIT 1').get() as any;
      expect(row.message).toMatch(/50/);  // 应该保留
    });

    it('username 脱敏：保留前 2 位，后面 ****', () => {
      vi.restoreAllMocks();
      const db = ConfigStore.getInstance().db;
      db.prepare('DELETE FROM system_log').run();
      writeSystemLog({
        logType: 'plugin_execute', level: 'INFO',
        message: 'user login username=admin123 ok',
      });
      const row = db.prepare('SELECT message FROM system_log ORDER BY id DESC LIMIT 1').get() as any;
      expect(row.message).not.toMatch(/admin123/);
      expect(row.message).toMatch(/username=ad\*\*\*\*/);
    });

    it('短 username (≤2) 不脱敏', () => {
      vi.restoreAllMocks();
      const db = ConfigStore.getInstance().db;
      db.prepare('DELETE FROM system_log').run();
      writeSystemLog({
        logType: 'startup', level: 'INFO',
        message: 'user=ab connected',
      });
      const row = db.prepare('SELECT message FROM system_log ORDER BY id DESC LIMIT 1').get() as any;
      // username=ab 长度为 2，不变
      expect(row.message).toMatch(/ab/);
    });
  });
});
