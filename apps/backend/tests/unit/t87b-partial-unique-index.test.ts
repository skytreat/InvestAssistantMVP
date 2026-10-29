/**
 * T87b —— `user_trade_record` 唯一键改为**部分唯一索引**（`WHERE is_deleted = 0`）
 *
 * ── 修的是什么 P0 数据缺陷 ──
 *   旧表级约束 `UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time)`
 *   **不含 is_deleted** ⇒ **软删记录永久占用交易唯一键**。用户可见症状：
 *     ① 软删一笔交易后，同一标的/类型/日期/时刻**再也录不进去**（提交必 409 TRADE_DUPLICATE）；
 *     ② 但 `GET /api/trade` 过滤了 `is_deleted = 0` ⇒ **用户看不到那条记录**；
 *     ⇒ 「列表里没有这一笔，但系统说重复」—— 典型的**幽灵占用**。
 *
 *   修法：SQLite 的**表级 UNIQUE 无法部分化**（不支持 WHERE 条件）
 *   ⇒ 必须去掉表级约束 + 改用部分唯一索引 `WHERE is_deleted = 0`。
 *
 * ── 本文件钉死的契约 ──
 *   ① 软删后同键**可再插入成功**（幽灵占用消失）
 *   ② 未软删时同键**仍被拒**（唯一性没丢）
 *   ③ 幂等：同一库连续两次启动 ⇒ **只重建一次**，第二次零动作
 *   ④ 数据完好：重建前后**行数相等** + `integrity_check = ok` + **关键字段逐行相等**
 *   ⑤ 部分索引真的生效：`PRAGMA index_list` 能查到 + `EXPLAIN QUERY PLAN` 走 `USING INDEX` 且**不扫表**
 *   ⑥ 新建库**直接就是新 schema**（不触发重建）
 *   ⑦ 预检端点口径同步：软删后 `taken:false`；未软删 `taken:true`
 *
 * ── SQLite 隔离 ──
 *   `mkdtempSync` 临时库 + 覆盖 `SQLITE_DB_PATH`（必须在 import ConfigStore 之前）。
 *   本文件**不触碰 DuckDB**（只读写 SQLite）⇒ CI 无行情库也能全绿。
 *
 * ── ⚠️ 为什么每个用例都「自建库 + 自己跑一次启动」──
 *   `tests/setup.ts` 的**文件级 afterEach 会把 `SQLITE_DB_PATH` 还原成文件基线**，
 *   ⇒ 跨用例依赖「上一个用例设的 env」必然被还原打脸（T81 顺序守卫的同类坑）。
 *   故：每个用例自己造库、自己触发启动、自己断言，**用例之间零依赖**。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── SQLite 隔离（必须在 import ConfigStore 之前设置）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t87b-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
const MAIN_DB_PATH = path.join(TMP_DIR, 't87b-main.db');
process.env.SQLITE_DB_PATH = MAIN_DB_PATH;

// 存在性判定源 = DuckDB raw_symbol_class：mock 返回空（本文件专注部分唯一索引，不做存在性判定）
const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerRoutes } = await import('../../src/routes/index.js');
const { TRADE_TIME_OCCUPANCY_SQL } = await import('../../src/routes/trade.js');
const { signToken } = await import('../../src/services/auth.js');

/** 部分唯一索引名（与 configStore.ts / SDD §3.2 一致，改名 = 契约漂移） */
const UNIQUE_INDEX_NAME = 'idx_user_trade_record_unique_live';

/** 关键字段（重建前后必须逐行相等） */
const KEY_COLUMNS = [
  'id',
  'user_id',
  'asset_code',
  'trade_type',
  'trade_date',
  'trade_time',
  'is_deleted',
] as const;

/** 读表定义文本 */
function tableDdl(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
    .get() as { sql: string } | undefined;
  return row?.sql ?? '';
}

/** 读关键字段（按 id 升序） */
function readKeyRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare(`SELECT ${KEY_COLUMNS.join(', ')} FROM user_trade_record ORDER BY id ASC`).all() as Array<
    Record<string, unknown>
  >;
}

