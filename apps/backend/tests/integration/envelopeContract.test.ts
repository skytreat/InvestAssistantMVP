/**
 * T89b —— 统一 envelope 契约测试（**响应体不得有 `success` 键**）
 *
 * ## 为什么要有这个测试
 *
 * T89a 落地统一 envelope 时，`success` 是**过渡期**保留字段（前端 20 处 `if (res.data.success)` 依赖它）。
 * T89b（Wave 8）**删除**该字段 —— 这是 B-9 收尾的**唯一破坏性变更**。
 *
 * ⇒ 一旦有人（或某个 agent）在某条路由里手写响应体、或给 `ok(data, extra)` 的 `extra`
 *   塞进 `success`，前端就会拿到「有 `success` 但没有 `code`」的畸形响应
 *   （前端成功判定已切到 `code === 0` ⇒ 该响应会被判为失败 ⇒ 页面空白）。
 *   ⇒ 本测试是**结构性回归锚点**：逐路由断言响应体**没有** `success` 键。
 *
 * ## 覆盖方式：显式路由表 + `onRoute` 完整性校验
 *
 * 1. 用 Fastify 的 **`onRoute` 钩子**捕获**实际注册的全部路由**；
 * 2. 与本文件维护的**显式路由表**比对 —— 新增路由而忘了加进表里 ⇒ **测试红**
 *    （这是「遍历全部路由」的可验证性保证，不靠人肉记得更新）；
 * 3. 逐条发请求，断言响应体形状。
 *
 * ⚠️ **为什么不用 `app.printRoutes()`**：它的输出是一棵**人读的树**，
 *   解析格式属于「实现细节」，Fastify 升级就可能变 ⇒ 脆。
 *   `onRoute` 是**公开 API**，稳定。
 *
 * ## 断言分层
 *
 * | 情形 | 断言 |
 * |---|---|
 * | **全部**响应 | `'success' in body === false`（T89b 核心契约） |
 * | 2xx | `code === 0` + `'data' in body` + `typeof timestamp === 'string'` |
 * | 4xx/5xx | `typeof code === 'string'`（错误码）+ `data === null` + `typeof message === 'string'` + `typeof timestamp === 'string'` |
 * | `/api/health` | **非 envelope**（健康检查刻意不走 envelope）⇒ 只断言无 `success` 键 |
 *
 * ⚠️ **依赖行情库的路由在 CI 也能跑**：它们在无行情时走 `fail(...)` 分支
 *   （如 `GET /api/market/latest` → 502 `DB_UNAVAILABLE`）⇒ **仍是统一 envelope**，
 *   故契约断言照常成立。只有**重操作**（备份）需要按行情档位跳过（见下）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── 隔离环境：SQLite 库 + BACKUP_DIR 都指临时目录 ──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t89b-'));
const DB_PATH = path.join(TMP_DIR, 't89b.db');
const BACKUP_TMP_DIR = path.join(TMP_DIR, 'backups');
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
const ORIG_BACKUP_DIR = process.env.BACKUP_DIR;
process.env.SQLITE_DB_PATH = DB_PATH;
process.env.BACKUP_DIR = BACKUP_TMP_DIR;

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerRoutes } = await import('../../src/routes/index.js');
const { hashPassword, signToken } = await import('../../src/services/auth.js');
const { marketDataAvailable } = await import('../_marketData.js');
const { BACKUP_DIR } = await import('../../src/services/backup.js');

/** 真实行情库是否可用（CI = 不可用；本地 = 有 1.24GB 真库） */
const HAS_MARKET = await marketDataAvailable();

/**
 * 备份目录是否**已隔离**到本测试的临时目录
 *
 * ⚠️ `services/backup.ts` 在**模块加载时**就把 `BACKUP_DIR` 定成常量。
 *   单进程跑全量套件时（`singleFork=true`），若**别的测试文件先加载**了它，
 *   本文件顶层设的 `process.env.BACKUP_DIR` 就**不再生效** ⇒ 备份会写进仓库的 `data/backup`。
 *   ⇒ 备份路由只在目录确已隔离时才跑（否则跳过），避免污染仓库。
 */
const BACKUP_DIR_ISOLATED = path.resolve(BACKUP_DIR).startsWith(path.resolve(TMP_DIR));

