/**
 * F4 Step C —— `ignored_at` 幂等补列 + 存量「双 1」归一（采纳优先）
 *
 * 用真实临时库文件（不是 `:memory:`），因为要验证「老库 → 重启 → 补列/归一」的
 * 完整升级路径：同一段构造函数代码既是新库初始化，也是老库升级。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { ConfigStore, normalizeSignalAdoptionFlags } from '../../src/config/configStore.js';

let dir: string;
let dbPath: string;
const origSqlitePath = process.env.SQLITE_DB_PATH;

function resetInstance(): void {
  (ConfigStore as any)._instance = null;
}

function getStore(): ConfigStore {
  return ConfigStore.getInstance();
}

const SIGNAL_INSERT = `INSERT INTO user_strategy_signal
  (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label,
   adopted, ignored, adopted_at, ignored_at)
  VALUES (1, ?, 'rsi_oversold', 'monitor', ?, 'buy', 't', ?, ?, ?, ?)`;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'invest-adoption-mig-'));
  dbPath = path.join(dir, 'mig.db');
  process.env.SQLITE_DB_PATH = dbPath;
  resetInstance();
});

afterEach(() => {
  const store = (ConfigStore as any)._instance as ConfigStore | null;
  store?.db.close();
  resetInstance();
  if (origSqlitePath !== undefined) process.env.SQLITE_DB_PATH = origSqlitePath;
  else delete process.env.SQLITE_DB_PATH;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄未释放时忽略 */
  }
});

function columnNames(store: ConfigStore): string[] {
  return (store.db.prepare('PRAGMA table_info(user_strategy_signal)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe('ignored_at 幂等补列', () => {
  it('老库缺列时自动补回，重复启动不报错', () => {
    const first = getStore();
    expect(columnNames(first)).toContain('ignored_at');

    // 模拟「老库」：直接删掉列（SQLite ≥3.35 支持 DROP COLUMN）
    first.db.exec('ALTER TABLE user_strategy_signal DROP COLUMN ignored_at');
    expect(columnNames(first)).not.toContain('ignored_at');
    first.db.close();
    resetInstance();

    // 第二次启动：走同一条构造函数路径，自动补列
    const second = getStore();
    expect(columnNames(second)).toContain('ignored_at');
    second.db.close();
    resetInstance();

    // 第三次启动：列已存在，仍不报错（幂等），且不会重复加列
    const third = getStore();
    const names = columnNames(third);
    expect(names.filter((n) => n === 'ignored_at')).toHaveLength(1);
  });
});

describe('存量「双 1」归一（采纳优先）', () => {
  it('双 1 行保留 adopted，ignored 清 0 且 ignored_at 置 NULL；重复执行 0 行受影响', () => {
    const store = getStore();
    store.db.pragma('foreign_keys = OFF');
    const insert = store.db.prepare(SIGNAL_INSERT);
    // 2 条双 1（历史脏数据）
    insert.run('sh600000', '2026-01-05', 1, 1, '2026-01-05 09:31:00', '2026-01-05 09:32:00');
    insert.run('sh600519', '2026-01-06', 1, 1, '2026-01-06 09:31:00', '2026-01-06 09:32:00');
    // 1 条仅采纳、1 条仅忽略（不应被动到）
    insert.run('sh601318', '2026-01-07', 1, 0, '2026-01-07 09:31:00', null);
    insert.run('sh510300', '2026-01-08', 0, 1, null, '2026-01-08 09:32:00');

    expect(normalizeSignalAdoptionFlags(store.db)).toBe(2);
    // 幂等：第二次 0 行
    expect(normalizeSignalAdoptionFlags(store.db)).toBe(0);

    const rows = store.db
      .prepare(
        `SELECT asset_code, adopted, ignored, adopted_at, ignored_at
           FROM user_strategy_signal ORDER BY asset_code`,
      )
      .all() as Array<{
      asset_code: string;
      adopted: number;
      ignored: number;
      adopted_at: string | null;
      ignored_at: string | null;
    }>;
    expect(rows).toEqual([
      {
        asset_code: 'sh510300',
        adopted: 0,
        ignored: 1,
        adopted_at: null,
        ignored_at: '2026-01-08 09:32:00',
      },
      {
        asset_code: 'sh600000',
        adopted: 1,
        ignored: 0,
        adopted_at: '2026-01-05 09:31:00',
        ignored_at: null,
      },
      {
        asset_code: 'sh600519',
        adopted: 1,
        ignored: 0,
        adopted_at: '2026-01-06 09:31:00',
        ignored_at: null,
      },
      {
        asset_code: 'sh601318',
        adopted: 1,
        ignored: 0,
        adopted_at: '2026-01-07 09:31:00',
        ignored_at: null,
      },
    ]);
  });

  it('构造 ConfigStore 时自动执行归一（老库升级路径）', () => {
    const store = getStore();
    store.db.pragma('foreign_keys = OFF');
    store.db
      .prepare(SIGNAL_INSERT)
      .run('sh600000', '2026-01-05', 1, 1, '2026-01-05 09:31:00', '2026-01-05 09:32:00');
    store.db.close();
    resetInstance();

    const upgraded = getStore();
    const row = upgraded.db
      .prepare('SELECT adopted, ignored, ignored_at FROM user_strategy_signal')
      .get() as { adopted: number; ignored: number; ignored_at: string | null };
    expect(row).toEqual({ adopted: 1, ignored: 0, ignored_at: null });
  });
});
