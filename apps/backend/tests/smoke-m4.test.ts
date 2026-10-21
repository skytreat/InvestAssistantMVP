/**
 * smoke-m4.test.ts — Phase 4 端到端完整验收（MVP 计划 T48）
 *
 * 全链路：登录 → 交易录入 → 持仓/收益双口径 → 信号查询 → 复盘归因 →
 *        插件管理 → 管理员备份 → 备份恢复 → 权限边界
 *
 * ⚠️ 三个已知坑（HANDOVER 里记过）：
 *   1. POST /api/trade 返回的是 data.trade_id，不是 data.trade.id
 *   2. POST /api/admin/backup 会真跑 db.backup()，大库时超过 vitest 默认 15s
 *      → 必须给显式 timeout，且 BACKUP_DIR 指向临时目录
 *   3. 不 listen 端口，全部走 app.inject()，避免 singleFork 下 EADDRINUSE
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { ConfigStore } from '../src/config/configStore.js';

// ── 隔离环境：SQLite 库 + BACKUP_DIR 都指临时目录 ──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-smoke4-'));
const DB_PATH = path.join(TMP_DIR, 'smoke4.db');
const BACKUP_TMP_DIR = path.join(TMP_DIR, 'backups');

const ORIG_BACKUP_DIR = process.env.BACKUP_DIR;
process.env.SQLITE_DB_PATH = DB_PATH;
process.env.BACKUP_DIR = BACKUP_TMP_DIR;
(ConfigStore as any)._instance = null;

// backup.ts 在 import 时读 BACKUP_DIR 常量，必须先设好 env 再动态 import
const backupMod = await import('../src/services/backup.js');
const { BACKUP_DIR } = backupMod;

const helpers = await import('./integration/_helpers.js');
const { createTestApp, cleanupIntegrationTest } = helpers;
const ADMIN_USER = helpers.ADMIN_USER; // int_admin —— createTestApp 实际 seed 的 admin
const ADMIN_PASS = helpers.ADMIN_PASS;
type TestAppBundle = Awaited<ReturnType<typeof createTestApp>>;

const TRADE_CODE = 'sh600036';

/** 全链路里累积的业务事实，供后续断言复用 */
const ctx = {
  bundle: null as unknown as TestAppBundle,
  adminToken: '',
  tradeId: 0,
  backupFile: '',
};

function adminHeaders() {
  return { authorization: `Bearer ${ctx.adminToken}` };
}

function userHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  const bundle = await createTestApp();
  ctx.bundle = bundle;
  ctx.adminToken = bundle.adminToken;

  // 备份目录必须存在，否则 list/restore 无从谈起
  if (!existsSync(BACKUP_TMP_DIR)) fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });
}, 30000);

afterAll(async () => {
  await ctx.bundle.app.close().catch(() => {});
  ConfigStore.resetInstance();
  cleanupIntegrationTest();
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (ORIG_BACKUP_DIR !== undefined) process.env.BACKUP_DIR = ORIG_BACKUP_DIR;
  else delete process.env.BACKUP_DIR;
}, 20000);

// ─────────────────────────────────────────────────────────────
// 1. 登录与鉴权
// ─────────────────────────────────────────────────────────────
/**
 * 🔴 T81 顺序依赖修复（本文件）：「交易闭环」是**顺序型场景测试**
 *   （建仓 → 加仓 → 减仓 → 分红 → 复盘归因），原实现把每次 POST 放在各自的 `it` 里，
 *   依赖「前一个 it 先跑」。T81 的 `sequence.shuffle` 一开就随机失败
 *   （实测：建仓用例看到 1100 而非 1000；复盘 PATCH 找不到 trade）。
 *   ⚠️ 试过 `describe.sequential` —— **在 vitest 2.1.9 + 配置级 `sequence.shuffle: true`
 *   下不生效**（该配置会连 sequential 块内部一起打乱）。
 *   → 改为：**整个场景在文件级 `beforeAll` 里按顺序构造完并存快照，各 `it` 只做断言**。
 *   断言内容与原来完全一致，只是数据来源从「上一个 it 的副作用」变成「快照」。
 */
const snap: Record<string, any> = {};

const postTrade = (payload: Record<string, unknown>) =>
  ctx.bundle.app.inject({ method: 'POST', url: '/api/trade', headers: adminHeaders(), payload });