const ADMIN_USER = 't89b_admin';
const ADMIN_PASS = 't89b_admin123';

let app: FastifyInstance;
let adminToken: string;

/** 实际注册的全部路由（`onRoute` 钩子捕获） */
const registeredRoutes: Array<{ method: string; url: string }> = [];

// ── 路由遍历表 ────────────────────────────────────────────────

/** 遍历表里的一条路由 */
interface RouteCase {
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 路径（带参数占位） */
  url: string;
  /** 请求体 */
  payload?: unknown;
  /** 查询参数 */
  query?: Record<string, string>;
  /**
   * 是否是**重操作**（备份：把整个行情视图 COPY 成 parquet，真库实测 >100s）
   *
   * ⇒ 有真库时跳过；`smoke-m4.test.ts` 已覆盖它的 envelope 形状（`body.code === 0`）。
   */
  heavy?: boolean;
  /** 是否**不走** envelope（只有 `/api/health`）*/
  raw?: boolean;
  /** 单条用例超时（毫秒）—— 走行情的端点在真库上可能十几秒 */
  timeout?: number;
}

/** 一个合法的交易 payload（T87：trade_time 必填且秒级） */
const TRADE_PAYLOAD = {
  asset_code: 'sh600000',
  trade_type: 'buy',
  trade_date: '2026-10-21',
  trade_time: '10:00:00',
  quantity: 100,
  price: 10,
  fee: 0,
  trade_reason: 'T89b 契约测试',
};

