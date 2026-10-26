/**
 * T129 —— 券商补录（brokerConfirm）服务级契约测试
 *
 * ── 本文件钉死的契约 ──
 *   ① 单行判定（INV-S3-7）：balance_after 存在 = 权威口径
 *      卖&余0→clear / 卖&余>0→reduce / 买&余=量→buy / 买&余>量→add
 *   ② 回放判定（INV-S3-2/3/8）：无余额按 (user, broker, asset) 分桶、时序回放；
 *      跨标的互相不影响。
 *   ③ 用户修正优先（INV-S3-9），落库后不再自动覆盖
 *   ④ 时间归一（INV-S2-36）：无法解析 → NULL，绝不填假时间
 *   ⑤ 可回溯（G3）：source_broker_record_id ←→ matched_trade_record_id 双向链接；
 *      is_auto_import=1、trade_reason='券商补录'
 *   ⑥ 幂等（G3/G4）：映射中的行二次确认 → 'already' 不重复插入；
 *      软删业务行后同 source 可再补录（索引 B 释放锚点）
 *   ⑦ 不可补行：manual_sheet（INV-S2-44）/ EXCLUDED / 缺关键字段 → 不进业务层
 *   ⑧ 标记 match：可关联既有业务行（归属 + 标的一致）；业务行不动（INV-S2-35）
 *
 * ── SQLite 隔离 ──
 *   每用例自建库（启动即最终形态 schema，零重建），用例间零依赖。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t129-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;

const { ConfigStore } = await import('../../src/config/configStore.js');
const Confirm = await import('../../src/services/broker/brokerConfirm.js');
const { confirmTrades, markAsManuallyRecorded } = Confirm;
type ConfirmItem = import('../../src/services/broker/brokerConfirm.js').ConfirmItem;

type Store = ReturnType<typeof ConfigStore.getInstance>;

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

const UID = 1;

/** 启动一个全新库（最终形态 schema）并 seed 用户 */
function freshStore(tag: string): Store {
  closeConfigStore();
  process.env.SQLITE_DB_PATH = path.join(TMP_DIR, `${tag}.db`);
  const store = ConfigStore.getInstance();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, 't129', 'x', 'admin')",
    )
    .run(UID);
  return store;
}

interface FactSpec {
  id?: number;
  eventType: string;
  asset: string;
  date?: string;
  time?: string | null;
  price?: number;
  qty?: number;
  balance?: number | null;
  sourceKind?: string;
  matchStatus?: string;
  contentSeq?: number;
  fee?: number;
}

