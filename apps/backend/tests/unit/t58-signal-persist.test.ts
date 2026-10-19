/**
 * T58 —— 信号落库字段补全 + `user_asset_rel` 持仓关系同步
 *
 * ① `is_final = 1` 显式写入（persistSignals / persistBatchSignals）
 * ② `metrics_json` = 插件回传的数值明细；无 metrics → NULL（不是 'null' 字符串）；
 *    且**不夹带** detail 自由文本 / 任何凭证
 * ③ 买入后 `rel_type='hold'` 存在；清仓（持仓归零）后**软删**
 * ④ 软删 / 恢复交易同样同步 hold 关系
 * ⑤ exDividendSync 主分支（user_asset_rel hold）已覆盖交易表用户 → 兜底分支补不到新用户
 *
 * 本文件用 `app.inject()`（进程内，不 listen、不占端口）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

// --- 必须在 import src 之前覆盖 SQLITE_DB_PATH（隔离开发库）---
// T81：顶层写 env 必须留原值并在 afterAll 还原，否则会漏给下一个测试文件
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-t58-persist-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { persistSignals, persistBatchSignals, SIGNAL_INSERT_SQL } from '../../src/services/signalService.js';
import { registerTradeRoutes, syncHoldRelation } from '../../src/routes/trade.js';
import type { PluginSignal } from '../../src/services/pluginEngine.js';
import type { JwtPayload } from '../../src/services/auth.js';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

const SIGNAL_USER_ID = 8901;
const TRADE_USER_ID = 8902;

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`
  ).run(SIGNAL_USER_ID, 't58_signal_user');
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`
  ).run(TRADE_USER_ID, 't58_trade_user');

  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(SIGNAL_USER_ID);

  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = {
      sub: TRADE_USER_ID, username: 't58_trade_user', role: 'user',
      iat: 0, exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerTradeRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close().catch(() => {});
  try { (db.db as unknown as { close: () => void }).close(); } catch { /* ignore */ }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

// ────────────────────────────────────────────────────────────
// ① is_final
// ────────────────────────────────────────────────────────────
function makeSignal(over: Partial<PluginSignal> = {}): PluginSignal {
  return {
    symbol: 'sh600000',
    signalType: 'BUY',
    pluginId: 'rsi_oversold',
    timestamp: '2026-10-15T00:00:00.000Z',
    ...over,
  };
}

describe('T58 · is_final 显式落库', () => {
  it('INSERT 语句里带 is_final 列（防止只靠 DDL DEFAULT 而无断言保护）', () => {
    expect(SIGNAL_INSERT_SQL).toMatch(/\bis_final\b/);
    expect(SIGNAL_INSERT_SQL).toMatch(/\bis_final\s*\)?\s*$/m);
  });

  it('persistSignals 写入的行 is_final = 1', () => {
    const r = persistSignals([makeSignal({ symbol: 'sh600519' })], 'rsi_oversold', 'monitor', '2026-10-15', SIGNAL_USER_ID);
    expect(r).toEqual({ inserted: 1, skipped: 0, errors: 0 });

    const row = db.db
      .prepare('SELECT is_final FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?')
      .get(SIGNAL_USER_ID, 'sh600519', '2026-10-15') as { is_final: number };
    expect(row.is_final).toBe(1);
  });

  it('persistBatchSignals 写入的行 is_final = 1（两条都验）', () => {
    const r = persistBatchSignals(
      [
        { pluginId: 'macd_cross', pluginCategory: 'monitor', signals: [makeSignal({ symbol: 'sz000001', signalType: 'SELL' })] },
        { pluginId: 'volume_spike', pluginCategory: 'filter', signals: [makeSignal({ symbol: 'sh601318', signalType: 'HOLD' })] },
      ],
      '2026-10-16',
      SIGNAL_USER_ID,
    );
    expect(r).toEqual({ inserted: 2, skipped: 0, errors: 0 });

    for (const code of ['sz000001', 'sh601318']) {
      const row = db.db
        .prepare('SELECT is_final FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?')
        .get(SIGNAL_USER_ID, code, '2026-10-16') as { is_final: number };
      expect(row.is_final).toBe(1);
    }
  });
});

