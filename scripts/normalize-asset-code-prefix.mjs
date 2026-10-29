#!/usr/bin/env node
/**
 * 一次性数据迁移：为 user_trade_record 中 6 位裸码补市场前缀。
 *
 * 用法：node scripts/normalize-asset-code-prefix.mjs [db-path]
 *   db-path 缺省读 SQLITE_DB_PATH 环境变量，再缺省 data/business.db
 *
 * 幂等：已有前缀（sh/sz/bj + 6 位数字）的行不动；只处理纯 6 位数字。
 * 规则：symbol_dict 的 code6→symbol 唯一命中优先（字典权威，与后端 normalizeAssetCode 同源）；
 *   字典未命中才走启发式兜底（920xxx=北交所 / 900xxx=沪B 等，见 normalize 注释）。
 * 事务：全部 UPDATE 包在一个事务里，失败整体回滚。
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = process.argv[2] || process.env.SQLITE_DB_PATH || path.resolve('data/business.db');
const db = new Database(dbPath);

function loadCode6Dict() {
  const dict = new Map();
  try {
    const rows = db.prepare(`SELECT code6, symbol FROM symbol_dict`).all();
    for (const r of rows) {
      dict.set(r.code6, dict.has(r.code6) ? null : r.symbol); // 同 code6 多 symbol ⇒ null = 歧义不猜
    }
  } catch {
    /* symbol_dict 未建/为空 → 全走启发式兜底 */
  }
  return dict;
}

// 与 apps/backend normalizeAssetCode 同规则（PR#60 review 修正版）：
// ① 字典权威：code6 → symbol 唯一命中直接采用；歧义 → 保留裸码
// ② 兜底启发式（依据 raw_symbol_name 实测分布 2026-10-28）：
//    92xxxx=北交所 / 900xxx=沪B；1x：10/11→sh，12/13/15/16/18→sz，14/17/19 不猜
function normalize(code, dict) {
  if (!/^\d{6}$/.test(code)) return code; // 非 6 位裸码（已带前缀/其他格式）原样
  const hit = dict.get(code);
  if (hit) return hit;
  if (hit === null) return code; // 字典歧义 → 保留裸码，不猜
  const d1 = code[0];
  const d2 = code[1];
  if (d1 === '6' || d1 === '5' || d1 === '7') return `sh${code}`;
  if (d1 === '0' || d1 === '2' || d1 === '3') return `sz${code}`;
  if (d1 === '4' || d1 === '8') return `bj${code}`;
  if (d1 === '9') return d2 === '2' ? `bj${code}` : `sh${code}`;
  if (d1 === '1') {
    if (d2 === '0' || d2 === '1') return `sh${code}`;
    if (d2 === '2' || d2 === '3' || d2 === '5' || d2 === '6' || d2 === '8') return `sz${code}`;
    return code; // 14/17/19 未知段 → 原样
  }
  return code;
}

const dict = loadCode6Dict();

const run = db.transaction(() => {
  const rows = db
    .prepare(
      `SELECT id, asset_code FROM user_trade_record WHERE asset_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'`,
    )
    .all();
  const update = db.prepare(`UPDATE user_trade_record SET asset_code = ? WHERE id = ?`);
  let changed = 0;
  for (const r of rows) {
    const nc = normalize(r.asset_code, dict);
    if (nc !== r.asset_code) {
      update.run(nc, r.id);
      changed++;
    }
  }
  // 同步 user_asset_rel（关联表也用 asset_code）
  const relRows = db
    .prepare(
      `SELECT id, asset_code FROM user_asset_rel WHERE asset_code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' AND is_deleted = 0`,
    )
    .all();
  const relUpdate = db.prepare(`UPDATE user_asset_rel SET asset_code = ? WHERE id = ?`);
  for (const r of relRows) {
    const nc = normalize(r.asset_code, dict);
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