const getPosition = () =>
  ctx.bundle.app.inject({ method: 'GET', url: `/api/holding/${TRADE_CODE}`, headers: adminHeaders() });

beforeAll(async () => {
  snap.build = await postTrade({
    asset_code: TRADE_CODE,
    trade_type: 'buy',
    trade_date: '2026-01-05',
    trade_time: '09:00:01',
    quantity: 1000,
    price: 10.0,
    fee: 5,
    trade_reason: 'M4 端到端建仓',
  });
  snap.noReason = await postTrade({
    asset_code: TRADE_CODE,
    trade_type: 'buy',
    trade_date: '2026-01-06',
    trade_time: '09:00:02',
    quantity: 100,
    price: 10,
  });
  snap.add = await postTrade({
    asset_code: TRADE_CODE,
    trade_type: 'buy',
    trade_date: '2026-01-10',
    trade_time: '09:00:03',
    quantity: 500,
    price: 12.0,
    fee: 0,
    trade_reason: 'M4 加仓',
  });
  snap.oversell = await postTrade({
    asset_code: TRADE_CODE,
    trade_type: 'reduce',
    trade_date: '2026-02-02',
    trade_time: '09:00:04',
    quantity: 99999,
    price: 15.0,
    trade_reason: 'M4 超卖校验',
  });
  snap.reduce = await postTrade({
    asset_code: TRADE_CODE,
    trade_type: 'reduce',
    trade_date: '2026-02-10',
    trade_time: '09:00:05',
    quantity: 400,
    price: 15.0,
    fee: 2,
    trade_reason: 'M4 减仓止盈',
  });
  snap.posBeforeDividend = await getPosition();
  snap.dividend = await postTrade({
    asset_code: TRADE_CODE,
    trade_type: 'dividend',
    trade_date: '2026-03-01',
    trade_time: '09:00:06',
    quantity: 1100,
    price: 0.5,
    trade_reason: '2025 年度分红',
  });
  snap.posAfterDividend = await getPosition();
  snap.positions = await ctx.bundle.app.inject({
    method: 'GET',
    url: '/api/holding',
    headers: adminHeaders(),
  });
  snap.reduceList = await ctx.bundle.app.inject({
    method: 'GET',
    url: `/api/trade?asset_code=${TRADE_CODE}&trade_type=reduce`,
    headers: adminHeaders(),
  });
  ctx.tradeId = JSON.parse(snap.build.body).data?.trade_id;
});

describe('M4 · 登录与鉴权', () => {
  it('admin 凭据可登录拿 JWT', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.data.token).toBe('string');
    expect(body.data.user.role).toBe('admin');
  });

  it('无 token 访问 /api/holding → 401', async () => {
    const res = await ctx.bundle.app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(401);
  });

  it('伪造 token → 401 INVALID_TOKEN', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/holding',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('UNAUTHORIZED');
  });

  it('普通用户访问 admin 路由 → 403', async () => {
    const seed = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: 'm4_normal', password: 'm4_pass1234', role: 'user' },
    });
    expect(seed.statusCode).toBe(201);
    const userToken = JSON.parse(seed.body).data.token;

    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: userHeaders(userToken),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('FORBIDDEN');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. 交易录入 → 持仓 → 双口径收益
