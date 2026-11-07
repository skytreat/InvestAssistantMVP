/**
 * PA-05 / §13.4 第 3 条 —— 清理脚本守卫必须**真的 abort**
 *
 * 两个方向都要证：
 *   - 命中 `paper_%` → 退出码非 0、对象仍在、数据未变；
 *   - 只有 `bt_*` → 正常清理、库文件保留、schema 不 DROP。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/cleanup-backtest-data.mjs', import.meta.url));
const tmpDirs: string[] = [];

function makeRoot(): { root: string; dbPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'paper-cleanup-'));
  tmpDirs.push(root);
  mkdirSync(path.join(root, 'data'), { recursive: true });
  return { root, dbPath: path.join(root, 'data', 'backtest.db') };
}

function run(root: string) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('cleanup-backtest-data 守卫', () => {
  it('正向：命中 paper_* 即 abort（退出码非 0 且数据原样保留）', () => {
    const { root, dbPath } = makeRoot();
    const db = new Database(dbPath);
    createPaperSchema(db);
    db.prepare(
      `INSERT INTO paper_account (
         user_id, strategy_id, strategy_version, strategy_name, name,
         params_json, rules_json, fee_snapshot_json, initial_cash, cash
       ) VALUES (1, 's', 'v', 'n', 'a', '{}', '{}', '{}', 100, 100)`,
    ).run();
    db.close();

    const res = run(root);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('ABORT');
    expect(res.stderr).toContain('paper_');

    const after = new Database(dbPath, { readonly: true });
    const objects = after
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'paper_%' OR name LIKE 'idx_paper_%' OR name LIKE 'trg_paper_%'`,
      )
      .get() as { n: number };
    expect(objects.n).toBeGreaterThan(0);
    expect((after.prepare(`SELECT COUNT(*) AS n FROM paper_account`).get() as { n: number }).n).toBe(1);
    after.close();
  });

  it('反向往：只有 bt_* 时正常清理（退出码 0、库文件与 schema 保留）', () => {
    const { root, dbPath } = makeRoot();
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE bt_run (id INTEGER PRIMARY KEY, strategy_id TEXT);
      CREATE TABLE bt_equity (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES bt_run(id), equity REAL);
      CREATE INDEX idx_bt_equity_run ON bt_equity(run_id);
    `);
    db.prepare(`INSERT INTO bt_run (id, strategy_id) VALUES (1, 's')`).run();
    db.prepare(`INSERT INTO bt_equity (run_id, equity) VALUES (1, 100)`).run();
    db.close();

    const res = run(root);
    expect(res.status).toBe(0);

    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare(`SELECT COUNT(*) AS n FROM bt_run`).get() as { n: number }).n).toBe(0);
    expect((after.prepare(`SELECT COUNT(*) AS n FROM bt_equity`).get() as { n: number }).n).toBe(0);
    const tables = (
      after.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bt_%'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables.sort()).toEqual(['bt_equity', 'bt_run']);
    after.close();
  });

  it('库文件不存在时安全退出（不创建空库）', () => {
    const { root, dbPath } = makeRoot();
    const res = run(root);
    expect(res.status).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });
});
