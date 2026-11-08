/**
 * F2 —— 信号 → 交易关联（**只做手动交易那条路**）
 *
 * 钉死的口径（本轮实现）：
 *   ① 关联方向：`user_strategy_signal.linked_trade_id → user_trade_record.id`
 *   ② 交易录入可选传 `signal_id`；不传照常录入（不因缺关联被拒）
 *   ③ 重复关联同一条成交 → 幂等（`unchanged: true`）；改指向需 `overwrite: true`
 *   ④ 一条成交可被多条信号关联（`shared_signals` 如实返回）
 *   ⑤ 读取侧：按信号查成交（金额 / 方向 / 成交日 / 平仓盈亏），列表派生 已成交/已忽略/已采纳/未处理
 *   ⑥ 成交被软删 → 关联断链（`link_broken: true`），不冒充「已成交」
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-f2-link-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import { registerTradeRoutes } from '../../src/routes/trade.js';
import { deriveSignalTradeStatus } from '../../src/services/signalService.js';
import type { JwtPayload } from '../../src/services/auth.js';

const TEST_USER_ID = 8841;
const DAY = '2026-11-06';
const CODE = 'sh600001';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

interface TradeBody {
  asset_code: string;
  trade_type: string;
  trade_date: string;
  trade_time: string;
  quantity: number;
  price: number;
  fee?: number;
  trade_reason?: string;
  signal_id?: number;
}

function postTrade(body: TradeBody) {
  return app.inject({ method: 'POST', url: '/api/trade', payload: body });
}

function insertSignal(
  code: string,
  opts: { direction?: 'buy' | 'sell'; adopted?: number; ignored?: number; plugin?: string } = {},
): number {
  return Number(
    db.db
      .prepare(
        `INSERT INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label,
            strength, adopted, ignored, metrics_json, is_final)
         VALUES (?, ?, ?, 'monitor', ?, ?, 'L', 0.5, ?, ?, '{}', 1)`,
      )
      .run(
        TEST_USER_ID,
        code,
        opts.plugin ?? 'p1',
        DAY,
        opts.direction ?? 'buy',
        opts.adopted ?? 0,
        opts.ignored ?? 0,
      ).lastInsertRowid,
  );
}

function signalLinkedTradeId(signalId: number): number | null {
  const row = db.db
    .prepare('SELECT linked_trade_id FROM user_strategy_signal WHERE id = ?')
    .get(signalId) as { linked_trade_id: number | null };
  return row.linked_trade_id;
}

function tradeCount(): number {
  return (
    db.db.prepare('SELECT COUNT(*) AS c FROM user_trade_record WHERE user_id = ?').get(TEST_USER_ID) as {
      c: number;
    }
  ).c;
}

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(TEST_USER_ID, 'f2_link_user');

  app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = { sub: TEST_USER_ID, username: 'f2_link_user' } as JwtPayload;
  });
  await registerSignalRoutes(app);
  await registerTradeRoutes(app);
  await app.ready();
});

beforeEach(() => {
  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
  db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ?').run(TEST_USER_ID);
});

afterAll(async () => {
  await app.close();
  if (db) {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
    db.db.prepare('DELETE FROM user_trade_record WHERE user_id = ?').run(TEST_USER_ID);
  }
  try {
    fs.rmSync(tmpDbPath, { force: true });
    fs.rmSync(`${tmpDbPath}-wal`, { force: true });
    fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  } catch {
    // ignore
  }
  if (ORIGINAL_SQLITE_DB_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
});

describe('F2 · 交易录入侧（POST /api/trade 可选 signal_id）', () => {
  it('传 signal_id → 成交落库后回填信号 linked_trade_id', async () => {
    const signalId = insertSignal(CODE);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:00:00',
      quantity: 100,
      price: 10,
      trade_reason: '信号采纳',
      signal_id: signalId,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { trade_id: number; linked_signal_id: number | null } };
    expect(body.data.linked_signal_id).toBe(signalId);
    expect(signalLinkedTradeId(signalId)).toBe(body.data.trade_id);
  });

  it('不传 signal_id → 照常录入，关联为空（不因缺字段拒绝）', async () => {
    const signalId = insertSignal(CODE);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:05:00',
      quantity: 100,
      price: 10,
      trade_reason: '手动买入',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { linked_signal_id: number | null } };
    expect(body.data.linked_signal_id).toBeNull();
    expect(signalLinkedTradeId(signalId)).toBeNull();
  });

  it('信号已关联另一条成交 → 409 SIGNAL_ALREADY_LINKED，且不产生新成交', async () => {
    const signalId = insertSignal(CODE);
    const first = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:10:00',
      quantity: 100,
      price: 10,
      trade_reason: '首笔',
      signal_id: signalId,
    });
    expect(first.statusCode).toBe(201);
    const before = tradeCount();

    const second = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:11:00',
      quantity: 10,
      price: 10,
      trade_reason: '第二笔',
      signal_id: signalId,
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe('SIGNAL_ALREADY_LINKED');
    expect(tradeCount()).toBe(before);
    // 原关联保持不变
    expect(signalLinkedTradeId(signalId)).toBe(
      (first.json() as { data: { trade_id: number } }).data.trade_id,
    );
  });

  it('标的与信号不一致 → 400 ASSET_MISMATCH，不产生成交', async () => {
    const signalId = insertSignal(CODE);
    const res = await postTrade({
      asset_code: 'sh600002',
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:20:00',
      quantity: 100,
      price: 10,
      trade_reason: '错标的',
      signal_id: signalId,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('ASSET_MISMATCH');
    expect(tradeCount()).toBe(0);
  });

  it('signal_id 不存在 → 404 SIGNAL_NOT_FOUND，不产生成交', async () => {
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:30:00',
      quantity: 100,
      price: 10,
      trade_reason: '野 id',
      signal_id: 999999,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('SIGNAL_NOT_FOUND');
    expect(tradeCount()).toBe(0);
  });
});

describe('F2 · 关联标注侧（PATCH /api/signal/:id/link-trade 幂等与冲突）', () => {
  async function createBuy(time: string): Promise<number> {
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: time,
      quantity: 100,
      price: 10,
      trade_reason: '建仓',
    });
    return (res.json() as { data: { trade_id: number } }).data.trade_id;
  }

  it('重复关联同一条成交 → 200 unchanged=true', async () => {
    const signalId = insertSignal(CODE);
    const tradeId = await createBuy('10:00:00');
    const first = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: tradeId },
    });
    const firstBody = first.json() as { data: { unchanged: boolean } };
    expect(firstBody.data.unchanged).toBe(false);

    const again = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: tradeId },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { data: { unchanged: boolean } }).data.unchanged).toBe(true);
  });

  it('改指向另一条成交：默认 409，显式 overwrite=true 才改', async () => {
    const signalId = insertSignal(CODE);
    const t1 = await createBuy('10:05:00');
    const t2 = await createBuy('10:06:00');
    await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: t1 },
    });

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: t2 },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { code: string }).code).toBe('SIGNAL_ALREADY_LINKED');
    expect(signalLinkedTradeId(signalId)).toBe(t1);

    const overwrite = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: t2, overwrite: true },
    });
    expect(overwrite.statusCode).toBe(200);
    expect(signalLinkedTradeId(signalId)).toBe(t2);
  });

  it('一条成交可被多条信号关联，响应附 shared_signals', async () => {
    // 同一标的同日不同策略（唯一约束是 user+asset+plugin+trade_date，不含 direction）
    const s1 = insertSignal(CODE, { direction: 'buy', plugin: 'p1' });
    const s2 = insertSignal(CODE, { direction: 'buy', plugin: 'p2' });
    const tradeId = await createBuy('10:07:00');
    const r1 = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${s1}/link-trade`,
      payload: { tradeRecordId: tradeId },
    });
    expect((r1.json() as { data: { shared_signals: number } }).data.shared_signals).toBe(0);

    const r2 = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${s2}/link-trade`,
      payload: { tradeRecordId: tradeId },
    });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { data: { shared_signals: number } }).data.shared_signals).toBe(1);
  });

  it('解绑幂等（null 再 null 仍 200）', async () => {
    const signalId = insertSignal(CODE);
    const tradeId = await createBuy('10:08:00');
    await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: tradeId },
    });
    const unlink = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: null },
    });
    expect(unlink.statusCode).toBe(200);
    expect(signalLinkedTradeId(signalId)).toBeNull();

    const again = await app.inject({
      method: 'PATCH',
      url: `/api/signal/${signalId}/link-trade`,
      payload: { tradeRecordId: null },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { data: { unchanged: boolean } }).data.unchanged).toBe(true);
  });
});

describe('F2 · 读取侧（GET /api/signal/:id/linked-trade）', () => {
  it('返回金额 / 方向 / 成交日；买入未平仓 → realized_pnl 为 null', async () => {
    const signalId = insertSignal(CODE);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:30:00',
      quantity: 100,
      price: 10,
      fee: 5,
      trade_reason: '信号采纳',
      signal_id: signalId,
    });
    const tradeId = (res.json() as { data: { trade_id: number } }).data.trade_id;

    const detail = await app.inject({ method: 'GET', url: `/api/signal/${signalId}/linked-trade` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      data: {
        trade_status: string;
        link_broken: boolean;
        trade: {
          id: number;
          direction: string;
          trade_date: string;
          amount: number;
          realized_pnl: number | null;
        } | null;
      };
    };
    expect(body.data.trade_status).toBe('traded');
    expect(body.data.link_broken).toBe(false);
    expect(body.data.trade?.id).toBe(tradeId);
    expect(body.data.trade?.direction).toBe('buy');
    expect(body.data.trade?.trade_date).toBe(DAY);
    expect(body.data.trade?.amount).toBe(1000);
    expect(body.data.trade?.realized_pnl).toBeNull();
  });

  it('平仓成交 → realized_pnl 可得（复用平仓盈亏口径）', async () => {
    const signalId = insertSignal(CODE, { direction: 'sell' });
    await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '09:40:00',
      quantity: 100,
      price: 10,
      trade_reason: '建仓',
    });
    const sell = await postTrade({
      asset_code: CODE,
      trade_type: 'reduce',
      trade_date: DAY,
      trade_time: '14:00:00',
      quantity: 50,
      price: 12,
      trade_reason: '减仓',
      signal_id: signalId,
    });
    expect(sell.statusCode).toBe(201);

    const detail = await app.inject({ method: 'GET', url: `/api/signal/${signalId}/linked-trade` });
    const body = detail.json() as {
      data: { trade: { direction: string; realized_pnl: number | null } | null };
    };
    expect(body.data.trade?.direction).toBe('sell');
    expect(body.data.trade?.realized_pnl).not.toBeNull();
    expect(body.data.trade?.realized_pnl as number).toBeGreaterThan(0);
  });

  it('成交被软删 → link_broken=true 且 trade 为 null（不冒充已成交）', async () => {
    const signalId = insertSignal(CODE);
    const res = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:31:00',
      quantity: 100,
      price: 10,
      trade_reason: '信号采纳',
      signal_id: signalId,
    });
    const tradeId = (res.json() as { data: { trade_id: number } }).data.trade_id;
    db.db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(tradeId);

    const detail = await app.inject({ method: 'GET', url: `/api/signal/${signalId}/linked-trade` });
    const body = detail.json() as {
      data: { trade_status: string; link_broken: boolean; trade: unknown };
    };
    expect(body.data.link_broken).toBe(true);
    expect(body.data.trade).toBeNull();
    expect(body.data.trade_status).not.toBe('traded');
  });

  it('信号不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signal/999999/linked-trade' });
    expect(res.statusCode).toBe(404);
  });
});

describe('F2 · 列表状态派生', () => {
  it('已成交 > 已忽略 > 已采纳 > 未处理', async () => {
    const traded = insertSignal(CODE, { adopted: 1, plugin: 'p1' });
    const ignored = insertSignal(CODE, { ignored: 1, plugin: 'p2' });
    const adopted = insertSignal(CODE, { adopted: 1, plugin: 'p3' });
    const pending = insertSignal(CODE, { plugin: 'p4' });
    // 让 traded 真正指向一条成交
    const trade = await postTrade({
      asset_code: CODE,
      trade_type: 'buy',
      trade_date: DAY,
      trade_time: '10:32:00',
      quantity: 100,
      price: 10,
      trade_reason: '信号采纳',
      signal_id: traded,
    });
    expect(trade.statusCode).toBe(201);
    // 去掉 adopted 标记，确认「已成交」优先于「已采纳」
    db.db.prepare('UPDATE user_strategy_signal SET adopted = 0 WHERE id = ?').run(traded);

    const list = await app.inject({ method: 'GET', url: `/api/signal?trade_date=${DAY}&page_size=20` });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { data: Array<{ id: number; trade_status: string; link_broken: boolean }> })
      .data;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(traded)?.trade_status).toBe('traded');
    expect(byId.get(ignored)?.trade_status).toBe('ignored');
    expect(byId.get(adopted)?.trade_status).toBe('adopted');
    expect(byId.get(pending)?.trade_status).toBe('pending');
    expect(byId.get(pending)?.link_broken).toBe(false);
  });

  it('派生函数优先级与断链兜底', () => {
    expect(deriveSignalTradeStatus({ linked_trade_id: 7, ignored: 1, adopted: 1 })).toBe('traded');
    expect(deriveSignalTradeStatus({ linked_trade_id: 7, ignored: 1 }, true)).toBe('ignored');
    expect(deriveSignalTradeStatus({ adopted: 1 })).toBe('adopted');
    expect(deriveSignalTradeStatus({})).toBe('pending');
    expect(deriveSignalTradeStatus({ linked_trade_id: 7 }, true)).toBe('pending');
  });
});
