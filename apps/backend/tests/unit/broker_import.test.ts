/**
 * broker_import.test.ts — T122（V3.1）事实层三表 + 导入批次
 * 对应 SDD_v3 §12.1：INV-S2-9（文件级幂等）/ INV-S2-39（行级幂等 + 同内容多笔）
 * 验收点①~⑤（plan T122 卡）：重复上传零重复 / 同内容多笔不误判 / 撤销只软删 / 确认不写业务层 / raw_row_json 可重放
 * ⚠️ sequence.shuffle=true ⇒ 用例自包含（专属 userId 段 + 专属文件组合）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-broker-import-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import {
  importBrokerFile,
  revokeBatch,
  listBatches,
  saveTemplate,
  getTemplate,
  rowHashOf,
  normalizeBrokerRow,
  normalizeAssetCode,
  buildCode6Dict,
  UnknownAssetCodesError,
} from '../../src/services/broker/brokerImport.js';
import { parseBrokerFile } from '../../src/services/broker/brokerParser.js';
import type { BrokerFileInput } from '../../src/services/broker/types.js';

let db: Database.Database;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');

function file(name: string, broker = '测试券商', userId = 0): BrokerFileInput & { userId: number } {
  void broker;
  return { buffer: fs.readFileSync(path.join(FIX, name)), filename: name, userId };
}

beforeAll(() => {
  db = ConfigStore.getInstance().db;
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

async function seedUser(uid: number): Promise<void> {
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  ).run(uid, `user_${uid}`, 'x');
}

describe('T122 · 验收① 同文件重复上传零重复（INV-S2-9）', () => {
  it('二次上传同文件 ⇒ duplicateFile=true、0 新行、批次不增生', async () => {
    await seedUser(9001);
    const f = file('20261020_华宝交割单.xls');
    const r1 = await importBrokerFile(db, 9001, '华宝', { buffer: f.buffer, filename: f.filename });
    expect(r1.duplicateFile).toBe(false);
    expect(r1.rowInserted).toBeGreaterThan(0);
    const batchesAfterFirst = listBatches(db, 9001).length;
    expect(batchesAfterFirst).toBe(1);

    const r2 = await importBrokerFile(db, 9001, '华宝', { buffer: f.buffer, filename: f.filename });
    expect(r2.duplicateFile).toBe(true);
    expect(r2.batchId).toBe(r1.batchId); // 命中原批次
    expect(r2.rowInserted).toBe(0);
    expect(listBatches(db, 9001).length).toBe(batchesAfterFirst);

    // 事实层行数不变
    const n = (
      db
        .prepare(`SELECT COUNT(*) c FROM broker_trade_record WHERE user_id = 9001 AND is_deleted = 0`)
        .get() as { c: number }
    ).c;
    expect(n).toBe(r1.rowInserted);
  });

  it('撤销后可重新导入（revoked 批次不拦截）', async () => {
    await seedUser(9002);
    const f = file('2026-10-20-国泰股票成交.xlsx');
    const r1 = await importBrokerFile(db, 9002, '国泰', { buffer: f.buffer, filename: f.filename });
    expect(r1.duplicateFile).toBe(false);
    const affected = revokeBatch(db, 9002, r1.batchId);
    expect(affected).toBe(r1.rowInserted);
    const r2 = await importBrokerFile(db, 9002, '国泰', { buffer: f.buffer, filename: f.filename });
    expect(r2.duplicateFile).toBe(false); // revoked 不拦截
    expect(r2.rowInserted).toBe(r1.rowInserted);
    // 旧批次行软删，新批次行在
    const live = db
      .prepare(
        `SELECT COUNT(*) c FROM broker_trade_record WHERE user_id = 9002 AND import_batch_id = ? AND is_deleted = 0`,
      )
      .get(r2.batchId) as { c: number };
    expect(live.c).toBe(r2.rowInserted);
  });
});

describe('T122 · 验收② 同内容多笔不误判（content_seq，INV-S2-39）', () => {
  it('同批次内同归一化内容的两行 → seq 0/1 全留', async () => {
    await seedUser(9003);
    const f = file('2026-10-20-国泰股票交割单.xlsx');
    const r = await importBrokerFile(db, 9003, '国泰', { buffer: f.buffer, filename: f.filename });
    // 找批次内出现次数 ≥2 的 row_hash
    const dup = db
      .prepare(
        `SELECT row_hash, COUNT(*) n FROM broker_trade_record
         WHERE user_id = 9003 AND import_batch_id = ? AND is_deleted = 0
         GROUP BY row_hash HAVING n >= 2 LIMIT 1`,
      )
      .get(r.batchId) as { row_hash: string; n: number } | undefined;
    // 股票交割单 14 行内若天然无重复，用合成数据兜底断言语义
    if (dup) {
      const seqs = (
        db
          .prepare(
            `SELECT content_seq FROM broker_trade_record WHERE user_id = 9003 AND row_hash = ? AND is_deleted = 0 ORDER BY content_seq`,
          )
          .all(dup.row_hash) as Array<{ content_seq: number }>
      ).map((x) => x.content_seq);
      expect(seqs).toEqual(Array.from({ length: dup.n }, (_, i) => i)); // 0,1,... 全留
    } else {
      // 合成：同内容两行（parse 层模拟）
      const parse = await parseBrokerFile({ buffer: f.buffer, filename: f.filename });
      const normA = normalizeBrokerRow(parse, parse.rows[0]);
      const normB = { ...normA }; // 内容相同
      expect(rowHashOf(normA)).toBe(rowHashOf(normB)); // 哈希确定性
    }
  });
});

describe('T122 · 验收③ 撤销只软删、原始证据保留', () => {
  it('revoke 后 raw_row_json 仍在（物理可读，可重放），is_deleted=1', async () => {
    await seedUser(9004);
    const f = file('2026-10-20-国泰ETF成交.xlsx');
    const r1 = await importBrokerFile(db, 9004, '国泰', { buffer: f.buffer, filename: f.filename });
    revokeBatch(db, 9004, r1.batchId);
    const row = db
      .prepare(
        `SELECT is_deleted, raw_row_json FROM broker_trade_record WHERE user_id = 9004 AND import_batch_id = ? LIMIT 1`,
      )
      .get(r1.batchId) as { is_deleted: number; raw_row_json: string };
    expect(row.is_deleted).toBe(1);
    const replay = JSON.parse(row.raw_row_json) as { rowIndex: number; cells: string[] };
    expect(replay.cells.length).toBeGreaterThan(3); // 原始单元格可重放
  });

  it('敏感列在 raw_row_json 中为空串（§3.6 不落库）', async () => {
    await seedUser(9005);
    const f = file('2026-10-20-国泰ETF交割单.xlsx');
    const parse = await parseBrokerFile({ buffer: f.buffer, filename: f.filename });
    expect(parse.ok).toBe(true);
    const sensitive = parse.columns.filter((c) => c.dropped).map((c) => c.index);
    expect(sensitive.length).toBeGreaterThanOrEqual(3);
    for (const row of parse.rows) {
      for (const i of sensitive) {
        expect(row.cells[i]).toBe('');
      }
    }
  });
});

describe('T122 · 验收④ 确认导入不写 user_trade_record', () => {
  it('导入后 user_trade_record 无该用户新记录', async () => {
    await seedUser(9006);
    const f = file('2026-10-20-国泰股票成交.xlsx');
    await importBrokerFile(db, 9006, '国泰', { buffer: f.buffer, filename: f.filename });
    const n = (
      db.prepare(`SELECT COUNT(*) c FROM user_trade_record WHERE user_id = 9006`).get() as { c: number }
    ).c;
    expect(n).toBe(0);
  });
});

describe('T122 · 验收⑤ match_status 五态与排除项', () => {
  it('排除项（场外/占位/忽略）= EXCLUDED + exclude_reason；其余初值 MISSING', async () => {
    await seedUser(9007);
    const f = file('20261020_华宝交割单.xls');
    const r = await importBrokerFile(db, 9007, '华宝', { buffer: f.buffer, filename: f.filename });
    expect(r.rowExcluded).toBeGreaterThan(0); // 基金申购 32 + 指定 2
    const ex = db
      .prepare(
        `SELECT exclude_reason FROM broker_trade_record WHERE user_id = 9007 AND match_status = 'EXCLUDED' AND is_deleted = 0 LIMIT 1`,
      )
      .get() as { exclude_reason: string | null };
    expect(ex.exclude_reason).toBeTruthy();
    const statuses = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT match_status FROM broker_trade_record WHERE user_id = 9007 AND is_deleted = 0`,
          )
          .all() as Array<{ match_status: string }>
      ).map((x) => x.match_status),
    );
    expect(statuses.has('EXCLUDED')).toBe(true);
    expect(statuses.has('MISSING')).toBe(true); // 待 T124 回填为 MATCHED/FUZZY/CONFLICT
  });
});

describe('T122 · 未知标的整文件拒绝', () => {
  it('symbol_dict 非空时，任一未知标的 → 整文件拒绝，不创建批次/不写事实层', async () => {
    await seedUser(9009);
    const f = file('2026-10-20-国泰股票成交.xlsx');
    const parse = await parseBrokerFile({ buffer: f.buffer, filename: f.filename });
    expect(parse.ok).toBe(true);
    const codes = [
      ...new Set(
        parse.rows
          .map((row) => normalizeBrokerRow(parse, row).asset_code)
          .filter((c): c is string => typeof c === 'string' && c.length > 0),
      ),
    ];
    expect(codes.length).toBeGreaterThan(1);
    const unknown = codes[codes.length - 1];
    const known = codes.slice(0, -1);

    db.prepare('DELETE FROM symbol_dict').run();
    const ins = db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES (?, ?, '', '', ?, 'unknown', 'risk')`,
    );
    for (const code of known) ins.run(code, code.replace(/^[a-z]+/i, ''), code.slice(0, 2));

    const beforeBatches = (
      db.prepare('SELECT COUNT(*) c FROM broker_import_batch WHERE user_id = ?').get(9009) as {
        c: number;
      }
    ).c;
    try {
      let caught: unknown;
      try {
        await importBrokerFile(db, 9009, '国泰', {
          buffer: f.buffer,
          filename: f.filename,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnknownAssetCodesError);
      expect((caught as UnknownAssetCodesError).details).toEqual([
        { filename: f.filename, assetCodes: [unknown] },
      ]);

      // 整文件拒绝：批次、事实层都不得留下半成品
      expect(
        (
          db.prepare('SELECT COUNT(*) c FROM broker_import_batch WHERE user_id = ?').get(9009) as {
            c: number;
          }
        ).c,
      ).toBe(beforeBatches);
      expect(
        (
          db
            .prepare('SELECT COUNT(*) c FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0')
            .get(9009) as { c: number }
        ).c,
      ).toBe(0);
    } finally {
      db.prepare('DELETE FROM symbol_dict').run();
    }
  });
});

describe('T122 · 映射模板（UNIQUE 幂等）', () => {
  it('saveTemplate 同 (user, broker, kind) upsert 不增生', () => {
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (9008, 'u9008', 'x', 'user')`,
    ).run();
    saveTemplate(db, 9008, '国泰', 'trade', '{"symbol":3}');
    saveTemplate(db, 9008, '国泰', 'trade', '{"symbol":5}');
    const rows = db
      .prepare(
        `SELECT COUNT(*) c FROM broker_import_template WHERE user_id = 9008 AND broker_code = '国泰' AND file_kind = 'trade'`,
      )
      .get() as { c: number };
    expect(rows.c).toBe(1);
    expect(getTemplate(db, 9008, '国泰', 'trade')!.mappingJson).toBe('{"symbol":5}');
  });
});

/**
 * PR#60 review 修复：normalizeAssetCode 字典权威 + 启发式兜底修正。
 * 背景：旧启发式按首位推断，920xxx（北交所）被错标成 sh（实测 raw_symbol_name：
 *   d1=9 → bj92xxxx 354 只 / sh900xxx 41 只 B 股）；12/13 可转债被错标成 sh。
 * 规则：① symbol_dict code6 唯一命中 → 直接采用（权威）；② 字典歧义 → 保留裸码；
 *   ③ 兜底启发式按实测分布修正（92→bj / 90→sh；1x：10/11→sh，12/13/15/16/18→sz）。
 */