const ROUTE_CASES: RouteCase[] = [
  // ── 公共路由 ──
  { method: 'GET', url: '/api/health', raw: true },
  { method: 'POST', url: '/api/auth/login', payload: { username: ADMIN_USER, password: ADMIN_PASS } },
  // 匿名注册在「库里已有用户」时返回 403 REGISTRATION_CLOSED（错误 envelope）
  { method: 'POST', url: '/api/auth/register', payload: { username: 't89b_anon', password: 'pw-123456' } },
  { method: 'POST', url: '/api/auth/refresh', payload: { refresh_token: 'not-a-real-token' } },
  {
    method: 'POST',
    url: '/api/auth/seed',
    payload: { username: 't89b_seeded', password: 'pw-123456', role: 'user' },
  },
  { method: 'GET', url: '/api/market/latest', timeout: 60_000 },
  { method: 'GET', url: '/api/market/latest-date', timeout: 60_000 },

  // ── 交易 ──
  { method: 'POST', url: '/api/trade', payload: TRADE_PAYLOAD },
  {
    method: 'GET',
    url: '/api/trade/check-duplicate',
    query: { asset_code: 'sh600000', trade_type: 'buy', trade_date: '2026-10-21', trade_time: '10:00:00' },
  },
  { method: 'GET', url: '/api/trade' },
  { method: 'PATCH', url: '/api/trade/:id', payload: { strategy_match: 'yes' } },
  { method: 'POST', url: '/api/trade/:id/soft-delete' },
  { method: 'POST', url: '/api/trade/:id/restore' },

  // ── 持仓 ──
  { method: 'GET', url: '/api/holding', timeout: 60_000 },
  { method: 'GET', url: '/api/holding/:asset_code', timeout: 60_000 },

  // ── 自选 / 候选 ──
  { method: 'GET', url: '/api/watch' },
  { method: 'POST', url: '/api/watch', payload: { asset_code: 'sh600000' } },
  { method: 'DELETE', url: '/api/watch/:asset_code' },
  { method: 'GET', url: '/api/candidate' },
  {
    method: 'POST',
    url: '/api/candidate',
    payload: { asset_code: 'sz000001', candidate_reason: 'T89b 契约测试' },
    timeout: 60_000,
  },
  { method: 'DELETE', url: '/api/candidate/:asset_code' },
  { method: 'POST', url: '/api/candidate/:id/migrate', payload: { price_mode: 'base' } },
  { method: 'POST', url: '/api/candidates/batch', payload: { asset_codes: ['sh600000'] } },

  // ── 复盘 / 资产统计 ──
  { method: 'GET', url: '/api/review/yield' },
  { method: 'GET', url: '/api/review/trades' },
  { method: 'GET', url: '/api/asset-stat/latest' },
  { method: 'GET', url: '/api/asset-stat/history' },

  // ── 行情 / 选股 ──
  { method: 'GET', url: '/api/quote/:symbol/kline', timeout: 60_000 },
  { method: 'POST', url: '/api/stockscan', payload: { asset_type: 'stock' }, timeout: 60_000 },
  { method: 'GET', url: '/api/stockscan/plugins' },
  { method: 'GET', url: '/api/symbols/search', query: { q: '600000' }, timeout: 60_000 },

  // ── 信号 / 除权 ──
  { method: 'GET', url: '/api/signal' },
  { method: 'GET', url: '/api/signal/stats' },
  { method: 'GET', url: '/api/ex-dividend/imports' },

  // ── 插件 / 策略 ──
  { method: 'GET', url: '/api/strategy/plugins' },
  { method: 'PUT', url: '/api/strategy/plugins/:id/config', payload: { enabled: true, params: {} } },
  // ⚠️ `enabled` 传数字或布尔都行：后端已在**参数层**收口成 SQLite 的 0/1
  //    （本波修复的缺陷 ② —— 原先传 boolean 会让 better-sqlite3 绑定失败 ⇒ 500 + 非 envelope 体）
  { method: 'PUT', url: '/api/strategy/plugins/:id/toggle', payload: { enabled: 1 } },
  { method: 'POST', url: '/api/strategy/reload' },
  { method: 'POST', url: '/api/strategy/plugins/reload' },

  // ── 券商对账（V3.1：T122 导入 + T126 对账）──
  // ⚠️ POST 路由读 request.body：至少给 `{}`（`toInput(undefined)` 会 500，非 envelope 体）。
  //    缺参时各路由返回 4xx 错误 envelope（码为字符串 + data=null），符合 T89b 契约。
  { method: 'POST', url: '/api/broker-import/upload', payload: {} },
  { method: 'POST', url: '/api/broker-import/preview', payload: {} },
  { method: 'POST', url: '/api/broker-import/confirm', payload: {} },
  { method: 'GET', url: '/api/broker-import/batches' },
  { method: 'POST', url: '/api/broker-import/batches/:id/revoke', payload: {} },
  { method: 'GET', url: '/api/broker-import/templates' },
  { method: 'POST', url: '/api/broker-import/templates', payload: {} },
  { method: 'POST', url: '/api/broker-reconcile/run', payload: { brokerCode: 't89b' } },
  { method: 'GET', url: '/api/broker-reconcile/latest', query: { brokerCode: 't89b' } },
  { method: 'GET', url: '/api/broker-reconcile/diff', query: { brokerCode: 't89b' } },

  // ── 管理员 ──
  { method: 'GET', url: '/api/admin/datacheck/result' },
  { method: 'POST', url: '/api/admin/datacheck/trigger', timeout: 60_000 },
  { method: 'POST', url: '/api/admin/run-signal', timeout: 60_000 },
  { method: 'GET', url: '/api/admin/system-log' },
  { method: 'GET', url: '/api/admin/system-log/fallback' },
  { method: 'GET', url: '/api/admin/users' },
  { method: 'PATCH', url: '/api/admin/role/:userId', payload: { role: 'user' } },
  { method: 'POST', url: '/api/admin/rerun-quotes', payload: { reason: 'T89b 契约测试' }, timeout: 60_000 },
  { method: 'POST', url: '/api/admin/backup', heavy: true, timeout: 300_000 },
  { method: 'GET', url: '/api/admin/backups' },
  { method: 'POST', url: '/api/admin/backup/:file/restore', payload: { confirm: true } },
];

/** 把 `:param` 占位替换成具体值 */
function fillPath(url: string): string {
  return url
    .replace(':symbol', 'sh600000')
    .replace(':asset_code', 'sh600000')
    .replace(':file', 'business.db.2000-01-01')
    .replace(':id', '1')
    .replace(':userId', '1');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  // 🔴 `onRoute` 必须在 `registerRoutes` **之前**挂上，才能捕获到全部路由
  app.addHook('onRoute', (routeOptions) => {
    const method = String(routeOptions.method ?? 'GET').toUpperCase();
    // ⚠️ Fastify 会为每个 GET 路由**自动派生**一条 HEAD 路由
    //   （`exposeHeadRoutes` 默认开）⇒ 那不是「独立路由」，不纳入遍历表
    if (method === 'HEAD') return;
    registeredRoutes.push({ method, url: routeOptions.url });
  });
  await registerRoutes(app);
  await app.ready();

  // seed 一个 admin（并拿 token）
  const db = ConfigStore.getInstance();
  db.db
    .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
    .run(ADMIN_USER, hashPassword(ADMIN_PASS), 'admin');
  adminToken = signToken({ sub: 1, username: ADMIN_USER, role: 'admin' });
});

