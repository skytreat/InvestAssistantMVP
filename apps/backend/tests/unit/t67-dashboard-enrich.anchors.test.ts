/**
 * T67 **真实行情库交叉验证** —— 真库锚点（手动线 `npm run test:anchors`）
 *
 * ── 为什么从 `t67-dashboard-enrich.test.ts` 挪到这里（2026-11-07）──
 *   原文件的 ⑨ / ⑪ 两个 describe 验的是「**真实行情库**上的行为」：
 *     · prevClose 是「倒数第二条」且与 latest 差一根 K 线；
 *     · `sh600000 = 浦发银行`、`sh600001` 无名（缺失是常态）。
 *   迷你库是真库的**子集**（历史深度/标的覆盖都不同）⇒ 在迷你库上跑这些断言没有意义
 *   （实测 mini 档下「倒数第二条」断言红）⇒ 移入手动线，由 `anchors.setup.ts` 强制真库。
 *
 * ⚠️ 断言与挪走前**逐字相同**（未放宽）。本条只保留「查询次数」这一契约：
 *   持仓 enrich 仍是**常数次批量查询**（品种 1 + 行情 1 + 名称 1），禁止 N+1。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../src/services/auth.js';

// ── SQLite 隔离（必须在 import ConfigStore 之前设置）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t67-anchors-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't67-anchors.db');

/**
 * 只包一层 `queryDuckDB` 的 **调用计数**（真正查询仍走真实实现）。
 * ⑨ 断言「3 次批量查询」、⑪ 断言「查名只 1 次 IN」都需要它。
 */
vi.mock('../../src/db/duckdb.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/duckdb.js')>();
  return {
    ...actual,
    queryDuckDB: vi.fn(async (sql: string, params?: unknown[]) => actual.queryDuckDB(sql, params)),
  };
});

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerTradeRoutes } = await import('../../src/routes/trade.js');
const { queryDuckDB } = await import('../../src/db/duckdb.js');

// ── 测试用户（与日常 t67 保持同口径）──
const TEST_UID = 6701;
const USER_PAYLOAD: JwtPayload = {
  sub: TEST_UID,
  username: 't67_user',
  role: 'user',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

/** 批量查询用的标的集合（20 只 → 用于断言「批量是一批」） */
const BATCH_CODES = Array.from({ length: 20 }, (_, i) => `sh6001${String(i).padStart(2, '0')}`);
/** 所有持仓标的（含 ⑨/⑪ 依赖的两个边界样本） */
const ALL_CODES = ['sh600000', 'sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005', ...BATCH_CODES];

let app: FastifyInstance;
let store: InstanceType<typeof ConfigStore>;

/** 插入一笔买入（造持仓用） */
function insertBuy(userId: number, assetCode: string, quantity = 100, price = 10, date = '2026-10-01'): void {
  store.db
    .prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', ?, '09:30:00', ?, ?, 0, 't67 anchors 造数', 0)`,
    )
    .run(userId, assetCode, date, quantity, price);
}

beforeAll(async () => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  store = ConfigStore.getInstance();

  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(TEST_UID, 't67_user', 'dummy-hash');

  for (const code of ALL_CODES) insertBuy(TEST_UID, code);

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user?: JwtPayload }).user = USER_PAYLOAD;
  });
  await registerTradeRoutes(app);
});

afterAll(async () => {
  await app.close();
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const { closeDuckDBInstance } = await import('../../src/db/duckdb.js');
  await closeDuckDBInstance();
  vi.restoreAllMocks();
});

beforeEach(() => {
  (queryDuckDB as unknown as { mockClear: () => void }).mockClear();
});

describe('T67-⑨ 真实行情库交叉验证（真库锚点）', () => {
  it('真库上 prevClose 仍是「倒数第二条」且与 latest 差一根 K 线', async () => {
    const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
    spy.mockClear();
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, any>>;

    // 假数据里 sh600001 有行情；真库上 sh600001 是真实股票 → 应能取到现价与昨收
    const p = items.find((i) => i.asset_code === 'sh600001');
    expect(p).toBeDefined();
    expect(typeof p!.currentPrice).toBe('number');
    expect(typeof p!.prevClose).toBe('number');
    expect(p!.prevClose).not.toBe(p!.currentPrice);
    // 仍是常数次的批量查询（品种 1 + 行情 1 + 名称 1）
    expect(spy.mock.calls.length).toBe(3);
  }, 120000);
});

describe('T67-⑪ 真实行情库 —— name 的命中与缺失（真库锚点）', () => {
  // ⚠️ 真实库上 `/api/holding` 会触发 `v_stock_qfq` 的全量扫描（实测约 3s/次）
  //   → 合并成**一次**调用，避免多开 DuckDB 实例（文件锁 + page cache 驱逐）
  it(
    '真库上 sh600000 = 浦发银行、sh600001 无名（缺失是常态，不报错），且查名仍只 1 次 IN 查询',
    async () => {
      const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
      spy.mockClear();
      const res = await app.inject({ method: 'GET', url: '/api/holding' });
      expect(res.statusCode).toBe(200);
      const items = res.json().data as Array<Record<string, any>>;

      // 真库实测：`raw_symbol_name` 有 sh600000（浦发银行），**没有** sh600001
      const named = items.find((i) => i.asset_code === 'sh600000');
      expect(named).toBeDefined();
      expect(named!.name).toBe('浦发银行');

      const unnamed = items.find((i) => i.asset_code === 'sh600001');
      expect(unnamed).toBeDefined();
      expect(unnamed!.name).toBeNull();

      // 查名仍是 1 次 IN 查询（无 N+1）
      const nameCalls = spy.mock.calls.filter((c) => String(c[0]).includes('FROM raw_symbol_name'));
      expect(nameCalls.length).toBe(1);
      const params = nameCalls[0][1] as unknown[];
      expect(params.length).toBe(ALL_CODES.length);
    },
    120000,
  );
});
