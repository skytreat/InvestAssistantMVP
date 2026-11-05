/**
 * 软删除 user_trade_record 中 asset_code 不在 DuckDB raw_symbol_class 的记录（执行前自动备份，单事务）。
 *
 * 判据与后端一致：存在性来源为 raw_symbol_class（排除 class = 'block'），
 * 见 apps/backend/src/routes/trade.ts、services/broker/brokerImport.ts、brokerConfirm.ts。
 *
 * 用法：
 *   node scripts/delete-orphan-trade-records.mjs                               # 预览模式
 *   node scripts/delete-orphan-trade-records.mjs --execute                     # 备份后软删除
 *   node scripts/delete-orphan-trade-records.mjs --db <path>                   # 指定 SQLite 路径
 *   node scripts/delete-orphan-trade-records.mjs --env /path/to/.env.local     # 指定环境变量文件
 *
 * 安全约束：
 *   - 行情字典为 0 行时无论预览/执行一律中止（说明行情库未就绪，避免全量误删）；
 *   - --execute 先用 better-sqlite3 在线备份 API 生成 <db>.pre-orphan-<时间戳>，失败即中止；
 *   - 删除在单事务内完成（BEGIN IMMEDIATE 预检写锁），失败整体回滚，不留半批状态。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/** 判定单个 asset_code 是否为孤儿（纯函数，便于单测） */
export function isOrphanAssetCode(assetCode, symbolSet) {
  if (!assetCode) return false;
  return !symbolSet.has(assetCode);
}

/** 从活交易中挑出孤儿记录（纯函数，便于单测） */
export function computeOrphans(liveTrades, symbolSet) {
  return liveTrades.filter((t) => isOrphanAssetCode(t.asset_code, symbolSet));
}

/** 行情字典是否可用（空集必须中止，否则全部活交易都会被判成孤儿） */
export function isDictionaryUsable(symbols) {
  return Array.isArray(symbols) && symbols.length > 0;
}

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

const readArg = (args, name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const envArg = readArg(args, '--env');
  const dbArg = readArg(args, '--db');

  if (envArg) {
    if (!loadEnvFile(envArg)) {
      console.warn(`⚠️ --env 指定的环境变量文件不可用：${resolve(envArg)}，回落到默认 env 查找。`);
    }
  } else {
    loadEnvFile('.env.local');
    loadEnvFile('apps/backend/.env.local');
  }

  const sqlitePath = dbArg ? resolve(dbArg) : (process.env.SQLITE_DB_PATH ?? './data/business.db');
  const duckdbPath = process.env.DUCKDB_PATH ?? './data/quotes.duckdb';

  console.log(`SQLite: ${sqlitePath}`);
  console.log(`DuckDB: ${duckdbPath}`);
  console.log(`模式: ${execute ? '执行软删除' : '预览（不删除）'}\n`);

  // 读取 DuckDB 符号字典（只读，口径与后端一致）
  let symbols = [];
  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const inst = await DuckDBInstance.create(duckdbPath, { access_mode: 'READ_ONLY' });
    const conn = await inst.connect();
    const result = await conn.runAndReadAll("SELECT symbol FROM raw_symbol_class WHERE class <> 'block'");
    symbols = result.getRows().map((r) => String(r[0]));
    conn.closeSync();
    console.log(`DuckDB raw_symbol_class 共 ${symbols.length} 个标的`);
  } catch (err) {
    console.error('⚠️ DuckDB 读取失败，无法判定孤儿记录，退出。', err.message);
    process.exit(1);
  }

  // 空集守卫：行情库未就绪时严禁继续，否则会把全部活交易判成孤儿
  if (!isDictionaryUsable(symbols)) {
    console.error('\n❌ raw_symbol_class 为 0 行，行情字典为空（疑似行情库未就绪），已中止，未做任何删除。');
    process.exit(1);
  }

  const symbolSet = new Set(symbols);

  // 读取 SQLite 活交易（只读预览）
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const liveTrades = db.prepare('SELECT id, asset_code FROM user_trade_record WHERE is_deleted = 0').all();
  db.close();

  console.log(`\n活交易记录共 ${liveTrades.length} 条`);
  const orphans = computeOrphans(liveTrades, symbolSet);
  console.log(`asset_code 不在 raw_symbol_class 中的记录：${orphans.length} 条\n`);

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

  // ---------- 执行前备份（在线备份 API，WAL 下也是一致性快照） ----------
  const dbW = new Database(sqlitePath);
  dbW.pragma('busy_timeout = 5000');
  const backupPath = `${resolve(sqlitePath)}.pre-orphan-${Date.now()}`;
  try {
    await dbW.backup(backupPath);
    const sizeMb = (statSync(backupPath).size / 1024 / 1024).toFixed(1);
    console.log(`\n已备份到：${backupPath}（${sizeMb} MB）`);
  } catch (err) {
    console.error('❌ 备份失败（磁盘空间或权限不足？），已中止，未删除任何记录：', err.message);
    dbW.close();
    process.exit(1);
  }

  // ---------- 单事务软删除（BEGIN IMMEDIATE 预检写锁，失败整体回滚） ----------
  const BATCH_SIZE = 100;
  const runAll = dbW.transaction(() => {
    // 持锁后重新读取，避免预览与执行之间的新增行漏判或错删
    const live = dbW.prepare('SELECT id, asset_code FROM user_trade_record WHERE is_deleted = 0').all();
    const targets = computeOrphans(live, symbolSet);
    const ids = targets.map((t) => t.id);
    let updated = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const info = dbW
        .prepare(`UPDATE user_trade_record SET is_deleted = 1 WHERE id IN (${placeholders})`)
        .run(chunk);
      updated += info.changes;
      console.log(
        `已处理批次 [${i + 1} - ${Math.min(i + BATCH_SIZE, ids.length)}] / ${ids.length}，本批更新 ${info.changes} 条`,
      );
    }
    return updated;
  });

  let totalDeleted;
  try {
    totalDeleted = runAll.immediate();
  } catch (err) {
    console.error('❌ 软删除事务失败，已整体回滚（数据库无改动）：', err.message);
    dbW.close();
    process.exit(1);
  }

  dbW.close();
  console.log(`\n✅ 软删除完成，共更新 ${totalDeleted} 条记录。`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await main();