/** 造一个「旧 schema」库：表级 UNIQUE 约束 + 无部分唯一索引 */
function buildLegacyDb(dbPath: string): void {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE user_account (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE CHECK(length(username) >= 3 AND length(username) <= 32),
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE user_trade_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      asset_code TEXT NOT NULL,
      trade_type TEXT NOT NULL CHECK (
        trade_type IN ('buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer')
      ),
      trade_date TEXT NOT NULL,
      trade_time TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity >= 0),
      price REAL NOT NULL CHECK (price >= 0),
      fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
      trade_reason TEXT,
      is_auto_import INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_import IN (0, 1)),
      is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
      review_summary TEXT,
      system_followed INTEGER CHECK (system_followed IS NULL OR system_followed IN (0, 1)),
      strategy_match INTEGER CHECK (strategy_match IS NULL OR strategy_match IN (0, 1)),
      is_stop_loss INTEGER CHECK (is_stop_loss IS NULL OR is_stop_loss IN (0, 1)),
      remark TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time),
      FOREIGN KEY (user_id) REFERENCES user_account(id)
    );
    CREATE INDEX idx_trade_user_date ON user_trade_record(user_id, trade_date DESC);
    CREATE INDEX idx_trade_asset ON user_trade_record(user_id, asset_code);
  `);
  legacy
    .prepare(
      "INSERT INTO user_account (id, username, password_hash, role) VALUES (1, 'legacy_user', 'dummy-hash', 'user')",
    )
    .run();
  const ins = legacy.prepare(
    `INSERT INTO user_trade_record
      (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted, created_at)
     VALUES (1, ?, ?, ?, ?, 100, 10, 0, ?, ?)`,
  );
  // 活记录 ×3（键各不相同）
  ins.run('sh600000', 'buy', '2026-05-01', '09:30:00', 0, '2026-05-01 09:30:00');
  ins.run('sh600000', 'add', '2026-05-02', '10:15:00', 0, '2026-05-02 10:15:00');
  ins.run('sz000001', 'reduce', '2026-05-03', '14:45:00', 0, '2026-05-03 14:45:00');
  // 🔴 软删记录 ×1 —— 旧 schema 下它会**永久占用**自己的键
  ins.run('sz000002', 'buy', '2026-05-04', '09:35:00', 1, '2026-05-04 09:35:00');
  legacy.close();
}

/** 关闭当前 ConfigStore 连接并清空单例 */
function closeConfigStore(): void {
  const inst = (ConfigStore as unknown as { _instance: { db?: Database.Database } | null })._instance;
  if (inst?.db) {
    try {
      inst.db.close();
    } catch {
      /* ignore */
    }
  }
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
}

/**
 * 模拟「后端启动一次」：切库 → 触发 ConfigStore 初始化 → 返回本次启动的**重建次数**
 *
 * ⚠️ 重建次数必须在**同一次同步调用内**抓取（`spy.mock.calls.length` 立刻读），
 *   不能留到下一个用例再读 —— `tests/setup.ts` 的 afterEach 会还原 env。
 */
function runStartup(dbPath: string): {
  store: ReturnType<typeof ConfigStore.getInstance>;
  rebuildCalls: number;
} {
  closeConfigStore();
  process.env.SQLITE_DB_PATH = dbPath;
  const spy = vi.spyOn(ConfigStore.prototype as never, '_rebuildTradeRecordTable' as never);
  try {
    const store = ConfigStore.getInstance();
    const rebuildCalls = (spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    return { store, rebuildCalls };
  } finally {
    (spy as unknown as { mockRestore: () => void }).mockRestore();
  }
}

/** 造一个用完即弃的临时目录 */
function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

afterAll(() => {
  closeConfigStore();
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * 🔴 幂等表重建（旧表级 UNIQUE → 部分唯一索引）
 *
 * 每个用例**自建一个旧 schema 库**并自己触发一次启动 ⇒ 用例之间零依赖。
 */
describe('T87b · 幂等表重建：旧表级 UNIQUE → 部分唯一索引', () => {
  it('旧库启动 → 触发一次重建：表级 UNIQUE 消失 + 部分唯一索引出现', () => {
    const dir = makeTempDir('invest-t87b-legacy-');
    const dbPath = path.join(dir, 'legacy.db');
    try {
      buildLegacyDb(dbPath);

      const { store, rebuildCalls } = runStartup(dbPath);
      expect(rebuildCalls, '旧库必须触发一次重建').toBe(1);

      const db = store.db;
      expect(/UNIQUE\s*\(/i.test(tableDdl(db)), '表定义里不应再有表级 UNIQUE 约束').toBe(false);

      const list = db.prepare('PRAGMA index_list(user_trade_record)').all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>;
      const meta = list.find((i) => i.name === UNIQUE_INDEX_NAME);
      expect(meta, '部分唯一索引应存在').toBeTruthy();
      expect(meta!.unique).toBe(1);
      expect(meta!.partial).toBe(1);

      const idxSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
          .get(UNIQUE_INDEX_NAME) as {
          sql: string;
        }
      ).sql;
      expect(idxSql).toMatch(/WHERE\s+is_deleted\s*=\s*0/i);
    } finally {
      closeConfigStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('数据完好：行数相等 + integrity_check=ok + 关键字段逐行相等', () => {
    const dir = makeTempDir('invest-t87b-legacy-');
    const dbPath = path.join(dir, 'legacy.db');
    try {
      buildLegacyDb(dbPath);

      // 迁移前快照（独立连接读）
      const probe = new Database(dbPath, { readonly: true });
      const beforeRows = readKeyRows(probe);
      const beforeCount = (
        probe.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get() as { c: number }
      ).c;
      probe.close();

      const { store } = runStartup(dbPath);
      const db = store.db;

      const afterCount = (db.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get() as { c: number }).c;
      expect(afterCount, '迁移后行数必须与迁移前一致（不丢行）').toBe(beforeCount);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      const afterRows = readKeyRows(db);
      expect(afterRows.length).toBe(beforeRows.length);
      for (let i = 0; i < beforeRows.length; i++) {
        for (const col of KEY_COLUMNS) {
          expect(afterRows[i][col], `第 ${i + 1} 行 ${col} 必须原样保留`).toBe(beforeRows[i][col]);
        }
      }
    } finally {
      closeConfigStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('幂等：同一库连续启动两次 ⇒ 只重建一次，第二次零动作且数据不丢', () => {
    const dir = makeTempDir('invest-t87b-legacy-');
    const dbPath = path.join(dir, 'legacy.db');
    try {
      buildLegacyDb(dbPath);

      const first = runStartup(dbPath);
      expect(first.rebuildCalls, '首次启动应重建一次').toBe(1);
      const rowsAfterFirst = readKeyRows(first.store.db);

      const second = runStartup(dbPath);
      expect(second.rebuildCalls, '已是新 schema ⇒ 第二次启动不得再重建').toBe(0);

      // 数据仍然完好
      const afterCount = (
        second.store.db.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get() as {
          c: number;
        }
      ).c;
      expect(afterCount).toBe(rowsAfterFirst.length);
      expect(readKeyRows(second.store.db)).toEqual(rowsAfterFirst);
    } finally {
      closeConfigStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('新库直接就是新 schema：新建库时**不触发重建**', () => {
    const dir = makeTempDir('invest-t87b-fresh-');
    const dbPath = path.join(dir, 'fresh.db');
    try {
      const { store, rebuildCalls } = runStartup(dbPath);
      expect(rebuildCalls, '新建库不得触发表重建（CREATE TABLE 原定义已是新 schema）').toBe(0);

      const db = store.db;
      expect(/UNIQUE\s*\(/i.test(tableDdl(db)), '新库表定义里不应有表级 UNIQUE').toBe(false);
      const list = db.prepare('PRAGMA index_list(user_trade_record)').all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>;
      const meta = list.find((i) => i.name === UNIQUE_INDEX_NAME);
      expect(meta, '新库应直接带部分唯一索引').toBeTruthy();
      expect(meta!.unique).toBe(1);
      expect(meta!.partial).toBe(1);
    } finally {
      closeConfigStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 🔴 部分唯一索引的**行为**（修的核心）
 *
 * 用主库（新 schema）验证：软删后同键可再插入；未软删时同键仍被拒。
 */
describe('T87b · 部分唯一索引行为', () => {
  const USER_ID = 8801;

  function openMainDb(): Database.Database {
    closeConfigStore();
    process.env.SQLITE_DB_PATH = MAIN_DB_PATH;
    const store = ConfigStore.getInstance();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')",
      )
      .run(USER_ID, 't87b_user');
    return store.db;
  }

  it('软删后可再插入同键成功（幽灵占用消失）', () => {
    const db = openMainDb();
    const info = db
      .prepare(
        `INSERT INTO user_trade_record
          (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
         VALUES (?, 'szPU0001', 'buy', '2026-06-01', '09:00:00', 100, 10, 0, 0)`,
      )
      .run(USER_ID);
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(info.lastInsertRowid);

    // 软删后同键**必须能**再插入
    expect(() =>
      db
        .prepare(
          `INSERT INTO user_trade_record
            (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
           VALUES (?, 'szPU0001', 'buy', '2026-06-01', '09:00:00', 200, 11, 0, 0)`,
        )
        .run(USER_ID),
    ).not.toThrow();

    // 两条都在库里：一条软删、一条活
    const rows = db
      .prepare('SELECT is_deleted FROM user_trade_record WHERE user_id = ? AND asset_code = ? ORDER BY id')
      .all(USER_ID, 'szPU0001') as Array<{ is_deleted: number }>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.is_deleted).sort()).toEqual([0, 1]);
  });

  it('未软删时同键仍被拒（唯一性没丢）', () => {
    const db = openMainDb();
    db.prepare(
      `INSERT INTO user_trade_record
        (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, 'szPU0002', 'buy', '2026-06-02', '10:00:00', 100, 10, 0, 0)`,
    ).run(USER_ID);
    expect(() =>
      db
        .prepare(
          `INSERT INTO user_trade_record
            (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
           VALUES (?, 'szPU0002', 'buy', '2026-06-02', '10:00:00', 200, 11, 0, 0)`,
        )
        .run(USER_ID),
    ).toThrow(/UNIQUE/);
  });

  it('部分索引真的生效：PRAGMA index_list 查得到 + EXPLAIN 走索引且不扫表', () => {
    const db = openMainDb();
    const list = db.prepare('PRAGMA index_list(user_trade_record)').all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const meta = list.find((i) => i.name === UNIQUE_INDEX_NAME);
    expect(meta, 'PRAGMA index_list 应能查到部分唯一索引').toBeTruthy();
    expect(meta!.unique).toBe(1);
    expect(meta!.partial).toBe(1);

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${TRADE_TIME_OCCUPANCY_SQL}`)
      .all(USER_ID, 'szPU0003', 'buy', '2026-06-03', '11:00:00') as Array<{ detail: string }>;
    expect(plan.length).toBeGreaterThan(0);
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail, '预检必须走部分唯一索引').toContain('USING INDEX');
    expect(detail).toContain(UNIQUE_INDEX_NAME);
    expect(detail, '不得扫表').not.toContain('SCAN');
  });
});