afterAll(async () => {
  await app.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  if (ORIG_BACKUP_DIR === undefined) delete process.env.BACKUP_DIR;
  else process.env.BACKUP_DIR = ORIG_BACKUP_DIR;
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
});

describe('T89b · 路由覆盖完整性（遍历表必须覆盖**全部已注册路由**）', () => {
  it('遍历表里的每条路由都真实存在，且没有漏掉新注册的路由', () => {
    const actual = new Set(registeredRoutes.map((r) => `${r.method} ${r.url}`));
    const listed = new Set(ROUTE_CASES.map((c) => `${c.method} ${c.url}`));

    const missing = [...actual].filter((k) => !listed.has(k));
    expect(missing, `新增路由未加入 T89b 遍历表：\n${missing.join('\n')}`).toEqual([]);

    const extra = [...listed].filter((k) => !actual.has(k));
    expect(extra, `遍历表里的路由不存在（路径/方法写错了）：\n${extra.join('\n')}`).toEqual([]);
  });
});

describe('T89b · envelope 契约（**响应体不得有 `success` 键**）', () => {
  for (const c of ROUTE_CASES) {
    // 🔴 重操作（备份）：有真库时跳过（真库 COPY 整个行情视图 >100s）
    let skipReason: string | undefined = undefined;
    if (c.heavy && HAS_MARKET) {
      skipReason = '备份会把整个行情视图 COPY 成 parquet（真库 >100s）；smoke-m4 已覆盖其 envelope 形状';
    } else if (c.heavy && !BACKUP_DIR_ISOLATED) {
      skipReason = `备份目录未被隔离（BACKUP_DIR=${BACKUP_DIR}）⇒ 跳过，避免把备份写进仓库`;
    }
    const runner = skipReason ? it.skip : it;

    runner(
      `${c.method} ${c.url} → 响应体无 \`success\` 键，且符合统一 envelope`,
      async () => {
        const res = await app.inject({
          method: c.method,
          url: fillPath(c.url) + (c.query ? `?${new URLSearchParams(c.query).toString()}` : ''),
          payload: c.payload as never,
          headers: { authorization: `Bearer ${adminToken}` },
        });

        const body = res.json() as Record<string, unknown>;

        // 🔴 T89b 核心契约：**任何**响应体都不得再有 `success` 键
        expect('success' in body, `${c.method} ${c.url} 的响应体仍有 success 键`).toBe(false);

        // `/api/health` 刻意不走 envelope（前端 Vite proxy 轮询用）⇒ 到此为止
        if (c.raw) {
          expect(body.status).toBe('ok');
          return;
        }

        if (res.statusCode < 400) {
          // 成功体：code === 0 + data + timestamp（SDD §4.2）
          expect(body.code, `${c.method} ${c.url} 成功体缺 code`).toBe(0);
          expect('data' in body, `${c.method} ${c.url} 成功体缺 data`).toBe(true);
          expect(typeof body.timestamp, `${c.method} ${c.url} 成功体缺 timestamp`).toBe('string');
        } else {
          // 错误体：字符串 code + message + data === null + timestamp（SDD §4.2 / §4.3）
          expect(typeof body.code, `${c.method} ${c.url} 错误体 code 不是字符串`).toBe('string');
          expect(body.data, `${c.method} ${c.url} 错误体 data 应为 null`).toBeNull();
          expect(typeof body.message, `${c.method} ${c.url} 错误体缺 message`).toBe('string');
          expect(typeof body.timestamp, `${c.method} ${c.url} 错误体缺 timestamp`).toBe('string');
        }
      },
      c.timeout ?? 15_000,
    );
  }
});
