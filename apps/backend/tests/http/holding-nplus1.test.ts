/**
 * tests/http/holding-nplus1.test.ts —— **N+1 消除验收（计划 §12.7 T60 ③）**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📖 **计划 §12.7「未完成验收项 → 归属门槛」表 T60 ③（逐字照抄）**
 * ════════════════════════════════════════════════════════════════════════
 *   「`calcAllPositions` 的 N+1 消除（实测仍是 `codes.map(c => calcPosition(...))`）
 *     ⇒ 30 只持仓的持仓查询**查询次数不随标的数线性增长**（**spy 计数**）」
 *
 * ── 判据怎么落地 ──
 *   ① **SQLite 侧**（N+1 的真正所在地）：`calcAllPositions` 原实现是
 *      `codes.map(c => calcPosition(userId, c.asset_code))` ⇒ **每个标的一次查询**
 *      （30 只持仓 = 1 次 DISTINCT + 30 次单标的查询 = 31 次）。
 *      ⇒ 现在是 **1 次查询**取回全部成交记录 + 内存分组 ⇒ **恒为 1 次**。
 *   ② **DuckDB 侧**（AGENTS.md「批量查询必须一次拿 100+ 标的」）：
 *      `/api/holding` 走 `batchGetLatestAndPrevClose`（1 次 IN 查询）+ `batchGetSymbolNames`
 *      （1 次 IN 查询）⇒ **恒为 2 次**，与标的数无关。
 *
 *   ⇒ **断言方式 = spy 计数 + 规模对照**：
 *      同一套夹具分别造 **5 只** 与 **30 只** 持仓，各打一次 `GET /api/holding`，
 *      断言两次的**查询次数完全相同**（这才叫「不随标的数线性增长」——
 *      只断言「≤ 某个数」无法排除「常数变大」）。
 *
 * ── spy 怎么做的 ──
 *   · **SQLite**：把 `ConfigStore` 的 better-sqlite3 实例上的 `prepare` 方法**临时替换**成
 *     计数版（记录每次 prepare 的 SQL 文本），测完立刻还原 ⇒ 不污染其它用例。
 *   · **DuckDB**：`vi.mock('../../src/db/duckdb.js')` 包一层计数（`vi.hoisted` 拿到跨模块
 *     可见的数组），内部仍调用真实实现 ⇒ **不 mock 掉真实行为**，只观测调用次数。
 *
 * ⚠️ **口径提醒**：SQLite 侧的「查询次数」= `prepare` 次数（一次 prepare 对应一条语句执行）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * 🔴 DuckDB 查询计数（`vi.hoisted` —— 必须在 import 之前提升，否则 mock 工厂里取不到）
 */
const { duckdbCalls } = vi.hoisted(() => ({ duckdbCalls: [] as string[] }));

vi.mock('../../src/db/duckdb.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/duckdb.js')>();
  return {
    ...actual,
    queryDuckDB: async (sql: string, params?: unknown[]) => {
      duckdbCalls.push(sql);
      return actual.queryDuckDB(sql, params);
    },
    queryDuckDBColumnar: async (sql: string, params?: unknown[]) => {
      duckdbCalls.push(sql);
      return actual.queryDuckDBColumnar(sql, params);
    },
  };
});

import {
  assertRealListen,
  createHttpApp,
  getDb,
  seedHoldings,
  seedUser,
  type HttpTestApp,
} from './_helpers.js';

/** 小规模（对照组） */
const SMALL_N = 5;
/** 计划 §12.7 T60 ③ 指定的规模 */
const BIG_N = 30;

let http: HttpTestApp;

/** 两个测试用户（一个 5 只、一个 30 只） */
const SMALL_UID = 94001;
const BIG_UID = 94002;

beforeAll(async () => {
  http = await createHttpApp({ portStart: 51320, portEnd: 51339 });

  await seedUser(SMALL_UID, 'nplus1_small');
  await seedUser(BIG_UID, 'nplus1_big');

  // 5 只 + 30 只持仓（标的代码只要**互不相同**即可 —— 计数与行情无关）
  await seedHoldings(
    SMALL_UID,
    Array.from({ length: SMALL_N }, (_, i) => `np${String(i).padStart(3, '0')}small`),
  );
  await seedHoldings(
    BIG_UID,
    Array.from({ length: BIG_N }, (_, i) => `np${String(i).padStart(3, '0')}big`),
  );

  const { signToken } = await import('../../src/services/auth.js');
  (globalThis as unknown as { __nplus1Tokens?: Record<number, string> }).__nplus1Tokens = {
    [SMALL_UID]: signToken({ sub: SMALL_UID, username: 'nplus1_small', role: 'user' }),
    [BIG_UID]: signToken({ sub: BIG_UID, username: 'nplus1_big', role: 'user' }),
  };
}, 60_000);

