/**
 * f-signal-default-date.test.ts —— F 域 P0-1：默认交易日口径
 *
 * 现状（修复前）：`GET /api/signal` 与 `GET /api/signal/stats` 在调用方未传 `trade_date` 时
 * 直接落 `getTradeDate()`（自然日今天）⇒ 周末/节假日/行情未补齐时统计恒为 0，
 * 前端 `Signals.tsx` 也硬编码 `todayStr()`，空态显示「今日暂无策略信号」，误导用户以为没信号。
 *
 * 修复后：未显式传日期时按 **最近有信号日 → 最近行情日（resolveLatestQuoteDate）→ 今天** 解析，
 * 并通过响应顶层 `trade_date` / `trade_date_source` / `latest_quote_date` 下发给前端；
 * `/api/signal` 的「无筛选 = 最近 N 条（跨交易日窗口）」契约**保持不变**。
 *
 * 测试环境约束（沿用 t85b / t54）：
 *   - 顶层覆盖 `SQLITE_DB_PATH` 到临时库，每个用例后销毁（避免 shuffle 顺序依赖）；
 *   - DuckDB 一律 mock（CI 只有 12KB 空壳行情库，真库可能被写入进程独占锁）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-f-signal-date-'));
const TEST_DB = path.join(tmpDir, 'f-signal-date.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import type { JwtPayload } from '../../src/services/auth.js';
import {
  getTradeDate,
  resolveDefaultSignalTradeDate,
  resolveLatestSignalDate,
} from '../../src/services/signalService.js';
import * as duckdbMod from '../../src/db/duckdb.js';

const USER_WITH_SIGNAL = 8801;
const USER_WITHOUT_SIGNAL = 8802;

type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance | null = null;

/** 行情最新日（DuckDB mock 的可变返回值；null = 行情库不可用） */
let quoteDate: string | null = null;

function cleanup(): void {
  try {
    const store = (ConfigStore as any)._instance;
    if (store) (store.db as any).close();
  } catch {
    /* ignore */
  }
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TEST_DB + ext);
    } catch {
      /* ignore */
    }
  }
  vi.restoreAllMocks();
}

/**
 * DuckDB mock：
 *   - `MAX(...)` 口径查询按 `quoteDate` 返回（模拟「最近行情日」）；
 *   - 其余查询一律返回空数组（日线 / 品种映射 / 快照都不参与本文件断言）。
 */
function installDuckDBMock(): void {
  vi.spyOn(duckdbMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
    if (
      typeof sql === 'string' &&
      /MAX\(\s*(?:date|d)\s*\)/i.test(sql) &&
      /raw_kline_daily|v_stock_qfq|v_etf_qfq/.test(sql)
    ) {
      return (quoteDate ? [{ d: quoteDate }] : []) as never;
    }
    return [] as never;
  });
}

function db() {
  return ConfigStore.getInstance().db;
}

