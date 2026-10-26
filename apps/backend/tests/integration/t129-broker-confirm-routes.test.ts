/**
 * T129 —— 券商补录路由层契约（/api/broker-reconcile/confirm + /diff/:id/match）
 *
 * ── 本文件钉死的契约 ──
 *   ① 权限（SDD §10.3）：confirm / diff/:id/match / broker-import 写路由 仅 admin；
 *      普通用户 → 403 FORBIDDEN envelope
 *   ② G5 事务：批量确认中任一行 UNIQUE 冲突 → 409 + **整体回滚**
 *      （导入计数 0、事实层 MATCHED 不落任何行）
 *   ③ envelope：所有响应（200/400/403/404/409）都是无 `success` 键的统一信封
 *
 * fixture 最小事实层：之间用例共用 seed，但用例内部状态用例自行收敛（sequence.shuffle 安全）。
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { cleanupIntegrationTest, createTestApp, makeUserToken, type TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const USER_TOKEN = makeUserToken(555, 'n_admin_user');
const ADMIN_ID = 1; // createTestApp 首个 admin（INSERT OR IGNORE id=1 并 login）

interface FactSpec {
  eventType: string;
  asset: string;
  date?: string;
  time?: string | null;
  price?: number;
  qty?: number;
  balance?: number | null;
  hash: string;
}

function seedFacts(specs: FactSpec[], brokerCode = 'rb'): number[] {
  const db = bundle.db.db;
  const ins = db.prepare(
    `INSERT INTO broker_trade_record
       (user_id, import_batch_id, broker_code, source_kind, event_type, asset_code,
        trade_date, trade_time, price, quantity, fee_total, balance_after,
        raw_row_json, row_hash, content_seq, match_status)
     VALUES (?, ?, ?, 'broker', ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?, 'MISSING')`,
  );
  const seedBatch = () =>
    Number(
      db
        .prepare(
          `INSERT INTO broker_import_batch (user_id, broker_code, file_kind, file_name, file_hash, parser_version, status)
           VALUES (?, ?, 'trade', 't.csv', 'h', 'v3.2.0', 'imported')`,
        )
        .run(ADMIN_ID, brokerCode).lastInsertRowid,
    );
  return specs.map((s) =>
    Number(
      ins.run(
        ADMIN_ID,
        seedBatch(),
        brokerCode,
        s.eventType,
        s.asset,
        s.date ?? '2026-09-01',
        s.time ?? null,
        s.price ?? 10,
        s.qty ?? 100,
        s.balance ?? null,
        s.hash,
        1,
      ).lastInsertRowid,
    ),
  );
}

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

function factCount(): number {
  return (
    bundle.db.db
      .prepare("SELECT COUNT(*) c FROM broker_trade_record WHERE match_status = 'MATCHED'")
      .get() as { c: number }
  ).c;
}

function errCode(body: string): string {
  return (JSON.parse(body).code ?? JSON.parse(body).error) as string;
}

describe('T129 补录路由', () => {
  it('① 普通 user → 403 FORBIDDEN（补录与标记均拦；SDD §10.3）', async () => {
    const r1 = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-reconcile/confirm',
      payload: { brokerCode: 'rb', items: [] },
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(r1.statusCode).toBe(403);
    expect(errCode(r1.body)).toBe('FORBIDDEN');

    const r2 = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-reconcile/diff/1/match',
      payload: {},
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(r2.statusCode).toBe(403);
    expect(errCode(r2.body)).toBe('FORBIDDEN');
  });

  it('② 缺 brokerCode / items / sourceId 非法 → 400 INVALID_BODY envelope', async () => {
    const admin = bundle.adminToken;
    const cases: Array<Record<string, unknown>> = [
      {},
      { brokerCode: 'rb' },
      { brokerCode: 'rb', items: 'not-array' },
      { brokerCode: 'rb', items: [{ sourceId: -3 }] },
    ];
    for (const payload of cases) {
      const r = await bundle.app.inject({
        method: 'POST',
        url: '/api/broker-reconcile/confirm',
        payload,
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(r.statusCode).toBe(400);
      expect(errCode(r.body)).toBe('INVALID_BODY');
    }
  });

  it('③ G5 事务：C 锚唯一冲突 → 409 BROKER_CONFIRM_CONFLICT 且整体回滚', async () => {
    const db = bundle.db.db;
    // 两条事实同 identity（同 user/broker/asset/type/date/seq/time）——
    // 🔴 time 必须非空：SQLite 唯一索引视 NULL 互异，NULL 行不相撞（T128 D-34 结论的推论）
    const ids = seedFacts([
      { eventType: 'TRADE_BUY', asset: 'sh600000', time: '09:30:00', balance: 100, hash: 'rb-a' },
      { eventType: 'TRADE_BUY', asset: 'sh600000', time: '09:30:00', balance: 100, hash: 'rb-b' },
    ]);
    // 预插一条与 confirm 目标同 identity 的业务行 ⇒ 第一次 insert 即撞 C → UNIQUE → 整体回滚
    db.prepare(
      `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price,
         broker_code, broker_seq, source_broker_record_id, is_auto_import)
       VALUES (?, 'sh600000', 'buy', '2026-09-01', '09:30:00', 100, 10, 'rb', 1, NULL, 1)`,
    ).run(ADMIN_ID);
    const preCount = (db.prepare('SELECT COUNT(*) c FROM user_trade_record').get() as { c: number }).c;

    const r = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-reconcile/confirm',
      payload: { brokerCode: 'rb', items: ids.map((sid) => ({ sourceId: sid })) },
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(r.statusCode).toBe(409);
    expect(errCode(r.body)).toBe('BROKER_CONFIRM_CONFLICT');
    // G5：整体回滚 —— 业务行数不变；事实层 0 行落 MATCHED
    expect((db.prepare('SELECT COUNT(*) c FROM user_trade_record').get() as { c: number }).c).toBe(preCount);
    expect(factCount()).toBe(0);
  });

  it('④ /diff/:id/match：不存在的 fact → 404 NOT_FOUND envelope', async () => {
    const r = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-reconcile/diff/999999/match',
      payload: {},
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(r.statusCode).toBe(404);
    expect(errCode(r.body)).toBe('NOT_FOUND');
  });

  it('⑤ broker-import 写路由 对 normal user 同样 403（T122 缺口补位）', async () => {
    const r = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/templates',
      payload: { brokerCode: 'rb', fileKind: 'trade', mappingJson: '{}' },
      headers: { authorization: `Bearer ${USER_TOKEN}` },
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r.body)).toBe('FORBIDDEN');
    // admin 可以存模板（回归保护）
    const ok = await bundle.app.inject({
      method: 'POST',
      url: '/api/broker-import/templates',
      payload: { brokerCode: 'rb', fileKind: 'trade', mappingJson: '{}' },
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(ok.statusCode).toBe(200);
  });
});
