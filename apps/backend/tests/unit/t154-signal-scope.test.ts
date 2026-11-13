/**
 * t154-signal-scope.test.ts —— T154（ADR-025，SDD_v3 §10.4.4）信号域分组视图
 *
 * ① `resolveSignalScopeSets`：holdings = `calcAllPositions` 净持仓 > 0（ADR-021 同源）；
 *    watch = `user_asset_rel` watch **且排除 holdings**（INV-S3-28 不双显）；
 *    现金类**不排除**（分组视图要可见并标「现金类」，与 `resolveSignalSymbols` 的生成域口径区分）；
 * ② `GET /api/signal?scope=holdings|watch`：1 次 IN 过滤 + 行级 `scope`/`is_cash` 回填 +
 *    缺省向后兼容 + 非法 scope 400 `PARAM_INVALID` + 空组 0 行不报错。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

// --- 必须在 import src 之前覆盖 SQLITE_DB_PATH（隔离开发库）---
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-t154-scope-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import { resolveSignalScopeSets } from '../../src/services/signalService.js';
import type { JwtPayload } from '../../src/services/auth.js';

const TEST_USER_ID = 8901;

type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

function seedTrades(rows: Array<[string, string, number, string, string]>): void {
  const stmt = db.db.prepare(
    `INSERT INTO user_trade_record
     (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 10.0, 0, 0)`,
  );
  for (const [code, type, qty, date, time] of rows) {
    stmt.run(TEST_USER_ID, code, type, date, time, qty);
  }
}

function seedWatch(codes: string[]): void {
  const stmt = db.db.prepare(
    `INSERT OR REPLACE INTO user_asset_rel
     (user_id, asset_code, rel_type, is_deleted, created_at)
     VALUES (?, ?, 'watch', 0, datetime('now','localtime'))`,
  );
  for (const c of codes) stmt.run(TEST_USER_ID, c);
}

function seedCash(code: string): void {
  db.db
    .prepare(
      `INSERT OR REPLACE INTO asset_class (symbol, asset_class, rule_hit, source, updated_at)
       VALUES (?, 'cash', 'test', 'manual', datetime('now','localtime'))`,
    )
    .run(code);
}

function seedSignal(code: string, pluginId = 'rsi_oversold', tradeDate = '2026-11-10'): void {
  db.db
    .prepare(
      `INSERT INTO user_strategy_signal
       (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final)
       VALUES (?, ?, ?, 'monitor', ?, 'buy', 'L', 0.5, '{}', 1)`,
    )
    .run(TEST_USER_ID, code, pluginId, tradeDate);
}

function cleanAll(): void {
  db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ?').run(TEST_USER_ID);
  db.db.prepare('DELETE FROM user_asset_rel WHERE user_id = ?').run(TEST_USER_ID);
  db.db.prepare('DELETE FROM asset_class').run();
  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
}

async function query(qs: string): Promise<{
  status: number;
  rows: Array<Record<string, unknown>>;
  total: number;
  body: Record<string, unknown>;
}> {
  const res = await app.inject({ method: 'GET', url: `/api/signal?page_size=200&${qs}` });
  const body = JSON.parse(res.body) as Record<string, unknown> & {
    data?: Array<Record<string, unknown>>;
    pagination?: { total: number };
  };
  return {
    status: res.statusCode,
    rows: body.data ?? [],
    total: body.pagination?.total ?? 0,
    body,
  };
}

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(TEST_USER_ID, 't154_scope_user');

  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = {
      sub: TEST_USER_ID,
      username: 't154_scope_user',
      role: 'user',
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerSignalRoutes(app);
  await app.ready();
});

afterEach(() => cleanAll());

afterAll(async () => {
  await app?.close().catch(() => {});
  try {
    (db.db as unknown as { close: () => void }).close();
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

describe('T154 · resolveSignalScopeSets（组集合口径）', () => {
  it('holdings = 净持仓 > 0；watch = 自选且排除持仓（INV-S3-28 不双显）', () => {
    seedTrades([
      ['sh600001', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600002', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600002', 'clear', 100, '2026-11-05', '10:00:00'], // 清仓 ⇒ 净持仓 0
      ['sh600003', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600003', 'reduce', 60, '2026-11-04', '10:00:00'], // 净 40 > 0
    ]);
    seedWatch(['sh600001', 'sh600010', 'sh600011']); // sh600001 与持仓重叠

    const sets = resolveSignalScopeSets(TEST_USER_ID);

    expect(sets.holdings).toEqual(['sh600001', 'sh600003']);
    expect(sets.watch).toEqual(['sh600010', 'sh600011']); // sh600001 被排除
    const overlap = sets.holdings.filter((c) => sets.watch.includes(c));
    expect(overlap, '两组互斥').toEqual([]);
  });

  it('现金类不排除（分组视图要可见；与生成域 resolveSignalSymbols 口径区分）', () => {
    seedTrades([['sh600071', 'buy', 100, '2026-11-02', '09:30:00']]);
    seedCash('sh600071');

    const sets = resolveSignalScopeSets(TEST_USER_ID);
    expect(sets.holdings).toContain('sh600071');
  });

  it('软删的自选与软删的交易都不计入', () => {
    seedTrades([['sh600051', 'buy', 100, '2026-11-02', '09:30:00']]);
    seedWatch(['sh600050']);
    db.db.prepare('UPDATE user_asset_rel SET is_deleted = 1 WHERE asset_code = ?').run('sh600050');
    db.db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE asset_code = ?').run('sh600051');

    expect(resolveSignalScopeSets(TEST_USER_ID)).toEqual({ holdings: [], watch: [] });
  });
});

describe('T154 · GET /api/signal?scope（路由契约）', () => {
  it('scope=holdings ⇒ 只回持仓组标的（1 次 IN），行级 scope/is_cash 回填', async () => {
    seedTrades([
      ['sh600001', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600071', 'buy', 100, '2026-11-02', '09:30:00'],
    ]);
    seedCash('sh600071');
    seedSignal('sh600001');
    seedSignal('sh600071');
    seedSignal('sh600010'); // 不在任何组

    const r = await query('scope=holdings&trade_date=2026-11-10');
    expect(r.status).toBe(200);
    expect(r.total).toBe(2);
    const codes = r.rows.map((x) => x.asset_code).sort();
    expect(codes).toEqual(['sh600001', 'sh600071']);
    for (const row of r.rows) {
      expect(row.scope).toBe('holdings');
    }
    const cashRow = r.rows.find((x) => x.asset_code === 'sh600071');
    expect(cashRow?.is_cash).toBe(true);
    expect(r.rows.find((x) => x.asset_code === 'sh600001')?.is_cash).toBe(false);
  });

  it('scope=watch ⇒ 自选组（排除持仓组），组为空 ⇒ 0 行不报错', async () => {
    seedTrades([['sh600001', 'buy', 100, '2026-11-02', '09:30:00']]);
    seedWatch(['sh600001', 'sh600010']);
    seedSignal('sh600001');
    seedSignal('sh600010');

    const r = await query('scope=watch&trade_date=2026-11-10');
    expect(r.status).toBe(200);
    expect(r.total).toBe(1);
    expect(r.rows[0]?.asset_code).toBe('sh600010');
    expect(r.rows[0]?.scope).toBe('watch');

    // 空组：删掉仅剩的 watch 标的信号 ⇒ 组集合仍有 sh600010 但无信号行
    db.db.prepare(`DELETE FROM user_strategy_signal WHERE asset_code = 'sh600010'`).run();
    const empty = await query('scope=watch&trade_date=2026-11-10');
    expect(empty.status).toBe(200);
    expect(empty.total).toBe(0);
  });

  it('缺省（不传 scope）⇒ 全量不变，但行级 scope/is_cash 仍回填（向后兼容）', async () => {
    seedTrades([['sh600001', 'buy', 100, '2026-11-02', '09:30:00']]);
    seedWatch(['sh600010']);
    seedSignal('sh600001');
    seedSignal('sh600010');
    seedSignal('sh600099'); // 两组之外

    const r = await query('trade_date=2026-11-10');
    expect(r.status).toBe(200);
    expect(r.total).toBe(3);
    const byCode = new Map(r.rows.map((x) => [x.asset_code, x]));
    expect(byCode.get('sh600001')?.scope).toBe('holdings');
    expect(byCode.get('sh600010')?.scope).toBe('watch');
    expect(byCode.get('sh600099')?.scope).toBe(null);
    expect(r.body.scope).toBe(null);
  });

  it('非法 scope ⇒ 400 PARAM_INVALID（不查库）', async () => {
    const r = await query('scope=all');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('PARAM_INVALID');
  });
});