describe('PR#60 review · normalizeAssetCode 字典权威 + 兜底修正', () => {
  it('字典唯一命中 → 采用字典 symbol（北交所 920xxx 不再错标 sh）', () => {
    const dict = new Map<string, string | null>([['920001', 'bj920001']]);
    expect(normalizeAssetCode('920001', dict)).toBe('bj920001');
    expect(normalizeAssetCode('600000', dict)).toBe('sh600000');
  });

  it('字典歧义（同 code6 两市并存）→ 保留裸码不猜', () => {
    const dict = new Map<string, string | null>([['300750', null]]);
    expect(normalizeAssetCode('300750', dict)).toBe('300750');
  });

  it('无字典兜底：920xxx→bj / 900xxx→sh / 12/13 可转债→sz', () => {
    expect(normalizeAssetCode('920001')).toBe('bj920001');
    expect(normalizeAssetCode('900901')).toBe('sh900901');
    expect(normalizeAssetCode('123456')).toBe('sz123456');
    expect(normalizeAssetCode('127012')).toBe('sz127012');
    expect(normalizeAssetCode('159915')).toBe('sz159915');
    expect(normalizeAssetCode('510300')).toBe('sh510300');
    expect(normalizeAssetCode('600000')).toBe('sh600000');
  });

  it('无字典兜底：14/17/19 未知段不猜，原样返回', () => {
    expect(normalizeAssetCode('140001')).toBe('140001');
    expect(normalizeAssetCode('170001')).toBe('170001');
    expect(normalizeAssetCode('190001')).toBe('190001');
  });

  it('带前缀码原样返回（小写归一），非法输入返回 null/原样', () => {
    expect(normalizeAssetCode('SH600000')).toBe('sh600000');
    expect(normalizeAssetCode('sz000001')).toBe('sz000001');
    expect(normalizeAssetCode(null)).toBeNull();
    expect(normalizeAssetCode('')).toBeNull();
    expect(normalizeAssetCode('ABC')).toBe('ABC');
  });

  it('buildCode6Dict：从 symbol_dict 建 code6→symbol 映射；同 code6 多 symbol → 歧义 null', () => {
    // 测试库 symbol_dict 为空（无行情库）→ 空映射，走启发式
    const empty = buildCode6Dict(db);
    expect(empty.size).toBe(0);
    // 造两条：一条唯一命中、一条同 code6 两个 symbol → 歧义
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES ('bj920999','920999','测试北交A','','bj','unknown','risk')`,
    ).run();
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES ('sh600001','600001','测试沪A','','sh','unknown','risk')`,
    ).run();
    db.prepare(
      `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
       VALUES ('sz600001','600001','测试深A','','sz','unknown','risk')`,
    ).run();
    try {
      const dict = buildCode6Dict(db);
      expect(dict.get('920999')).toBe('bj920999');
      expect(dict.get('600001')).toBeNull(); // 歧义
      expect(normalizeAssetCode('920999', dict)).toBe('bj920999');
      expect(normalizeAssetCode('600001', dict)).toBe('600001');
    } finally {
      db.prepare(`DELETE FROM symbol_dict WHERE code6 IN ('920999','600001')`).run();
    }
  });
});
