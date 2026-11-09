/**
 * F4 Step C —— 采纳 / 忽略写路径：服务端互斥 + 幂等
 *
 * 验证两个 PATCH 端点行为**严格对称**：
 *   ① 设一个即把另一个清 0，并清掉对方的时间戳（互斥由服务端保证，不依赖前端）
 *   ② 重复打同一端点 → `unchanged: true`，且时间戳不漂移（幂等）
 *   ③ 不存在 / 非法 id → 404 / 400
 *
 * 本文件自建空业务库（同 `strategyEffectiveness-empty.test.ts` 的做法），
 * 不复用 `_helpers.ts` 的共享库，避免别的用例插入的行干扰断言行集合。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { ConfigStore } from '../../src/config/configStore.js';
import { registerRoutes } from '../../src/routes/index.js';
import { signToken } from '../../src/services/auth.js';

const _TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-signal-adopt-'));
const _DB_PATH = path.join(_TMP_DIR, 'adopt-business.db');
const _origSqlitePath = process.env.SQLITE_DB_PATH;

process.env.SQLITE_DB_PATH = _DB_PATH;
(ConfigStore as any)._instance = null;

const USER_ID = 1;
const TOKEN = signToken({ sub: USER_ID, username: 'adopt_user', role: 'admin' });

let app: Awaited<ReturnType<typeof Fastify>>;

const SIGNAL_INSERT = `INSERT INTO user_strategy_signal
  (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label)
  VALUES (?, ?, 'rsi_oversold', 'monitor', ?, 'buy', 't')`;

function insertSignal(assetCode: string, tradeDate: string): number {
  const info = ConfigStore.getInstance().db.prepare(SIGNAL_INSERT).run(USER_ID, assetCode, tradeDate);
  return Number(info.lastInsertRowid);
}

function readRow(id: number): {
  adopted: number;
  ignored: number;
  adopted_at: string | null;
  ignored_at: string | null;
} {
  return ConfigStore.getInstance()
    .db.prepare('SELECT adopted, ignored, adopted_at, ignored_at FROM user_strategy_signal WHERE id = ?')
    .get(id) as {
    adopted: number;
    ignored: number;
    adopted_at: string | null;
    ignored_at: string | null;
  };
}

type Endpoint = 'adopt' | 'ignore';

async function patch(id: number, endpoint: Endpoint) {
  return app.inject({
    method: 'PATCH',
    url: `/api/signal/${id}/${endpoint}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await registerRoutes(app);

  const db = ConfigStore.getInstance().db;
  db.prepare(
    'INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(USER_ID, 'adopt_user', 'x', 'admin');
}, 10000);

afterAll(async () => {
  await app.close().catch(() => {});
  const store = (ConfigStore as any)._instance as ConfigStore | null;
  store?.db.close();
  (ConfigStore as any)._instance = null;
  if (_origSqlitePath !== undefined) process.env.SQLITE_DB_PATH = _origSqlitePath;
  else delete process.env.SQLITE_DB_PATH;
  try {
    rmSync(_TMP_DIR, { recursive: true, force: true });
  } catch {
    /* Windows 上句柄未释放时忽略 */
  }
}, 5000);

describe('F4 Step C · 采纳/忽略互斥', () => {
  it('先采纳后忽略：ignored=1 且 adopted 被清 0、adopted_at 置 NULL', async () => {
    const id = insertSignal('sh600000', '2026-03-02');

    const adoptRes = await patch(id, 'adopt');
    expect(adoptRes.statusCode).toBe(200);
    const adopted = JSON.parse(adoptRes.body).data;
    expect(adopted).toMatchObject({ id, adopted: 1, ignored: 0, unchanged: false });
    expect(adopted.adoptedAt).toBeTruthy();

    const ignoreRes = await patch(id, 'ignore');
    expect(ignoreRes.statusCode).toBe(200);
    const ignored = JSON.parse(ignoreRes.body).data;
    expect(ignored).toMatchObject({ id, adopted: 0, ignored: 1, unchanged: false });
    expect(ignored.adoptedAt).toBeNull();
    expect(ignored.ignoredAt).toBeTruthy();

    expect(readRow(id)).toEqual({
      adopted: 0,
      ignored: 1,
      adopted_at: null,
      ignored_at: ignored.ignoredAt,
    });
  });

  it('先忽略后采纳：adopted=1 且 ignored 被清 0、ignored_at 置 NULL', async () => {
    const id = insertSignal('sh600519', '2026-03-03');

    expect((await patch(id, 'ignore')).statusCode).toBe(200);
    const adoptRes = await patch(id, 'adopt');
    expect(adoptRes.statusCode).toBe(200);
    const data = JSON.parse(adoptRes.body).data;
    expect(data).toMatchObject({ id, adopted: 1, ignored: 0, unchanged: false });
    expect(data.ignoredAt).toBeNull();

    expect(readRow(id)).toEqual({
      adopted: 1,
      ignored: 0,
      adopted_at: data.adoptedAt,
      ignored_at: null,
    });
  });

  it('重复采纳：第二次 unchanged=true 且 adopted_at 不漂移', async () => {
    const id = insertSignal('sh601318', '2026-03-04');

    const first = JSON.parse((await patch(id, 'adopt')).body).data;
    expect(first.unchanged).toBe(false);

    const second = JSON.parse((await patch(id, 'adopt')).body).data;
    expect(second).toMatchObject({ id, adopted: 1, ignored: 0, unchanged: true });
    expect(second.adoptedAt).toBe(first.adoptedAt);
    expect(readRow(id).adopted_at).toBe(first.adoptedAt);
  });

  it('重复忽略：第二次 unchanged=true 且 ignored_at 不漂移', async () => {
    const id = insertSignal('sh601988', '2026-03-05');

    const first = JSON.parse((await patch(id, 'ignore')).body).data;
    expect(first.unchanged).toBe(false);

    const second = JSON.parse((await patch(id, 'ignore')).body).data;
    expect(second).toMatchObject({ id, adopted: 0, ignored: 1, unchanged: true });
    expect(second.ignoredAt).toBe(first.ignoredAt);
    expect(readRow(id).ignored_at).toBe(first.ignoredAt);
  });

  it('两个端点返回结构对称（同一组字段）', async () => {
    const adoptId = insertSignal('sh600036', '2026-03-06');
    const ignoreId = insertSignal('sh601899', '2026-03-07');

    const adoptData = JSON.parse((await patch(adoptId, 'adopt')).body).data;
    const ignoreData = JSON.parse((await patch(ignoreId, 'ignore')).body).data;
    expect(Object.keys(adoptData).sort()).toEqual(Object.keys(ignoreData).sort());
  });

  it('信号不存在 → 404 NOT_FOUND', async () => {
    const res = await patch(999_999, 'adopt');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NOT_FOUND');
  });

  it('非法 id → 400 INVALID_ID', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/signal/abc/adopt',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_ID');
  });
});
