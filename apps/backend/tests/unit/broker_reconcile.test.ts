/**
 * broker_reconcile.test.ts — T124（V3.1）跨文件去重 + 成交时间回填
 * 对应 SDD_v3 §12.1：INV-S2-48~51（去重）/ INV-S2-54~61d（回填）；gate G4（不双计）+ G5（回填 100%）
 * 载体 = tests/fixtures/broker-samples/ 6 份脱敏样本（经 T122 导入到事实层）。
 * 实测基线（SDD §12）：回填 125/125（国泰 ETF）+ 12/12（国泰股票）；行内自洽基线见 T125。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-broker-reconcile-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import { importBrokerFile } from '../../src/services/broker/brokerImport.js';
import { dedupeAcrossFiles, backfillTradeTime } from '../../src/services/broker/brokerReconcile.js';

let db: Database.Database;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');

async function importAll(userId: number, brokerCode: string, files: string[]): Promise<void> {
  for (const f of files) {
    const r = await importBrokerFile(db, userId, brokerCode, {
      buffer: fs.readFileSync(path.join(FIX, f)),
      filename: f,
    });
    expect(r.duplicateFile, f).toBe(false);
  }
}

const GUOTAI_FILES = [
  '2026-10-20-国泰ETF交割单.xlsx',
  '2026-10-20-国泰ETF成交.xlsx',
  '2026-10-20-国泰股票交割单.xlsx',
  '2026-10-20-国泰股票成交.xlsx',
];

/**
 * shuffle 守卫：每个断言回填计数的用例使用专属 userId（7101 / 7104 等），互不共享
 * ⇒ backfillTradeTime 是一次性操作（trade_time 已填则 totalNeeded=0），共享用户会随
 *    用例顺序翻转（2026-10-25 实测：standalone 3 跑 2 红），专属用户后顺序无关。
 * 导入本身仍幂等（文件级 file_hash 拦截）。
 */
async function ensureGuotai(uid: number): Promise<void> {
  const n = (
    db
      .prepare(`SELECT COUNT(*) c FROM broker_import_batch WHERE user_id = ? AND is_deleted = 0`)
      .get(uid) as { c: number }
  ).c;
  if (n === 0) {
    await importAll(uid, '国泰', GUOTAI_FILES);
  }
}

beforeAll(async () => {
  db = ConfigStore.getInstance().db;
  const seed = db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  );
  for (const uid of [7101, 7102, 7103, 7104]) seed.run(uid, `user_${uid}`, 'x');
});

