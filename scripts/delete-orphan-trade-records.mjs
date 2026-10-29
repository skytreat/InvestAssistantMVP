/**
 * 软删除 user_trade_record 中 asset_code 不在 DuckDB raw_symbol_name 的记录。
 *
 * 用法：
 *   node scripts/delete-orphan-trade-records.mjs            # 预览模式（不实际删除）
 *   node scripts/delete-orphan-trade-records.mjs --execute  # 实际软删除
 */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

function loadEnvFile(p) {
  try {
    const content = readFileSync(p, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnvFile('.env.local');
loadEnvFile('apps/backend/.env.local');

const sqlitePath = process.env.SQLITE_DB_PATH ?? './data/business.db';
const duckdbPath = process.env.DUCKDB_PATH ?? './data/quotes.duckdb';
const execute = process.argv.includes('--execute');

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
const liveTrades = db
  .prepare('SELECT id, asset_code FROM user_trade_record WHERE is_deleted = 0')
  .all();
db.close();

console.log(`\n活交易记录共 ${liveTrades.length} 条`);
const orphans = liveTrades.filter((t) => t.asset_code && !symbolSet.has(t.asset_code));
console.log(`asset_code 不在 raw_symbol_name 中的记录：${orphans.length} 条\n`);

if (orphans.length === 0) {
  console.log('✅ 无孤儿记录，无需操作。');
  process.exit(0);
}

const byAsset = {};
for (const t of orphans) byAsset[t.asset_code] = (byAsset[t.asset_code] ?? 0) + 1;
console.log('各 asset_code 分布：');
for (const [code, count] of Object.entries(byAsset).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${count} 条`);
}

if (!execute) {
  console.log('\n预览模式。如需实际软删除，请加上 --execute 参数运行。');
  process.exit(0);
}

console.log('\n开始软删除…');
const dbW = new Database(sqlitePath);
const update = dbW.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?');
const ids = orphans.map((t) => t.id);
dbW.transaction((list) => {
  for (const id of list) update.run(id);
})(ids);
dbW.close();
console.log(`✅ 已软删除 ${ids.length} 条记录。`);
