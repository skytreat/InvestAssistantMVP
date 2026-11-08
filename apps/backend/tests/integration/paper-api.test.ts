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

    const bad = await post('/api/paper/fee-configs', { name: '带印花税', stampDutyRate: 0.001 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('FEE_RULE_UNSUPPORTED');
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
