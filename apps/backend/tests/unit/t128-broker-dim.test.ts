/**
 * T128 —— `user_trade_record` 券商维度改造 + 三条部分唯一索引（SDD_v3 §11.2 定稿 / INV-S3-11~14）
 *
 * ── 本文件钉死的契约 ──
 *   ① legacy（T87 时代：表级 UNIQUE + trade_time NOT NULL + 无券商三维列）
 *      → 启动触发**幂等表重建**；历史数据**零丢失**（行数 + 关键列逐行相等 + integrity_check）
 *   ② stale-index（表已最终形态、索引仍是 T87b 旧谓词）→ **只重建索引**，不重建表
 *   ③ 新库 → ready（零重建）；同一库二次启动 → 零动作（幂等）
 *   ④ 约束并存（G1）：
 *      - 手工（broker_code IS NULL）同日同标的同类型同时刻 → **UNIQUE 拒绝**（409 语义不变）
 *      - 导入（broker_code NOT NULL）同秒同类型多笔 → **可表达**（不同事实行 broker_seq 互异）
 *      - 同一事实行（source_broker_record_id）两条活记录 → **UNIQUE 拒绝**（回溯幂等）
 *      - 软删导入记录后同 source 可再插入（INV-S2-35：撤销补录后可重新补录）
 *      - trade_time 可空：导入行时间留空不报错（INV-S2-36）
 *
 * ── SQLite 隔离 ──
 *   每个用例自建库、自触发启动、自断言，用例之间零依赖（setup.ts 会还原 env）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t128-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;

const { ConfigStore } = await import('../../src/config/configStore.js');

const IDX_MANUAL = 'idx_user_trade_record_unique_live';
const IDX_SOURCE = 'idx_user_trade_record_broker_source';
const IDX_IDENTITY = 'idx_user_trade_record_broker_identity';

const KEY_COLUMNS = [
  'id',
  'user_id',
  'asset_code',
  'trade_type',
  'trade_date',
  'trade_time',
  'is_deleted',
] as const;

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

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 旧 schema 骨架：T87 时代（表级 UNIQUE + trade_time NOT NULL + 无券商三维列） */
function buildLegacyT87Db(dbPath: string): void {
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
  ins.run('sh600000', 'buy', '2026-05-01', '09:30:00', 0, '2026-05-01 09:30:00');
  ins.run('sh600000', 'add', '2026-05-02', '10:15:00', 0, '2026-05-02 10:15:00');
  ins.run('sz000001', 'reduce', '2026-05-03', '14:45:00', 0, '2026-05-03 14:45:00');
  ins.run('sz000002', 'buy', '2026-05-04', '09:35:00', 1, '2026-05-04 09:35:00'); // 软删
  legacy.close();
}

function readKeyRows(db: Database.Database, withBrokerCol: boolean): Array<Record<string, unknown>> {
  const cols = KEY_COLUMNS.join(', ') + (withBrokerCol ? ', broker_code' : '');
  return db.prepare(`SELECT ${cols} FROM user_trade_record ORDER BY id ASC`).all() as Array<
    Record<string, unknown>
  >;
}

