/**
 * backup.test.ts — 单元测试 src/services/backup.ts
 *
 * 覆盖：
 *   1. _deleteOldBackups：超过 RETENTION_DAYS 的文件被删除，过期阈值边界
 *   2. backupSQLite 成功路径：返回 { success: true, size } 且 writeSystemLog 调 INFO
 *   3. backupSQLite 失败降级：db.backup 抛错 → 返回 { success: false, error } 且 writeSystemLog 调 ERROR
 *   4. **backup_restore_duckdb**（SDD §12.5 F11）：真跑 DuckDB 备份 → 恢复 → COUNT(*) 一致
 *
 * 关键：backup.ts 顶层有 `const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve('data', 'backup')`
 *       必须在 backup.ts 被 evaluate 之前设好 env，因此用动态 import + top-level await 保证时序。
 *       ConfigStore 构造是惰性的，静态 import 没问题。
 *
 * ⚠️ **隔离铁律**：本文件的 SQLite 库、备份目录、DuckDB 文件**全部在 mkdtemp 临时目录**里，
 *    绝不读写 `data/quotes.duckdb`（1.2GB 真实行情库）与 `data/business.db`。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';

// === 必须在 backup.ts 被加载前设好 env ===
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-backup-'));
const TEST_BACKUP_DIR = path.join(TMP_DIR, 'backup');
const TEST_DB = path.join(TMP_DIR, 'backup-test.db');
/** F11 用：临时 DuckDB（被备份对象）—— 绝不碰 data/quotes.duckdb */
const TEST_DUCKDB = path.join(TMP_DIR, 'quotes-test.duckdb');
/** F11 用：GZIP 导出专用源库（backupDuckDB 内部不关 instance，会锁住 TEST_DUCKDB） */
const TEST_DUCKDB_GZIP = path.join(TMP_DIR, 'quotes-gzip-source.duckdb');
/** F11 用：恢复目标 DuckDB */
const RESTORE_DUCKDB = path.join(TMP_DIR, 'quotes-restored.duckdb');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const ORIGINAL_BACKUP_DIR = process.env.BACKUP_DIR;
const ORIGINAL_DUCKDB_PATH = process.env.DUCKDB_PATH;

process.env.SQLITE_DB_PATH = TEST_DB;
process.env.BACKUP_DIR = TEST_BACKUP_DIR;
process.env.DUCKDB_PATH = TEST_DUCKDB;

// 静态 import ConfigStore —— 构造惰性，getInstance 首次调用才 new，此时 env 已设好
import { ConfigStore } from '../../src/config/configStore.js';

// 静态 import logger 命名空间，用于 spyOn writeSystemLog
import * as loggerNs from '../../src/services/logger.js';

// 动态 import backup.js —— 此时 env 已设，backup.ts 内 BACKUP_DIR 会正确读到 TEST_BACKUP_DIR
const backupMod = await import('../../src/services/backup.js');
const { backupSQLite, backupDuckDB, _deleteOldBackups } = backupMod;

// ================================================================

/** 清理测试 db 及其 WAL / SHM 附属文件 */
function cleanupTestDb(): void {
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const p = TEST_DB + ext;
    try {
      fs.unlinkSync(p);
    } catch {
      /* 文件被占用或不存在，忽略 */
    }
  }
}

/** 清空备份临时目录 */
function cleanupBackupDir(): void {
  if (!fs.existsSync(TEST_BACKUP_DIR)) return;
  for (const name of fs.readdirSync(TEST_BACKUP_DIR)) {
    try {
      fs.unlinkSync(path.join(TEST_BACKUP_DIR, name));
    } catch {
      /* 忽略 */
    }
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
    // ⚠️ 先 resetInstance：vitest 开了 sequence.shuffle，文件内两个 describe 的执行顺序不固定，
    //    另一个 describe 的 afterAll 可能已经把连接 close 掉了 —— 不重开会报
    //    "The database connection is not open"。
    ConfigStore.resetInstance();
    ConfigStore.getInstance();
  });

  afterAll(() => {
    // 关闭 db 连接（Windows 上打开的文件无法 unlink）
    try {
      const store = ConfigStore.getInstance();
      (store.db as any).close();
    } catch {
      /* 忽略 */
    }

    cleanupTestDb();
    cleanupBackupDir();
    try {
      fs.rmdirSync(TEST_BACKUP_DIR);
    } catch {
      /* 非空或不存在，忽略 */
    }

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
    if (ORIGINAL_DUCKDB_PATH !== undefined) {
      process.env.DUCKDB_PATH = ORIGINAL_DUCKDB_PATH;
    } else {
      delete process.env.DUCKDB_PATH;
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
      const backupInfoCalls = callArgs.filter((arg) => arg?.logType === 'backup' && arg?.level === 'INFO');
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
      const backupErrorCalls = callArgs.filter((arg) => arg?.logType === 'backup' && arg?.level === 'ERROR');
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
      expect(typeof result.error).toBe('string'); // String(err) 对任何类型都安全
      expect(result.size).toBeUndefined();

      // 确保 ERROR 日志也被写了
      const callArgs = logSpy.mock.calls.map((c) => c[0]);
      const backupErrorCalls = callArgs.filter((arg) => arg?.logType === 'backup' && arg?.level === 'ERROR');
      expect(backupErrorCalls.length).toBeGreaterThanOrEqual(1);

      vi.restoreAllMocks();
    });
  });
});