/**
 * 🔴 预检端点口径同步（T87b 修完 DDL 后必须闭环）
 *
 * 旧口径（唯一键含软删记录）下预检**刻意不加** `is_deleted = 0`；
 * 修完 DDL 后软删记录不再占用唯一键 ⇒ 预检**必须**加回 `is_deleted = 0`，
 * 否则会造出「预检说占用、提交却成功」的新矛盾。
 */
describe('T87b · 预检端点口径同步', () => {
  const USER_ID = 8802;
  let app: FastifyInstance;
  let db: Database.Database;
  let token: string;

  beforeAll(async () => {
    closeConfigStore();
    process.env.SQLITE_DB_PATH = MAIN_DB_PATH;
    // 默认放行：mock raw_symbol_class 返回空（本文件专注部分唯一索引/预检端点，不做存在性判定）
    queryDuckDBMock.mockImplementation(async () => []);
    app = Fastify({ logger: false });
    await registerRoutes(app);
    db = ConfigStore.getInstance().db;
    db.prepare(
      "INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')",
    ).run(USER_ID, 't87b_pre');
    token = signToken({ sub: USER_ID, username: 't87b_pre', role: 'user' });
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  async function check(params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params);
    const res = await app.inject({
      method: 'GET',
      url: `/api/trade/check-duplicate?${qs.toString()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('未软删 → taken:true', async () => {
    db.prepare(
      `INSERT INTO user_trade_record
        (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, 'szPRECK1', 'buy', '2026-07-01', '09:00:00', 100, 10, 0, 0)`,
    ).run(USER_ID);
    const { status, body } = await check({
      asset_code: 'szPRECK1',
      trade_type: 'buy',
      trade_date: '2026-07-01',
      trade_time: '09:00:00',
    });
    expect(status).toBe(200);
    expect(body.data.taken).toBe(true);
  });

  it('软删后 → taken:false（与「同键可再录入」的实际行为一致）', async () => {
    const info = db
      .prepare(
        `INSERT INTO user_trade_record
          (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
         VALUES (?, 'szPRECK2', 'buy', '2026-07-02', '10:00:00', 100, 10, 0, 0)`,
      )
      .run(USER_ID);
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(info.lastInsertRowid);

    const { status, body } = await check({
      asset_code: 'szPRECK2',
      trade_type: 'buy',
      trade_date: '2026-07-02',
      trade_time: '10:00:00',
    });
    expect(status).toBe(200);
    expect(body.data.taken, '软删记录不再占用唯一键 ⇒ 预检必须报 taken:false').toBe(false);

    // 闭环验证：预检说「未占用」⇒ 实际提交也必须成功（201）
    const post = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        asset_code: 'szPRECK2',
        trade_type: 'buy',
        trade_date: '2026-07-02',
        trade_time: '10:00:00',
        quantity: 100,
        price: 10,
        trade_reason: '软删后重新录入',
      },
    });
    expect(post.statusCode, '预检 taken:false ⇒ 提交必须成功（口径闭环）').toBe(201);
  });
});
