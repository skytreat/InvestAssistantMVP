/**
 * T133 / PA-05 —— 组合配置 schema 校验
 *
 * 覆盖：建表幂等、表清单、索引、CHECK 约束拒绝非法取值。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { COMBO_TABLES, ensureComboTables } from '../../src/config/comboSchema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // 最小 user_account 桩：组合主表的外键目标
  db.exec(`CREATE TABLE user_account (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.prepare(`INSERT INTO user_account (id) VALUES (1)`).run();
  ensureComboTables(db);
  return db;
}

function masterSnapshot(db: Database.Database) {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all();
}

describe('combo schema', () => {
  it('建表幂等：连续两次 ensureComboTables 无 schema 差异', () => {
    const db = freshDb();
    const before = masterSnapshot(db);
    ensureComboTables(db);
    expect(masterSnapshot(db)).toEqual(before);
    db.close();
  });

  it('表清单与约定一致（不多不少）', () => {
    const db = freshDb();
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'strategy_combo%'`,
        )
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
    expect(tables).toEqual([...COMBO_TABLES].sort());
    db.close();
  });

  it('索引存在', () => {
    const db = freshDb();
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND name LIKE 'idx_strategy_combo%'`,
        )
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
    expect(indexes).toEqual(['idx_strategy_combo_condition', 'idx_strategy_combo_user']);
    db.close();
  });

  it('combine_op 只接受 AND / OR', () => {
    const db = freshDb();
    const insert = db.prepare(
      `INSERT INTO strategy_combo (id, user_id, name, combine_op)
       VALUES (?, 1, 'x', ?)`,
    );
    expect(() => insert.run('c1', 'AND')).not.toThrow();
    expect(() => insert.run('c2', 'OR')).not.toThrow();
    expect(() => insert.run('c3', 'XOR')).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('asset_scope 只接受枚举值', () => {
    const db = freshDb();
    const insert = db.prepare(
      `INSERT INTO strategy_combo (id, user_id, name, asset_scope)
       VALUES (?, 1, 'x', ?)`,
    );
    expect(() => insert.run('c1', 'exclude_cash')).not.toThrow();
    expect(() => insert.run('c2', 'all')).not.toThrow();
    expect(() => insert.run('c3', 'futures')).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('cooldown_bars 限定 1~20', () => {
    const db = freshDb();
    const insert = db.prepare(
      `INSERT INTO strategy_combo (id, user_id, name, cooldown_bars)
       VALUES (?, 1, 'x', ?)`,
    );
    expect(() => insert.run('c1', 1)).not.toThrow();
    expect(() => insert.run('c2', 20)).not.toThrow();
    expect(() => insert.run('c3', 0)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run('c4', 21)).toThrow(/CHECK constraint failed/);
    db.close();
  });
});
