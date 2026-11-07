/**
 * I8 —— 差异明细 CSV 导出（PRD_v3 §3.2.1「可筛选 + 可导出」/ §4.3「导出 CSV」）
 *
 * 钉死的契约：
 *   ① 鉴权：无 Bearer token → 401；brokerCode / category 非法 → 400
 *   ② 响应头：`text/csv` + `Content-Disposition: attachment; filename="*.csv"`
 *   ③ 列序与页面表格一致：id / 事件 / 标的 / 日期 / 数量 / 金额 / 状态 / 排除原因
 *   ④ 与 `/diff` 同口径：分类条件一致、归因专属行状态显示「归因（不补录）」、
 *      金额 `amount ?? cash_flow`、日期含成交时间
 *   ⑤ 文本含逗号 / 双引号按 RFC4180 转义；首行带 UTF-8 BOM
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanupIntegrationTest, createTestApp, makeUserToken, type TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const BROKER = 'i8exp';

interface FactSpec {
  eventType: string;
  rawEventType?: string;
  asset: string | null;
  date?: string;
  time?: string | null;
  qty?: number | null;
  amount?: number | null;
  cashFlow?: number | null;
  status?: string;
  excludeReason?: string | null;
  hash: string;
}

function seedFacts(specs: FactSpec[]): number[] {
  const db = bundle.db.db;
  const batchId = Number(
    db
      .prepare(
        `INSERT INTO broker_import_batch (user_id, broker_code, file_kind, file_name, file_hash, parser_version, status)
         VALUES (1, ?, 'trade', 'i8.csv', 'i8h', 'v3.2.0', 'imported')`,
      )
      .run(BROKER).lastInsertRowid,
  );
  const ins = db.prepare(
    `INSERT INTO broker_trade_record
       (user_id, import_batch_id, broker_code, source_kind, event_type, raw_event_type, asset_code,
        trade_date, trade_time, price, quantity, amount, cash_flow, fee_total, balance_after,
        raw_row_json, row_hash, content_seq, match_status, exclude_reason)
     VALUES (1, ?, ?, 'broker', ?, ?, ?, ?, ?, 10, ?, ?, ?, 0, NULL, '{}', ?, 1, ?, ?)`,
  );
  return specs.map((s) =>
    Number(
      ins.run(
        batchId,
        BROKER,
        s.eventType,
        s.rawEventType ?? s.eventType,
        s.asset,
        s.date ?? '2026-09-01',
        s.time ?? null,
        s.qty ?? 100,
        s.amount ?? null,
        s.cashFlow ?? null,
        s.hash,
        s.status ?? 'MISSING',
        s.excludeReason ?? null,
      ).lastInsertRowid,
    ),
  );
}

let ids: number[];

beforeAll(async () => {
  bundle = await createTestApp();
  ids = seedFacts([
    {
      eventType: 'TRADE_BUY',
      rawEventType: '买入',
      asset: 'sh600000',
      date: '2026-09-01',
      qty: 100,
      cashFlow: -1000,
      hash: 'i8-a',
      excludeReason: '=IMPORT()',
    },
    {
      eventType: 'TRADE_SELL',
      rawEventType: '卖出,含"引号"',
      asset: 'sz000001',
      date: '2026-09-02',
      time: '14:30:00',
      qty: 200,
      amount: 2000,
      hash: 'i8-b',
      status: 'FUZZY',
    },
    { eventType: 'TRADE_BUY', rawEventType: '买入', asset: 'sh600001', hash: 'i8-c', status: 'MATCHED' },
    { eventType: 'REPO', rawEventType: '逆回购', asset: '131810', hash: 'i8-repo' },
    { eventType: 'TRANSFER_IN', rawEventType: '转入', asset: 'sh600002', qty: 50, hash: 'i8-transfer' },
  ]);
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

function get(url: string, token?: string) {
  return bundle.app.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('I8 差异明细 CSV 导出', () => {
  it('无 token → 401（全局鉴权钩子生效）', async () => {
    const res = await get(`/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=unmatched`);
    expect(res.statusCode).toBe(401);
  });

  it('缺 brokerCode / 非法 category → 400', async () => {
    const noCode = await get('/api/broker-reconcile/diff/export?category=unmatched', bundle.adminToken);
    expect(noCode.statusCode).toBe(400);
    const badCat = await get(
      `/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=nope`,
      bundle.adminToken,
    );
    expect(badCat.statusCode).toBe(400);
  });

  it('unmatched：CSV 头 + Content-Disposition + 列序与页面表格一致', async () => {
    const res = await get(
      `/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=unmatched`,
      bundle.adminToken,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toMatch(
      /filename="broker-reconcile-[^"]+-unmatched-\d{8}\.csv"/,
    );

    const lines = res.body.replace('\uFEFF', '').split('\r\n');
    expect(lines[0]).toBe('id,事件,标的,日期,数量,金额,状态,排除原因');
    // 已匹配行不进入「缺失未匹配」分类 → 只剩 2 行（日期升序）
    expect(lines).toHaveLength(3);
  });

  it('unmatched：金额走 amount ?? cash_flow；逗号/引号按 RFC4180 转义；公式注入被中和', async () => {
    const res = await get(
      `/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=unmatched`,
      bundle.adminToken,
    );
    const [, first, second] = res.body.replace('\uFEFF', '').split('\r\n');
    // 第 1 行：amount 缺失 → 回退 cash_flow；排除原因以 = 开头 → 前置单引号防公式
    expect(first).toBe(`${ids[0]},买入,sh600000,2026-09-01,100,-1000,MISSING,'=IMPORT()`);
    // 第 2 行：含逗号与双引号 → 整格加引号并双写；日期附带成交时间
    expect(second).toBe(`${ids[1]},"卖出,含""引号""",sz000001,2026-09-02 14:30:00,200,2000,FUZZY,`);
  });

  it('repo：归因专属行状态为「归因（不补录）」', async () => {
    const res = await get(
      `/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=repo`,
      bundle.adminToken,
    );
    expect(res.statusCode).toBe(200);
    const lines = res.body.replace('\uFEFF', '').split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`${ids[3]},逆回购,131810,2026-09-01,100,,归因（不补录）,`);
  });

  it('nonTrade：非成交族待补录行可导出（与 /diff 同条件）', async () => {
    const res = await get(
      `/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=nonTrade`,
      bundle.adminToken,
    );
    const lines = res.body.replace('\uFEFF', '').split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`${ids[4]},转入,sh600002,2026-09-01,50,,MISSING,`);
  });

  it('用户隔离：其他用户同名券商导出为空', async () => {
    const other = await get(
      `/api/broker-reconcile/diff/export?brokerCode=${BROKER}&category=unmatched`,
      makeUserToken(9999, 'i8_other'),
    );
    expect(other.statusCode).toBe(200);
    expect(other.body.replace('\uFEFF', '').split('\r\n')).toHaveLength(1);
  });
});