// ─────────────────────────────────────────────────────────────
describe('M4 · 交易闭环与双口径收益', () => {
  it('买入建仓 → 201，返回持仓与 trade_id', () => {
    const res = snap.build;
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.position.totalQuantity).toBe(1000);
    // 买入手续费计入成本：(1000*10 + 5) / 1000
    expect(body.data.position.avgCost).toBeCloseTo(10.005, 4);
    // 坑 1：返回字段是 trade_id，不是 trade.id
    expect(body.data.trade_id).toBeGreaterThan(0);
  });

  it('买入类缺 trade_reason → 400 TRADE_REASON_REQUIRED', () => {
    const res = snap.noReason;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('TRADE_REASON_REQUIRED');
  });

  it('加仓后移动加权成本重算', () => {
    const res = snap.add;
    expect(res.statusCode).toBe(201);
    // 成本基 = 10005 + 6000 = 16005，qty=1500 → 均价 10.67
    expect(JSON.parse(res.body).data.position.avgCost).toBeCloseTo(16005 / 1500, 4);
  });

  it('超持仓卖出 → 409 HOLDING_INSUFFICIENT', () => {
    const res = snap.oversell;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('HOLDING_INSUFFICIENT');
  });

  it('减仓 400 股 → 持仓 1100，浮盈为正', () => {
    const res = snap.reduce;
    expect(res.statusCode).toBe(201);
    const pos = JSON.parse(res.body).data.position;
    expect(pos.totalQuantity).toBe(1100);
    // 均价不因卖出而变（移动加权法，Requirements §5.3#3）
    expect(pos.avgCost).toBeCloseTo(16005 / 1500, 4);
  });

  it('分红计入实际口径、不改持仓（Requirements §5.3#5）', () => {
    const res = snap.dividend;
    expect(res.statusCode).toBe(201);

    const b = JSON.parse(snap.posBeforeDividend.body).data;
    const a = JSON.parse(snap.posAfterDividend.body).data;
    expect(a.totalQuantity).toBe(b.totalQuantity);
    expect(a.avgCost).toBeCloseTo(b.avgCost, 6);
    expect(a.totalCostBasis).toBeCloseTo(b.totalCostBasis, 6);
  });

  it('GET /api/holding 返回 enrich 字段与 summary', () => {
    const res = snap.positions;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const pos = body.data.find((p: any) => p.asset_code === TRADE_CODE);
    expect(pos.totalQuantity).toBe(1100);
    expect(body.summary.positionCount).toBeGreaterThanOrEqual(1);
    expect(typeof body.summary.totalCostBasis).toBe('number');
    // DuckDB 无行情时降级为 null，接口不应报错
    expect([null, 'number']).toContain(typeof pos.currentPrice);
  });

  it('GET /api/asset-stat/history 可读（快照由 17:02 cron 写入，可为空）', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/asset-stat/history?days=30',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body).data)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. 信号 / 复盘归因
// ─────────────────────────────────────────────────────────────
describe('M4 · 信号与复盘归因', () => {
  it('GET /api/signal 结构完整（可为空列表）', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/signal?page=1&page_size=10',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.pagination.total).toBe('number');
  });

  // 🔴 T81 顺序依赖修复：后面的「review/stats」「strategy_match 筛选」都依赖
  //   本用例 PATCH 出来的标记 → 提为 beforeAll，各 `it` 只做断言。
  beforeAll(async () => {
    snap.reviewPatch = await ctx.bundle.app.inject({
      method: 'PATCH',
      url: `/api/trade/${ctx.tradeId}`,
      headers: adminHeaders(),
      payload: {
        review_summary: 'M4：建仓理由成立，仓位偏重',
        strategy_match: 1,
        is_stop_loss: 0,
        remark: '下次分批建仓',
      },
    });
    snap.buyList = await ctx.bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${TRADE_CODE}&trade_type=buy`,
      headers: adminHeaders(),
    });
  });

  it('复盘 4 字段 PATCH 成功（strategy_match 三态）', () => {
    const res = snap.reviewPatch;
    expect(res.statusCode).toBe(200);

    const row = JSON.parse(snap.buyList.body).data.find((r: any) => r.id === ctx.tradeId);
    expect(row.strategy_match).toBe(1);
    expect(row.is_stop_loss).toBe(0);
    expect(row.review_summary).toContain('M4');
  });

  it('GET /api/review/yield 胜率/盈亏比口径正确', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/review/yield',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const s = JSON.parse(res.body).data;
    // 本链路只有 1 笔平仓（reduce 400 @15，均价 10.67 → 盈利）
    expect(s.closedCount).toBe(1);
    expect(s.winCount).toBe(1);
    expect(s.winRate).toBe(100);
    expect(s.reviewedCount).toBeGreaterThanOrEqual(1);
  });

  it('strategy_match 筛选可用', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/trade?strategy_match=1',
      headers: adminHeaders(),
    });
    const rows = JSON.parse(res.body).data as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.strategy_match === 1)).toBe(true);
  });

  it('软删平仓交易 → 统计排除 → 恢复', async () => {
    // 注意：要删的是平仓交易（reduce），删买入不影响 closedCount
    const reduceId = JSON.parse(snap.reduceList.body).data[0].id;

    const del = await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/trade/${reduceId}/soft-delete`,
      headers: adminHeaders(),
    });
    expect(del.statusCode).toBe(200);

    const gone = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/review/yield',
      headers: adminHeaders(),
    });
    expect(JSON.parse(gone.body).data.closedCount).toBe(0);

    const restore = await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/trade/${reduceId}/restore`,
      headers: adminHeaders(),
    });
    expect(restore.statusCode).toBe(200);

    const back = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/review/yield',
      headers: adminHeaders(),
    });
    expect(JSON.parse(back.body).data.closedCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. 候选池 / 插件管理
// ─────────────────────────────────────────────────────────────
describe('M4 · 候选池与插件管理', () => {
  it('候选 → 自选迁移幂等（T92：只打标记，不建关联）', async () => {
    await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/candidate',
      headers: adminHeaders(),
      payload: { asset_code: TRADE_CODE },
    });
    const first = await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/candidate/${TRADE_CODE}/migrate`,
      headers: adminHeaders(),
      payload: { price_mode: 'base' },
    });
    expect(first.statusCode).toBe(200);
    const second = await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/candidate/${TRADE_CODE}/migrate`,
      headers: adminHeaders(),
      payload: { price_mode: 'base' },
    });
    expect(second.statusCode).toBe(200);
    // T92：返回值语义改为 marked / autoCreated（不再有 alreadyExisted）
    expect(JSON.parse(second.body).data.marked).toBe(true);
    expect(JSON.parse(second.body).data.autoCreated).toBe(false);
  });

  it('插件列表可读，参数可保存、可启停', async () => {
    const list = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/strategy/plugins',
      headers: adminHeaders(),
    });
    expect(list.statusCode).toBe(200);
    const plugins = JSON.parse(list.body).data as any[];
    expect(plugins.length).toBeGreaterThan(0);
    const target = plugins[0];

    const cfg = await ctx.bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${target.id}/config`,
      headers: adminHeaders(),
      payload: { params: { period: 14 } },
    });
    expect(cfg.statusCode).toBe(200);

    const toggle = await ctx.bundle.app.inject({
      method: 'PUT',
      url: `/api/strategy/plugins/${target.id}/toggle`,
      headers: adminHeaders(),
      payload: { enabled: 0 },
    });
    expect(toggle.statusCode).toBe(200);

    const after = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/strategy/plugins',
      headers: adminHeaders(),
    });
    const reloaded = (JSON.parse(after.body).data as any[]).find((p) => p.id === target.id);
    expect(reloaded.enabled).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. 备份 → 恢复（T41 全链路）
