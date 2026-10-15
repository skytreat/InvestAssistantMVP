import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../config/configStore.js';
import { DuckDBInstance } from '@duckdb/node-api';
import { writeSystemLog } from './logger.js';

/**
 * 双库备份（T30）
 *
 * SQLite：better-sqlite3 db.backup(path) 热备份（零停机，AGENTS.md 推荐）
 * DuckDB：COPY v_stock_qfq TO parquet（本质 SELECT 导出，不写 DuckDB 本身，符合只读硬约束）
 *   - 服务器实测全量 821MB parquet 几秒跑完
 *
 * 保留策略：本地 /opt/invol/backup/ 保留 3 天，清理过期文件
 * OCI Object Storage rclone copyto：MVP 简化——备份到本地足够（用户手动跑 cron mount 后再扩）
 */

const BACKUP_DIR = process.env.BACKUP_DIR ?? '/opt/invol/backup';
const RETENTION_DAYS = 3;

function _ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function _date(): string {
  const d = new Date();
  const offset = 8 * 60;  // UTC+8
  const local = new Date(d.getTime() + offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function _deleteOldBackups(): number {
  _ensureBackupDir();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  const entries = fs.readdirSync(BACKUP_DIR);
  for (const name of entries) {
    const full = path.join(BACKUP_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch { /* 忽略 */ }
  }
  return deleted;
}

/**
 * SQLite 热备份（better-sqlite3 db.backup）
 */
export function backupSQLite(): { success: boolean; size?: number; error?: string } {
  try {
    _ensureBackupDir();
    const db = ConfigStore.getInstance().db;
    const out = path.join(BACKUP_DIR, `business.db.${_date()}`);
    db.backup(out);
    const size = fs.statSync(out).size;
    writeSystemLog({ logType: 'backup', level: 'INFO', message: `SQLite 备份成功`, detail: `file=${out} size=${size}` });
    return { success: true, size };
  } catch (err: any) {
    writeSystemLog({ logType: 'backup', level: 'ERROR', message: `SQLite 备份失败`, detail: String(err) });
    return { success: false, error: String(err) };
  }
}

/**
 * DuckDB COPY TO parquet（本质 SELECT 导出，不写 DuckDB 本身）
 * Fastify 进程只有 SELECT 权限也能做，符合 AGENTS.md 硬约束
 */
export async function backupDuckDB(): Promise<{ success: boolean; size?: number; error?: string }> {
  try {
    _ensureBackupDir();
    const duckdbPath = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
    const out = path.join(BACKUP_DIR, `v_stock_qfq.${_date()}.parquet`);

    const inst = await DuckDBInstance.create(duckdbPath);
    const conn = await inst.connect();
    await conn.runAndReadAll(`COPY v_stock_qfq TO '${out}' (FORMAT PARQUET)`);
    const size = fs.statSync(out).size;
    writeSystemLog({ logType: 'backup', level: 'INFO', message: `DuckDB 备份成功`, detail: `file=${out} size=${size}` });
    return { success: true, size };
  } catch (err: any) {
    writeSystemLog({ logType: 'backup', level: 'ERROR', message: `DuckDB 备份失败`, detail: String(err) });
    return { success: false, error: String(err) };
  }
}

/**
 * 一键双库备份
 */
export async function runFullBackup(): Promise<{
  sqlite: { success: boolean; size?: number };
  duckdb: { success: boolean; size?: number };
  cleanedFiles: number;
}> {
  const sqliteResult = backupSQLite();
  const duckdbResult = await backupDuckDB();
  const cleaned = _deleteOldBackups();
  return {
    sqlite: { success: sqliteResult.success, size: sqliteResult.size },
    duckdb: { success: duckdbResult.success, size: duckdbResult.size },
    cleanedFiles: cleaned,
  };
}
