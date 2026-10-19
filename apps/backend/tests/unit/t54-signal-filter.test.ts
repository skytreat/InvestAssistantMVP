/**
 * T54 —— GET /api/signals 筛选能力
 *
 * 覆盖 src/routes/signal.ts 新增的 `asset_code` / `start_date` / `end_date`：
 *   ① 单 symbol 过滤只回该标的
 *   ② 日期范围**边界闭合**（start_date 与 end_date 当天都命中）
 *   ③ 组合筛选（symbol + plugin_id + 日期范围）同时生效
 *   ④ 无匹配返回**空数组**（200，不报错）
 *   ⑤ 排序 `trade_date ASC`
 *
 * 本文件用 `app.inject()`（进程内，不 listen、不占端口）。
 * 只注册 signal 路由 + 注入 user，不走 JWT —— 被测的是筛选 SQL，不是鉴权。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

// --- 必须在 import src 之前覆盖 SQLITE_DB_PATH（隔离开发库）---
const tmpDbPath = path.join(os.tmpdir(), `invest-t54-filter-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import type { JwtPayload } from '../../src/services/auth.js';

const TEST_USER_ID = 8801;
const OTHER_USER_ID = 8802;

type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

const insert = (userId: number, code: string, pluginId: string, tradeDate: string, direction = 'buy') =>
  db.db.prepare(
    `INSERT INTO user_strategy_signal
       (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final)
     VALUES (?, ?, ?, 'monitor', ?, ?, 'L', 0.5, '{}', 1)`
  ).run(userId, code, pluginId, tradeDate, direction);

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`
  ).run(TEST_USER_ID, 't54_filter_user');
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`
  ).run(OTHER_USER_ID, 't54_other_user');

  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id IN (?, ?)').run(TEST_USER_ID, OTHER_USER_ID);

  // 主数据集：3 个标的 × 3 个交易日 × 2 个插件
  const dates = ['2026-10-13', '2026-10-14', '2026-10-15'];
  const codes = ['sh600000', 'sz000001', 'sh601318'];
  for (const date of dates) {
    for (const code of codes) {
      insert(TEST_USER_ID, code, 'rsi_oversold', date);
      insert(TEST_USER_ID, code, 'macd_cross', date, 'sell');
    }
  }
  // 区间外的一条（下界之前）
  insert(TEST_USER_ID, 'sh600000', 'rsi_oversold', '2026-10-01');
  // 区间外的一条（上界之后）
  insert(TEST_USER_ID, 'sh600000', 'rsi_oversold', '2026-10-31');
  // 另一个用户的同名信号（验证隔离，不应被查到）
  insert(OTHER_USER_ID, 'sh600000', 'rsi_oversold', '2026-10-14');

  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = {
      sub: TEST_USER_ID, username: 't54_filter_user', role: 'user',
      iat: 0, exp: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  await registerSignalRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close().catch(() => {});
  try { (db.db as unknown as { close: () => void }).close(); } catch { /* ignore */ }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

interface SignalRow {
  asset_code: string;
  plugin_id: string;
  trade_date: string;
  direction: string;
  user_id: number;
}

async function query(qs: string): Promise<{ rows: SignalRow[]; total: number }> {
  const res = await app.inject({ method: 'GET', url: `/api/signals?page_size=200&${qs}` });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as {
    success: boolean; data: SignalRow[]; pagination: { total: number };
  };
  expect(body.success).toBe(true);
  return { rows: body.data, total: body.pagination.total };
}

describe('T54 · asset_code 单标的过滤', () => {
  it('只回该标的（3 个交易日的 6 条）', async () => {
    const { rows, total } = await query('asset_code=sh600000');
    expect(total).toBe(8);            // 3 天 × 2 插件 + 区间外 2 条
    expect(rows.length).toBe(8);
    expect(rows.every((r) => r.asset_code === 'sh600000')).toBe(true);
  });

  it('不存在的标的 → 空数组 + 200，不报错', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signals?asset_code=sz999999' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.totalPages).toBe(0);
  });

  it('不串到其他用户的数据', async () => {
    const { rows } = await query('asset_code=sh600000');
    expect(rows.every((r) => r.user_id === TEST_USER_ID)).toBe(true);
  });
});

