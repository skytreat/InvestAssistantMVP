/**
 * tests/http/pe5-sqlite-concurrency.test.ts —— **PE5 验收：SQLite WAL 模式 ≤ 10 并发读写**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📖 **SDD §12.5 性能验收组（权威口径，逐字照抄）**
 * ════════════════════════════════════════════════════════════════════════
 *   | PE5 | SQLite WAL 模式 ≤ 10 并发读写 | SQLite 并发压测脚本 | **不出现 SQLITE_BUSY** |
 *
 * ── 为什么必须真 listen ──
 *   压测要打的是**真实 API 链路**（HTTP → 路由 → SQLite 事务）。
 *   `inject()` 走内存 ⇒ 同一进程内串行执行 ⇒ 测不出并发下的锁竞争。
 *
 * ── 判据拆解 ──
 *   ① **WAL 模式**：读 `PRAGMA journal_mode` 必须是 `wal`（AGENTS.md 硬约束）
 *   ② **busy_timeout ≥ 5s**：读 `PRAGMA busy_timeout`（AGENTS.md：连接初始化必须设）
 *   ③ **10 并发读写不出现 SQLITE_BUSY**：
 *      10 个并发 worker，每个 worker 交替做「读（GET /api/holding）」与
 *      「写（POST /api/trade）」⇒ 断言
 *        · 写全部 201（无 409 唯一键冲突 —— 每笔用**唯一**的 标的+时刻）
 *        · 读全部 200
 *        · 任何响应体里都**不出现** `SQLITE_BUSY` / `database is locked`
 *
 * ⚠️ 写操作用**不同的标的 + 不同时刻**，否则会撞 T87b 的部分唯一索引
 *   （`user_id, asset_code, trade_type, trade_date, trade_time`）⇒ 那是业务 409，不是锁问题。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { assertRealListen, createHttpApp, getDb, seedUser, type HttpTestApp } from './_helpers.js';

// 存在性判定源 = DuckDB raw_symbol_class：mock 返回空（本文件专注 SQLite 并发压测，不做存在性判定）
const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

/** SDD §12.5 PE5 的并发档 */
const CONCURRENCY = 10;

/** 每个 worker 的读写轮数 */
const ITERATIONS = 6;

/** 测试用户 */
const TEST_UID = 93001;

let http: HttpTestApp;
let token = '';

beforeAll(async () => {
  // 默认放行：mock raw_symbol_class 返回空（本文件专注 SQLite 并发压测，不做存在性判定）
  queryDuckDBMock.mockImplementation(async () => []);
  http = await createHttpApp({ portStart: 51280, portEnd: 51299 });
  await seedUser(TEST_UID, 'pe5_user');
  const { signToken } = await import('../../src/services/auth.js');
  token = signToken({ sub: TEST_UID, username: 'pe5_user', role: 'user' });
}, 60_000);

afterAll(async () => {
  await http?.close();
}, 30_000);

describe('PE5 —— SQLite WAL 模式 ≤ 10 并发读写（SDD §12.5）', () => {
  it('前置守卫：本文件确实调用了 app.listen()（inject() 恒绿 = 没测）', async () => {
    const raw = await assertRealListen(http.app, http.port);
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
  });

  it('连接初始化：journal_mode = wal 且 busy_timeout ≥ 5000ms', async () => {
    const db = await getDb();
    const journalMode = db.pragma('journal_mode', { simple: true }) as string;
    const busyTimeout = db.pragma('busy_timeout', { simple: true }) as number;
    console.log(`[PE5] PRAGMA journal_mode=${journalMode} / busy_timeout=${busyTimeout}ms`);

    expect(String(journalMode).toLowerCase()).toBe('wal');
    expect(Number(busyTimeout)).toBeGreaterThanOrEqual(5000);
  });

  it('10 并发读写：全部成功，且**不出现 SQLITE_BUSY**', async () => {
    const results: Array<{ kind: 'read' | 'write'; status: number; body: string }> = [];

    // 10 个并发 worker
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_unused, worker) => {
        for (let i = 0; i < ITERATIONS; i++) {
          // 读
          const readRes = await fetch(`${http.baseUrl}/api/holding`, {
            headers: { authorization: `Bearer ${token}` },
          });
          results.push({
            kind: 'read',
            status: readRes.status,
            body: await readRes.text(),
          });

          // 写（标的与时刻都唯一 ⇒ 不撞业务唯一键）
          const writeRes = await fetch(`${http.baseUrl}/api/trade`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              asset_code: `pe5${String(worker).padStart(2, '0')}${String(i).padStart(2, '0')}`,
              trade_type: 'buy',
              trade_date: '2026-02-02',
              trade_time: `09:${String(30 + i).padStart(2, '0')}:00`,
              quantity: 100,
              price: 10,
              // ⚠️ buy 属于 `NEED_REASON_TYPES`（Requirements §5.2：买入/加仓/减仓/清仓必填理由）
              trade_reason: 'PE5 并发压测',
            }),
          });
          results.push({
            kind: 'write',
            status: writeRes.status,
            body: await writeRes.text(),
          });
        }
      }),
    );

    const reads = results.filter((r) => r.kind === 'read');
    const writes = results.filter((r) => r.kind === 'write');

    const busyHits = results.filter((r) => /SQLITE_BUSY|database is locked/i.test(r.body));
    const badReads = reads.filter((r) => r.status !== 200);
    const badWrites = writes.filter((r) => r.status !== 201);

    console.log(
      `[PE5] 并发 ${CONCURRENCY} × ${ITERATIONS} 轮：读 ${reads.length} 次（失败 ${badReads.length}）/ ` +
        `写 ${writes.length} 次（失败 ${badWrites.length}）/ SQLITE_BUSY ${busyHits.length} 次`,
    );

    expect(busyHits.length, `出现 SQLITE_BUSY：${busyHits[0]?.body?.slice(0, 200)}`).toBe(0);
    expect(badReads.length, `读失败：${badReads[0]?.status} ${badReads[0]?.body?.slice(0, 200)}`).toBe(0);
    expect(badWrites.length, `写失败：${badWrites[0]?.status} ${badWrites[0]?.body?.slice(0, 200)}`).toBe(0);
  }, 120_000);
});
