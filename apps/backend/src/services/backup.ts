import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

// 默认备份目录：用相对路径 data/backup（Windows 能跑；服务器部署时 export BACKUP_DIR=/opt/invol/backup 覆盖）
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve('data', 'backup');
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

export function _deleteOldBackups(): number {
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
 *
 * better-sqlite3 v13 起 db.backup() 变为 async，必须 await。
 * 参见 backup.js:33（backup 返回 Promise，内部 setImmediate 步进 transfer）。
 */
export async function backupSQLite(): Promise<{ success: boolean; size?: number; error?: string }> {
  try {
    _ensureBackupDir();
    const db = ConfigStore.getInstance().db;
    const out = path.join(BACKUP_DIR, `business.db.${_date()}`);
    await db.backup(out);
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
 * OCI Object Storage 上传（MVP T30 降级逻辑）
 *
 * 前提：服务器上 rclone 已配置好 oci remote（rclone config create oci swift ...）
 *   - export ENABLE_OCI_BACKUP=true 开启
 *   - export OCI_REMOTE="oci:invest-assistant-backup" 可覆盖
 *   - export OCI_MAX_AGE=30d OCI 端对象保留期（rclone copyto --max-age 参数）
 *
 * 降级：
 *   - ENABLE_OCI_BACKUP 未设置 → 直接跳过
 *   - rclone 执行失败 → 写 WARN 日志，本地保留 3 天继续
 *   - backup 是独立 cron，不经过 pluginEngine 50ms 沙盒，execSync 阻塞没关系
 */
function _uploadToOCI(files: string[]): { success: boolean; uploaded: number; error?: string } {
  if (process.env.ENABLE_OCI_BACKUP !== 'true') {
    return { success: true, uploaded: 0 };  // 未开启 → 静默跳过
  }

  const remote = process.env.OCI_REMOTE ?? 'oci:invest-assistant-backup';
  let uploaded = 0;

  for (const file of files) {
    const basename = path.basename(file);
    try {
      execSync(`rclone copyto "${file}" "${remote}/${basename}"`, {
        encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
      });
      uploaded++;
      writeSystemLog({ logType: 'backup', level: 'INFO', message: 'OCI 上传成功', detail: `file=${basename} remote=${remote}` });
    } catch (err: any) {
      const msg = String(err?.stderr ?? err?.message ?? err);
      writeSystemLog({
        logType: 'backup', level: 'WARN',
        message: 'OCI 上传失败（本地备份保留）',
        detail: `file=${basename} error=${msg.slice(0, 200)}`,
      });
    }
  }

  return { success: true, uploaded };
}

/**
 * 一键双库备份 + 可选 OCI 上传
 */
export async function runFullBackup(): Promise<{
  sqlite: { success: boolean; size?: number };
  duckdb: { success: boolean; size?: number };
  cleanedFiles: number;
  ociUploaded?: number;
}> {
  const sqliteResult = await backupSQLite();
  const duckdbResult = await backupDuckDB();
  const cleaned = _deleteOldBackups();

  // OCI 上传（MVP T30）
  let ociUploaded: number | undefined;
  try {
    const files: string[] = [];
    const date = _date();
    const sqlitePath = path.join(BACKUP_DIR, `business.db.${date}`);
    const duckdbPath = path.join(BACKUP_DIR, `v_stock_qfq.${date}.parquet`);
    if (fs.existsSync(sqlitePath)) files.push(sqlitePath);
    if (fs.existsSync(duckdbPath)) files.push(duckdbPath);
    const ociResult = _uploadToOCI(files);
    ociUploaded = ociResult.uploaded;
  } catch { /* OCI 上传任何异常不影响主流程 */ }

  return {
    sqlite: { success: sqliteResult.success, size: sqliteResult.size },
    duckdb: { success: duckdbResult.success, size: duckdbResult.size },
    cleanedFiles: cleaned,
    ociUploaded,
  };
}
