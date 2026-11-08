/**
 * F3 —— GET /api/signal/top5「今日 Top 5 摘要与优先级」
 *
 * 钉死的口径（PRD_v3 §4.2）：
 *   ① **今日过滤**：缺省交易日 = 最近有信号日（不跨交易日取数）
 *   ② **优先级**：grade 强 > 中 > 弱 > 未分级；同档 strength 降序；strength 为空排末位
 *   ③ **固定 Top 5**：无论当日多少条，只回 5 条
 *   ④ 显式 `trade_date` 生效；非法格式 → 400
 *   ⑤ 用户隔离：他人信号不进入结果
 *
 * 用 `app.inject()`（进程内，不 listen、不占端口），只注册 signal 路由 + 注入 user。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-f3-top5-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import type { JwtPayload } from '../../src/services/auth.js';

const TEST_USER_ID = 8811;
const OTHER_USER_ID = 8812;
const DAY = '2026-11-06';
const PREV_DAY = '2026-11-05';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

interface SeedSpec {
  code: string;
  plugin: string;
  date: string;
  strength: number | null;
  grade: 'strong' | 'medium' | 'weak' | null;
  direction?: 'buy' | 'sell' | 'hold';
}

const insert = (userId: number, s: SeedSpec): number =>
  Number(
    db.db
      .prepare(
        `INSERT INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, grade, metrics_json, is_final)
         VALUES (?, ?, ?, 'monitor', ?, ?, 'L', ?, ?, '{}', 1)`,
      )
      .run(userId, s.code, s.plugin, s.date, s.direction ?? 'buy', s.strength, s.grade).lastInsertRowid,
  );

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(TEST_USER_ID, 'f3_top5_user');
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(OTHER_USER_ID, 'f3_other_user');
  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id IN (?, ?)').run(TEST_USER_ID, OTHER_USER_ID);

  // 当日 7 条：验证「强 > 中 > 弱 > 未分级」+ 同档 strength 降序 + null 末尾 + LIMIT 5
  insert(TEST_USER_ID, { code: 'sh600001', plugin: 'p1', date: DAY, strength: 0.9, grade: 'strong' });
  insert(TEST_USER_ID, { code: 'sh600002', plugin: 'p2', date: DAY, strength: 0.1, grade: 'strong' });
  insert(TEST_USER_ID, { code: 'sh600003', plugin: 'p3', date: DAY, strength: null, grade: 'strong' });
  insert(TEST_USER_ID, { code: 'sh600004', plugin: 'p4', date: DAY, strength: 0.8, grade: 'medium' });
  insert(TEST_USER_ID, { code: 'sh600005', plugin: 'p5', date: DAY, strength: null, grade: 'medium' });
  insert(TEST_USER_ID, { code: 'sh600006', plugin: 'p6', date: DAY, strength: 0.99, grade: 'weak' });
  insert(TEST_USER_ID, { code: 'sh600007', plugin: 'p7', date: DAY, strength: 0.95, grade: null });
  // 前一交易日（默认日不得取到它）
  insert(TEST_USER_ID, { code: 'sh600008', plugin: 'p8', date: PREV_DAY, strength: 0.99, grade: 'strong' });
  // 其他用户（隔离）
  insert(OTHER_USER_ID, { code: 'sh600009', plugin: 'p9', date: DAY, strength: 0.99, grade: 'strong' });

  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = {
      sub: TEST_USER_ID,
      username: 'f3_top5_user',
      role: 'user',
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerSignalRoutes(app);
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

interface SignalRow {
  id: number;
  asset_code: string;
  trade_date: string;
  grade: string | null;
  strength: number | null;
  user_id: number;
}

async function top5(query = ''): Promise<{ rows: SignalRow[]; meta: Record<string, unknown> }> {
  const res = await app.inject({ method: 'GET', url: `/api/signal/top5${query}` });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: SignalRow[]; trade_date: string; trade_date_source: string };
  return { rows: body.data, meta: body as unknown as Record<string, unknown> };
}

describe('F3 今日 Top 5', () => {
  it('缺省交易日 = 最近有信号日（不跨交易日取数）', async () => {
    const { rows, meta } = await top5();
    expect(meta.trade_date).toBe(DAY);
    expect(meta.trade_date_source).toBe('signal');
    expect(rows.every((r) => r.trade_date === DAY)).toBe(true);
    expect(rows.some((r) => r.asset_code === 'sh600008')).toBe(false);
  });

  it('优先级：强 > 中 > 弱 > 未分级；同档 strength 降序；null 排末位', async () => {
    const { rows } = await top5();
    expect(rows.map((r) => r.asset_code)).toEqual([
      'sh600001', // strong 0.9
      'sh600002', // strong 0.1
      'sh600003', // strong null
      'sh600004', // medium 0.8
      'sh600005', // medium null（第 6 名的 weak 0.99 被 LIMIT 5 截断）
    ]);
  });

  it('固定 Top 5：当日 7 条只回 5 条', async () => {
    const { rows, meta } = await top5();
    expect(rows).toHaveLength(5);
    expect(meta.limit).toBe(5);
  });

  it('显式 trade_date 生效', async () => {
    const { rows, meta } = await top5(`?trade_date=${PREV_DAY}`);
    expect(meta.trade_date).toBe(PREV_DAY);
    expect(meta.trade_date_source).toBe('explicit');
    expect(rows.map((r) => r.asset_code)).toEqual(['sh600008']);
  });

  it('trade_date 格式非法 → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signal/top5?trade_date=2026/11/06' });
    expect(res.statusCode).toBe(400);
  });

  it('用户隔离：他人信号不进入结果', async () => {
    const { rows } = await top5();
    expect(rows.every((r) => r.user_id === TEST_USER_ID)).toBe(true);
    expect(rows.some((r) => r.asset_code === 'sh600009')).toBe(false);
  });
});