// ────────────────────────────────────────────────────────────
// ② metrics_json
// ────────────────────────────────────────────────────────────
describe('T58 · metrics_json = 插件数值明细', () => {
  it('内容与 metrics 逐字段相等', () => {
    const metrics = { period: 14, oversold: 30, latestRSI: 28.5 };
    persistSignals([makeSignal({ symbol: 'sz000002', metrics })], 'rsi_oversold', 'monitor', '2026-10-17', SIGNAL_USER_ID);

    const row = db.db
      .prepare('SELECT metrics_json FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?')
      .get(SIGNAL_USER_ID, 'sz000002', '2026-10-17') as { metrics_json: string };
    expect(JSON.parse(row.metrics_json)).toEqual(metrics);
  });

  it('无 metrics → 落 NULL（不是字符串 "null"）', () => {
    persistSignals([makeSignal({ symbol: 'sz000003' })], 'rsi_oversold', 'monitor', '2026-10-17', SIGNAL_USER_ID);
    const row = db.db
      .prepare('SELECT metrics_json, typeof(metrics_json) AS t FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?')
      .get(SIGNAL_USER_ID, 'sz000003', '2026-10-17') as { metrics_json: string | null; t: string };
    expect(row.metrics_json).toBeNull();
    expect(row.t).toBe('null');
  });

  it('不夹带 detail 自由文本 / 凭证类字段（只序列化 metrics）', () => {
    const metrics = { rsi: 28.5 };
    persistSignals(
      [makeSignal({ symbol: 'sz000004', metrics, detail: 'token=SECRET-abc123 疑似内部凭证' })],
      'rsi_oversold', 'monitor', '2026-10-17', SIGNAL_USER_ID,
    );
    const row = db.db
      .prepare('SELECT metrics_json FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?')
      .get(SIGNAL_USER_ID, 'sz000004', '2026-10-17') as { metrics_json: string };
    expect(JSON.parse(row.metrics_json)).toEqual(metrics);
    expect(row.metrics_json).not.toContain('SECRET');
    expect(row.metrics_json).not.toContain('token');
    expect(row.metrics_json).not.toContain('detail');
  });

  it('metrics 值为 0 时不能被当成 falsy 丢成 NULL', () => {
    persistSignals([makeSignal({ symbol: 'sz000005', metrics: { dif: 0 } })], 'macd_cross', 'monitor', '2026-10-17', SIGNAL_USER_ID);
    const row = db.db
      .prepare('SELECT metrics_json FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?')
      .get(SIGNAL_USER_ID, 'sz000005', '2026-10-17') as { metrics_json: string };
    expect(JSON.parse(row.metrics_json)).toEqual({ dif: 0 });
  });
});

// ────────────────────────────────────────────────────────────
// ③④ user_asset_rel hold 同步
// ────────────────────────────────────────────────────────────
function holdRow(code: string) {
  return db.db
    .prepare('SELECT id, is_deleted FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = ?')
    .get(TRADE_USER_ID, code, 'hold') as { id: number; is_deleted: number } | undefined;
}

function cleanCode(code: string) {
  db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ? AND asset_code = ?').run(TRADE_USER_ID, code);
  db.db.prepare('DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = ?').run(TRADE_USER_ID, code);
}

