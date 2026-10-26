/**
 * T146（V3.8 组合域）—— `/api/holding` 的 V3 enrich：`asset_class` + `broker_code`
 *
 * 契约（PRD_v3 §3.4.1 持仓页「券商列 + 现金类分区」数据源）：
 *   - `asset_class`：asset_class 表（T120）查得；**无记录 = 'risk'**（安全侧默认，INV-S4-14）
 *   - `broker_code`：该标的最近一条带券商维度交易：单券商 → 编码；多券商 → 'mixed'；纯手工 → null
 *
 * 行情层 mock（duckdb.js）→ 不需要真库，CI 可跑。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../src/services/auth.js';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t146-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't146.db');

vi.mock('../../src/db/duckdb.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, queryDuckDB: vi.fn(async () => [] as unknown[]) };
});

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerTradeRoutes } = await import('../../src/routes/trade.js');

const UID = 14601;
let app: FastifyInstance;

beforeAll(async () => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  const store = ConfigStore.getInstance();
  store.db
    .prepare(`INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, 't146_user', 'x', 'user')`)
    .run(UID);

  const ins = store.db.prepare(
    `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, broker_code, is_auto_import, is_deleted)
     VALUES (?, ?, 'buy', '2026-09-01', '09:30:00', 100, 10, 0, ?, ?, 0)`,
  );
  // 纯手工（broker NULL）
  ins.run(UID, 'sh600001', null, 0);
  // 单券商导入
  ins.run(UID, 'sh511880', 'gt', 1);
  // 多券商 → mixed
  ins.run(UID, 'sz000001', 'gt', 1);
  ins.run(UID, 'sz000001', 'hb', 1);

  // 现金类分类（T120 表）
  store.db
    .prepare(`INSERT OR IGNORE INTO asset_class (symbol, asset_class, rule_hit, source) VALUES ('sh511880', 'cash', 'cash_etf_name', 'rule')`)
    .run();

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const user: JwtPayload = { sub: UID, username: 't146_user', role: 'user', iat: 0, exp: 9999999999 };
    (request as FastifyRequest & { user?: JwtPayload }).user = user;
  });
  await registerTradeRoutes(app);
});

afterAll(async () => {
  await app.close();
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  else delete process.env.SQLITE_DB_PATH;
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('T146 /api/holding 券商维度 + 现金类 enrich', () => {
  it('asset_class / broker_code 逐标的正确（单券商 / mixed / 手工 / 无记录默认 risk）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ asset_code: string; asset_class: string; broker_code: string | null }>;
    const byCode = new Map(rows.map((r) => [r.asset_code, r]));

    expect(byCode.get('sh600001')).toMatchObject({ asset_class: 'risk', broker_code: null }); // 无记录 → risk；纯手工 → null
    expect(byCode.get('sh511880')).toMatchObject({ asset_class: 'cash', broker_code: 'gt' });
    expect(byCode.get('sz000001')).toMatchObject({ asset_class: 'risk', broker_code: 'mixed' });

    // 契约只加不改：既有 enrich 字段仍在
    expect(rows[0]).toHaveProperty('currentPrice');
    expect(rows[0]).toHaveProperty('unrealizedPnl');
    expect(rows[0]).toHaveProperty('signal');
    expect(rows[0]).toHaveProperty('name');
  });

  it('summary 顶层字段不受影响（T89a 契约）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    const body = res.json() as { data: unknown[]; summary: Record<string, unknown> };
    expect(body.summary).toHaveProperty('positionCount', 3);
  });
});
