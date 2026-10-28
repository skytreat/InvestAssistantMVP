#!/usr/bin/env node
/**
 * 一次性数据迁移：为 user_trade_record 中 6 位裸码补市场前缀。
 *
 * 用法：node scripts/normalize-asset-code-prefix.mjs [db-path]
 *   db-path 缺省读 SQLITE_DB_PATH 环境变量，再缺省 data/business.db
 *
 * 幂等：已有前缀（sh/sz/bj + 6 位数字）的行不动；只处理纯 6 位数字。
 * 事务：全部 UPDATE 包在一个事务里，失败整体回滚。
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = process.argv[2] || process.env.SQLITE_DB_PATH || path.resolve('data/business.db');
const db = new Database(dbPath);

function normalize(code) {
  if (!/^\d{6}$/.test(code)) return code; // 非 6 位裸码（已带前缀/其他格式）原样
  const d1 = code[0];
  const d2 = code[1];
  if (d1 === '6' || d1 === '9' || d1 === '5' || d1 === '7') return `sh${code}`;
  if (d1 === '0' || d1 === '3' || d1 === '2') return `sz${code}`;
  if (d1 === '4' || d1 === '8') return `bj${code}`;
  if (d1 === '1') return Number(d2) <= 3 ? `sh${code}` : `sz${code}`;
  return code;
}

const run = db.transaction(() => {
  const rows = db
    .prepare(`SELECT id, asset_code FROM user_trade_record WHERE asset_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'`)
    .all();
  const update = db.prepare(`UPDATE user_trade_record SET asset_code = ? WHERE id = ?`);
  let changed = 0;
  for (const r of rows) {
    const nc = normalize(r.asset_code);
    if (nc !== r.asset_code) {
      update.run(nc, r.id);
      changed++;
    }
  }
  // 同步 user_asset_rel（关联表也用 asset_code）
  const relRows = db
    .prepare(`SELECT id, asset_code FROM user_asset_rel WHERE asset_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' AND is_deleted = 0`)
    .all();
  const relUpdate = db.prepare(`UPDATE user_asset_rel SET asset_code = ? WHERE id = ?`);
  for (const r of relRows) {
    const nc = normalize(r.asset_code);
    if (nc !== r.asset_code) {
      relUpdate.run(nc, r.id);
      changed++;
    }
  }
  return changed;
});

const n = run();
console.log(`迁移完成：${n} 行 asset_code 已补前缀（${dbPath}）`);
db.close();