function seedFacts(db: Database.Database, specs: FactSpec[], brokerCode = 't129broker'): Map<number, number> {
  const batch = db
    .prepare(
      `INSERT INTO broker_import_batch (user_id, broker_code, file_kind, file_name, file_hash, parser_version, status)
       VALUES (?, ?, 'trade', 't129.csv', 'h', 'v3.2.0', 'imported')`,
    )
    .run(UID, brokerCode);
  const batchId = Number(batch.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO broker_trade_record
       (user_id, import_batch_id, broker_code, source_kind, event_type, asset_code,
        trade_date, trade_time, price, quantity, fee_total, balance_after,
        raw_row_json, row_hash, content_seq, match_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  );
  const ids = new Map<number, number>();
  specs.forEach((s, i) => {
    const info = ins.run(
      UID,
      batchId,
      brokerCode,
      s.sourceKind ?? 'broker',
      s.eventType,
      s.asset,
      s.date ?? '2026-09-01',
      s.time ?? null,
      s.price ?? 10,
      s.qty ?? 100,
      s.fee ?? 0,
      s.balance ?? null,
      `hash-t129-${i}`,
      s.contentSeq ?? i + 1,
      s.matchStatus ?? 'MISSING',
    );
    if (s.id != null) ids.set(s.id, Number(info.lastInsertRowid));
    else ids.set(i + 1, Number(info.lastInsertRowid));
  });
  return ids;
}

function readTrade(db: Database.Database, id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM user_trade_record WHERE id = ?').get(id) as Record<string, unknown>;
}

afterAll(() => {
  if (ORIG_SQLITE_PATH) process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('T129 券商补录 brokerConfirm', () => {
  it('① 单行判定（balance_after 权威）+ 回溯链 + 明细字段（G3）', () => {
    const store = freshStore('single');
    const db = store.db;
    const ids = seedFacts(db, [
      {
        id: 11,
        eventType: 'TRADE_BUY',
        asset: 'sh600000',
        date: '2026-09-01',
        time: '09:30:00',
        balance: 100,
        fee: 5,
      }, // 买=量 → buy
      {
        id: 12,
        eventType: 'TRADE_BUY',
        asset: 'sh600000',
        date: '2026-09-02',
        time: '10:00:00',
        balance: 300,
      }, // 买>量 → add
      {
        id: 13,
        eventType: 'TRADE_SELL',
        asset: 'sh600000',
        date: '2026-09-03',
        time: '14:00:00',
        balance: 100,
      }, // 卖>0 → reduce
      {
        id: 14,
        eventType: 'TRADE_SELL',
        asset: 'sh600000',
        date: '2026-09-04',
        time: '15:00:00',
        balance: 0,
      }, // 卖&0 → clear
    ]);
    const items: ConfirmItem[] = [...ids.values()].map((sid) => ({ sourceId: sid }));
    const r = confirmTrades(db, UID, 't129broker', items);
    expect(r.imported).toBe(4);
    expect(r.invalid).toBe(0);
    const got = r.rows.map((x) => x.tradeType);
    expect(got).toEqual(['buy', 'add', 'reduce', 'clear']);

    for (const row of r.rows) {
      const t = readTrade(db, row.tradeRecordId!);
      expect(t.user_id).toBe(UID);
      expect(t.asset_code).toBe('sh600000');
      expect(t.is_auto_import).toBe(1);
      expect(t.is_deleted).toBe(0);
      expect(t.trade_reason).toBe('券商补录');
      expect(t.broker_code).toBe('t129broker');
      expect(t.source_broker_record_id).toBe(row.sourceId);
      // G3 双向回溯
      const fact = db
        .prepare('SELECT match_status, matched_trade_record_id FROM broker_trade_record WHERE id = ?')
        .get(row.sourceId) as { match_status: string; matched_trade_record_id: number };
      expect(fact.match_status).toBe('MATCHED');
      expect(Number(fact.matched_trade_record_id)).toBe(row.tradeRecordId);
    }
    // fee 从事实层 fee_total 复制（仅 facts id 11 有 fee=5）
    expect(readTrade(db, r.rows[0].tradeRecordId!).fee).toBe(5);
  });

  it('② 回放判定：无余额按 (asset) 分桶回放；跨标的互不影响（INV-S3-3）', () => {
    const store = freshStore('replay');
    const db = store.db;
    const ids = seedFacts(db, [
      // 桶 A：sh600000 —— 买 100（无余额→buy）→ 买 100（netQty>0→add）→ 卖 100（netQty-100=100>0→reduce）→ 卖 100（netQty-100=0→clear）
      { id: 1, eventType: 'TRADE_BUY', asset: 'sh600000', qty: 100 },
      { id: 2, eventType: 'TRADE_BUY', asset: 'sh600000', qty: 100 },
      { id: 3, eventType: 'TRADE_SELL', asset: 'sh600000', qty: 100 },
      { id: 4, eventType: 'TRADE_SELL', asset: 'sh600000', qty: 100 },
      // 桶 B：sz000001 —— 先卖（回放起点视为 0 → clear）
      { id: 5, eventType: 'TRADE_SELL', asset: 'sz000001', qty: 200 },
    ]);
    const items: ConfirmItem[] = [...ids.values()].map((sid) => ({ sourceId: sid }));
    const r = confirmTrades(db, UID, 't129broker', items);
    expect(r.imported).toBe(5);
    const types = new Map(r.rows.map((x) => [x.sourceId, x.tradeType]));
    expect(types.get(ids.get(1))).toBe('buy');
    expect(types.get(ids.get(2))).toBe('add');
    expect(types.get(ids.get(3))).toBe('reduce');
    expect(types.get(ids.get(4))).toBe('clear');
    expect(types.get(ids.get(5))).toBe('clear');
  });

  it('③ 用户修正优先（INV-S3-9）+ 时间归一（INV-S2-36 不可解析→NULL）', () => {
    const store = freshStore('override');
    const db = store.db;
    const ids = seedFacts(db, [
      // balance_after 说 add，但用户改 reduce → 尊重修正
      { id: 1, eventType: 'TRADE_BUY', asset: 'sh600000', time: '09:30', balance: 500 },
      // 不可解析时间 → NULL（不填假时间）
      { id: 2, eventType: 'TRADE_SELL', asset: 'sh600000', time: 'not-a-time', balance: 300 },
      // 空时间 → NULL
      { id: 3, eventType: 'TRADE_SELL', asset: 'sh600000', time: null, balance: 200 },
      // '094530' 紧凑格式 → '09:45:30'
      { id: 4, eventType: 'TRADE_SELL', asset: 'sh600000', time: '094530', balance: 100 },
    ]);
    const r = confirmTrades(db, UID, 't129broker', [
      { sourceId: ids.get(1)!, tradeType: 'reduce' },
      { sourceId: ids.get(2)! },
      { sourceId: ids.get(3)! },
      { sourceId: ids.get(4)! },
    ]);
    expect(r.imported).toBe(4);
    expect(r.invalid).toBe(0);
    const trades = r.rows.map((x) => readTrade(db, x.tradeRecordId!));
    expect(trades[0].trade_type).toBe('reduce'); // 修正生效，没有回到 add
    expect(trades[1].trade_time).toBeNull();
    expect(trades[2].trade_time).toBeNull();
    expect(trades[3].trade_time).toBe('09:45:30');
    expect(trades[0].trade_time).toBe('09:30:00'); // HH:mm 补秒
  });

  it('④ 幂等 already（二次确认不重复插入）+ 撤销后可再补录（索引 B 释放锚点）', () => {
    const store = freshStore('idem');
    const db = store.db;
    const ids = seedFacts(db, [{ id: 1, eventType: 'TRADE_BUY', asset: 'sh600000', balance: 100 }]);
    const items: ConfirmItem[] = [{ sourceId: ids.get(1)! }];
    const first = confirmTrades(db, UID, 't129broker', items);
    expect(first.imported).toBe(1);
    const tradeId = first.rows[0].tradeRecordId!;

    const second = confirmTrades(db, UID, 't129broker', items);
    expect(second.imported).toBe(0);
    expect(second.already).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM user_trade_record').get() as { c: number }).c).toBe(1);

    // 撤销（软删业务层）→ 同 source 可再次补录（INV-S2-35）
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(tradeId);
    const third = confirmTrades(db, UID, 't129broker', items);
    expect(third.imported).toBe(1);
    expect(third.rows[0].tradeRecordId).not.toBe(tradeId);
  });

  it('⑤ 不可补行：manual_sheet（INV-S2-44）/ EXCLUDED / 缺关键字段 → invalid 不写入', () => {
    const store = freshStore('invalid');
    const db = store.db;
    const ids = seedFacts(db, [
      {
        id: 1,
        eventType: 'TRADE_BUY',
        asset: 'sh600000',
        sourceKind: 'manual_sheet',
        matchStatus: 'MISSING',
      },
      { id: 2, eventType: 'TRADE_BUY', asset: 'sh600000', matchStatus: 'EXCLUDED' },
      { id: 3, eventType: 'TRADE_BUY', asset: 'sh600000', price: -1, matchStatus: 'MISSING' },
      { id: 4, eventType: 'DIVIDEND', asset: 'sh600000', matchStatus: 'MISSING' }, // 事件族不可补录
    ]);
    const items: ConfirmItem[] = [...ids.values()].map((sid) => ({ sourceId: sid }));
    const r = confirmTrades(db, UID, 't129broker', items);
    expect(r.imported).toBe(0);
    expect(r.invalid + r.rows.filter((x) => x.status === 'manual_sheet').length).toBeGreaterThanOrEqual(3);
    expect(
      (db.prepare('SELECT COUNT(*) c FROM user_trade_record WHERE is_deleted = 0').get() as { c: number }).c,
    ).toBe(0);
    // 事实层未被污染（EXCLUDED 行保持原状）
    const kept = db.prepare('SELECT match_status FROM broker_trade_record WHERE id = ?').get(ids.get(2)) as {
      match_status: string;
    };
    expect(kept.match_status).toBe('EXCLUDED');
  });

  it('⑥ 标记 match：/diff/:id/match 语义 —— 归属 + 标的一致才允许关联；业务行不动', () => {
    const store = freshStore('match');
    const db = store.db;
    const ids = seedFacts(db, [{ id: 1, eventType: 'TRADE_BUY', asset: 'sh600000' }]);
    const factId = ids.get(1)!;

    // 业务层手工记录一条同标的
    const manual = db
      .prepare(
        `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price)
         VALUES (?, 'sh600000', 'buy', '2026-09-01', '09:30:00', 100, 10)`,
      )
      .run(UID);
    const manualId = Number(manual.lastInsertRowid);

    // 归属不匹配 → 拒
    expect(markAsManuallyRecorded(db, UID, factId, 999999).ok).toBe(false);
    // 标的不一致 → 拒
    const other = db
      .prepare(
        `INSERT INTO user_trade_record (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price)
         VALUES (?, 'sz000001', 'buy', '2026-09-01', '09:30:00', 100, 10)`,
      )
      .run(UID);
    expect(markAsManuallyRecorded(db, UID, factId, Number(other.lastInsertRowid)).ok).toBe(false);

    // 合法关联 → MATCHED + matched_trade_record_id；业务行自身不被修改
    const okRes = markAsManuallyRecorded(db, UID, factId, manualId);
    expect(okRes.ok).toBe(true);
    const fact = db
      .prepare('SELECT match_status, matched_trade_record_id FROM broker_trade_record WHERE id = ?')
      .get(factId) as {
      match_status: string;
      matched_trade_record_id: number;
    };
    expect(fact.match_status).toBe('MATCHED');
    expect(Number(fact.matched_trade_record_id)).toBe(manualId);
    const b = readTrade(db, manualId);
    expect(b.is_deleted).toBe(0); // 业务行不动（INV-S2-35）
  });
});
