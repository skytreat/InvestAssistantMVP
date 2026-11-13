/**
 * T58 —— 信号落库字段补全（`user_asset_rel` 持仓关系同步已废弃，ADR-028：`hold` 不再派生维护）
 *
 * ① `is_final = 1` 显式写入（persistSignals / persistBatchSignals）
 * ② `metrics_json` = 插件回传的数值明细；无 metrics → NULL（不是 'null' 字符串）；
 *    且**不夹带** detail 自由文本 / 任何凭证
 *
 * 本文件用 `app.inject()`（进程内，不 listen、不占端口）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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

// 存在性判定源 = DuckDB raw_symbol_class：mock 返回空（本文件专注 signal 行为，不做存在性判定）
const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import { ConfigStore } from '../../src/config/configStore.js';
import { persistSignals, persistBatchSignals, SIGNAL_INSERT_SQL } from '../../src/services/signalService.js';
import { registerTradeRoutes } from '../../src/routes/trade.js';
import type { PluginSignal } from '../../src/services/pluginEngine.js';
import type { JwtPayload } from '../../src/services/auth.js';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

const SIGNAL_USER_ID = 8901;
const TRADE_USER_ID = 8902;

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(async () => {
  db = ConfigStore.getInstance();
  // 默认放行：mock raw_symbol_class 返回空（本文件专注 signal 行为，不做存在性判定）
  queryDuckDBMock.mockImplementation(async () => []);
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(SIGNAL_USER_ID, 't58_signal_user');
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(TRADE_USER_ID, 't58_trade_user');

  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(SIGNAL_USER_ID);

  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = {
      sub: TRADE_USER_ID,
      username: 't58_trade_user',
      role: 'user',
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerTradeRoutes(app);
  await app.ready();
});

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
    const r = persistSignals(
      [makeSignal({ symbol: 'sh600519' })],
      'rsi_oversold',
      'monitor',
      '2026-10-15',
      SIGNAL_USER_ID,
    );
    expect(r).toEqual({ inserted: 1, skipped: 0, errors: 0 });

    const row = db.db
      .prepare(
        'SELECT is_final FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?',
      )
      .get(SIGNAL_USER_ID, 'sh600519', '2026-10-15') as { is_final: number };
    expect(row.is_final).toBe(1);
  });

  it('persistBatchSignals 写入的行 is_final = 1（两条都验）', () => {
    const r = persistBatchSignals(
      [
        {
          pluginId: 'macd_cross',
          pluginCategory: 'monitor',
          signals: [makeSignal({ symbol: 'sz000001', signalType: 'SELL' })],
        },
        {
          pluginId: 'volume_spike',
          pluginCategory: 'filter',
          signals: [makeSignal({ symbol: 'sh601318', signalType: 'HOLD' })],
        },
      ],
      '2026-10-16',
      SIGNAL_USER_ID,
    );
    expect(r).toEqual({ inserted: 2, skipped: 0, errors: 0 });

    for (const code of ['sz000001', 'sh601318']) {
      const row = db.db
        .prepare(
          'SELECT is_final FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?',
        )
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
    persistSignals(
      [makeSignal({ symbol: 'sz000002', metrics })],
      'rsi_oversold',
      'monitor',
      '2026-10-17',
      SIGNAL_USER_ID,
    );

    const row = db.db
      .prepare(
        'SELECT metrics_json FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?',
      )
      .get(SIGNAL_USER_ID, 'sz000002', '2026-10-17') as { metrics_json: string };
    expect(JSON.parse(row.metrics_json)).toEqual(metrics);
  });

  it('无 metrics → 落 NULL（不是字符串 "null"）', () => {
    persistSignals(
      [makeSignal({ symbol: 'sz000003' })],
      'rsi_oversold',
      'monitor',
      '2026-10-17',
      SIGNAL_USER_ID,
    );
    const row = db.db
      .prepare(
        'SELECT metrics_json, typeof(metrics_json) AS t FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?',
      )
      .get(SIGNAL_USER_ID, 'sz000003', '2026-10-17') as { metrics_json: string | null; t: string };
    expect(row.metrics_json).toBeNull();
    expect(row.t).toBe('null');
  });

  it('不夹带 detail 自由文本 / 凭证类字段（只序列化 metrics）', () => {
    const metrics = { rsi: 28.5 };
    persistSignals(
      [makeSignal({ symbol: 'sz000004', metrics, detail: 'token=SECRET-abc123 疑似内部凭证' })],
      'rsi_oversold',
      'monitor',
      '2026-10-17',
      SIGNAL_USER_ID,
    );
    const row = db.db
      .prepare(
        'SELECT metrics_json FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?',
      )
      .get(SIGNAL_USER_ID, 'sz000004', '2026-10-17') as { metrics_json: string };
    expect(JSON.parse(row.metrics_json)).toEqual(metrics);
    expect(row.metrics_json).not.toContain('SECRET');
    expect(row.metrics_json).not.toContain('token');
    expect(row.metrics_json).not.toContain('detail');
  });

  it('metrics 值为 0 时不能被当成 falsy 丢成 NULL', () => {
    persistSignals(
      [makeSignal({ symbol: 'sz000005', metrics: { dif: 0 } })],
      'macd_cross',
      'monitor',
      '2026-10-17',
      SIGNAL_USER_ID,
    );
    const row = db.db
      .prepare(
        'SELECT metrics_json FROM user_strategy_signal WHERE user_id = ? AND asset_code = ? AND trade_date = ?',
      )
      .get(SIGNAL_USER_ID, 'sz000005', '2026-10-17') as { metrics_json: string };
    expect(JSON.parse(row.metrics_json)).toEqual({ dif: 0 });
  });
});

// ────────────────────────────────────────────────────────────
// ③④ user_asset_rel hold 同步（已废弃：hold 不再派生维护，ADR-028）
// ────────────────────────────────────────────────────────────
// 所有持仓口径一律由 user_trade_record 实时计算（ADR-028 / ADR-021）。

// ────────────────────────────────────────────────────────────
// ⑤ exDividendSync 用户来源：已改为直接查 user_trade_record（ADR-028）
// ────────────────────────────────────────────────────────────
