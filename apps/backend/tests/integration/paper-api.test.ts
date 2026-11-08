/**
 * PA-07 / PA-06 —— 纸面账户 HTTP 链路（鉴权、确认语义、归属、切阶段）
 *
 * 用真实 `app.inject()`（不经网络层），行情日历由 CI 档迷你库提供 `raw_holidays`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTestApp, cleanupIntegrationTest, makeUserToken } from './_helpers.js';
import { PaperStore } from '../../src/services/paper/store.js';
import { hashPassword } from '../../src/services/auth.js';

let bundle: Awaited<ReturnType<typeof createTestApp>>;
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'paper-api-'));
const origBacktestPath = process.env.BACKTEST_DB_PATH;

const auth = (token = bundle.adminToken) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.BACKTEST_DB_PATH = path.join(tmpDir, 'backtest.db');
  PaperStore.resetInstance();
  // ⚠️ 必须在这里**主动**建实例：`tests/setup.ts` 的 afterEach 会把 env 恢复成进程基线，
  //    若留给首个请求惰性解析，本文件就会意外接到别的文件留下的同一个库（并发/串行都可能）。
  PaperStore.getInstance();
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  PaperStore.resetInstance();
  cleanupIntegrationTest();
  if (origBacktestPath !== undefined) process.env.BACKTEST_DB_PATH = origBacktestPath;
  else delete process.env.BACKTEST_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function post(url: string, payload: unknown, token = bundle.adminToken) {
  const res = await bundle.app.inject({ method: 'POST', url, headers: auth(token), payload });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('鉴权', () => {
  it('无 token 一律 401', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/paper/accounts' });
    expect(res.statusCode).toBe(401);
  });
});

describe('费用配置', () => {
  it('创建 / 列表 / 非法费率拒绝', async () => {
    const created = await post('/api/paper/fee-configs', { name: '测试券商', commissionRate: 0.0002 });
    expect(created.status).toBe(201);
    expect(created.body.data.commissionRate).toBe(0.0002);

    const list = await bundle.app.inject({ method: 'GET', url: '/api/paper/fee-configs', headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).data.some((c: any) => c.name === '测试券商')).toBe(true);

    const withFees = await post('/api/paper/fee-configs', {
      name: '带印花税',
      stampDutyRate: 0.001,
      transferFeeRate: 0.00002,
    });
    expect(withFees.status).toBe(201);
    expect(withFees.body.data.stampDutyRate).toBe(0.001);
    expect(withFees.body.data.transferFeeRate).toBe(0.00002);
  });
});

describe('账户生命周期', () => {
  it('建户 → 列表 → 重复建户 409 → 切阶段缺确认 400 → 确认后切成功 → 关闭', async () => {
    const strategies = await bundle.app.inject({
      method: 'GET',
      url: '/api/paper/strategies',
      headers: auth(),
    });
    expect(strategies.statusCode).toBe(200);
    expect(JSON.parse(strategies.body).data.length).toBeGreaterThan(0);

    const created = await post('/api/paper/accounts', {
      strategyId: 'wufu-rotation',
      strategyVersion: '5.2.0-m3',
      initialCash: 50_000,
    });
    expect(created.status).toBe(201);
    const id: number = created.body.data.id;
    expect(created.body.data.phase).toBe('shadow');

    const list = await bundle.app.inject({ method: 'GET', url: '/api/paper/accounts', headers: auth() });
    expect(JSON.parse(list.body).data.map((a: any) => a.id)).toContain(id);

    const dup = await post('/api/paper/accounts', {
      strategyId: 'wufu-rotation',
      strategyVersion: '5.2.0-m3',
      initialCash: 10_000,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PAPER_ACCOUNT_EXISTS');

    const noConfirm = await post(`/api/paper/accounts/${id}/phase`, { to: 'ledger' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.code).toBe('PAPER_CONFIRM_REQUIRED');

    const switched = await post(`/api/paper/accounts/${id}/phase`, { to: 'ledger', confirm: true });
    expect(switched.status).toBe(200);
    expect(switched.body.data.phase).toBe('ledger');
    expect(switched.body.data.cash).toBe(50_000);
    expect(switched.body.data.ledgerStartDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(switched.body.data.lastSettledDate).toBeNull();

    const closed = await post(`/api/paper/accounts/${id}/close`, {});
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('closed');

    // A15 后半：关闭旧账户后允许新建（唯一索引只约束「在用」账户）
    const rebuilt = await post('/api/paper/accounts', {
      strategyId: 'wufu-rotation',
      strategyVersion: '5.2.0-m3',
      initialCash: 20_000,
    });
    expect(rebuilt.status).toBe(201);
    expect(rebuilt.body.data.phase).toBe('shadow');
  });

  it('跨用户访问 → 404（不泄露存在性）', async () => {
    const db = bundle.db.db;
    db.prepare(
      `INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES ('other', ?, 'user')`,
    ).run(hashPassword('other123456'));
    const otherId = (
      db.prepare(`SELECT id FROM user_account WHERE username = 'other'`).get() as { id: number }
    ).id;
    const otherToken = makeUserToken(otherId, 'other');

    const created = await post(
      '/api/paper/accounts',
      { strategyId: 'wufu-rotation', strategyVersion: '5.2.0-m3', initialCash: 20_000 },
      otherToken,
    );
    expect(created.status).toBe(201);
    const otherAccountId: number = created.body.data.id;

    const asAdmin = await bundle.app.inject({
      method: 'GET',
      url: `/api/paper/accounts/${otherAccountId}`,
      headers: auth(),
    });
    expect(asAdmin.statusCode).toBe(404);

    const switchOther = await post(`/api/paper/accounts/${otherAccountId}/phase`, {
      to: 'ledger',
      confirm: true,
    });
    expect(switchOther.status).toBe(404);
  });
});

/**
 * ⚠️ `sequence.shuffle=true`（T81 顺序敏感守卫）会在**文件内打乱用例顺序** ⇒
 * 这里的用例**不能**复用 admin 的「单用户单账户」名额，否则会与生命周期用例随机 409。
 * 每个用例各自建一个独立用户。
 */