let timeSeq = 0;
function nextTime(): string {
  timeSeq += 1;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(9 + Math.floor(timeSeq / 3600))}:${p(Math.floor(timeSeq / 60) % 60)}:${p(timeSeq % 60)}`;
}

async function postTrade(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/trade', payload: { trade_time: nextTime(), ...payload } });
}

describe('T58 · 买入后 hold 关系存在', () => {
  it('POST buy → user_asset_rel 出现 rel_type=hold 且 is_deleted=0', async () => {
    const code = 'sh600036';
    cleanCode(code);

    const res = await postTrade({
      asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10,
      trade_reason: '建仓',
    });
    expect(res.statusCode).toBe(201);

    const row = holdRow(code);
    expect(row).toBeDefined();
    expect(row!.is_deleted).toBe(0);
  });

  it('hold 行只建 1 条（重复买入不产生第二行）', async () => {
    const code = 'sh600037';
    cleanCode(code);
    await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'a' });
    await postTrade({ asset_code: code, trade_type: 'add', trade_date: '2026-10-16', quantity: 100, price: 11, trade_reason: 'b' });

    const cnt = db.db
      .prepare(`SELECT COUNT(*) AS c FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = 'hold'`)
      .get(TRADE_USER_ID, code) as { c: number };
    expect(cnt.c).toBe(1);
    expect(holdRow(code)!.is_deleted).toBe(0);
  });

  it('hold 关系不与 watch / candidate 互相影响（三列唯一独立共存）', async () => {
    const code = 'sh600038';
    cleanCode(code);
    db.db.prepare('DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = ?').run(TRADE_USER_ID, code);
    db.db.prepare(`INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, 'watch')`).run(TRADE_USER_ID, code);
    db.db.prepare(`INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, 'candidate')`).run(TRADE_USER_ID, code);

    await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'a' });

    const rows = db.db
      .prepare(`SELECT rel_type, is_deleted FROM user_asset_rel WHERE user_id = ? AND asset_code = ? ORDER BY rel_type`)
      .all(TRADE_USER_ID, code) as Array<{ rel_type: string; is_deleted: number }>;
    expect(rows).toEqual([
      { rel_type: 'candidate', is_deleted: 0 },
      { rel_type: 'hold', is_deleted: 0 },
      { rel_type: 'watch', is_deleted: 0 },
    ]);
  });
});

describe('T58 · 清仓后软删 hold 关系', () => {
  it('buy 100 → reduce 100 → hold 行仍在但 is_deleted=1（软删，非物理删除）', async () => {
    const code = 'sh600039';
    cleanCode(code);

    await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: '建仓' });
    const idBefore = holdRow(code)!.id;
    expect(holdRow(code)!.is_deleted).toBe(0);

    const res = await postTrade({
      asset_code: code, trade_type: 'reduce', trade_date: '2026-10-16', quantity: 100, price: 12, trade_reason: '清仓',
    });
    expect(res.statusCode).toBe(201);

    const row = holdRow(code);
    expect(row).toBeDefined();                 // 行还在 = 软删，不是 DELETE
    expect(row!.id).toBe(idBefore);            // 没重建
    expect(row!.is_deleted).toBe(1);
  });

  it('buy 100 → reduce 40（仍有持仓）→ hold 保持 is_deleted=0', async () => {
    const code = 'sh600040';
    cleanCode(code);
    await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'a' });
    await postTrade({ asset_code: code, trade_type: 'reduce', trade_date: '2026-10-16', quantity: 40, price: 12, trade_reason: 'b' });
    expect(holdRow(code)!.is_deleted).toBe(0);
  });

  it('清仓后再次买入 → 同一行被恢复（is_deleted 0），不新建行', async () => {
    const code = 'sh600041';
    cleanCode(code);
    await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'a' });
    const idBefore = holdRow(code)!.id;
    await postTrade({ asset_code: code, trade_type: 'clear', trade_date: '2026-10-16', quantity: 100, price: 12, trade_reason: 'b' });
    expect(holdRow(code)!.is_deleted).toBe(1);

    await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-17', quantity: 50, price: 13, trade_reason: 'c' });
    const row = holdRow(code);
    expect(row!.id).toBe(idBefore);
    expect(row!.is_deleted).toBe(0);
  });
});

describe('T58 · 软删 / 恢复交易同步 hold', () => {
  /** T81：造一条「已建仓且已软删」的交易，两个用例各自调用 → 不依赖执行顺序 */
  async function seedSoftDeletedTrade(code: string): Promise<number> {
    cleanCode(code);
    const buy = await postTrade({ asset_code: code, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'a' });
    expect(buy.statusCode).toBe(201);
    const tradeId = (JSON.parse(buy.body).data as { trade_id: number }).trade_id;
    const del = await app.inject({ method: 'POST', url: `/api/trade/${tradeId}/soft-delete` });
    expect(del.statusCode).toBe(200);
    return tradeId;
  }

  it('软删唯一的买入交易 → 持仓归零 → hold 软删', async () => {
    const code = 'sh600042';
    await seedSoftDeletedTrade(code);
    expect(holdRow(code)!.is_deleted).toBe(1);
  });

  it('恢复该交易 → hold 恢复为 is_deleted=0', async () => {
    const code = 'sh600042';
    // T81：自带前置（建仓 + 软删），不依赖上一个用例跑过
    const tradeId = await seedSoftDeletedTrade(code);
    expect(holdRow(code)!.is_deleted).toBe(1);

    const res = await app.inject({ method: 'POST', url: `/api/trade/${tradeId}/restore` });
    expect(res.statusCode).toBe(200);
    expect(holdRow(code)!.is_deleted).toBe(0);
  });

  it('syncHoldRelation 直接调用：幂等，重复调用不新增行', () => {
    const code = 'sh600043';
    cleanCode(code);
    db.db.prepare(
      `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
       VALUES (?, ?, 'buy', '2026-10-15', '09:30:00', 100, 10, 0, 0)`
    ).run(TRADE_USER_ID, code);

    expect(syncHoldRelation(TRADE_USER_ID, code)).toEqual({ action: 'created', totalQuantity: 100 });
    expect(syncHoldRelation(TRADE_USER_ID, code)).toEqual({ action: 'kept', totalQuantity: 100 });

    const cnt = db.db
      .prepare(`SELECT COUNT(*) AS c FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = 'hold'`)
      .get(TRADE_USER_ID, code) as { c: number };
    expect(cnt.c).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// ⑤ exDividendSync 主分支覆盖（兜底分支不再需要）
// ────────────────────────────────────────────────────────────
describe('T58 · exDividendSync 用户来源：主分支已覆盖', () => {
  /**
   * 复刻 exDividendSync.importDividendEvents 里的两条查询（该文件在禁改区）：
   *   主分支 user_asset_rel (rel_type='hold')
   *   兜底分支 user_trade_record
   * 断言：经 trade.ts 写入的**在持**用户全部被主分支命中 →
   *        `userIds.size === 0` 不成立 → 兜底分支不会执行。
   *
   * ⚠️ T81：本 describe 自带独立标的 + 自带前置（经 trade.ts 写入），
   *    不再依赖同文件其它 describe 是否跑过（打乱顺序时原写法会读到 0 条交易）。
   */
  const HOLD_CODE = 'sh600136';    // 仍持仓 → 主分支应命中
  const CLEARED_CODE = 'sh600139'; // buy 100 → reduce 100 → 持仓 0 → 主分支不命中

  beforeAll(async () => {
    await postTrade({ asset_code: HOLD_CODE, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'exdiv-src' });
    await postTrade({ asset_code: CLEARED_CODE, trade_type: 'buy', trade_date: '2026-10-15', quantity: 100, price: 10, trade_reason: 'exdiv-src' });
    await postTrade({ asset_code: CLEARED_CODE, trade_type: 'reduce', trade_date: '2026-10-16', quantity: 100, price: 12, trade_reason: 'exdiv-src' });
  });

  it('持有中的用户全部由 user_asset_rel hold 主分支命中', () => {
    for (const code of [HOLD_CODE]) {
      const holders = db.db
        .prepare(`SELECT DISTINCT user_id FROM user_asset_rel WHERE asset_code = ? AND rel_type = 'hold' AND is_deleted = 0`)
        .all(code) as Array<{ user_id: number }>;
      const tradeUsers = db.db
        .prepare(`SELECT DISTINCT user_id FROM user_trade_record WHERE asset_code = ? AND is_deleted = 0`)
        .all(code) as Array<{ user_id: number }>;

      const holderIds = new Set(holders.map((h) => h.user_id));
      expect(tradeUsers.length).toBeGreaterThan(0);
      expect(tradeUsers.every((u) => holderIds.has(u.user_id))).toBe(true);
    }
  });

  it('已清仓用户不再出现在主分支（与 exDividendSync「持仓=0 → 跳过」一致）', () => {
    const code = CLEARED_CODE;   // buy 100 → reduce 100，持仓 0
    const holders = db.db
      .prepare(`SELECT DISTINCT user_id FROM user_asset_rel WHERE asset_code = ? AND rel_type = 'hold' AND is_deleted = 0`)
      .all(code) as Array<{ user_id: number }>;
    expect(holders).toEqual([]);
  });
});