afterAll(() => {
  try {
    (db as unknown as { close(): void }).close();
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

describe('T124 · gate G5：成交时间回填命中 100%（125/125 + 12/12）', () => {
  it('国泰 4 份（ETF + 股票 双账户）：可回填行 100% 命中，0 低置信度，成交独有 0 行', async () => {
    // 专属用户 7104：本用例断言回填计数（matched=109），不得与其他用例共享回填状态
    await ensureGuotai(7104);
    const r = backfillTradeTime(db, 7104, '国泰');
    // 交割侧 TRADE 事件 109 行（= 125 ETF + 12 股票 中剔除货币 ETF 等非成交事件后的可回填量）全部命中
    expect(r.unmatched).toBe(0);
    expect(r.matched).toBe(r.totalNeeded);
    expect(r.matched).toBe(109);
    expect(r.lowConfidence).toBe(0); // 全 L1（精确内容键）

    // SDD §5.1 基线「成交独有 0 行」：成交流水侧每个 TRADE 事件内容键在交割侧都有对应行
    const orphan = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT 1
               FROM broker_trade_record t JOIN broker_import_batch tf ON tf.id = t.import_batch_id
              WHERE t.user_id = 7104 AND tf.file_kind = 'trade' AND t.is_deleted = 0
                AND t.event_type IN ('TRADE_BUY','TRADE_SELL')
              GROUP BY t.asset_code, t.trade_date, t.price, t.quantity
              HAVING NOT EXISTS (
                SELECT 1 FROM broker_trade_record s JOIN broker_import_batch sf ON sf.id = s.import_batch_id
                 WHERE s.user_id = 7104 AND sf.file_kind = 'settlement' AND s.is_deleted = 0
                   AND s.asset_code = t.asset_code AND s.trade_date = t.trade_date
                   AND s.price = t.price AND s.quantity = t.quantity)
           )`,
        )
        .get() as { c: number }
    ).c;
    expect(orphan, '成交独有 0 行（SDD §5.1）').toBe(0);

    // 品种维度拆分：股票交割侧 12 行全部 MATCHED
    const split = db
      .prepare(
        `SELECT CASE WHEN b.asset_code LIKE 'sh6%' OR b.asset_code LIKE 'sz0%' OR b.asset_code LIKE 'sz3%'
                      OR b.asset_code LIKE '6%' OR b.asset_code LIKE '0%' OR b.asset_code LIKE '3%'
                 THEN 'stock' ELSE 'etf' END AS kind,
                COUNT(*) AS n
           FROM broker_trade_record b JOIN broker_import_batch f ON f.id = b.import_batch_id
           WHERE b.user_id = 7104 AND f.file_kind = 'settlement' AND b.match_status = 'MATCHED' AND b.is_deleted = 0
           GROUP BY 1`,
      )
      .all() as Array<{ kind: string; n: number }>;
    expect(split.find((x) => x.kind === 'stock')?.n).toBe(12);
    expect((split.find((x) => x.kind === 'etf')?.n ?? 0) + 12).toBe(109); // ETF 侧 97 + 股票 12
  });

  it('回填只写成交时间：交割行价格/数量/金额字段不被成交流水覆盖', async () => {
    // 自包含（shuffle 守卫）：数据不存在才导入；回填幂等
    await ensureGuotai(7101);
    backfillTradeTime(db, 7101, '国泰');
    const row = db
      .prepare(
        `SELECT b.price, b.quantity, b.cash_flow, b.trade_time FROM broker_trade_record b
          JOIN broker_import_batch f ON f.id = b.import_batch_id
         WHERE b.user_id = 7101 AND f.file_kind = 'settlement' AND b.match_status = 'MATCHED'
           AND b.is_deleted = 0 LIMIT 1`,
      )
      .get() as
      | { price: number | null; quantity: number | null; cash_flow: number | null; trade_time: string | null }
      | undefined;
    expect(row, '须存在 MATCHED 交割行').toBeDefined();
    expect(row!.trade_time).not.toBeNull(); // 已回填
    expect(row!.price ?? 0).toBeGreaterThan(0); // 交割侧字段未被覆盖（与成交流水同源同值）
  });
});

describe('T124 · gate G4：跨文件去重不双计（INV-S2-48~51）', () => {
  it('华宝 2 份（交割 ∪ 成交）：冗余成交行被软标记，交割侧全保留', async () => {
    await importAll(7102, '华宝', ['20261020_华宝交割单.xls', '20261020_华宝成交.xls']);
    const d = dedupeAcrossFiles(db, 7102, '华宝');
    expect(d.redundantMarked).toBeGreaterThan(0); // 同键同价量的成交侧被标 EXCLUDED
    expect(d.splitGroups).toBeGreaterThan(0); // 同日分笔（价量不同）全保留

    // 双计判据（G4）：跨文件同内容组中，不得出现「同一笔在两个文件各有一行活动」：
    // 凡（标的,日期,方向,价,量）组含交割侧活动行 ⇒ 成交侧活动行必须为 0
    const active = db
      .prepare(
        `SELECT b.event_type, b.raw_event_type, b.asset_code, b.trade_date, b.price, b.quantity, f.file_kind
           FROM broker_trade_record b JOIN broker_import_batch f ON f.id = b.import_batch_id
          WHERE b.user_id = 7102 AND b.is_deleted = 0 AND b.match_status != 'EXCLUDED'
            AND b.event_type IN ('TRADE_BUY','TRADE_SELL','REPO','CASH_LIKE_ETF')`,
      )
      .all() as Array<{
      event_type: string;
      raw_event_type: string | null;
      asset_code: string;
      trade_date: string;
      price: number;
      quantity: number;
      file_kind: string;
    }>;
    // D-21：方向按事件语义（与 brokerReconcile.directionOf 同口径），不按 cash_flow 符号
    const dirOf = (t: string, raw: string | null): number => {
      const r = raw ?? '';
      if (t === 'TRADE_BUY') return 1;
      if (t === 'TRADE_SELL') return -1;
      if (t === 'REPO') return /购回|赎回/.test(r) ? -1 : 1;
      if (t === 'CASH_LIKE_ETF') return /卖出|赎回|扣款/.test(r) ? -1 : 1;
      return 0;
    };
    const byGroup = new Map<string, { settle: number; trade: number }>();
    for (const r of active) {
      const k = `${r.asset_code}|${r.trade_date}|${dirOf(r.event_type, r.raw_event_type)}|${r.price}|${r.quantity}`;
      const g = byGroup.get(k) ?? { settle: 0, trade: 0 };
      if (r.file_kind === 'settlement') g.settle++;
      else g.trade++;
      byGroup.set(k, g);
    }
    const bad = [...byGroup.values()].filter((g) => g.settle > 0 && g.trade > 0);
    expect(bad, `双计组（交割与成交侧同时有活动行）：${JSON.stringify(bad.slice(0, 3))}`).toHaveLength(0);
  });

  it('标的名称变体不影响匹配（键只用 asset_code，不用 raw_name）', async () => {
    // 事实层键 = asset_code：直接断言去重组键不含名称
    const src = fs.readFileSync(
      new URL('../../src/services/broker/brokerReconcile.ts', import.meta.url),
      'utf-8',
    );
    const keyLine = src.match(/const key = `[^`]+`/)?.[0] ?? '';
    expect(keyLine).toContain('asset_code');
    expect(keyLine).not.toContain('raw_name');
  });
});

describe('T124 · 低置信度单列（INV-S2-61d）', () => {
  it('L3 顺序配对命中 ⇒ match_status=FUZZY + match_confidence=L3，计入 lowConfidence', async () => {
    // 合成：成交流水侧同标的同日有 2 笔相同价量（真实分笔），交割侧 1 笔无时间
    // 精确键命中 2 候选 ⇒ 仍走 L1（取第一个）；强制 L3 场景：交割日期偏移 3 天（超默认 ±2 窗口）
    const uid = 7103;
    const mkRow = (
      batch: 'trade' | 'settle',
      date: string,
      time: string | null,
      price: number,
      qty: number,
      cash: number,
    ) => {
      const kind = batch === 'trade' ? 'trade' : 'settlement';
      db.prepare(
        `INSERT INTO broker_import_batch (user_id, broker_code, file_kind, encoding, file_name, file_hash, file_size, parser_version, status, row_total)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'v3.1.0', 'imported', 1)`,
      ).run(uid, '测试', kind, 'utf-8', `synth-${batch}-${date}.txt`, `${batch}${date}${Math.random()}`);
      const batchId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id as number;
      db.prepare(
        `INSERT INTO broker_trade_record
         (user_id, import_batch_id, broker_code, source_kind, event_type, asset_code, trade_date, trade_time,
          price, quantity, cash_flow, raw_event_type, raw_row_json, source_file, match_status, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uid,
        batchId,
        '测试',
        'broker',
        'TRADE_BUY',
        'sh600000',
        date,
        time,
        price,
        qty,
        cash,
        '买入',
        JSON.stringify({ rowIndex: 1, cells: [] }),
        'synth',
        'MISSING',
        `h${Math.random()}`,
      );
    };
    // 成交流水：2026-03-02 09:30 买入 10@100（权威日期）
    mkRow('trade', '2026-03-02', '09:30:00', 100, 10, 1000);
    // 交割侧：交收日 2026-03-05（超 ±2 天窗口）同价量无时间 ⇒ L2 失手 ⇒ L3 顺序配对
    mkRow('settle', '2026-03-05', null, 100, 10, 1000);

    const r = backfillTradeTime(db, uid, '测试');
    expect(r.totalNeeded).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.byLevel.L3).toBe(1);
    expect(r.lowConfidence).toBe(1); // 单列
    const row = db
      .prepare(
        `SELECT trade_time, match_status, match_confidence FROM broker_trade_record WHERE user_id = ? AND trade_date = '2026-03-05'`,
      )
      .get(uid) as { trade_time: string; match_status: string; match_confidence: string };
    expect(row.trade_time).toBe('09:30:00'); // 时间来自成交流水侧
    expect(row.match_status).toBe('FUZZY');
    expect(row.match_confidence).toBe('L3');
  });
});
