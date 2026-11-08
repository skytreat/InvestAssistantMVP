/**
 * backup-backtest.test.ts — PA-15（S4）
 *
 * 覆盖「备份清单必须包含纸面账本」这一 Gate 项：
 *   1. `backupBacktestDb()` 的产物里真有 `paper_*` 表与行（不是只备份了个空文件）；
 *   2. 库文件不存在 → `skipped=true`（不算失败）；
 *   3. `restoreBacktestBackup()` 往返可恢复纸面账本，并留下 pre-restore 安全备份；
 *   4. 文件名白名单拒绝非 `backtest.db.YYYY-MM-DD` 输入；
 *   5. `runFullBackup()` 的返回值包含 `backtest` 段（cron 日志据此判定 FAIL）。
 *
 * ⚠️ 与既有 `backup.test.ts` 分开：本文件只碰 `backtest.db`，不依赖 ConfigStore 业务库结构。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backup-'));
const BACKUP_DIR = path.join(TMP, 'backup');
const PAPER_DB = path.join(TMP, 'backtest.db');

process.env.BACKUP_DIR = BACKUP_DIR;
process.env.BACKTEST_DB_PATH = PAPER_DB;
process.env.SQLITE_DB_PATH = path.join(TMP, 'business.db');
process.env.ENABLE_QUOTE_BACKUP = 'false';
process.env.SYSTEM_LOG_FALLBACK_FILE = path.join(TMP, 'err.log');

type BackupModule = typeof import('../../src/services/backup.js');
type StoreModule = typeof import('../../src/services/paper/store.js');

let backupMod: BackupModule;
let storeMod: StoreModule;

beforeAll(async () => {
  backupMod = await import('../../src/services/backup.js');
  storeMod = await import('../../src/services/paper/store.js');
});

afterAll(async () => {
  storeMod?.PaperStore.resetInstance();
  // writeSystemLog 走 ConfigStore（临时 business.db）—— 不关连接 Windows 上 rmSync 会 EPERM
  const { ConfigStore } = await import('../../src/config/configStore.js');
  ConfigStore.resetInstance();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 与 backup.ts 的 `_date()` 同口径（UTC+8） */
function backupDate(): string {
  const local = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

/** 重建一个干净的纸面库并插入 N 个账户（每用例独立，免受 shuffle 影响） */
function freshPaperDb(accountCount = 2): void {
  storeMod.PaperStore.resetInstance();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(PAPER_DB + suffix);
    } catch {
      /* 不存在即可 */
    }
  }
  const store = storeMod.PaperStore.getInstance();
  for (let userId = 1; userId <= accountCount; userId += 1) {
    store.db
      .prepare(
        `INSERT INTO paper_account (user_id, strategy_id, strategy_version, strategy_name, name,
           params_json, rules_json, fee_config_id, fee_snapshot_json, phase, status, initial_cash, cash,
           benchmark_asset_code)
         VALUES (?, 'buy_and_hold', '1.0.0', '买入持有', '纸面账户', '{}', '{}', NULL, '{}',
           'shadow', 'active', 1000000, 1000000, 'sh510300')`,
      )
      .run(userId);
  }
}

function paperBackupFiles(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^backtest\.db\.\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
}

describe('PA-15 备份包含纸面账本（backtest.db）', () => {
  it('备份产物内含 paper_* 表与数据（不是空壳）', async () => {
    freshPaperDb(2);
    const result = await backupMod.backupBacktestDb();
    expect(result.success).toBe(true);
    expect(result.skipped).toBeFalsy();

    const files = paperBackupFiles();
    expect(files.length).toBeGreaterThan(0);
    const latest = path.join(BACKUP_DIR, files[files.length - 1]);

    const probe = new Database(latest, { readonly: true, fileMustExist: true });
    try {
      const accounts = probe
        .prepare(`SELECT COUNT(*) AS c FROM paper_account WHERE is_deleted = 0`)
        .get() as { c: number };
      expect(accounts.c).toBe(2);
      const tables = (
        probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'paper_%'`).all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining(['paper_account', 'paper_order', 'paper_position', 'paper_equity']),
      );
      const indexes = (
        probe
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_paper_%'`)
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(indexes.length).toBeGreaterThan(0);
    } finally {
      probe.close();
    }
  });

  it('库文件不存在 → skipped=true（不是失败）', async () => {
    const missing = path.join(TMP, 'missing', 'backtest.db');
    const original = process.env.BACKTEST_DB_PATH;
    process.env.BACKTEST_DB_PATH = missing;
    try {
      const result = await backupMod.backupBacktestDb();
      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
      process.env.BACKTEST_DB_PATH = original;
    }
  });

  it('恢复往返：能回到备份时点的纸面账本，并留 pre-restore 安全备份', async () => {
    freshPaperDb(1);
    const backupResult = await backupMod.backupBacktestDb();
    expect(backupResult.success).toBe(true);
    const fileName = `backtest.db.${backupDate()}`;
    expect(fs.existsSync(path.join(BACKUP_DIR, fileName))).toBe(true);

    // 破坏当前账本（模拟误操作）
    const store = storeMod.PaperStore.getInstance();
    store.db.prepare('DELETE FROM paper_account').run();
    storeMod.PaperStore.resetInstance();

    const restore = backupMod.restoreBacktestBackup(fileName);
    expect(restore.success).toBe(true);
    expect(restore.safetyBackup).toBeTruthy();
    expect(fs.existsSync(path.join(BACKUP_DIR, restore.safetyBackup as string))).toBe(true);

    const reopened = storeMod.PaperStore.getInstance();
    const count = reopened.db.prepare('SELECT COUNT(*) AS c FROM paper_account').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('文件名白名单：拒绝非 backtest.db.YYYY-MM-DD', async () => {
    expect(backupMod.restoreBacktestBackup('business.db.2026-11-08').success).toBe(false);
    expect(backupMod.restoreBacktestBackup('backtest.db').success).toBe(false);
    expect(backupMod.restoreBacktestBackup('../backtest.db.2026-11-08').success).toBe(false);
    expect(backupMod.restoreBacktestBackup('backtest.db.2026-11-08.tmp').success).toBe(false);
  });

  it('runFullBackup 返回值含 backtest 段（cron 日志据此判 FAIL）', async () => {
    freshPaperDb(1);
    const result = await backupMod.runFullBackup();
    expect(result.backtest).toBeDefined();
    expect(result.backtest.success).toBe(true);
    expect(result.backtest.size).toBeGreaterThan(0);
    // 行情库开关关闭 ⇒ 只跳过 DuckDB，不影响纸面账本备份
    expect(result.duckdb.skipped).toBe(true);
  });
});
