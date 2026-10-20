/**
 * tradeTypeContract.test.ts — 交易类型白名单 ↔ DDL CHECK **契约测试**
 *
 * 🔴 本次 bug 的根因：`routes/trade.ts` 的白名单曾写成
 *   `['buy','sell','reduce','clear','dividend','bonus','transfer']`
 *   —— 含 DDL **不认**的 `'sell'`、漏了 DDL **认**的 `'add'`：
 *     ① `trade_type='sell'` → INSERT 撞 CHECK → 500 + 裸 SQLite 报错外泄
 *     ② `trade_type='add'`（前端「加仓」）→ 400 PARAM_INVALID（线上入口是坏的）
 *
 * 本文件把「白名单 = DDL CHECK = Requirements §5.1 的 7 种」**锁死**，防止再次漂移：
 *   ① 运行时 DDL（sqlite_master）CHECK 集合 ≡ 路由白名单（逐项相等，双向）
 *   ② 源文件 `configStore.ts` 里**所有** `trade_type IN (...)` 出现处彼此一致且 ≡ 运行时
 *   ③ 白名单内容 ≡ Requirements §5.1 的 7 种（**硬编码字面量**，独立于被测常量 → 不自证）
 *   ④ `'sell'` 入库被 CHECK 拒绝（证明 DDL 侧确实不认它）
 *   ⑤ 加仓（`'add'`）落库后：持仓数量增加、均价按移动加权成本重算
 *
 * ⚠️ 为什么解析**运行时 DDL**（sqlite_master）而不是只读源文件：
 *   生效的表可能是**旧库迁移重建**出来的（`_ensureTradeRecordUniqueConstraint`
 *   的空表重建 DDL，与 `CREATE TABLE` 是两段不同的字符串），
 *   读 sqlite_master 拿到的是**数据库里真正生效的那份约束** —— 与「能不能写进去」直接对应。
 *   源文件解析作为**补充**（第 ② 条），用于保证 CREATE TABLE 与重建 DDL 两处不各写各的。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// --- 必须在 import src 之前设置 SQLITE_DB_PATH，让 ConfigStore 指向临时库 ---
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-trade-type-contract-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { TRADE_TYPES } from '../../src/routes/trade.js';
import { calcPosition, calcClosedTradePnLs } from '../../src/services/positionCalculator.js';

/**
 * Requirements §5.1 的 7 种交易类型（**硬编码字面量**）
 *
 * 故意不从被测常量派生 —— 若从 `TRADE_TYPES` 派生，契约测试就变成「自己和自己比」，
 * 白名单被改错时反而全绿。独立字面量才是真正的外部锚点。
 */
const REQUIREMENTS_TYPES = ['buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'];

const CONFIG_STORE_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/config/configStore.ts',
);

/** 从 `trade_type IN ('a', 'b')` 片段里抠出类型集合 */
function parseTradeTypeIn(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** 从一段 DDL 文本里提取 `trade_type IN (...)` 的类型集合（未找到 → 空数组） */
function extractTradeTypes(ddl: string): string[] {
  const m = /trade_type\s+IN\s*\(([^)]*)\)/i.exec(ddl);
  return m ? parseTradeTypeIn(m[1]) : [];
}

let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(() => {
  db = ConfigStore.getInstance();
});

