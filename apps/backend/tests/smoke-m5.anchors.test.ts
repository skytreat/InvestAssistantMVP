/**
 * smoke-m5 **规模型锚点** —— 选股候选池规模（必须真库；手动线 `npm run test:anchors`）
 *
 * ── 为什么从 `smoke-m5.test.ts` 挪到这里（2026-11-07）──
 *   smoke-m5 是「11 环节串成一条链」的全链路冒烟，其中「选股公共过滤」的
 *   **候选池规模 > 3000** 是**规模型**断言：真库约 5561 只股票，迷你库只有 400 余只子集
 *   ⇒ 日常套件（默认迷你库）跑它必然假红，且它是整条链里唯一必须真库的一步。
 *   移出手动线后**不再是静默 skip**：`tests/anchors.setup.ts` 会先强制 `MARKET_DATA_MODE=full`
 *   并探测真库，环境不对直接抛错红灯。
 *
 * ⚠️ 断言与挪走前**逐字相同**（`totalCandidates > 3000`，未放宽）。
 * ⚠️ 这里只构造「注册 → 选股」两步的**最小链路**（不是整条 smoke 链）——
 *   本用例唯一依赖的产物就是 `POST /api/stockscan` 的响应。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ConfigStore } from '../src/config/configStore.js';
import { registerRoutes } from '../src/routes/index.js';

// ── 隔离环境：SQLite 库 + 备份目录都指临时目录（绝不碰 data/business.db）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-smoke5-anchors-'));
const ORIG_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const ORIG_BACKUP_DIR = process.env.BACKUP_DIR;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 'smoke5-anchors.db');
process.env.BACKUP_DIR = path.join(TMP_DIR, 'backups');

/** 选股用的插件（内置 monitor 插件，与日常 smoke-m5 同口径） */
const PLUGIN_ID = 'rsi_oversold';
/** 规模门槛：股票池 > 3000（实测真库 5561 只） */
const SCALE_THRESHOLD = 3000;

let app: Awaited<ReturnType<typeof Fastify>>;
let userToken = '';
let scanAll: Awaited<ReturnType<typeof app.inject>>;

beforeAll(async () => {
  ConfigStore.resetInstance();
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await registerRoutes(app);

  // 库里必须 0 用户，首个匿名注册才会自动成为 admin（与产品入口一致）
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'anchors_smoke5', password: 'anchors_smoke5_pw' },
  });
  expect([200, 201]).toContain(reg.statusCode);
  userToken = JSON.parse(reg.body).data?.token ?? '';
  expect(userToken.length).toBeGreaterThan(0);

  scanAll = await app.inject({
    method: 'POST',
    url: '/api/stockscan',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { plugin_id: PLUGIN_ID, asset_type: 'stock', max_results: 100 },
  });
});

afterAll(async () => {
  await app.close().catch(() => {});
  ConfigStore.resetInstance();
  if (ORIG_SQLITE_DB_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_DB_PATH;
  if (ORIG_BACKUP_DIR === undefined) delete process.env.BACKUP_DIR;
  else process.env.BACKUP_DIR = ORIG_BACKUP_DIR;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('smoke-m5 规模型锚点（真库）', () => {
  it('候选池规模 > 3000（实测真库 5561）', () => {
    expect(scanAll.statusCode).toBe(200);
    const data = JSON.parse(scanAll.body).data;
    expect(data.totalCandidates).toBeGreaterThan(SCALE_THRESHOLD);
  }, 120000);
});