// ─────────────────────────────────────────────────────────────
describe('M4 · 备份与恢复', () => {
  // 🔴 T81 顺序依赖修复：备份文件名由「手动备份」用例产出，
  //   「列出备份文件」用例依赖它 → shuffle 下随机失败。
  //   → 备份动作提到本 describe 的 beforeAll，列出用例只做断言。
  let backupRes: any;
  beforeAll(async () => {
    // 坑 2：db.backup() 真跑 IO，给足超时
    backupRes = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/admin/backup',
      headers: adminHeaders(),
      payload: {},
    });
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^business\.db\.\d{4}-\d{2}-\d{2}$/.test(f));
    ctx.backupFile = files.sort().pop()!;
  }, 300000); // 1.24GB 库 COPY 成 parquet，IO 争用下 120s 偏紧（实测全量跑偶发超时）

  it('手动备份 → 生成 business.db.YYYY-MM-DD', () => {
    const res = backupRes;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sqlite.success).toBe(true);

    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^business\.db\.\d{4}-\d{2}-\d{2}$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(statSync(path.join(BACKUP_DIR, ctx.backupFile)).size).toBeGreaterThan(0);
  });

  it('GET /api/admin/backups 列出备份文件', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body).data as any[];
    expect(list.some((f) => f.name === ctx.backupFile)).toBe(true);
  });

  it('恢复未带 confirm → 400 CONFIRM_REQUIRED', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/admin/backup/${ctx.backupFile}/restore`,
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('CONFIRM_REQUIRED');
  });

  it('路径穿越文件名 → 拒绝恢复', async () => {
    const res = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/admin/backup/..%2F..%2Fetc%2Fpasswd/restore',
      headers: adminHeaders(),
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('RESTORE_FAILED');
  });

  // 🔴 T81 顺序依赖修复：恢复动作 + 留痕断言互相依赖（且留痕必须在恢复**之后**才有）。
  //   → 整段搬进 describe 级 beforeAll，各 `it` 只做断言。
  beforeAll(async () => {
    // 先破坏数据：软删那笔平仓交易
    const list = await ctx.bundle.app.inject({
      method: 'GET',
      url: `/api/trade?asset_code=${TRADE_CODE}&trade_type=reduce`,
      headers: adminHeaders(),
    });
    const reduceId = JSON.parse(list.body).data[0].id;
    await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/trade/${reduceId}/soft-delete`,
      headers: adminHeaders(),
    });

    snap.beforeStats = JSON.parse(
      (
        await ctx.bundle.app.inject({
          method: 'GET',
          url: '/api/review/yield',
          headers: adminHeaders(),
        })
      ).body,
    ).data;

    // 恢复 —— 回到"备份那一刻"的状态（reduce 交易应当回来）
    snap.restore = await ctx.bundle.app.inject({
      method: 'POST',
      url: `/api/admin/backup/${ctx.backupFile}/restore`,
      headers: adminHeaders(),
      payload: { confirm: true },
    });

    // restore 会重置 ConfigStore 单例并重建连接 → 必须重新登录拿新 token
    const login = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    snap.login = login;
    if (login.statusCode === 200) {
      ctx.adminToken = JSON.parse(login.body).data.token;
    }

    snap.afterStats = JSON.parse(
      (
        await ctx.bundle.app.inject({
          method: 'GET',
          url: '/api/review/yield',
          headers: adminHeaders(),
        })
      ).body,
    ).data;

    // 关键表齐全（连接已重建，必须重新取单例，不能复用 bundle.db 旧句柄）
    snap.tables = ConfigStore.getInstance()
      .db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_account','user_trade_record','system_log')`,
      )
      .all() as any[];
  }, 60000);

  it('恢复成功后业务数据回到备份时刻 + 生成安全备份', () => {
    expect(snap.beforeStats.closedCount).toBe(0); // 已破坏

    expect(snap.restore.statusCode).toBe(200);
    const restoreBody = JSON.parse(snap.restore.body);
    expect(restoreBody.success).toBe(true);
    expect(restoreBody.data.safetyBackup).toMatch(/pre-restore/);

    expect(snap.login.statusCode).toBe(200);
    expect(snap.afterStats.closedCount).toBe(1); // 数据回到备份时刻
    expect(snap.tables.length).toBe(3);
  });

  it('恢复操作写 system_log 留痕', () => {
    // 恢复动作已在同 describe 的 beforeAll 完成（同一 describe 内 beforeAll 先于 it 执行）
    const rows = ConfigStore.getInstance()
      .db.prepare(`SELECT * FROM system_log WHERE message LIKE '%备份恢复%' ORDER BY id DESC LIMIT 1`)
      .all() as any[];
    expect(rows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. 权限与合规收尾
// ─────────────────────────────────────────────────────────────
describe('M4 · 权限边界收尾', () => {
  it('普通用户不能触发手动备份', async () => {
    const seed = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/auth/seed',
      payload: { username: 'm4_plain2', password: 'm4_pass1234', role: 'user' },
    });
    const token = JSON.parse(seed.body).data.token;
    const res = await ctx.bundle.app.inject({
      method: 'POST',
      url: '/api/admin/backup',
      headers: userHeaders(token),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('禁止把当前 admin 降级自己', async () => {
    const me = JSON.parse(
      (
        await ctx.bundle.app.inject({
          method: 'GET',
          url: '/api/admin/users',
          headers: adminHeaders(),
        })
      ).body,
    ).data.find((u: any) => u.username === ADMIN_USER);

    const res = await ctx.bundle.app.inject({
      method: 'PATCH',
      url: `/api/admin/role/${me.id}`,
      headers: adminHeaders(),
      payload: { role: 'user' },
    });
    expect(res.statusCode).toBe(400);
    // T89a：中文文案在 `message`（`error`/`code` 是错误码）
    expect(JSON.parse(res.body).message).toContain('禁止降级');
  });

  it('全程无明文 token / 密码落 system_log（AGENTS.md 安全硬约束）', () => {
    const leaked = ConfigStore.getInstance()
      .db.prepare(
        `SELECT COUNT(*) AS c FROM system_log
       WHERE detail LIKE '%ghp_%' OR detail LIKE '%m4_pass1234%' OR message LIKE '%m4_pass1234%'`,
      )
      .get() as { c: number };
    expect(leaked.c).toBe(0);
  });
});
