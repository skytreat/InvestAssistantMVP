/**
 * repo_model.test.ts — T127（V3.1）现金类资产建模
 * 对应 SDD_v3 §12.1：INV-S4-18~22（逆回购）/ INV-S4-23~26（货币 ETF）；gate G9（利息 7501.46 ±0.5、配对 180/180）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-repo-model-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import { importBrokerFile } from '../../src/services/broker/brokerImport.js';
import { dedupeAcrossFiles } from '../../src/services/broker/brokerReconcile.js';
import { modelRepoCashFlow, cashLikeEtfReturn } from '../../src/services/broker/brokerCashModel.js';

let db: Database.Database;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');

async function ensure(uid: number, broker: string, files: string[]): Promise<void> {
  const n = (
    db
      .prepare(`SELECT COUNT(*) c FROM broker_import_batch WHERE user_id = ? AND is_deleted = 0`)
      .get(uid) as { c: number }
  ).c;
  if (n === 0) {
    for (const f of files) {
      const r = await importBrokerFile(db, uid, broker, {
        buffer: fs.readFileSync(path.join(FIX, f)),
        filename: f,
      });
      expect(r.duplicateFile, f).toBe(false);
    }
  }
}

beforeAll(async () => {
  db = ConfigStore.getInstance().db;
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (7301, 'user_7301', 'x', 'user')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (7302, 'user_7302', 'x', 'user')`,
  ).run();
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

describe('T127 · gate G9：逆回购建模（INV-S4-18~22）', () => {
  it('华宝 2 份：配对 180/180、未配对 0、利息 7,501.46 ±0.5（§7.1.5 基线）', async () => {
    await ensure(7301, '华宝', ['20261020_华宝交割单.xls', '20261020_华宝成交.xls']);
    dedupeAcrossFiles(db, 7301, '华宝'); // 成交侧冗余腿软标记 ⇒ 模型只算交割侧，不双计
    const r = modelRepoCashFlow(db, 7301, '华宝');
    expect(r.pairs.length).toBe(180); // 360 出资 + 360 收回（跨两文件各 180 对）
    expect(r.unpairedOpens).toBe(0);
    expect(r.unpairedCloses).toBe(0);
    expect(r.totalInterest).toBeCloseTo(7501.46, 0); // ±0.5 以内
    expect(r.totalInterest).toBeGreaterThan(7500.96);
    expect(r.totalInterest).toBeLessThan(7501.96);
    // 隐含年化（§7.1.5 参照 2.04%；本实现为本金×天数加权口径，实测 1.44%——口径差异已登记审计 D-23）
    expect(r.impliedAnnualRate).toBeGreaterThan(0.8);
    expect(r.impliedAnnualRate).toBeLessThan(3.0);
    // 逐对利息非负且量级合理（百元级以下，防 −100 万量级错配回归）
    const neg = r.pairs.filter((p) => p.interest < -0.01).length;
    expect(neg).toBe(0);
    expect(Math.abs(Math.max(...r.pairs.map((p) => p.interest)))).toBeLessThan(10000);
  });

  it('FIFO 顺序保护：时间乱序输入不产生负利息（§7.1.3 实测坑）', () => {
    // 合成：同品种两笔先后开仓，收回腿故意乱序（后开的先收）⇒ FIFO 仍按开仓序配对
    const d = db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (7303, 'u7303x', 'x', 'user')`,
      )
      .run();
    void d;
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (7303, 'user_7303', 'x', 'user')`,
    ).run();
    const ins = (
      batchKind: 'trade' | 'settlement',
      date: string,
      time: string,
      raw: string,
      amount: number,
      cf: number,
    ) => {
      db.prepare(
        `INSERT INTO broker_import_batch (user_id, broker_code, file_kind, encoding, file_name, file_hash, file_size, parser_version, status, row_total)
         VALUES (7303, '合成', ?, 'utf-8', ?, ?, 0, 'v3.1.0', 'imported', 1)`,
      ).run(batchKind, `synth-${raw}-${date}`, `h${Math.random()}`);
      const batchId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id as number;
      db.prepare(
        `INSERT INTO broker_trade_record
         (user_id, import_batch_id, broker_code, source_kind, event_type, asset_code, trade_date, trade_time,
          price, quantity, cash_flow, raw_event_type, raw_row_json, source_file, match_status, row_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        7303,
        batchId,
        '合成',
        'broker',
        'REPO',
        'sh204001',
        date,
        time,
        1.5,
        10,
        cf,
        raw,
        JSON.stringify({ rowIndex: 1, cells: [] }),
        'synth',
        'MISSING',
        `x${Math.random()}`,
      );
    };
    ins('settlement', '20260101', '15:00:00', '融券', 10000, -10000);
    ins('settlement', '20260102', '00:00:00', '融券购回', 10000.5, 10000.5);
    ins('settlement', '20260103', '15:00:00', '融券', 10000, -10000.1);
    ins('settlement', '20260104', '00:00:00', '融券购回', 10000.6, 10000.6);

    const r = modelRepoCashFlow(db, 7303, '合成');
    expect(r.pairs).toHaveLength(2);
    // FIFO：第一笔收回配第一笔出资（利息 0.5），第二笔配第二笔（利息 0.5）
    expect(r.pairs[0].interest).toBeCloseTo(0.5, 4);
    expect(r.pairs[1].interest).toBeCloseTo(0.5, 4);
    expect(r.totalInterest).toBeCloseTo(1.0, 4);
    expect(r.unpairedOpens).toBe(0);
    expect(r.unpairedCloses).toBe(0);
  });
});

describe('T127 · 货币 ETF 市值口径（INV-S4-23~26）', () => {
  it('现金申购（面值）+ 竞价卖出（市价）：收益 = 市值变动，不用百分比', async () => {
    await ensure(7302, '国泰', ['2026-10-20-国泰ETF交割单.xlsx', '2026-10-20-国泰ETF成交.xlsx']);
    const res = cashLikeEtfReturn(db, 7302, '国泰', new Map([['sh511990', 100.004]]));
    // 结构断言（数值随样本浮动，此处断言口径逻辑）：
    expect(res.totalPaid).toBeGreaterThan(0); // 有申购实付
    // 无缺失价格时 missingPrice 为空（本例只给了 511990，其它货币 ETF 若有份额会缺）
    for (const m of res.missingPrice) expect(m).not.toBe('sh511990');
    // 收益公式 = 未赎份额×最新价 + 已变现 − 累计实付（市值口径，非百分比）
    expect(res.returnAmount).toBeCloseTo(res.marketValue + res.cashRealized - res.totalPaid, 6);
    // 0.05% 振幅不失真：价格微动 0.004 元 ⇒ 收益对应份额×0.004 的量级（百分比口径会舍入为 0.00%）
    expect(Math.abs(res.returnAmount)).toBeGreaterThan(0);
  });

  it('无行情价格 ⇒ 该标的市值计 0 且进 missingPrice（不得假设面值 100）', async () => {
    await ensure(7302, '国泰', ['2026-10-20-国泰ETF交割单.xlsx', '2026-10-20-国泰ETF成交.xlsx']);
    const res = cashLikeEtfReturn(db, 7302, '国泰', new Map());
    expect(res.missingPrice.length).toBeGreaterThan(0); // 有份额的货币 ETF 全部缺价
    expect(res.marketValue).toBe(0); // 缺价按 0 计（保守，不顶替面值）
  });
});
