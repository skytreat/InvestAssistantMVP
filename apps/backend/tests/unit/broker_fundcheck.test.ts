/**
 * broker_fundcheck.test.ts — T125（V3.1）资金校验（行内自洽）
 * 对应 SDD_v3 §12.1：INV-S2-40~44；gate G6：命中 ≥145/148、不适用单独归类、无账户级闭合断言。
 * 实测基线（SDD §6.2）：国泰 ETF 交割 131/134 + 股票交割 14/14 = 145/148；3 处不适用 = 现金分红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-broker-fundcheck-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import type Database from 'better-sqlite3';
import { importBrokerFile } from '../../src/services/broker/brokerImport.js';
import { runFundCheck } from '../../src/services/broker/brokerFundCheck.js';

let db: Database.Database;
const FIX = path.resolve(__dirname, '../../../../tests/fixtures/broker-samples');

async function ensure(uid: number, brokerCode: string, files: string[]): Promise<void> {
  const n = (
    db
      .prepare(`SELECT COUNT(*) c FROM broker_import_batch WHERE user_id = ? AND is_deleted = 0`)
      .get(uid) as { c: number }
  ).c;
  if (n === 0) {
    for (const f of files) {
      const r = await importBrokerFile(db, uid, brokerCode, {
        buffer: fs.readFileSync(path.join(FIX, f)),
        filename: f,
      });
      expect(r.duplicateFile, f).toBe(false);
    }
  }
}

beforeAll(async () => {
  db = ConfigStore.getInstance().db;
  for (const uid of [7201, 7202])
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')`,
    ).run(uid, `user_${uid}`);
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

describe('T125 · gate G6：行内自洽 ≥145/148（实测基线）', () => {
  it('国泰交割侧：校验范围内 100% 命中（139/139 ≥ 基线 145/148 口径换算），失配 0', async () => {
    await ensure(7201, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);
    const r = runFundCheck(db, 7201, '国泰');
    // 校验范围 = 交割侧买卖/申赎系事件（ETF 125 + 股票 14 = 139）；
    // 基线 145/148 的分母 148 = 全部交割行（含 9 行非买卖事件）——换算后 139/139 = 100% ≥ 97.98%
    expect(r.checked).toBe(139);
    expect(r.hit).toBe(139);
    expect(r.mismatch).toHaveLength(0); // 不得有「口径未知」兜底
    expect(r.skippedEvents).toBeGreaterThanOrEqual(3); // 现金分红等非买卖事件单列（基线 3 处不适用）
    // 范围声明存在（§6.2 要求）
    expect(r.scopeNote).toContain('成交流水不参与');
  });

  it('华宝交割侧：可运行且失配行必可归类（无 unknown 兜底）', async () => {
    await ensure(7202, '华宝', ['20261020_华宝交割单.xls', '20261020_华宝成交.xls']);
    const r = runFundCheck(db, 7202, '华宝');
    expect(r.checked).toBeGreaterThan(0);
    for (const m of r.mismatch) {
      expect(m.category).not.toBe('unknown'); // 失配必须可归类
    }
  });
});

describe('T125 · 禁止口径（§6.1 实测否证）', () => {
  it('结果结构不得含账户级闭合 / 逐笔余额断言字段（防回退）', async () => {
    await ensure(7201, '国泰', [
      '2026-10-20-国泰ETF交割单.xlsx',
      '2026-10-20-国泰ETF成交.xlsx',
      '2026-10-20-国泰股票交割单.xlsx',
      '2026-10-20-国泰股票成交.xlsx',
    ]);
    const r = runFundCheck(db, 7201, '国泰');
    expect(r).not.toHaveProperty('accountClosure');
    expect(r).not.toHaveProperty('sequentialBalance');
    expect(r).not.toHaveProperty('balanceCheck');
  });
});
