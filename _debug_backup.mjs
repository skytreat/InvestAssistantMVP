// /opt/invol/InvestAssistantMVP/apps/backend/_debug_backup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from './src/config/configStore.js';

// 模拟 smoke-m3 场景：ConfigStore 已 init（WAL 可能有残留）
ConfigStore.getInstance();

// 手动触发 backupSQLite（直接调 db.backup）
const dbPath = process.env.SQLITE_DB_PATH ?? path.resolve('data', 'business.db');
const out = path.resolve('data', 'backup', 'business.db.test');
fs.mkdirSync(path.dirname(out), { recursive: true });

console.log('ConfigStore DB path=', dbPath);
console.log('backup out=', out);

try {
  // 显式 WAL checkpoint（better-sqlite3 backup 前建议做）
  const { Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.backup(out);
  db.close();
  console.log('SQLITE_BACKUP_OK size=', fs.statSync(out).size);
} catch (err) {
  console.error('SQLITE_BACKUP_FAIL', err.message);
}
