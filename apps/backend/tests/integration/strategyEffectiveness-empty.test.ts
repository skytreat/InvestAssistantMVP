import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { ConfigStore } from '../../src/config/configStore.js';
import { registerRoutes } from '../../src/routes/index.js';
import { signToken } from '../../src/services/auth.js';

/**
 * F4 Step B —— 空信号降级路径
 *
 * 验收「0 信号 + 行情库缺失 ⇒ 200 空报告，而不是 500」。
 *
 * 本文件**自己建空业务库**并把 `DUCKDB_PATH` 指向不存在的文件，不与
 * `strategyEffectiveness.test.ts` 复用 `_helpers.ts`（后者会把业务库换成
 * 别的用例插过数据的共享库，还会覆盖 `SQLITE_DB_PATH`）。
 * `tests/setup.ts` 的规则是「文件显式设置 > 档位解析」，故这里的
 * `DUCKDB_PATH` 不会被 `MARKET_DATA_MODE=ci` 的迷你库覆盖。
 */
const _TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-eft-empty-'));
const _EMPTY_DB_PATH = path.join(_TMP_DIR, 'empty-business.db');
const _MISSING_DUCKDB_PATH = path.join(_TMP_DIR, 'no-such-quotes.duckdb');
const _origSqlitePath = process.env.SQLITE_DB_PATH;
const _origDuckDBPath = process.env.DUCKDB_PATH;

process.env.SQLITE_DB_PATH = _EMPTY_DB_PATH;
process.env.DUCKDB_PATH = _MISSING_DUCKDB_PATH;
(ConfigStore as any)._instance = null;

const TOKEN = signToken({ sub: 1, username: 'eft_empty_user', role: 'admin' });

let app: Awaited<ReturnType<typeof Fastify>>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
}, 10000);

afterAll(async () => {
  await app.close().catch(() => {});
  (ConfigStore as any)._instance = null;
  if (_origSqlitePath !== undefined) process.env.SQLITE_DB_PATH = _origSqlitePath;
  else delete process.env.SQLITE_DB_PATH;
  if (_origDuckDBPath !== undefined) process.env.DUCKDB_PATH = _origDuckDBPath;
  else delete process.env.DUCKDB_PATH;
  try {
    rmSync(_TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 5000);

describe('F4 Step B · 空信号 + 行情库缺失', () => {
  it('前置：行情库确实不存在，业务库里也确实没有信号（否则用例无意义）', () => {
    expect(existsSync(_MISSING_DUCKDB_PATH)).toBe(false);
    const rows = ConfigStore.getInstance()
      .db.prepare('SELECT COUNT(*) AS c FROM user_strategy_signal')
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('0 信号 + 行情库缺失 → 200 空报告（不是 500）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/strategy/effectiveness?from=2026-02-01&to=2026-04-30&group_by=plugin',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const report = JSON.parse(res.body).data;

    // 空报告结构完整：样本 0、判定样本不足、费率口径由代码形态规则给出（ETF 0/0）
    expect(report.meta.sampleSize).toBe(0);
    expect(report.meta.insufficientSample).toBe(true);
    expect(report.meta.benchmark).toBe('sh510300');
    expect(report.meta.benchmarkClass).toBe('etf');
    expect(report.meta.fees.stampDutyRate).toBe(0);
    expect(report.meta.fees.transferFeeRate).toBe(0);
    expect(report.meta.feeModelLabel).toContain('ETF 口径（印花税 0 / 过户费 0）');

    // 3 个周期都在、分组与明细为空
    expect(report.summary.map((s: { horizon: string }) => s.horizon)).toEqual(['t1', 't5', 't10']);
    for (const s of report.summary) {
      expect(s.sampleSize).toBe(0);
      expect(s.insufficientSample).toBe(true);
    }
    expect(report.groups).toEqual([]);
    expect(report.details).toEqual([]);
  });
});