afterAll(() => {
  try {
    (db.db as any).close();
  } catch {
    /* ignore */
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('契约 · 路由白名单 ≡ DDL CHECK', () => {
  it('运行时 DDL（sqlite_master）的 CHECK 集合 ≡ 路由白名单（逐项相等）', () => {
    const row = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
      .get() as { sql: string };
    expect(row.sql, 'user_trade_record 表定义应存在').toBeTruthy();

    const ddlTypes = extractTradeTypes(row.sql).sort();
    expect(ddlTypes.length, 'DDL 里应能解析出 trade_type CHECK 列表').toBeGreaterThan(0);
    expect(ddlTypes).toEqual([...TRADE_TYPES].sort());
  });

  it('白名单 ≡ Requirements §5.1 的 7 种（含 add、不含 sell）', () => {
    expect([...TRADE_TYPES].sort()).toEqual([...REQUIREMENTS_TYPES].sort());
    expect(TRADE_TYPES).toContain('add');
    expect(TRADE_TYPES).not.toContain('sell');
    expect(TRADE_TYPES.length).toBe(7);
  });

  it('configStore.ts 里所有 trade_type IN (...) 出现处彼此一致，且 ≡ 运行时 DDL', () => {
    const src = fs.readFileSync(CONFIG_STORE_SRC, 'utf-8');
    const occurrences = [...src.matchAll(/trade_type\s+IN\s*\(([^)]*)\)/gi)].map((m) =>
      parseTradeTypeIn(m[1]).sort(),
    );
    expect(occurrences.length, 'configStore.ts 至少应有 1 处 trade_type CHECK').toBeGreaterThan(0);
    for (const occ of occurrences) {
      expect(occ).toEqual([...REQUIREMENTS_TYPES].sort());
    }
    // 与运行时（真正生效的）DDL 对齐
    const row = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
      .get() as { sql: string };
    expect(extractTradeTypes(row.sql).sort()).toEqual(occurrences[0]);
  });
});

describe('DDL 层 · 7 种类型可写、sell 不可写', () => {
  const uid = 8801;
  const code = 'szCT0001';

  beforeAll(() => {
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
  });

  it("'sell' 被 CHECK 拒绝（DDL 不认它 → 路由必须在入口拦下）", () => {
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO user_trade_record
           (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
           VALUES (?, ?, 'sell', '2025-01-01', '09:30:00', 100, 10.0, 0, 0)`,
        )
        .run(uid, code),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("'add' 可写（DDL 认它）", () => {
    expect(() =>
      db.db
        .prepare(
          `INSERT INTO user_trade_record
           (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
           VALUES (?, ?, 'add', '2025-01-02', '09:30:00', 10, 10.0, 0, 0)`,
        )
        .run(uid, code),
    ).not.toThrow();
  });
});

describe('加仓（add）· 持仓数量增加 + 均价按移动加权成本重算', () => {
  const uid = 8802;
  const code = 'szCT0002';

  beforeAll(() => {
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    // 建仓 100@10，手续费 5 → 成本 1005，持仓 100，均价 10.05
    insert.run(uid, code, 'buy', '2025-02-01', '09:31:00', 100, 10.0, 5);
    // 加仓 100@12，手续费 5 → 成本 1205
    insert.run(uid, code, 'add', '2025-02-02', '09:31:00', 100, 12.0, 5);
  });

  it('持仓数量 100 → 200（加仓后增加，不是归零）', () => {
    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(200);
  });

  it('均价按移动加权成本重算：(100*10+5 + 100*12+5) / 200 = 11.05', () => {
    const pos = calcPosition(uid, code);
    expect(pos.totalCostBasis).toBeCloseTo(100 * 10 + 5 + (100 * 12 + 5), 6);
    expect(pos.avgCost).toBeCloseTo(2210 / 200, 6);
  });

  it("'add' 不是平仓：calcClosedTradePnLs 不应把加仓记成已实现盈亏", () => {
    const closed = calcClosedTradePnLs(uid);
    expect(
      closed.some((c) => c.trade_type === 'add'),
      '加仓不得被记成平仓交易',
    ).toBe(false);
    expect(closed.length, '只有买入 + 加仓 → 无平仓记录').toBe(0);
  });
});

describe('加仓（add）+ 减仓 · 已实现盈亏按卖出时点的移动加权均价计', () => {
  const uid = 8803;
  const code = 'szCT0003';

  beforeAll(() => {
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(uid, `user_${uid}`, 'dummy-hash');
    const insert = db.db.prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    insert.run(uid, code, 'buy', '2025-03-01', '09:32:00', 100, 10.0, 0); // 成本 1000
    insert.run(uid, code, 'add', '2025-03-02', '09:32:00', 100, 20.0, 0); // 成本 2000 → 均价 15
    insert.run(uid, code, 'reduce', '2025-03-03', '09:32:00', 50, 18.0, 0); // 收入 900 − 成本 750 = 150
  });

  it('平仓记录是 reduce（不是 add），已实现盈亏 = 150', () => {
    const closed = calcClosedTradePnLs(uid);
    expect(closed.length).toBe(1);
    expect(closed[0].trade_type).toBe('reduce');
    expect(closed[0].quantity).toBe(50);
    expect(closed[0].realized_pnl).toBeCloseTo(150, 6);
  });

  it('剩余持仓 150 股，均价仍为 15（卖出不改均价）', () => {
    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(150);
    expect(pos.avgCost).toBeCloseTo(15, 6);
  });
});
