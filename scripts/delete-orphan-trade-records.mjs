/**
 * 软删除 user_trade_record 中 asset_code 不在 DuckDB raw_symbol_name 的记录（支持自定义 .env 路径，每批 100 条）。
 *
 * 用法：
 *   node scripts/delete-orphan-trade-records.mjs                               # 预览模式
 *   node scripts/delete-orphan-trade-records.mjs --execute                     # 实际软删除
 *   node scripts/delete-orphan-trade-records.mjs --env /path/to/.env.local     # 指定环境变量文件
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

// 解析命令行参数
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const envIndex = args.indexOf('--env');
const customEnvPath = envIndex !== -1 ? args[envIndex + 1] : null;

function loadEnvFile(p) {
  try {
    const fullPath = resolve(p);
    if (!existsSync(fullPath)) return false;
    const content = readFileSync(fullPath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^['"](.*)['"]$/, '$1');
      }
    }
    console.log(`已加载环境变量文件: ${fullPath}`);
    return true;
  } catch {
    return false;
  }
}

if (customEnvPath) {
  loadEnvFile(customEnvPath);
} else {
  loadEnvFile('.env.local');
  loadEnvFile('apps/backend/.env.local');
}

const sqlitePath = process.env.SQLITE_DB_PATH ?? './data/business.db';
const duckdbPath = process.env.DUCKDB_PATH ?? './data/quotes.duckdb';

console.log(`SQLite: ${sqlitePath}`);
console.log(`DuckDB: ${duckdbPath}`);
console.log(`模式: ${execute ? '执行软删除' : '预览（不删除）'}\n`);

// 读取 DuckDB 符号字典（只读）
let symbols = [];
try {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const inst = await DuckDBInstance.create(duckdbPath, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();
  const result = await conn.runAndReadAll('SELECT symbol FROM raw_symbol_name');
  const rows = result.getRows();
  symbols = rows.map((r) => String(r[0]));
  conn.closeSync();
  console.log(`DuckDB raw_symbol_name 共 ${symbols.length} 个标的`);
} catch (err) {
  console.error('⚠️ DuckDB 读取失败，无法判定孤儿记录，退出。', err.message);
  process.exit(1);
}

const symbolSet = new Set(symbols);

// 读取 SQLite 活交易
const db = new Database(sqlitePath, { readonly: true });
const liveTrades = db.prepare('SELECT id, asset_code FROM user_trade_record WHERE is_deleted = 0').all();
db.close();

console.log(`\n活交易记录共 ${liveTrades.length} 条`);
const orphans = liveTrades.filter((t) => t.asset_code && !symbolSet.has(t.asset_code));
console.log(`asset_code 不在 raw_symbol_name 中的记录：${orphans.length} 条\n`);

if (orphans.length === 0) {
  console.log('✅ 无孤儿记录，无需操作。');
  process.exit(0);
}

const byAsset = {};
for (const t of orphans) {
  byAsset[t.asset_code] = (byAsset[t.asset_code] ?? 0) + 1;
}
console.log('各 asset_code 分布：');
for (const [code, count] of Object.entries(byAsset).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${count} 条`);
}

if (!execute) {
  console.log('\n预览模式。如需实际软删除，请加上 --execute 参数运行。');
  process.exit(0);
}

console.log('\n开始分批软删除（每批 100 条）…');
const dbW = new Database(sqlitePath);
const ids = orphans.map((t) => t.id);
const BATCH_SIZE = 100;
let totalDeleted = 0;

const runBatch = dbW.transaction((batchIds) => {
  const placeholders = batchIds.map(() => '?').join(',');
  const stmt = dbW.prepare(`UPDATE user_trade_record SET is_deleted = 1 WHERE id IN (${placeholders})`);
  const info = stmt.run(batchIds);
  return info.changes;
});

for (let i = 0; i < ids.length; i += BATCH_SIZE) {
  const chunk = ids.slice(i, i + BATCH_SIZE);
  const changed = runBatch(chunk);
  totalDeleted += changed;
  console.log(
    `已处理批次 [${i + 1} - ${Math.min(i + BATCH_SIZE, ids.length)}] / ${ids.length}，本批更新 ${changed} 条`,
  );
}

dbW.close();
console.log(`\n✅ 软删除完成，共更新 ${totalDeleted} 条记录。`);