afterAll(async () => {
  await http?.close();
}, 30_000);

function tokenFor(uid: number): string {
  const map = (globalThis as unknown as { __nplus1Tokens?: Record<number, string> }).__nplus1Tokens;
  return map?.[uid] ?? '';
}

/** SQLite prepare 计数 spy */
interface PrepareSpy {
  count: number;
  sqls: string[];
  restore: () => void;
}

function installPrepareSpy(db: any): PrepareSpy {
  const original = db.prepare.bind(db);
  const spy: PrepareSpy = {
    count: 0,
    sqls: [],
    restore: () => {
      // 删掉实例上的自有属性 ⇒ 还原为原型方法
      delete db.prepare;
    },
  };
  db.prepare = (sql: string) => {
    spy.count += 1;
    spy.sqls.push(String(sql).replace(/\s+/g, ' ').trim());
    return original(sql);
  };
  return spy;
}

/** 打一次 /api/holding 并统计两类查询次数 */
async function measure(userId: number): Promise<{
  status: number;
  count: number;
  sqliteQueries: number;
  duckdbQueries: number;
  sqliteSqls: string[];
}> {
  const db = await getDb();
  duckdbCalls.length = 0;
  const spy = installPrepareSpy(db);
  try {
    const res = await fetch(`${http.baseUrl}/api/holding`, {
      headers: { authorization: `Bearer ${tokenFor(userId)}` },
    });
    const body = (await res.json()) as { data?: unknown[] };
    return {
      status: res.status,
      count: Array.isArray(body.data) ? body.data.length : -1,
      sqliteQueries: spy.count,
      duckdbQueries: duckdbCalls.length,
      sqliteSqls: spy.sqls,
    };
  } finally {
    spy.restore();
  }
}

describe('N+1 消除 —— 查询次数不随标的数线性增长（计划 §12.7 T60 ③）', () => {
  it('前置守卫：本文件确实调用了 app.listen()（inject() 恒绿 = 没测）', async () => {
    const raw = await assertRealListen(http.app, http.port);
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
  });

  it('5 只 vs 30 只持仓：SQLite / DuckDB 查询次数**完全相同**', async () => {
    const small = await measure(SMALL_UID);
    const big = await measure(BIG_UID);

    console.log(
      `[N+1] ${SMALL_N} 只持仓：返回 ${small.count} 条 / SQLite ${small.sqliteQueries} 次 / DuckDB ${small.duckdbQueries} 次\n` +
        `[N+1] ${BIG_N} 只持仓：返回 ${big.count} 条 / SQLite ${big.sqliteQueries} 次 / DuckDB ${big.duckdbQueries} 次\n` +
        `[N+1] 旧实现（codes.map(calcPosition)）的 SQLite 查询次数会是 ${BIG_N + 1} 次（1 次 DISTINCT + ${BIG_N} 次单标的）`,
    );
    console.log(`[N+1] 30 只持仓实际执行的 SQLite 语句：\n  ${big.sqliteSqls.join('\n  ')}`);

    expect(small.status).toBe(200);
    expect(big.status).toBe(200);
    expect(small.count).toBe(SMALL_N);
    expect(big.count).toBe(BIG_N);

    // 🔴 核心断言：**规模从 5 涨到 30，查询次数不变**
    expect(big.sqliteQueries).toBe(small.sqliteQueries);
    expect(big.duckdbQueries).toBe(small.duckdbQueries);

    // 绝对上限（防止「常数变大」蒙混过关）
    expect(big.sqliteQueries, `SQLite 查询 ${big.sqliteQueries} 次，超出常量上限`).toBeLessThanOrEqual(4);
    expect(big.duckdbQueries, `DuckDB 查询 ${big.duckdbQueries} 次，超出常量上限`).toBeLessThanOrEqual(3);
  }, 120_000);

  it('calcAllPositions 只发 1 条 SQL（无逐标的查询）', async () => {
    const { calcAllPositions } = await import('../../src/services/positionCalculator.js');
    const db = await getDb();
    const spy = installPrepareSpy(db);
    try {
      const positions = calcAllPositions(BIG_UID);
      console.log(`[N+1] calcAllPositions(${BIG_UID}) → ${positions.length} 个持仓 / SQL ${spy.count} 条`);
      expect(positions.length).toBe(BIG_N);
      expect(spy.count, `calcAllPositions 发了 ${spy.count} 条 SQL（期望 1 条）`).toBe(1);
      expect(spy.sqls[0]).toContain('FROM user_trade_record');
    } finally {
      spy.restore();
    }
  }, 60_000);
});