// ================================================================
// F11 · backup_restore_duckdb（SDD §12.5 验收项 F11）
//
// 通过标准：「`COPY TO PARQUET GZIP` → `COPY FROM` 恢复 → COUNT(*) 一致」
//
// ⚠️ 隔离铁律：
//   - 被备份对象是**临时目录里新建的一次性 DuckDB**（含 raw_daily 表 + v_stock_qfq 视图），
//     绝不读写 `data/quotes.duckdb`（1.2GB 真实行情库）；
//   - 备份产物写到临时 BACKUP_DIR，不落仓库；
//   - 恢复目标是另一个临时 DuckDB 文件。
//   - 本用例**真跑** COPY TO / COPY FROM / COUNT(*)，不做 mock。
// ================================================================

const DUCKDB_DDL = `CREATE TABLE raw_daily (
    symbol VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE,
    close DOUBLE, volume BIGINT, amount DOUBLE)`;

const DUCKDB_ROWS: Array<{ symbol: string; date: string; close: number }> = [
  { symbol: 'sh600001', date: '2026-10-12', close: 10.5 },
  { symbol: 'sh600002', date: '2026-10-12', close: 20.25 },
  { symbol: 'sh600003', date: '2026-10-12', close: 30.75 },
  { symbol: 'sh600001', date: '2026-10-09', close: 10.1 },
  { symbol: 'sh600002', date: '2026-10-09', close: 19.8 },
  { symbol: 'sh600003', date: '2026-10-09', close: 30.2 },
];