afterAll(() => {
  if (ORIG_SQLITE_PATH) process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('T128 user_trade_record 券商维度改造（SDD_v3 §11.2 定稿）', () => {
  it('① legacy（T87 形态）→ 幂等表重建；历史数据零丢失；券商维度列就位', () => {
    const dir = makeTempDir('t128-legacy-');
    const dbPath = path.join(dir, 'main.db');
    buildLegacyT87Db(dbPath);

    // 重建前快照（旧表无 broker_code 列 ⇒ 关键列对比不含它）
    const pre = new Database(dbPath);
    const beforeRows = readKeyRows(pre, false);
    expect(beforeRows.length).toBe(4);
    pre.close();

    const { store, rebuildCalls } = runStartup(dbPath);
    expect(rebuildCalls).toBe(1); // legacy 必须重建

    const db = store.db;
    // 零丢失（G2）：行数 + 关键列逐行相等；broker 维度全 NULL（手工形态）
    const afterRows = readKeyRows(db, false);
    expect(afterRows.length).toBe(beforeRows.length);
    expect(JSON.stringify(afterRows)).toBe(JSON.stringify(beforeRows));
    const withBroker = (
      db.prepare(`SELECT COUNT(*) c FROM user_trade_record WHERE broker_code IS NOT NULL`).get() as {
        c: number;
      }
    ).c;
    expect(withBroker).toBe(0); // 存量全为手工形态（broker 维度 NULL）
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    // 三条部分唯一索引就位
    const list = db.prepare('PRAGMA index_list(user_trade_record)').all() as Array<{ name: string }>;
    const names = list.map((i) => i.name);
    expect(names).toContain(IDX_MANUAL);
    expect(names).toContain(IDX_SOURCE);
    expect(names).toContain(IDX_IDENTITY);

    // trade_time 已可空
    const tt = (
      db.prepare("PRAGMA table_info('user_trade_record')").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === 'trade_time');
    expect(tt?.notnull).toBe(0);
    closeConfigStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('② legacy 迁移后的约束并存语义（G1）：手工同刻仍拒 / 导入同秒可表达 / 回溯锚幂等', () => {
    const dir = makeTempDir('t128-constraints-');
    const dbPath = path.join(dir, 'main.db');
    buildLegacyT87Db(dbPath);
    const { store } = runStartup(dbPath);
    const db = store.db;

    // 启动后事实表已由 DDL_SQL 建出（空）；source_broker_record_id 是 FK，
    // 先补三行事实父行（101 / 102 / 201）供约束用例引用
    db.prepare(
      `INSERT INTO broker_import_batch
       (user_id, broker_code, file_kind, encoding, file_name, file_hash, file_size, parser_version, status)
       VALUES (1, 'hb', 'settlement', 'utf8', 'f.xls', 'hash-t128', 1, 'v3.1.0', 'imported')`,
    ).run();
    for (const fid of [101, 102, 201]) {
      db.prepare(
        `INSERT INTO broker_trade_record
         (id, user_id, import_batch_id, broker_code, source_kind, event_type, asset_code, trade_date,
          price, quantity, cash_flow, match_status, raw_row_json, row_hash, content_seq)
         VALUES (?, 1, 1, 'hb', 'broker', 'TRADE_SELL', 'sh688001', '2026-05-05',
                 33.58, 100, -3358, 'MISSING', '{}', 'h?', ?)`,
      ).run(fid, fid === 201 ? 0 : fid - 101);
    }

    // (a) 手工同刻重复 → UNIQUE 拒绝（409 语义由 HTTP 层承袭，此处钉 DB 层）
    const manualDup = db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price)
       VALUES (1, 'sh600000', 'buy', '2026-05-01', '09:30:00', 50, 9.9)`,
    );
    expect(() => manualDup.run()).toThrow(/UNIQUE/);

    // (b) 导入同秒同类型多笔（不同事实行，broker_seq 互异）→ 都成功（INV-S3-13）
    //     ⚠️ user_trade_record 的 trade_type 枚举只有 7 种（买卖在业务层用 buy/reduce 表达）
    const insImported = db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price,
        broker_code, broker_seq, source_broker_record_id, is_auto_import)
       VALUES (1, 'sh688001', 'reduce', '2026-05-05', '09:31:00', 100, 33.58, 'hb', ?, ?, 1)`,
    );
    insImported.run(0, 101);
    insImported.run(1, 102); // 同秒第二笔：seq 不同 → 允许
    const sameSec = db
      .prepare(
        `SELECT COUNT(*) c FROM user_trade_record
          WHERE user_id = 1 AND asset_code = 'sh688001' AND trade_time = '09:31:00' AND broker_code = 'hb'`,
      )
      .get() as { c: number };
    expect(sameSec.c).toBe(2);

    // (c) 同一事实行两条活记录 → 源锚 UNIQUE 拒绝（回溯幂等）
    const anchorDup = db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price,
        broker_code, broker_seq, source_broker_record_id, is_auto_import)
       VALUES (1, 'sh688001', 'reduce', '2026-05-05', '09:31:00', 100, 33.58, 'hb', 0, 101, 1)`,
    );
    expect(() => anchorDup.run()).toThrow(/UNIQUE/);

    // (d) 软删导入记录后，同一 source 可再插入（INV-S2-35：撤销补录后可重新补录）
    db.prepare(`UPDATE user_trade_record SET is_deleted = 1 WHERE source_broker_record_id = 101`).run();
    expect(() => anchorDup.run()).not.toThrow();

    // (e) trade_time 可空（INV-S2-36：导入无时间留空，不填假时间）
    db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price,
        broker_code, broker_seq, source_broker_record_id, is_auto_import)
       VALUES (1, 'sh600519', 'add', '2026-05-06', NULL, 10, 1400, 'hb', 0, 201, 1)`,
    ).run();
    const nullTime = db
      .prepare(`SELECT trade_time FROM user_trade_record WHERE source_broker_record_id = 201`)
      .get() as { trade_time: string | null };
    expect(nullTime.trade_time).toBeNull();
    closeConfigStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('③ stale-index（T87b 旧谓词索引 + 已有券商列）→ 只重建索引，不重建表', () => {
    const dir = makeTempDir('t128-stale-');
    const dbPath = path.join(dir, 'main.db');
    buildLegacyT87Db(dbPath);
    runStartup(dbPath); // 一次到位
    closeConfigStore();

    // 把索引降级回 T87b 旧形态：手工索引谓词少了 broker_code IS NULL，且删掉 B/C
    const down = new Database(dbPath);
    down.exec(`DROP INDEX ${IDX_MANUAL};
       CREATE UNIQUE INDEX ${IDX_MANUAL}
         ON user_trade_record(user_id, asset_code, trade_type, trade_date, trade_time)
         WHERE is_deleted = 0;`);
    const beforeRows = readKeyRows(down);
    down.close();

    const { store, rebuildCalls } = runStartup(dbPath);
    expect(rebuildCalls).toBe(0); // 表已最终形态 → 不重建
    const db = store.db;
    expect(readKeyRows(db)).toEqual(beforeRows); // 数据原样

    const a = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(IDX_MANUAL) as {
      sql: string;
    };
    expect(a.sql).toMatch(/broker_code\s+IS\s+NULL/); // 新谓词就位
    closeConfigStore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('④ 新库直接 ready，二次启动零动作（幂等）', () => {
    const dir = makeTempDir('t128-fresh-');
    const dbPath = path.join(dir, 'main.db');
    const { store, rebuildCalls } = runStartup(dbPath);
    expect(rebuildCalls).toBe(0);
    const list = store.db.prepare('PRAGMA index_list(user_trade_record)').all() as Array<{ name: string }>;
    const names = list.map((i) => i.name);
    for (const idx of [IDX_MANUAL, IDX_SOURCE, IDX_IDENTITY]) expect(names).toContain(idx);
    closeConfigStore();

    const { rebuildCalls: second } = runStartup(dbPath);
    expect(second).toBe(0);
    closeConfigStore();
    rmSync(dir, { recursive: true, force: true });
  });
});