describe('T54 · 日期范围（闭区间）', () => {
  it('start_date 当天命中（下界闭合）', async () => {
    const { rows } = await query('start_date=2026-10-13');
    expect(rows.some((r) => r.trade_date === '2026-10-13')).toBe(true);
  });

  it('end_date 当天命中（上界闭合）', async () => {
    const { rows } = await query('end_date=2026-10-15');
    expect(rows.some((r) => r.trade_date === '2026-10-15')).toBe(true);
  });

  it('恰好等于 [start, end] 单日 → 6 条（3 标的 × 2 插件）', async () => {
    const { rows, total } = await query('start_date=2026-10-14&end_date=2026-10-14');
    expect(total).toBe(6);
    expect(rows.every((r) => r.trade_date === '2026-10-14')).toBe(true);
  });

  it('范围 [10-14, 10-15] → 只含边界内两天，10-13 / 10-31 被排除', async () => {
    const { rows, total } = await query('start_date=2026-10-14&end_date=2026-10-15');
    expect(total).toBe(12);
    expect(rows.every((r) => r.trade_date >= '2026-10-14' && r.trade_date <= '2026-10-15')).toBe(true);
    expect(new Set(rows.map((r) => r.trade_date))).toEqual(new Set(['2026-10-14', '2026-10-15']));
  });

  it('start > end（空交集）→ 空数组 + 200', async () => {
    const { rows, total } = await query('start_date=2026-10-15&end_date=2026-10-13');
    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe('T54 · 组合筛选（symbol + plugin + 日期范围）', () => {
  it('asset_code + plugin_id + 闭区间同时生效', async () => {
    const { rows, total } = await query(
      'asset_code=sz000001&plugin_id=macd_cross&start_date=2026-10-14&end_date=2026-10-15'
    );
    expect(total).toBe(2);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.asset_code).toBe('sz000001');
      expect(r.plugin_id).toBe('macd_cross');
      expect(r.direction).toBe('sell');
      expect(['2026-10-14', '2026-10-15']).toContain(r.trade_date);
    }
  });

  it('组合条件互斥（无交集）→ 空数组 + 200', async () => {
    const { rows, total } = await query(
      'asset_code=sz000001&plugin_id=volume_spike&start_date=2026-10-14&end_date=2026-10-15'
    );
    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });

  it('与既有筛选参数可叠加（trade_date 精确日 + asset_code）', async () => {
    const { rows, total } = await query('trade_date=2026-10-15&asset_code=sh601318');
    expect(total).toBe(2);
    expect(rows.every((r) => r.trade_date === '2026-10-15' && r.asset_code === 'sh601318')).toBe(true);
  });
});

describe('T54 · 排序 trade_date ASC', () => {
  it('返回结果按 trade_date 升序', async () => {
    const { rows } = await query('');
    const dates = rows.map((r) => r.trade_date);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe('2026-10-01');
    expect(dates[dates.length - 1]).toBe('2026-10-31');
  });
});

describe('T54 · 参数化绑定（注入防护）', () => {
  it("asset_code 含引号/分号 → 按字面量匹配，不报 SQL 语法错", async () => {
    const qs = "asset_code=" + encodeURIComponent("sh600000'; DROP TABLE user_strategy_signal;--");
    const res = await app.inject({ method: 'GET', url: `/api/signals?${qs}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
    // 表还在
    const cnt = db.db.prepare('SELECT COUNT(*) AS c FROM user_strategy_signal').get() as { c: number };
    expect(cnt.c).toBeGreaterThan(0);
  });

  it("end_date 含注入片段 → 按字面量比较（0 行），不放大结果集也不报 SQL 语法错", async () => {
    // 若参数被拼接进 SQL，会变成 `trade_date <= 2026-01-01' OR '1'='1`
    // —— 语法错；即便侥幸可解析也会命中全部行。走参数化时它只是一个字面量，
    // 字典序小于全部 '2026-10-xx' → 0 行
    const literal = "2026-01-01' OR '1'='1";
    const res = await app.inject({
      method: 'GET',
      url: `/api/signals?end_date=${encodeURIComponent(literal)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual([]);
  });
});