function makePaperUser(username: string): { userId: number; token: string } {
  const db = bundle.db.db;
  db.prepare(`INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, 'user')`).run(
    username,
    hashPassword(`${username}123456`),
  );
  const userId = (
    db.prepare(`SELECT id FROM user_account WHERE username = ?`).get(username) as { id: number }
  ).id;
  return { userId, token: makeUserToken(userId, username) };
}

describe('只读报告（PA-09）', () => {
  it('影子账户：订单 / 持仓 / 净值 / 报告四条只读路由', async () => {
    const { token } = makePaperUser('viewer');
    const created = await post(
      '/api/paper/accounts',
      { strategyId: 'ref-buy-and-hold', strategyVersion: '0.1.0', initialCash: 100_000 },
      token,
    );
    expect(created.status).toBe(201);
    const id: number = created.body.data.id;

    // 影子期不跑决策，直接留痕一条 shadow 信号（PA-08 的产物形态）
    PaperStore.getInstance()
      .db.prepare(
        `INSERT INTO paper_order (
           account_id, signal_id, decision_date, trade_date, seq, asset_code,
           intent_kind, side, rebalance_mode, target_weight, target_notional,
           cutoff_equity, intent_notional, status
         ) VALUES (?, ?, '2026-11-06', '2026-11-09', 0, 'sh510300',
                   'target', 'buy', 'replace', 0.5, 50_000, 100_000, 50_000, 'shadow')`,
      )
      .run(id, `psig_${id}_2026-11-06_sh510300`);

    const orders = await bundle.app.inject({
      method: 'GET',
      url: `/api/paper/accounts/${id}/orders`,
      headers: auth(token),
    });
    expect(orders.statusCode).toBe(200);
    const orderList = JSON.parse(orders.body).data;
    expect(orderList).toHaveLength(1);
    expect(orderList[0].assetCode).toBe('sh510300');
    expect(orderList[0].status).toBe('shadow');
    expect(orderList[0].targetWeight).toBe(0.5);
    expect(orderList[0].tradeDate).toBe('2026-11-09');

    // 影子期这两张表恒空（§7.8：读了只会误导）
    const positions = await bundle.app.inject({
      method: 'GET',
      url: `/api/paper/accounts/${id}/positions`,
      headers: auth(token),
    });
    expect(positions.statusCode).toBe(200);
    expect(JSON.parse(positions.body).data).toEqual([]);

    const equity = await bundle.app.inject({
      method: 'GET',
      url: `/api/paper/accounts/${id}/equity`,
      headers: auth(token),
    });
    expect(equity.statusCode).toBe(200);
    expect(JSON.parse(equity.body).data).toEqual([]);

    const report = await bundle.app.inject({
      method: 'GET',
      url: `/api/paper/accounts/${id}/report`,
      headers: auth(token),
    });
    expect(report.statusCode).toBe(200);
    const data = JSON.parse(report.body).data;
    expect(data.account.phase).toBe('shadow');
    expect(data.ledger).toBeNull();
    expect(data.shadow.latestDecisionDate).toBe('2026-11-06');
    expect(data.shadow.latestTargets).toHaveLength(1);
    expect(data.shadow.latestTargets[0].assetCode).toBe('sh510300');
    expect(data.shadow.orderCounts).toEqual({ shadow: 1 });
  });

  it('跨用户读报告 → 404', async () => {
    const { token } = makePaperUser('reporter');

    const created = await post(
      '/api/paper/accounts',
      { strategyId: 'ref-buy-and-hold', strategyVersion: '0.1.0', initialCash: 10_000 },
      token,
    );
    expect(created.status).toBe(201);
    const accountId: number = created.body.data.id;

    const asAdmin = await bundle.app.inject({
      method: 'GET',
      url: `/api/paper/accounts/${accountId}/report`,
      headers: auth(),
    });
    expect(asAdmin.statusCode).toBe(404);
  });
});