/** 造临时 DuckDB（表 + v_stock_qfq 视图）并写入 6 行，返回行数 */
async function createTempDuckDB(file: string): Promise<number> {
  const inst = await DuckDBInstance.create(file);
  const conn = await inst.connect();
  try {
    await conn.runAndReadAll(DUCKDB_DDL);
    await conn.runAndReadAll(`CREATE VIEW v_stock_qfq AS SELECT * FROM raw_daily`);
    for (const r of DUCKDB_ROWS) {
      await conn.runAndReadAll(
        `INSERT INTO raw_daily VALUES ('${r.symbol}', DATE '${r.date}', ` +
          `${r.close}, ${r.close * 1.01}, ${r.close * 0.99}, ${r.close}, 1000000, ${r.close * 1000000})`,
      );
    }
    const res = await conn.runAndReadAll('SELECT COUNT(*) AS c FROM v_stock_qfq');
    return Number(res.getRows()[0][0]);
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

/** 从 parquet 恢复到目标 DuckDB（`COPY ... FROM`），返回恢复后的行数 */
async function restoreFromParquet(parquetPath: string, targetFile: string): Promise<number> {
  const inst = await DuckDBInstance.create(targetFile);
  const conn = await inst.connect();
  try {
    await conn.runAndReadAll(`DROP TABLE IF EXISTS v_stock_qfq`);
    await conn.runAndReadAll(DUCKDB_DDL.replace('raw_daily', 'v_stock_qfq'));
    await conn.runAndReadAll(`COPY v_stock_qfq FROM '${parquetPath}' (FORMAT PARQUET)`);
    const res = await conn.runAndReadAll('SELECT COUNT(*) AS c FROM v_stock_qfq');
    return Number(res.getRows()[0][0]);
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

/** 在临时 DuckDB 上执行 COPY TO PARQUET GZIP，返回产物路径 */
async function copyToParquetGzip(sourceFile: string, outFile: string): Promise<string> {
  const inst = await DuckDBInstance.create(sourceFile);
  const conn = await inst.connect();
  try {
    await conn.runAndReadAll(`COPY v_stock_qfq TO '${outFile}' (FORMAT PARQUET, COMPRESSION GZIP)`);
    return outFile;
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

describe('backup_restore_duckdb — SDD §12.5 F11（DuckDB 行情层备份恢复）', () => {
  let sourceCount = 0;
  let parquetPath = '';

  beforeAll(async () => {
    // 0. 强制指向临时行情库 + 临时 SQLite
    //    （上一个 describe 的 afterAll 已把 env 还原成原值：
    //      若不重设，backupDuckDB 会去读真实的 data/quotes.duckdb —— 违反隔离铁律）
    process.env.DUCKDB_PATH = TEST_DUCKDB;
    process.env.SQLITE_DB_PATH = TEST_DB;
    expect(process.env.DUCKDB_PATH).toBe(TEST_DUCKDB);

    // 重新打开临时 SQLite（上一个 describe 已把连接 close 掉），保证备份日志能落库
    ConfigStore.resetInstance();
    ConfigStore.getInstance();

    // 1. 造临时行情库（被备份对象）
    sourceCount = await createTempDuckDB(TEST_DUCKDB);
    expect(sourceCount).toBe(DUCKDB_ROWS.length);

    // 1b. GZIP 导出专用源库（独立文件：backupDuckDB 不关 instance，会锁住 TEST_DUCKDB）
    expect(await createTempDuckDB(TEST_DUCKDB_GZIP)).toBe(DUCKDB_ROWS.length);

    // 2. 走真实备份实现（services/backup.ts → backupDuckDB，COPY v_stock_qfq TO parquet）
    cleanupBackupDir();
    const result = await backupDuckDB();
    expect(result.success, `DuckDB 备份失败: ${result.error ?? ''}`).toBe(true);
    expect(typeof result.size).toBe('number');
    expect(result.size!).toBeGreaterThan(0);

    // 3. 找到备份产物
    const files = fs.readdirSync(TEST_BACKUP_DIR).filter((f) => f.endsWith('.parquet'));
    expect(files, '备份目录里应产生 parquet 产物').toHaveLength(1);
    parquetPath = path.join(TEST_BACKUP_DIR, files[0]);
    expect(fs.existsSync(parquetPath)).toBe(true);
    expect(fs.statSync(parquetPath).size).toBeGreaterThan(0);
  }, 60000);

  afterAll(() => {
    // 还原 env
    if (ORIGINAL_DUCKDB_PATH !== undefined) {
      process.env.DUCKDB_PATH = ORIGINAL_DUCKDB_PATH;
    } else {
      delete process.env.DUCKDB_PATH;
    }
    if (ORIGINAL_SQLITE_DB_PATH !== undefined) {
      process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
    } else {
      delete process.env.SQLITE_DB_PATH;
    }
    // ⚠️ 这里**不**关闭 ConfigStore 连接、**不**删临时目录：
    //    vitest 开了 sequence.shuffle，本 describe 可能排在另一个 describe 前面，
    //    关连接/删目录会让后续 describe 的用例报 "database connection is not open"。
    //    统一由文件末尾的根级 afterAll 收尾。
  });

  it('backup_restore_duckdb：COPY TO parquet → COPY FROM 恢复 → COUNT(*) 与源库一致', async () => {
    const restoredCount = await restoreFromParquet(parquetPath, RESTORE_DUCKDB);
    expect(restoredCount).toBe(sourceCount);
    expect(restoredCount).toBe(6);
  }, 60000);

  it('backup_restore_duckdb：SDD 指定的 COPY TO PARQUET GZIP → 恢复 → COUNT(*) 一致', async () => {
    const gzipPath = path.join(TMP_DIR, 'v_stock_qfq.gzip.parquet');
    await copyToParquetGzip(TEST_DUCKDB_GZIP, gzipPath);
    expect(fs.existsSync(gzipPath)).toBe(true);
    expect(fs.statSync(gzipPath).size).toBeGreaterThan(0);

    const restoredCount = await restoreFromParquet(gzipPath, RESTORE_DUCKDB);
    expect(restoredCount).toBe(sourceCount);
    expect(restoredCount).toBe(6);
  }, 60000);

  it('恢复出来的数据内容与源库一致（symbol / date / close 抽样比对）', async () => {
    // ⚠️ 自带恢复步骤：vitest 开了 sequence.shuffle，用例顺序不固定，
    //    本用例不能依赖前两个用例已经恢复过 RESTORE_DUCKDB。
    const contentTarget = path.join(TMP_DIR, 'quotes-restored-content.duckdb');
    const restoredCount = await restoreFromParquet(parquetPath, contentTarget);
    expect(restoredCount).toBe(sourceCount);

    const inst = await DuckDBInstance.create(contentTarget);
    const conn = await inst.connect();
    try {
      const res = await conn.runAndReadAll(
        `SELECT symbol, date, close FROM v_stock_qfq ORDER BY symbol, date`,
      );
      const rows = res.getRows().map((r) => ({
        symbol: String(r[0]),
        date: String(r[1]),
        close: Number(r[2]),
      }));
      expect(rows).toHaveLength(6);
      expect(rows[0]).toEqual({ symbol: 'sh600001', date: '2026-10-09', close: 10.1 });
      expect(rows[5]).toEqual({ symbol: 'sh600003', date: '2026-10-12', close: 30.75 });
    } finally {
      conn.closeSync();
      inst.closeSync();
    }
  }, 60000);

  it('备份产物落在临时 BACKUP_DIR，且不触碰真实行情库 data/quotes.duckdb', () => {
    expect(parquetPath.startsWith(TEST_BACKUP_DIR)).toBe(true);
    expect(path.resolve(parquetPath)).not.toContain(path.join('data', 'quotes.duckdb'));
    // 被备份的确实是临时文件
    expect(process.env.DUCKDB_PATH).toBe(TEST_DUCKDB);
    expect(TEST_DUCKDB.startsWith(TMP_DIR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 文件级收尾（根级 afterAll）：所有 describe 跑完之后才关连接 / 删临时目录
// ⚠️ vitest 开了 sequence.shuffle，describe 之间顺序不固定 —— 清理必须放在根级，
//    否则先跑的 describe 会把后续 describe 的依赖（SQLite 连接 / 临时 DuckDB）删掉。
// ---------------------------------------------------------------------------
afterAll(() => {
  try {
    (ConfigStore.getInstance().db as any).close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
