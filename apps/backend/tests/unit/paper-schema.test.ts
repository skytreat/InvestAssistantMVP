/**
 * PA-05 / §13.4 —— 纸面 schema 隔离校验
 *
 * 覆盖：
 *   1) 建表幂等；
 *   2) 表 / 索引 / 触发器命名前缀；
 *   3) `paper_*` 与 `bt_*` 零交叉引用（外键 + 定义文本双路），且**反向能抓到违规**；
 *   4) `initial_cash` 不可变触发器真的 ABORT（D5）。
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  PAPER_TABLES,
  PaperSchemaError,
  assertPaperSchemaIsolation,
  createPaperSchema,
} from '../../src/services/backtest/store/paperSchema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);
  return db;
}

function masterSnapshot(db: Database.Database) {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
}

describe('paper schema', () => {
  it('建表幂等：连续两次 createPaperSchema 不产生 schema 差异', () => {
    const db = freshDb();
    const before = masterSnapshot(db);
    createPaperSchema(db);
    expect(masterSnapshot(db)).toEqual(before);
    db.close();
  });

  it('表清单与约定完全一致（不多不少）', () => {
    const db = freshDb();
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'paper_%'`).all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([...PAPER_TABLES].sort());
    db.close();
  });

  it('索引全部 idx_paper_ 前缀、触发器全部 trg_paper_ 前缀', () => {
    const db = freshDb();
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'paper_%' AND sql IS NOT NULL`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes.length).toBeGreaterThan(0);
    for (const name of indexes) expect(name).toMatch(/^idx_paper_/);

    const triggers = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'paper_%'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(triggers.length).toBeGreaterThan(0);
    for (const name of triggers) expect(name).toMatch(/^trg_paper_/);
    db.close();
  });

  it('外键双路断言：paper_* 与 bt_* 之间零引用（含回测表存在时）', () => {
    const db = freshDb();
    // 同一文件里再建 bt_* 表，模拟 D1 的同库共存
    db.exec(`
      CREATE TABLE bt_run (id INTEGER PRIMARY KEY, strategy_id TEXT);
      CREATE TABLE bt_equity (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES bt_run(id));
      CREATE INDEX idx_bt_equity_run ON bt_equity(run_id);
    `);
    expect(() => assertPaperSchemaIsolation(db)).not.toThrow();
    db.close();
  });

  it('能抓到「paper 表外键指向 bt 表」的违规', () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE bt_run (id INTEGER PRIMARY KEY);
      ALTER TABLE paper_equity ADD COLUMN evil_run_id INTEGER REFERENCES bt_run(id);
    `);
    expect(() => assertPaperSchemaIsolation(db)).toThrow(PaperSchemaError);
    db.close();
  });

  it('能抓到「bt 表引用 paper 表」的反向违规', () => {
    const db = freshDb();
    db.exec(
      `CREATE TABLE bt_evil (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES paper_account(id));`,
    );
    expect(() => assertPaperSchemaIsolation(db)).toThrow(/禁止交叉引用|paper_/);
    db.close();
  });

  it('能抓到视图同时引用两套前缀', () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE bt_run (id INTEGER PRIMARY KEY);
      CREATE VIEW v_evil AS SELECT * FROM paper_account JOIN bt_run ON 1 = 1;
    `);
    expect(() => assertPaperSchemaIsolation(db)).toThrow(PaperSchemaError);
    db.close();
  });

  it('能抓到索引未用 idx_paper_ 前缀', () => {
    const db = freshDb();
    db.exec(`CREATE INDEX bad_paper_idx ON paper_account (cash);`);
    expect(() => assertPaperSchemaIsolation(db)).toThrow(/idx_paper_/);
    db.close();
  });

  it('能抓到表白名单外的新增 paper 表', () => {
    const db = freshDb();
    db.exec(`CREATE TABLE paper_bogus (id INTEGER PRIMARY KEY);`);
    expect(() => assertPaperSchemaIsolation(db)).toThrow(/表清单/);
    db.close();
  });

  it('D5：initial_cash 建户后不可变（触发器 ABORT）', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO paper_account (
         user_id, strategy_id, strategy_version, strategy_name, name,
         params_json, rules_json, fee_snapshot_json, initial_cash, cash
       ) VALUES (1, 's', 'v', 'n', 'a', '{}', '{}', '{}', 100, 100)`,
    ).run();
    expect(() => db.prepare(`UPDATE paper_account SET initial_cash = 200 WHERE id = 1`).run()).toThrow(
      /immutable/,
    );
    // 不改该列的正常更新不受影响
    expect(() => db.prepare(`UPDATE paper_account SET cash = 50 WHERE id = 1`).run()).not.toThrow();
    db.close();
  });
});