function seedUser(id: number, username: string): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role)
       VALUES (?, ?, 'dummy-hash', 'admin')`,
    )
    .run(id, username);
}

function insertSignal(
  userId: number,
  code: string,
  pluginId: string,
  tradeDate: string,
  direction = 'buy',
): void {
  db()
    .prepare(
      `INSERT INTO user_strategy_signal
         (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final)
       VALUES (?, ?, ?, 'monitor', ?, ?, 'L', 0.5, '{}', 1)`,
    )
    .run(userId, code, pluginId, tradeDate, direction);
}

async function makeApp(userId: number): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = {
      sub: userId,
      username: 'f_signal_user',
      role: 'admin',
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerSignalRoutes(app);
  await app.ready();
  return app;
}

beforeAll(() => {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(async () => {
  await app?.close().catch(() => {});
  app = null;
  cleanup();
});

afterAll(() => {
  cleanup();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('F 域 P0-1 — 默认交易日口径（最近有信号日 → 最近行情日 → 今天）', () => {
  it('无参 GET /api/signal：默认口径取最近有信号日，且窗口仍跨多个交易日', async () => {
    installDuckDBMock();
    seedUser(USER_WITH_SIGNAL, 'f_signal_8801');
    // 两个交易日各 1 条 → 若默认口径变成「单日过滤」，行集合会缩成 1 条
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'rsi_oversold', '2026-10-13');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'macd_cross', '2026-10-14', 'sell');
    quoteDate = '2026-11-04';

    const server = await makeApp(USER_WITH_SIGNAL);
    const res = await server.inject({ method: 'GET', url: '/api/signal?page_size=200' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      code: number;
      data: Array<{ trade_date: string }>;
      trade_date: string | null;
      trade_date_source: string;
      latest_quote_date: string | null;
    };

    expect(body.code).toBe(0);
    expect(body.trade_date).toBe('2026-10-14');
    expect(body.trade_date_source).toBe('signal');
    expect(body.latest_quote_date).toBeNull();
    // 🔒 窗口契约不变：仍然返回跨交易日的行集合（不是「默认日单日过滤」）
    expect(new Set(body.data.map((r) => r.trade_date))).toEqual(new Set(['2026-10-13', '2026-10-14']));
  });

  it('显式 trade_date → trade_date_source=explicit，不再解析默认口径', async () => {
    installDuckDBMock();
    seedUser(USER_WITH_SIGNAL, 'f_signal_8801');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'rsi_oversold', '2026-10-13');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'rsi_oversold', '2026-10-14');
    quoteDate = '2026-11-04';

    const server = await makeApp(USER_WITH_SIGNAL);
    const res = await server.inject({
      method: 'GET',
      url: '/api/signal?page_size=200&trade_date=2026-10-13',
    });
    const body = JSON.parse(res.body) as {
      data: Array<{ trade_date: string }>;
      trade_date: string;
      trade_date_source: string;
      latest_quote_date: string | null;
    };
    expect(body.trade_date_source).toBe('explicit');
    expect(body.trade_date).toBe('2026-10-13');
    expect(body.latest_quote_date).toBeNull();
    expect(body.data.every((r) => r.trade_date === '2026-10-13')).toBe(true);
  });

  it('无信号 + 有行情日 → 默认口径回落「最近行情日」', async () => {
    installDuckDBMock();
    seedUser(USER_WITHOUT_SIGNAL, 'f_signal_8802');
    quoteDate = '2026-11-04';

    const server = await makeApp(USER_WITHOUT_SIGNAL);
    const res = await server.inject({ method: 'GET', url: '/api/signal?page_size=200' });
    const body = JSON.parse(res.body) as {
      data: unknown[];
      trade_date: string | null;
      trade_date_source: string;
      latest_quote_date: string | null;
    };
    expect(body.data).toEqual([]);
    expect(body.trade_date).toBe('2026-11-04');
    expect(body.trade_date_source).toBe('quote');
    expect(body.latest_quote_date).toBe('2026-11-04');
  });

  it('无信号 + 行情库不可用 → 兜底「东八区今天」（不再静默漂移）', async () => {
    installDuckDBMock();
    seedUser(USER_WITHOUT_SIGNAL, 'f_signal_8802');
    quoteDate = null;

    const server = await makeApp(USER_WITHOUT_SIGNAL);
    const res = await server.inject({ method: 'GET', url: '/api/signal?page_size=200' });
    const body = JSON.parse(res.body) as { trade_date: string; trade_date_source: string };
    expect(body.trade_date_source).toBe('today');
    expect(body.trade_date).toBe(getTradeDate());
  });

  it('无参 GET /api/signal/stats：统计落在最近有信号日，而不是今天', async () => {
    installDuckDBMock();
    seedUser(USER_WITH_SIGNAL, 'f_signal_8801');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'rsi_oversold', '2026-10-13');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'macd_cross', '2026-10-13', 'sell');
    // 🔴 修复前缺省会落到「自然日今天」→ 今天没有信号 ⇒ total=0；新口径必须落在 2026-10-13
    quoteDate = '2026-11-04';

    const server = await makeApp(USER_WITH_SIGNAL);
    const res = await server.inject({ method: 'GET', url: '/api/signal/stats' });
    const body = JSON.parse(res.body) as {
      data: { total: number; up: number; down: number };
      trade_date: string;
      trade_date_source: string;
      latest_quote_date: string | null;
    };
    expect(body.trade_date).toBe('2026-10-13');
    expect(body.trade_date_source).toBe('signal');
    expect(body.latest_quote_date).toBeNull();
    expect(body.data.total).toBe(2);
    expect(body.data.up).toBe(1);
    expect(body.data.down).toBe(1);
  });

  it('无信号 + 有行情日：stats 的 meta 指向行情最新日（前端空态文案依据）', async () => {
    installDuckDBMock();
    seedUser(USER_WITHOUT_SIGNAL, 'f_signal_8802');
    quoteDate = '2026-11-04';

    const server = await makeApp(USER_WITHOUT_SIGNAL);
    const res = await server.inject({ method: 'GET', url: '/api/signal/stats' });
    const body = JSON.parse(res.body) as {
      data: { total: number };
      trade_date: string;
      trade_date_source: string;
      latest_quote_date: string | null;
    };
    expect(body.data.total).toBe(0);
    expect(body.trade_date).toBe('2026-11-04');
    expect(body.trade_date_source).toBe('quote');
    expect(body.latest_quote_date).toBe('2026-11-04');
  });

  it('resolveLatestSignalDate 只认 YYYY-MM-DD 且排除软删行', () => {
    seedUser(USER_WITH_SIGNAL, 'f_signal_8801');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'rsi_oversold', '2026-10-13');
    insertSignal(USER_WITH_SIGNAL, 'sh600000', 'rsi_oversold', '2026-10-20');
    db()
      .prepare(
        `UPDATE user_strategy_signal SET is_deleted = 1
         WHERE user_id = ? AND trade_date = '2026-10-20'`,
      )
      .run(USER_WITH_SIGNAL);
    expect(resolveLatestSignalDate(USER_WITH_SIGNAL)).toBe('2026-10-13');
    expect(resolveLatestSignalDate(USER_WITHOUT_SIGNAL)).toBeNull();
  });

  it('resolveDefaultSignalTradeDate：无信号时先查行情日，再兜底今天', async () => {
    installDuckDBMock();
    seedUser(USER_WITHOUT_SIGNAL, 'f_signal_8802');

    quoteDate = '2026-11-04';
    await expect(resolveDefaultSignalTradeDate(USER_WITHOUT_SIGNAL)).resolves.toEqual({
      tradeDate: '2026-11-04',
      source: 'quote',
      latestQuoteDate: '2026-11-04',
    });

    quoteDate = null;
    await expect(resolveDefaultSignalTradeDate(USER_WITHOUT_SIGNAL)).resolves.toEqual({
      tradeDate: getTradeDate(),
      source: 'today',
      latestQuoteDate: null,
    });
  });
});
