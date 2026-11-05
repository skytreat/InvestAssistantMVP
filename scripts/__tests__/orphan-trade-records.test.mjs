import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DuckDBInstance } from '@duckdb/node-api';
import { fileURLToPath } from 'node:url';
import {
  computeOrphans,
  isDictionaryUsable,
  isOrphanAssetCode,
} from '../delete-orphan-trade-records.mjs';

const SCRIPT = fileURLToPath(new URL('../delete-orphan-trade-records.mjs', import.meta.url));

function makeSqlite(dir, rows) {
  const dbPath = path.join(dir, 'business.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE user_trade_record (id INTEGER PRIMARY KEY, asset_code TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)');
  const insert = db.prepare('INSERT INTO user_trade_record (id, asset_code, is_deleted) VALUES (?, ?, ?)');
  for (const r of rows) insert.run(r.id, r.asset_code, r.is_deleted ?? 0);
  db.close();
  return dbPath;
}

async function makeDuck(dir, symbols) {
  const duckPath = path.join(dir, 'quotes.duckdb');
  const inst = await DuckDBInstance.create(duckPath);
  const conn = await inst.connect();
  await conn.run('CREATE TABLE raw_symbol_class (symbol TEXT, class TEXT)');
  for (const s of symbols) await conn.run(`INSERT INTO raw_symbol_class VALUES ('${s}', 'stock')`);
  conn.closeSync();
  inst.closeSync(); // 释放文件句柄，否则子进程无法以 READ_ONLY 打开
  return duckPath;
}

describe('孤儿判定（纯函数）', () => {
  it('class 表里有、name 表没有的标的（旧口径会误判）不算孤儿', () => {
    const classSet = new Set(['sh600000']);
    const nameSet = new Set(); // 行情字典无该标的名
    expect(isOrphanAssetCode('sh600000', classSet)).toBe(false);
    expect(isOrphanAssetCode('sh600000', nameSet)).toBe(true); // 旧口径的误判，说明改用 class 的必要性
  });

  it('class 表里也没有 → 真孤儿', () => {
    expect(isOrphanAssetCode('sz999999', new Set(['sh600000']))).toBe(true);
  });

  it('空字典不可用（由 main 中止），非空可用', () => {
    expect(isDictionaryUsable([])).toBe(false);
    expect(isDictionaryUsable(['sh600000'])).toBe(true);
  });

  it('computeOrphans 只挑出目标行', () => {
    const trades = [
      { id: 1, asset_code: 'sh600000' },
      { id: 2, asset_code: 'sz999999' },
      { id: 3, asset_code: null },
    ];
    expect(computeOrphans(trades, new Set(['sh600000'])).map((t) => t.id)).toEqual([2]);
  });
});

describe('集成（临时库）', () => {
  it('--execute：生成 pre-orphan 备份，且只软删真孤儿', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-it-'));
    const dbPath = makeSqlite(dir, [
      { id: 1, asset_code: 'sh600000' }, // 合法
      { id: 2, asset_code: 'sz999999' }, // 真孤儿
      { id: 3, asset_code: 'sh600000', is_deleted: 1 }, // 已软删，不应再动
    ]);
    const duckPath = await makeDuck(dir, ['sh600000']);
    const envPath = path.join(dir, '.env.test');
    fs.writeFileSync(envPath, `DUCKDB_PATH=${duckPath}\n`);

    const out = execFileSync(process.execPath, [SCRIPT, '--db', dbPath, '--env', envPath, '--execute'], {
      encoding: 'utf8',
    });
    expect(out).toContain('已备份到');
    expect(fs.readdirSync(dir).some((f) => f.startsWith('business.db.pre-orphan-'))).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT id, is_deleted FROM user_trade_record ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { id: 1, is_deleted: 0 },
      { id: 2, is_deleted: 1 },
      { id: 3, is_deleted: 1 },
    ]);
  });

  it('空字典 → 预览也中止，且不建备份', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-empty-'));
    const dbPath = makeSqlite(dir, [{ id: 1, asset_code: 'sh600000' }]);
    const duckPath = await makeDuck(dir, []);
    const envPath = path.join(dir, '.env.test');
    fs.writeFileSync(envPath, `DUCKDB_PATH=${duckPath}\n`);

    expect(() => execFileSync(process.execPath, [SCRIPT, '--db', dbPath, '--env', envPath], { stdio: 'pipe' })).toThrow();
    expect(fs.readdirSync(dir).some((f) => f.startsWith('business.db.pre-orphan-'))).toBe(false);
  });
});
