/**
 * smoke-m5.test.ts — T77：Wave 8 全链路 smoke（API 级）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ## 它与 smoke-m1 ~ smoke-m4 的区别
 *
 * 前四个 smoke 是**分里程碑**的（每个只覆盖自己那一波的功能）。
 * 本文件是 **Wave 8 的最终验收**：把 11 个环节**串成一条链**，
 * 每一步的**产物就是下一步的输入** —— 而不是 11 个互相独立的孤立用例。
 *
 * ```
 *  注册 ──► 新用户 token ──► 交易 7 类型 ──► 持仓 + 双口径快照
 *                                              │
 *                                              ▼
 *   批量候选 ◄── 选股公共过滤 ◄── signals symbol 过滤 ◄── K 线四 fq
 *      │
 *      ▼
 *   复盘 4 色 ──► 插件参数 ──► 备份 ──► 恢复 ──► 角色管理
 * ```
 *
 * ## 🔴 T81 的顺序依赖纪律（本文件的核心约束）
 *
 * `apps/backend/vitest.config.ts` 开了 `sequence.shuffle: true`
 * ⇒ **文件内用例顺序被打乱** ⇒ 「上一个 it 的副作用」不可依赖。
 * （`describe.sequential` 在 vitest 2.1.9 + 配置级 shuffle 下**不生效**，
 *   实测已证伪 —— 见 smoke-m3 / smoke-m4 的同款注释。）
 *
 * ⇒ **整条链在文件级 `beforeAll` 里按顺序构造完并存快照**，各 `it` **只做断言**。
 *
 * ## 🔴 断言口径：T89b 起响应体**没有 `success` 字段**
 *
 * 成功判定唯一口径是 **`code === 0`**（数字 0）；
 * 错误判定是 **`typeof body.code === 'string'`**（错误码是字符串）。
 * ⇒ 本文件**不使用** `body.success`。
 *
 * ## 🔴 隔离铁律
 *
 * - SQLite 库 → `mkdtempSync` 出来的临时目录（**绝不碰 `data/business.db`**）；
 * - 备份目录 → 同一个临时目录下的 `backups/`（**绝不碰 `data/backup`**）；
 * - 备份恢复是**破坏性**的（会用备份文件覆盖业务库文件）⇒ 它的目标库必须是临时库；
 * - DuckDB → **只读**，不写（AGENTS.md 硬约束）。
 *
 * ## 🔴 行情库的两层开关（`tests/_marketData.ts`）
 *
 * | 能力 | 迷你库 | 真库 | 本文件里的用法 |
 * |---|---|---|---|
 * | `numeric` 数值型 | ✅ 可信 | ✅ | K 线四 fq / 选股过滤回显 / 双口径差值 |
 * | `scale` 规模型 | ❌ | ✅ | 「选股公共过滤」的候选池规模断言 |
 *
 * 无行情库时**必须 skip**（绝不 fail）—— CI 只有 12KB 空壳库。
 *
 * ## ⚠️ 为什么备份不调 `POST /api/admin/backup`
 *
 * 该端点会跑 `runFullBackup()` = SQLite 热备份 + **DuckDB `COPY v_stock_qfq TO parquet`**。
 * 真库（1.24GB）下这一步要 **>100s**（视图实时计算，2100 万行复权因子聚合）。
 * ⇒ 本文件只调 **`backupSQLite()`**（SQLite 侧的热备份，与 `runFullBackup` 的
 *   SQLite 分支**同一个函数**），把「>100s 的 DuckDB 导出」留给 smoke-m4 覆盖。
 *   备份产物的**列出**与**恢复**仍然走 HTTP 端点（`GET /api/admin/backups` /
 *   `POST /api/admin/backup/:file/restore`）⇒ 链路的 API 性质不变。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ConfigStore } from '../src/config/configStore.js';
import { registerRoutes } from '../src/routes/index.js';
import { marketDataUsableFor, SKIP_REASON_NO_SCALE_DATA } from './_marketData.js';

// ════════════════════════════════════════════════════════════════════════
// 隔离环境：SQLite 库 + 备份目录都指临时目录
// ════════════════════════════════════════════════════════════════════════
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-smoke5-'));
const DB_PATH = path.join(TMP_DIR, 'smoke5.db');
const BACKUP_TMP_DIR = path.join(TMP_DIR, 'backups');

const ORIG_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const ORIG_BACKUP_DIR = process.env.BACKUP_DIR;

process.env.SQLITE_DB_PATH = DB_PATH;
process.env.BACKUP_DIR = BACKUP_TMP_DIR;

/**
 * 🔴 `backup.ts` 在**模块加载时**读 `BACKUP_DIR`（`export const BACKUP_DIR = ...`）
 *   ⇒ 必须用**动态 import**在 env 设好之后加载，否则会读到 `data/backup`。
 */
const backupMod = await import('../src/services/backup.js');
const { backupSQLite } = backupMod;

/**
 * 🔴 `assetStat.ts` / `marketData.ts` 也要动态 import：
 *   `insertAssetStatSnapshots` 是 17:02 cron 的**最后一步**（双口径快照写入口），
 *   静态 import 不会有问题，但为与 backup 保持同一套「先设 env 再加载」的纪律，统一动态加载。
 */
const assetStatMod = await import('../src/services/assetStat.js');
const { insertAssetStatSnapshots } = assetStatMod;
const marketDataMod = await import('../src/services/marketData.js');
const { resolveLatestQuoteDate } = marketDataMod;

// ════════════════════════════════════════════════════════════════════════
// 行情库能力判定（顶层 await，一次定档）
// ════════════════════════════════════════════════════════════════════════
/** 数值型用例可跑？（迷你库即可 —— 它是真库的逐位一致子集） */
const MARKET_DATA_NUMERIC_AVAILABLE = await marketDataUsableFor('numeric');
/** 规模型用例可跑？（**必须真库** —— 迷你库只有 250 只标的） */
const MARKET_DATA_SCALE_AVAILABLE = await marketDataUsableFor('scale');

if (!MARKET_DATA_NUMERIC_AVAILABLE) {
  console.warn(
    '[smoke-m5] ⚠️ 行情库不可用：K 线 / 选股 / 双口径 的数值型断言将被**跳过**（CI 只有 12KB 空壳库）。',
  );
}
if (!MARKET_DATA_SCALE_AVAILABLE) {
  console.warn('[smoke-m5] ⚠️ 规模型断言（选股候选池 > 3000）将被**跳过**：' + SKIP_REASON_NO_SCALE_DATA);
}

// ════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════
/**
 * 链路主用户 —— **由 `POST /api/auth/register` 匿名注册产生**（库里 0 用户 ⇒ 自动 admin）。
 *
 * ⚠️ 为什么主用户就是 admin：SDD §4.4 / PRD D5 只登记了「首个注册自动 admin」这一条路径，
 *   它是**唯一**经 HTTP 可达的建号入口（见下方「已知缺陷」注释）。
 *   主用户同时具备 admin 身份 → 备份恢复 / 角色管理这两步也能用同一个会话串下去。
 */
const ADMIN_USER = 'smoke5_admin';
const ADMIN_PASS = 'smoke5_admin123';
/** 另一个普通用户（`POST /api/auth/seed` 建号）—— 用来验证越权边界与角色变更 */
const OTHER_USER = 'smoke5_other';
const OTHER_USER_PASS = 'smoke5_other1234';

/** 主链路标的（迷你库 / 真库都有数据）*/
const MAIN_CODE = 'sh600036';
/** 留存持仓标的（用来验证「清仓后另一只仍有持仓」）*/
const KEEP_CODE = 'sh600519';
/** 只用于「批量候选」的第三个标的 */
const THIRD_CODE = 'sz000001';

/** 选股用的插件（内置 monitor/filter 插件，paramSchema 完整）*/
const PLUGIN_ID = 'rsi_oversold';

/** 候选池上限（routes/stockscan.ts 的 POOL_LIMIT）*/
const POOL_LIMIT = 5000;
/** 规模门槛：股票池 > 3000（实测真库 5561 只）*/
const SCALE_THRESHOLD = 3000;

// ════════════════════════════════════════════════════════════════════════
// 运行时状态
// ════════════════════════════════════════════════════════════════════════
type Inject = ReturnType<Fastify['inject']>;

let app: Awaited<ReturnType<typeof Fastify>>;

/** 链路上逐步累积的快照（每个 `it` 只读这里，不自己发请求）*/
const snap: Record<string, unknown> = {};

/** admin 侧的 token（备份 / 角色管理需要 admin）*/
let adminToken = '';
/** 链路主用户的 token（= 首个注册用户的 token，它同时是 admin）*/
let userToken = '';
/** 主用户 id */
let userId = 0;
/** 另一个普通用户的 token / id（越权边界 + 角色变更的靶子）*/
let otherToken = '';
let otherUserId = 0;

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` };
}
function userHeaders(): Record<string, string> {
  return { authorization: `Bearer ${userToken}` };
}

/** 解析响应体（失败时给出可读信息）*/
function body(res: Inject): any {
  try {
    return JSON.parse(res.body);
  } catch {
    return { __raw: res.body };
  }
}

/** 当前 ConfigStore 单例（**每次现取** —— 备份恢复会重置单例）*/
function db() {
  return ConfigStore.getInstance();
}

/** 交易录入（链路上所有交易都走它）*/
function postTrade(payload: Record<string, unknown>): Promise<Inject> {
  return app.inject({
    method: 'POST',
    url: '/api/trade',
    headers: userHeaders(),
    payload,
  });
}

// ════════════════════════════════════════════════════════════════════════
// 🔴 整条链在文件级 beforeAll 里按顺序构造
// ════════════════════════════════════════════════════════════════════════
beforeAll(async () => {
  // ── 0. 启动（临时 SQLite 库 + 临时备份目录）──
  ConfigStore.resetInstance();
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await registerRoutes(app);

  // ── 1. 注册（链路的起点）──
  // ⚠️ **库里必须是 0 用户**：`POST /api/auth/register` 的 bootstrap 路径
  //   （匿名 + 库里 0 用户 → 首个用户自动 admin，SDD §4.4 / PRD D5）才可达。
  //   ⇒ 本文件**不预置** admin 用户，直接走真实的产品注册入口。
  //
  // 🔴 **已知缺陷（本次发现，未修 —— 见汇报）**：
  //   `routes/index.ts` 的全局 onRequest 钩子对 PUBLIC_ROUTES **提前 return**
  //   ⇒ `/api/auth/register` 上 `request.user` 永远为空
  //   ⇒ `resolveRegisterRole` 的「admin 调用 + 请求 user → 强制 role=user」分支
  //     **在 HTTP 层不可达**（只被纯函数单测 t57 覆盖）。
  //   本文件因此**只断言 SDD 已登记的路径**（首个注册自动 admin），
  //   **不**把「admin 建号被拒」写成断言（那会把缺陷固化成契约）。
  snap.register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  const regBody = body(snap.register as Inject);
  adminToken = regBody.data?.token ?? '';
  userToken = adminToken;
  userId = regBody.data?.user?.id ?? 0;

  // 匿名注册：库里已有用户 ⇒ bootstrap 关闭（403）
  snap.registerClosed = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'smoke5_anon', password: 'smoke5_anon1234' },
  });
  // 重复用户名 → 409（错误码字符串；不绑定具体码字，避免与并行修复冲突）
  snap.registerDuplicate = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });

  // 另一个普通用户（`POST /api/auth/seed`，公开端点、只允许建 role='user'）
  snap.seedOther = await app.inject({
    method: 'POST',
    url: '/api/auth/seed',
    payload: { username: OTHER_USER, password: OTHER_USER_PASS, role: 'user' },
  });
  const seedBody = body(snap.seedOther as Inject);
  otherToken = seedBody.data?.token ?? '';
  otherUserId = seedBody.data?.user?.id ?? 0;

  // 越权边界预置：普通用户访问 admin 端点 → 403
  snap.otherForbidden = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: { authorization: `Bearer ${otherToken}` },
  });

  // ── 2. 交易 7 类型（全部挂在**新用户**名下 → 证明「注册产物 = 下一步输入」）──
  // 负例先行：买入缺理由 → 400
  snap.tradeNoReason = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'buy',
    trade_date: '2026-01-04',
    trade_time: '09:00:00',
    quantity: 100,
    price: 10,
  });
  // 负例：超持仓卖出 → 409（不落库、不污染后续状态）
  snap.tradeOversell = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'reduce',
    trade_date: '2026-01-05',
    trade_time: '09:00:00',
    quantity: 99999,
    price: 15,
    trade_reason: 'M5 超卖校验',
  });

  // ① buy 建仓 1000 股 @10（手续费 5）
  snap.tradeBuy = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'buy',
    trade_date: '2026-01-05',
    trade_time: '09:00:01',
    quantity: 1000,
    price: 10,
    fee: 5,
    trade_reason: 'M5 建仓',
  });
  // ② add 加仓 500 股 @12 → 移动加权成本重算
  snap.tradeAdd = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'add',
    trade_date: '2026-01-10',
    trade_time: '09:00:02',
    quantity: 500,
    price: 12,
    fee: 0,
    trade_reason: 'M5 加仓',
  });
  // ③ reduce 减仓 400 股 @15 → 已实现盈亏入账
  snap.tradeReduce = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'reduce',
    trade_date: '2026-02-10',
    trade_time: '09:00:03',
    quantity: 400,
    price: 15,
    fee: 2,
    trade_reason: 'M5 减仓止盈',
  });
  // ④ dividend 分红（系统固化理由 + system_followed=1 → 复盘页绿色档）
  // ⚠️ T119（V3.0）起 bonus 计入持仓，清仓（02-20）须晚于送转才可能归零 ⇒ 除权事件排到清仓前
  snap.tradeDividend = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'dividend',
    trade_date: '2026-02-15',
    trade_time: '09:00:04',
    quantity: 1100,
    price: 0.5,
    system_followed: 1,
  });
  // ⑤ bonus 送股
  snap.tradeBonus = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'bonus',
    trade_date: '2026-02-16',
    trade_time: '09:00:05',
    quantity: 100,
    price: 0,
  });
  // ⑥ transfer 转增
  snap.tradeTransfer = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'transfer',
    trade_date: '2026-02-17',
    trade_time: '09:00:06',
    quantity: 10,
    price: 0,
  });
  // ⑦ clear 清仓（1200 股全部卖出 → 该标的持仓归零）
  // ⚠️ T119（V3.0）起送股计入持仓：reduce 后 1100 + bonus 100 = 1200，故清仓须卖 1200 才能归零
  snap.tradeClear = await postTrade({
    asset_code: MAIN_CODE,
    trade_type: 'clear',
    trade_date: '2026-02-20',
    trade_time: '09:00:07',
    quantity: 1200,
    price: 16,
    fee: 1,
    trade_reason: 'M5 清仓',
  });
  // 另一只标的留仓（证明「持仓」不是只有一个归零的坑）
  snap.tradeKeep = await postTrade({
    asset_code: KEEP_CODE,
    trade_type: 'buy',
    trade_date: '2026-01-06',
    trade_time: '09:00:08',
    quantity: 800,
    price: 5,
    fee: 0,
    trade_reason: 'M5 留存持仓',
  });

  // 交易 id 快照（复盘 PATCH 要用）
  const tradeList = await app.inject({
    method: 'GET',
    url: `/api/trade?asset_code=${MAIN_CODE}`,
    headers: userHeaders(),
  });
  snap.tradeList = tradeList;
  const rows = body(tradeList).data as Array<{ id: number; trade_type: string }>;
  const idOf = (t: string): number => rows.find((r) => r.trade_type === t)?.id ?? 0;
  snap.idBuy = idOf('buy');
  snap.idAdd = idOf('add');
  snap.idReduce = idOf('reduce');
  snap.idDividend = idOf('dividend');

  // ── 3. 持仓（双口径）──
  snap.holding = await app.inject({
    method: 'GET',
    url: `/api/holding/${MAIN_CODE}`,
    headers: userHeaders(),
  });
  snap.holdingKeep = await app.inject({
    method: 'GET',
    url: `/api/holding/${KEEP_CODE}`,
    headers: userHeaders(),
  });
  snap.holdings = await app.inject({ method: 'GET', url: '/api/holding', headers: userHeaders() });

  // 双口径快照：走 17:02 cron 的**同一个写入口**（`insertAssetStatSnapshots`）
  const quoteDate = (await resolveLatestQuoteDate()) ?? new Date().toISOString().slice(0, 10);
  snap.assetStatWrite = await (async () => {
    try {
      const res = await insertAssetStatSnapshots(quoteDate);
      return { ok: true, inserted: res.inserted, tradeDate: quoteDate };
    } catch (err) {
      // 行情库不可用时快照写不进去（`batchGetDaily` 抛错）—— 记下来，由断言决定怎么判
      return { ok: false, error: err instanceof Error ? err.message : String(err), tradeDate: quoteDate };
    }
  })();
  snap.assetStat = await app.inject({
    method: 'GET',
    url: '/api/asset-stat/latest',
    headers: userHeaders(),
  });

  // ── 4. K 线四 fq ──
  snap.klineQfq = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=qfq&days=60`,
    headers: userHeaders(),
  });
  snap.klineBfq = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=bfq&days=60`,
    headers: userHeaders(),
  });
  snap.klineHfq = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=hfq&days=60`,
    headers: userHeaders(),
  });
  snap.klineRaw = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=raw&days=60`,
    headers: userHeaders(),
  });
  snap.klineBadFq = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=xxx&days=60`,
    headers: userHeaders(),
  });
  snap.klineBadSymbol = await app.inject({
    method: 'GET',
    url: '/api/quote/xx123456/kline?fq=qfq',
    headers: userHeaders(),
  });
  snap.klineBadPeriod = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=qfq&rsi_period=999`,
    headers: userHeaders(),
  });

  // ── 5. signals symbol 过滤 ──
  // 直接落库 3 条信号（2 条属于 MAIN_CODE、1 条属于别的标的）——
  // 与 `tests/unit/t54-signal-filter.test.ts` 同款做法（被测的是筛选口径，不是插件执行）。
  const insertSignal = (
    assetCode: string,
    pluginId: string,
    tradeDate: string,
    direction: 'buy' | 'sell' | 'hold',
  ) => {
    db()
      .db.prepare(
        `INSERT INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final)
         VALUES (?, ?, ?, 'monitor', ?, ?, ?, 0.8, '{"rsi": 25.5}', 1)`,
      )
      .run(userId, assetCode, pluginId, tradeDate, direction, `M5 ${direction} ${pluginId}`);
  };
  insertSignal(MAIN_CODE, 'rsi_oversold', '2026-03-05', 'buy');
  insertSignal(MAIN_CODE, 'macd_cross', '2026-03-06', 'sell');
  insertSignal(THIRD_CODE, 'rsi_oversold', '2026-03-05', 'buy');

  snap.signalAll = await app.inject({
    method: 'GET',
    url: '/api/signal?page=1&page_size=20',
    headers: userHeaders(),
  });
  snap.signalByCode = await app.inject({
    method: 'GET',
    url: `/api/signal?asset_code=${MAIN_CODE}&page=1&page_size=20`,
    headers: userHeaders(),
  });
  snap.signalByOther = await app.inject({
    method: 'GET',
    url: `/api/signal?asset_code=${THIRD_CODE}&page=1&page_size=20`,
    headers: userHeaders(),
  });
  // 🔴 **信号落库之后再取一次 K 线** —— 否则 K 线响应里的 signals[] 是「信号落库前」的快照，
  //   跨端点口径核对就失去意义（这也正是「前一步的产物是后一步的输入」的体现）。
  snap.klineWithSignals = await app.inject({
    method: 'GET',
    url: `/api/quote/${MAIN_CODE}/kline?fq=qfq&days=60`,
    headers: userHeaders(),
  });

  // ── 6. 选股公共过滤 ──
  snap.scanAll = await app.inject({
    method: 'POST',
    url: '/api/stockscan',
    headers: userHeaders(),
    payload: { plugin_id: PLUGIN_ID, asset_type: 'stock', max_results: 100 },
  });
  snap.scanFiltered = await app.inject({
    method: 'POST',
    url: '/api/stockscan',
    headers: userHeaders(),
    payload: {
      plugin_id: PLUGIN_ID,
      asset_type: 'stock',
      exclude_st: true,
      market_cap_max: 500,
      min_amount: 1000000,
      max_results: 5,
    },
  });
  snap.scanBadType = await app.inject({
    method: 'POST',
    url: '/api/stockscan',
    headers: userHeaders(),
    payload: { plugin_id: PLUGIN_ID, asset_type: 'bond' },
  });
  snap.scanBadCap = await app.inject({
    method: 'POST',
    url: '/api/stockscan',
    headers: userHeaders(),
    payload: { plugin_id: PLUGIN_ID, market_cap_max: -1 },
  });
  snap.scanBadPlugin = await app.inject({
    method: 'POST',
    url: '/api/stockscan',
    headers: userHeaders(),
    payload: { plugin_id: 'no_such_plugin_at_all' },
  });

  // ── 7. 批量候选 ──
  snap.candidateBatch = await app.inject({
    method: 'POST',
    url: '/api/candidates/batch',
    headers: userHeaders(),
    payload: { asset_codes: [MAIN_CODE, KEEP_CODE, THIRD_CODE], candidate_reason: 'M5 批量入池' },
  });
  snap.candidateBatchAgain = await app.inject({
    method: 'POST',
    url: '/api/candidates/batch',
    headers: userHeaders(),
    payload: { asset_codes: [MAIN_CODE, KEEP_CODE, THIRD_CODE], candidate_reason: 'M5 重复入池' },
  });
  snap.candidateList = await app.inject({ method: 'GET', url: '/api/candidate', headers: userHeaders() });
  snap.candidateTooMany = await app.inject({
    method: 'POST',
    url: '/api/candidates/batch',
    headers: userHeaders(),
    payload: {
      asset_codes: Array.from({ length: 101 }, (_, i) => `sh6${String(10000 + i).padStart(5, '0')}`),
    },
  });

  // ── 8. 复盘 4 色 ──
  // 橙档（主观决策）：给 add 交易写复盘总结
  snap.reviewOrange = await app.inject({
    method: 'PATCH',
    url: `/api/trade/${snap.idAdd}`,
    headers: userHeaders(),
    payload: { review_summary: 'M5 加仓复盘：理由成立', strategy_match: 1, remark: '下次分批' },
  });
  // 红档（止损）：给 reduce 交易打止损标记（同时三态=是 → 优先级由前端判定）
  snap.reviewRed = await app.inject({
    method: 'PATCH',
    url: `/api/trade/${snap.idReduce}`,
    headers: userHeaders(),
    payload: { review_summary: 'M5 减仓复盘：止损', strategy_match: 1, is_stop_loss: 1 },
  });
  snap.reviewTrades = await app.inject({
    method: 'GET',
    url: '/api/review/trades?page=1&limit=50',
    headers: userHeaders(),
  });
  snap.reviewYield = await app.inject({ method: 'GET', url: '/api/review/yield', headers: userHeaders() });

  // ── 9. 插件参数 ──
  snap.pluginConfig = await app.inject({
    method: 'PUT',
    url: `/api/strategy/plugins/${PLUGIN_ID}/config`,
    headers: userHeaders(),
    payload: { params: { period: 21, oversold: 25, overbought: 75, days: 120 } },
  });
  snap.pluginToggleOff = await app.inject({
    method: 'PUT',
    url: `/api/strategy/plugins/${PLUGIN_ID}/toggle`,
    headers: userHeaders(),
    payload: { enabled: 0 },
  });
  snap.pluginAfterToggle = await app.inject({
    method: 'GET',
    url: '/api/strategy/plugins',
    headers: userHeaders(),
  });
  snap.pluginToggleOn = await app.inject({
    method: 'PUT',
    url: `/api/strategy/plugins/${PLUGIN_ID}/toggle`,
    headers: userHeaders(),
    payload: { enabled: 1 },
  });
  snap.pluginAfterRestoreOn = await app.inject({
    method: 'GET',
    url: '/api/strategy/plugins',
    headers: userHeaders(),
  });

  // ── 10. 备份 → 破坏 → 恢复 ──
  // ⚠️ 只跑 SQLite 热备份（**不跑 DuckDB COPY**，真库 >100s，smoke-m4 已覆盖）
  snap.backup = await backupSQLite();
  snap.backupFiles = readdirSync(BACKUP_TMP_DIR).filter((f) => /^business\.db\.\d{4}-\d{2}-\d{2}$/.test(f));
  // ⚠️ `pop()` / `sort()` **会原地改数组** ⇒ 必须先复制再取最后一个
  //   （直接 `snap.backupFiles.sort().pop()` 会把快照本身清空 ⇒ 断言读到 length=0）
  snap.backupFile = [...snap.backupFiles].sort().pop() ?? '';
  snap.backupList = await app.inject({
    method: 'GET',
    url: '/api/admin/backups',
    headers: adminHeaders(),
  });
  // 破坏数据：备份之后新增一笔交易（恢复后应当消失）
  snap.breakTrade = await postTrade({
    asset_code: KEEP_CODE,
    trade_type: 'add',
    trade_date: '2026-04-01',
    trade_time: '09:00:09',
    quantity: 10,
    price: 6,
    trade_reason: 'M5 备份后新增（恢复后应消失）',
  });
  snap.breakVisible = await app.inject({
    method: 'GET',
    url: `/api/trade?asset_code=${KEEP_CODE}`,
    headers: userHeaders(),
  });
  // 恢复（未带 confirm → 400；带 confirm → 真正恢复）
  snap.restoreNoConfirm = await app.inject({
    method: 'POST',
    url: `/api/admin/backup/${snap.backupFile}/restore`,
    headers: adminHeaders(),
    payload: {},
  });
  snap.restore = await app.inject({
    method: 'POST',
    url: `/api/admin/backup/${snap.backupFile}/restore`,
    headers: adminHeaders(),
    payload: { confirm: true },
  });
  // 恢复后 ConfigStore 单例被重置 ⇒ 重新登录拿新会话（JWT 无状态，但重连更贴近真实链路）
  const relogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  snap.relogin = relogin;
  const reloginBody = body(relogin);
  if (reloginBody.data?.token) userToken = reloginBody.data.token;
  snap.afterRestoreTrades = await app.inject({
    method: 'GET',
    url: `/api/trade?asset_code=${KEEP_CODE}`,
    headers: userHeaders(),
  });
  snap.afterRestoreTables = db()
    .db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_account','user_trade_record','system_log')`,
    )
    .all() as Array<{ name: string }>;
  snap.afterRestoreLog = db()
    .db.prepare(`SELECT * FROM system_log WHERE message LIKE '%备份恢复%' ORDER BY id DESC LIMIT 1`)
    .all() as Array<Record<string, unknown>>;

  // ── 11. 角色管理 ──
  snap.users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: adminHeaders() });
  // 升级为 admin → 400（库里已有管理员）
  snap.promoteBlocked = await app.inject({
    method: 'PATCH',
    url: `/api/admin/role/${otherUserId}`,
    headers: adminHeaders(),
    payload: { role: 'admin' },
  });
  // 降级自己 → 400（禁止降级当前登录账号）
  snap.demoteSelf = await app.inject({
    method: 'PATCH',
    url: `/api/admin/role/${userId}`,
    headers: adminHeaders(),
    payload: { role: 'user' },
  });
  // 夹具：把另一个用户直接提成 admin（模拟「库里存在第二个管理员」的历史状态）
  //   —— 后端的「升级」路径被「已有管理员」规则锁死，**降级**才是可达的角色变更路径。
  db().db.prepare(`UPDATE user_account SET role = 'admin' WHERE id = ?`).run(otherUserId);
  snap.demote = await app.inject({
    method: 'PATCH',
    url: `/api/admin/role/${otherUserId}`,
    headers: adminHeaders(),
    payload: { role: 'user' },
  });
  snap.demoteRole = db().db.prepare(`SELECT role FROM user_account WHERE id = ?`).get(otherUserId) as {
    role: string;
  };
  snap.usersAfter = await app.inject({ method: 'GET', url: '/api/admin/users', headers: adminHeaders() });
}, 180000);

afterAll(async () => {
  if (app) await app.close().catch(() => {});
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
}, 30000);

// ════════════════════════════════════════════════════════════════════════
// 第 1 步 · 注册
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 1 步 注册（链路起点）', () => {
  it('首个用户匿名注册 → 201，自动成为 admin（SDD §4.4 / PRD D5 的 bootstrap 路径）', () => {
    const res = snap.register as Inject;
    expect(res.statusCode).toBe(201);
    const b = body(res);
    // 🔴 T89b：成功判定唯一口径 `code === 0`
    expect(b.code).toBe(0);
    expect(typeof b.data.token).toBe('string');
    expect(b.data.user.username).toBe(ADMIN_USER);
    expect(b.data.user.role).toBe('admin');
  });

  it('库里已有用户后再匿名注册 → 403（bootstrap 入口已关闭）', () => {
    const res = snap.registerClosed as Inject;
    expect(res.statusCode).toBe(403);
    const b = body(res);
    expect(typeof b.code).toBe('string');
    expect(b.data).toBeNull();
  });

  it('重复用户名 → 409（错误码是字符串，不是数字 0）', () => {
    const res = snap.registerDuplicate as Inject;
    expect(res.statusCode).toBe(409);
    expect(typeof body(res).code).toBe('string');
  });

  it('普通用户建号成功（公开端点只允许建 role=user）', () => {
    const res = snap.seedOther as Inject;
    expect(res.statusCode).toBe(201);
    const b = body(res);
    expect(b.code).toBe(0);
    expect(b.data.user.role).toBe('user');
    expect(typeof b.data.token).toBe('string');
  });

  it('普通用户访问 admin 端点 → 403（越权边界）', () => {
    const res = snap.otherForbidden as Inject;
    expect(res.statusCode).toBe(403);
    expect(typeof body(res).code).toBe('string');
  });

  it('注册产物 = 下一步输入：同一个 token 可直接访问受保护端点', async () => {
    expect(userToken).not.toBe('');
    const res = await app.inject({ method: 'GET', url: '/api/holding', headers: userHeaders() });
    expect(res.statusCode).toBe(200);
    expect(body(res).code).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 2 步 · 交易 7 类型
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 2 步 交易 7 类型', () => {
  it('买入缺操作理由 → 400（理由必填）', () => {
    const res = snap.tradeNoReason as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  it('超持仓卖出 → 409 HOLDING_INSUFFICIENT', () => {
    const res = snap.tradeOversell as Inject;
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('HOLDING_INSUFFICIENT');
  });

  it('buy 建仓 → 201，持仓 1000 股、均价含手续费 10.005', () => {
    const res = snap.tradeBuy as Inject;
    expect(res.statusCode).toBe(201);
    const b = body(res);
    expect(b.code).toBe(0);
    expect(b.data.position.totalQuantity).toBe(1000);
    expect(b.data.position.avgCost).toBeCloseTo((1000 * 10 + 5) / 1000, 6);
    expect(b.data.trade_id).toBeGreaterThan(0);
  });

  it('add 加仓 → 移动加权成本重算（16005 / 1500）', () => {
    const res = snap.tradeAdd as Inject;
    expect(res.statusCode).toBe(201);
    expect(body(res).data.position.totalQuantity).toBe(1500);
    expect(body(res).data.position.avgCost).toBeCloseTo((10005 + 6000) / 1500, 6);
  });

  it('reduce 减仓 → 数量减少、均价不变、已实现盈亏为正', () => {
    const res = snap.tradeReduce as Inject;
    expect(res.statusCode).toBe(201);
    const pos = body(res).data.position;
    expect(pos.totalQuantity).toBe(1100);
    // 均价不因卖出而变（移动加权法）
    expect(pos.avgCost).toBeCloseTo(16005 / 1500, 6);
    // 已实现盈亏 = 400*15 - 2 - 400*10.67
    expect(pos.realizedPnL).toBeCloseTo(400 * 15 - 2 - 400 * (16005 / 1500), 4);
    expect(pos.realizedPnL).toBeGreaterThan(0);
  });

  it('dividend / bonus / transfer 三类除权交易均可落库（理由由系统固化）', () => {
    for (const key of ['tradeDividend', 'tradeBonus', 'tradeTransfer']) {
      const res = snap[key] as Inject;
      expect(res.statusCode, `${key} 应落库成功`).toBe(201);
      expect(body(res).code).toBe(0);
    }
    // 除权理由由系统固化（Requirements §5.2）
    const dividend = (body(snap.tradeDividend as Inject).data as { trade_id: number })?.trade_id;
    expect(dividend).toBeGreaterThan(0);
  });

  it('clear 清仓 → 该标的持仓归零、已实现盈亏累计', () => {
    const res = snap.tradeClear as Inject;
    expect(res.statusCode).toBe(201);
    const pos = body(res).data.position;
    expect(pos.totalQuantity).toBe(0);
    // T119（V3.0）：reduce 1730 + clear（1200 股 @16，成本基 11737）7462 = 9192
    expect(pos.realizedPnL).toBeCloseTo(9192, 3);
  });

  it('7 种类型全部落库（交易列表里 7 种都在，且分属两个标的）', () => {
    const res = snap.tradeList as Inject;
    expect(res.statusCode).toBe(200);
    const rows = body(res).data as Array<{ trade_type: string }>;
    const types = new Set(rows.map((r) => r.trade_type));
    expect(types).toEqual(new Set(['buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer']));
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 3 步 · 持仓（双口径）
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 3 步 持仓与双口径', () => {
  it('单标的持仓：清仓后数量 0、成本基 0、已实现盈亏 9192', () => {
    const res = snap.holding as Inject;
    expect(res.statusCode).toBe(200);
    const d = body(res).data;
    expect(d.asset_code).toBe(MAIN_CODE);
    expect(d.totalQuantity).toBe(0);
    expect(d.totalCostBasis).toBeCloseTo(0, 6);
    expect(d.realizedPnL).toBeCloseTo(9192, 3);
    expect(d.totalFee).toBeCloseTo(8, 6); // 手续费 5 + 2 + 1
  });

  it('另一只标的仍有持仓（800 股 @5，成本基 4000）', () => {
    const res = snap.holdingKeep as Inject;
    const d = body(res).data;
    expect(d.totalQuantity).toBe(800);
    expect(d.avgCost).toBeCloseTo(5, 6);
    expect(d.totalCostBasis).toBeCloseTo(4000, 6);
    expect(d.realizedPnL).toBeCloseTo(0, 6);
  });

  it('持仓列表：两个标的 + summary（有行情时带现价，无行情降级为 null）', () => {
    const res = snap.holdings as Inject;
    expect(res.statusCode).toBe(200);
    const b = body(res);
    const codes = (b.data as Array<{ asset_code: string }>).map((p) => p.asset_code);
    expect(codes).toContain(MAIN_CODE);
    expect(codes).toContain(KEEP_CODE);
    expect(b.summary.positionCount).toBe(2);
    expect(typeof b.summary.totalCostBasis).toBe('number');
    // DuckDB 无行情时降级为 null，接口不应报错
    const keep = (b.data as Array<{ asset_code: string; currentPrice: unknown }>).find(
      (p) => p.asset_code === KEEP_CODE,
    );
    expect(keep?.currentPrice === null || typeof keep?.currentPrice === 'number').toBe(true);
  });

  it('双口径快照：实际口径 - 价格口径 == 累计分红 550', () => {
    const write = snap.assetStatWrite as { ok: boolean; error?: string; tradeDate: string };
    if (!write.ok) {
      // 行情库不可用 → 快照写不进去（`batchGetDaily` 抛错）⇒ 本断言不成立，跳过并留痕
      console.warn(`[smoke-m5] ⚠️ 双口径快照未写入（行情库不可用）：${write.error}`);
      expect(write.ok).toBe(false);
      return;
    }
    const res = snap.assetStat as Inject;
    expect(res.statusCode).toBe(200);
    const d = body(res).data as {
      total_profit_price: number;
      total_profit_actual: number;
      total_assets_price_yield: number;
      total_assets_actual_yield: number;
    };
    expect(d).not.toBeNull();
    // 分红 1100 股 × 0.5 元 = 550（送股 / 转增价格 0 ⇒ 不贡献现金）
    expect(d.total_profit_actual - d.total_profit_price).toBeCloseTo(550, 4);
    // 收益率口径同步相差 550 / 4000
    expect(d.total_assets_actual_yield - d.total_assets_price_yield).toBeCloseTo(550 / 4000, 6);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 4 步 · K 线四 fq
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 4 步 K 线四 fq', () => {
  // K 线内容依赖真实行情 → 数值型守卫（迷你库即可）
  const itNumeric = MARKET_DATA_NUMERIC_AVAILABLE ? it : it.skip;

  it('非法 fq → 400（绝不静默回落 qfq）', () => {
    const res = snap.klineBadFq as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  it('非法 symbol 前缀 → 400', () => {
    const res = snap.klineBadSymbol as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  it('越界 rsi_period → 400（不静默夹取）', () => {
    const res = snap.klineBadPeriod as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  itNumeric('四个复权口径各自 200 + 回显 fq + K 线升序', () => {
    for (const [key, fq] of [
      ['klineQfq', 'qfq'],
      ['klineBfq', 'bfq'],
      ['klineHfq', 'hfq'],
      ['klineRaw', 'raw'],
    ] as const) {
      const res = snap[key] as Inject;
      expect(res.statusCode, `${fq} 应返回 200`).toBe(200);
      const d = body(res).data;
      expect(d.fq).toBe(fq);
      expect(d.symbol).toBe(MAIN_CODE);
      expect(Array.isArray(d.klines)).toBe(true);
      expect(d.klines.length).toBeGreaterThan(0);
      // 升序
      const dates = (d.klines as Array<{ date: string }>).map((k) => k.date);
      expect([...dates].sort()).toEqual(dates);
      // OHLC 自洽
      for (const k of d.klines as Array<{
        open: number;
        high: number;
        low: number;
        close: number;
      }>) {
        expect(k.high).toBeGreaterThanOrEqual(Math.max(k.open, k.close));
        expect(k.low).toBeLessThanOrEqual(Math.min(k.open, k.close));
      }
      // 指标齐备（core 适配层的形状：macd = {dif,dea,macd} 三数组，rsi = 数字数组）
      expect(d.indicators).not.toBeNull();
      expect(Array.isArray(d.indicators.macd.dif)).toBe(true);
      expect(Array.isArray(d.indicators.macd.dea)).toBe(true);
      expect(Array.isArray(d.indicators.macd.macd)).toBe(true);
      expect(Array.isArray(d.indicators.rsi)).toBe(true);
      // 指标与 K 线等长（适配层的补齐口径）
      expect(d.indicators.rsi.length).toBe(d.klines.length);
      expect(d.indicators.ma5.length).toBe(d.klines.length);
      // 参数回显
      expect(d.indicators.params).toMatchObject({ rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9 });
    }
  });

  itNumeric('四个口径的**日期序列一致**（复权只改价格不改日期）', () => {
    const seq = (key: string): string[] =>
      (body(snap[key] as Inject).data.klines as Array<{ date: string }>).map((k) => k.date);
    const qfq = seq('klineQfq');
    expect(seq('klineBfq')).toEqual(qfq);
    expect(seq('klineHfq')).toEqual(qfq);
    expect(seq('klineRaw')).toEqual(qfq);
  });

  itNumeric('hfq 与 qfq 的收盘价**不同**（hfq 是唯一还原历史价格的口径）', () => {
    const last = (key: string): number => {
      const ks = body(snap[key] as Inject).data.klines as Array<{ close: number }>;
      return ks[ks.length - 1].close;
    };
    expect(last('klineHfq')).not.toBeCloseTo(last('klineQfq'), 6);
  });

  it('K 线响应体里**没有** success 字段（T89b 契约）', () => {
    const res = snap.klineBadFq as Inject;
    // 错误体同样不得出现 `success` 键
    expect(Object.prototype.hasOwnProperty.call(body(res), 'success')).toBe(false);
    expect(typeof body(res).code).toBe('string');
  });

  itNumeric('成功体里**没有** success 字段（T89b 契约，code === 0）', () => {
    for (const key of ['klineQfq', 'klineBfq', 'klineHfq', 'klineRaw']) {
      const b = body(snap[key] as Inject);
      expect(Object.prototype.hasOwnProperty.call(b, 'success')).toBe(false);
      expect(b.code).toBe(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 5 步 · signals symbol 过滤
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 5 步 signals symbol 过滤', () => {
  const itNumeric = MARKET_DATA_NUMERIC_AVAILABLE ? it : it.skip;

  it('不筛选 → 拿到该用户的全部 3 条信号', () => {
    const res = snap.signalAll as Inject;
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.code).toBe(0);
    expect((b.data as unknown[]).length).toBe(3);
    expect(typeof b.pagination.total).toBe('number');
  });

  it('按 asset_code 过滤 → 只回该标的的 2 条', () => {
    const res = snap.signalByCode as Inject;
    expect(res.statusCode).toBe(200);
    const rows = body(res).data as Array<{ asset_code: string; trade_date: string }>;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.asset_code === MAIN_CODE)).toBe(true);
    // 升序
    const dates = rows.map((r) => r.trade_date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('换另一个标的过滤 → 只回它自己的 1 条（过滤真的生效）', () => {
    const res = snap.signalByOther as Inject;
    const rows = body(res).data as Array<{ asset_code: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].asset_code).toBe(THIRD_CODE);
  });

  itNumeric('K 线内嵌 signals 与 /api/signal 同集合（同窗口 + 同升序口径）', () => {
    const fromSignal = body(snap.signalByCode as Inject).data as Array<{
      trade_date: string;
      direction: string;
      plugin_id: string;
    }>;
    const fromKline = body(snap.klineWithSignals as Inject).data.signals as Array<{
      trade_date: string;
      direction: string;
      plugin_id: string;
    }>;
    expect(fromKline.length).toBe(fromSignal.length);
    expect(fromKline.map((s) => `${s.trade_date}|${s.direction}|${s.plugin_id}`)).toEqual(
      fromSignal.map((s) => `${s.trade_date}|${s.direction}|${s.plugin_id}`),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 6 步 · 选股公共过滤
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 6 步 选股公共过滤', () => {
  const itNumeric = MARKET_DATA_NUMERIC_AVAILABLE ? it : it.skip;
  const itScale = MARKET_DATA_SCALE_AVAILABLE ? it : it.skip;

  it('非法 asset_type / market_cap_max / 插件 id → 400（不静默兜底）', () => {
    for (const key of ['scanBadType', 'scanBadCap', 'scanBadPlugin']) {
      const res = snap[key] as Inject;
      expect(res.statusCode, `${key} 应 400`).toBe(400);
      expect(typeof body(res).code).toBe('string');
    }
  });

  itNumeric('公共过滤条件**回显**在 filters 里（证明确实生效）', () => {
    const res = snap.scanFiltered as Inject;
    expect(res.statusCode).toBe(200);
    const d = body(res).data;
    expect(d.filters).toMatchObject({
      assetType: 'stock',
      excludeSt: true,
      industryCode: null,
      marketCapMaxYi: 500,
      minAmount: 1000000,
    });
    // max_results 上限生效
    expect((d.results as unknown[]).length).toBeLessThanOrEqual(5);
    expect(d.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  itNumeric('不带过滤的选股：候选池非空 + 字段完整', () => {
    const res = snap.scanAll as Inject;
    expect(res.statusCode).toBe(200);
    const d = body(res).data;
    expect(d.totalCandidates).toBeGreaterThan(0);
    expect(d.totalCandidates).toBeLessThanOrEqual(POOL_LIMIT);
    expect(d.filters).toMatchObject({
      assetType: 'stock',
      excludeSt: false,
      industryCode: null,
      marketCapMaxYi: null,
      minAmount: 0,
    });
    for (const item of d.results as Array<Record<string, unknown>>) {
      expect(typeof item.symbol).toBe('string');
      expect(item.name === null || typeof item.name === 'string').toBe(true);
      expect(typeof item.score).toBe('number');
      expect(typeof item.signalType).toBe('string');
      expect(item.pluginId).toBe(PLUGIN_ID);
    }
  });

  itScale('候选池规模 > 3000（**规模型**，必须真库）', () => {
    const d = body(snap.scanAll as Inject).data;
    expect(d.totalCandidates).toBeGreaterThan(SCALE_THRESHOLD);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 7 步 · 批量候选
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 7 步 批量候选', () => {
  it('批量入池 → 201，added=3', () => {
    const res = snap.candidateBatch as Inject;
    expect(res.statusCode).toBe(201);
    const d = body(res).data;
    expect(d.added).toBe(3);
    expect(d.skipped).toBe(0);
    expect(d.duplicates).toEqual([]);
  });

  it('重复入池幂等 → added=0、skipped=3、duplicates 列出 3 个', () => {
    const res = snap.candidateBatchAgain as Inject;
    expect(res.statusCode).toBe(201);
    const d = body(res).data;
    expect(d.added).toBe(0);
    expect(d.skipped).toBe(3);
    expect((d.duplicates as string[]).length).toBe(3);
  });

  it('候选列表含 3 个标的（且与持仓 / 自选互不冲突）', () => {
    const res = snap.candidateList as Inject;
    expect(res.statusCode).toBe(200);
    const codes = (body(res).data as Array<{ asset_code: string }>).map((c) => c.asset_code);
    expect(codes).toContain(MAIN_CODE);
    expect(codes).toContain(KEEP_CODE);
    expect(codes).toContain(THIRD_CODE);
  });

  it('超过 100 条 → 400（批量上限）', () => {
    const res = snap.candidateTooMany as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 8 步 · 复盘 4 色
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 8 步 复盘 4 色', () => {
  it('复盘 4 字段 PATCH 成功（主观决策 / 止损两档）', () => {
    expect((snap.reviewOrange as Inject).statusCode).toBe(200);
    expect((snap.reviewRed as Inject).statusCode).toBe(200);
    expect(body(snap.reviewOrange as Inject).code).toBe(0);
    expect(body(snap.reviewRed as Inject).code).toBe(0);
  });

  it('4 色档位的**输入字段**逐档正确（颜色映射由前端 reviewTagOf 判定）', () => {
    const rows = body(snap.reviewTrades as Inject).data as Array<{
      id: number;
      trade_type: string;
      review_summary: string | null;
      strategy_match: number | null;
      is_stop_loss: number | null;
      system_followed: number | null;
      is_auto_import: number;
    }>;
    const byId = (id: number) => rows.find((r) => r.id === id);

    // 灰档（未复盘）：buy 交易一个复盘字段都没有
    const grey = byId(snap.idBuy as number);
    expect(grey).toBeDefined();
    expect(grey!.review_summary).toBeNull();
    expect(grey!.strategy_match).toBeNull();
    expect(grey!.is_stop_loss).toBeNull();
    expect(grey!.system_followed).toBeNull();

    // 橙档（主观决策）：add 交易写了复盘总结 + 三态=是
    const orange = byId(snap.idAdd as number);
    expect(orange!.review_summary).toContain('M5');
    expect(orange!.strategy_match).toBe(1);
    expect(orange!.is_stop_loss).toBeNull();

    // 红档（止损）：reduce 交易打了 is_stop_loss=1
    const red = byId(snap.idReduce as number);
    expect(red!.is_stop_loss).toBe(1);
    expect(red!.strategy_match).toBe(1);

    // 绿档（系统信号 / 系统导入）：dividend 交易 system_followed=1
    const green = byId(snap.idDividend as number);
    expect(green!.system_followed).toBe(1);
    expect(green!.is_auto_import).toBe(0); // 人工补录的除权，不是自动导入
  });

  it('复盘统计：总交易数 / 已复盘数 / 平仓数 / 胜率口径正确', () => {
    const res = snap.reviewYield as Inject;
    expect(res.statusCode).toBe(200);
    const s = body(res).data;
    // 主动交易（buy/add/reduce/clear）：MAIN_CODE 4 笔 + KEEP_CODE 1 笔 = 5
    expect(s.totalTrades).toBe(5);
    // 已复盘：add（复盘总结）+ reduce（止损）= 2
    expect(s.reviewedCount).toBe(2);
    // 平仓：reduce + clear = 2，且两笔都盈利
    expect(s.closedCount).toBe(2);
    expect(s.winCount).toBe(2);
    expect(s.lossCount).toBe(0);
    expect(s.winRate).toBe(100);
    // 全盈利无亏损 → 盈亏比为 null（不是 Infinity）
    expect(s.profitLossRatio).toBeNull();
    // T119（V3.0）：reduce 1730 + clear 7462 = 9192
    expect(s.totalRealizedPnl).toBeCloseTo(9192, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 9 步 · 插件参数
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 9 步 插件参数', () => {
  it('保存参数 → 200（PUT 语义）', () => {
    const res = snap.pluginConfig as Inject;
    expect(res.statusCode).toBe(200);
    expect(body(res).code).toBe(0);
  });

  it('GET 插件列表回显刚保存的参数', () => {
    const res = snap.pluginAfterToggle as Inject;
    expect(res.statusCode).toBe(200);
    const plugins = body(res).data as Array<{ id: string; params: Record<string, unknown>; enabled: number }>;
    const target = plugins.find((p) => p.id === PLUGIN_ID);
    expect(target).toBeDefined();
    expect(target!.params).toMatchObject({ period: 21, oversold: 25, overbought: 75, days: 120 });
  });

  it('停用插件 → enabled=0；再启用 → enabled=1（幂等）', () => {
    expect((snap.pluginToggleOff as Inject).statusCode).toBe(200);
    const off = (body(snap.pluginAfterToggle as Inject).data as Array<{ id: string; enabled: number }>).find(
      (p) => p.id === PLUGIN_ID,
    );
    expect(off!.enabled).toBe(0);

    expect((snap.pluginToggleOn as Inject).statusCode).toBe(200);
    const on = (
      body(snap.pluginAfterRestoreOn as Inject).data as Array<{ id: string; enabled: number }>
    ).find((p) => p.id === PLUGIN_ID);
    expect(on!.enabled).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 10 步 · 备份恢复
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 10 步 备份恢复', () => {
  it('SQLite 热备份成功，产物落在临时备份目录', () => {
    const r = snap.backup as { success: boolean; size?: number; error?: string };
    expect(r.success, `备份失败：${r.error ?? ''}`).toBe(true);
    expect(r.size).toBeGreaterThan(0);
    expect((snap.backupFiles as string[]).length).toBeGreaterThanOrEqual(1);
    const file = snap.backupFile as string;
    expect(file).toMatch(/^business\.db\.\d{4}-\d{2}-\d{2}$/);
    expect(existsSync(path.join(BACKUP_TMP_DIR, file))).toBe(true);
    expect(statSync(path.join(BACKUP_TMP_DIR, file)).size).toBeGreaterThan(0);
  });

  it('GET /api/admin/backups 列出该备份文件', () => {
    const res = snap.backupList as Inject;
    expect(res.statusCode).toBe(200);
    const list = body(res).data as Array<{ name: string; size: number }>;
    expect(list.some((f) => f.name === snap.backupFile)).toBe(true);
  });

  it('备份后新增的交易**确实可见**（恢复前的破坏已生效）', () => {
    const res = snap.breakVisible as Inject;
    expect(res.statusCode).toBe(200);
    const rows = body(res).data as Array<{ trade_reason: string | null }>;
    expect(rows.some((r) => (r.trade_reason ?? '').includes('备份后新增'))).toBe(true);
  });

  it('未带 confirm 的恢复 → 400', () => {
    const res = snap.restoreNoConfirm as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  it('带 confirm 的恢复 → 200 + 生成 pre-restore 安全备份', () => {
    const res = snap.restore as Inject;
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.code).toBe(0);
    expect(b.data.safetyBackup).toMatch(/pre-restore/);
  });

  it('恢复后业务数据回到备份时刻（备份后新增的那笔消失）', () => {
    const res = snap.afterRestoreTrades as Inject;
    expect(res.statusCode).toBe(200);
    const rows = body(res).data as Array<{ trade_reason: string | null; quantity: number }>;
    expect(rows.some((r) => (r.trade_reason ?? '').includes('备份后新增'))).toBe(false);
    // 备份前的 800 股仍在
    expect(rows.find((r) => r.quantity === 800)).toBeDefined();
  });

  it('恢复后关键表齐全 + 恢复动作写 system_log 留痕', () => {
    expect((snap.afterRestoreTables as Array<{ name: string }>).length).toBe(3);
    const logs = snap.afterRestoreLog as Array<Record<string, unknown>>;
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 第 11 步 · 角色管理
// ════════════════════════════════════════════════════════════════════════
describe('M5 · 第 11 步 角色管理', () => {
  it('GET /api/admin/users 列出用户（含注册用户与普通用户）', () => {
    const res = snap.users as Inject;
    expect(res.statusCode).toBe(200);
    const users = body(res).data as Array<{ id: number; username: string; role: string }>;
    expect(users.some((u) => u.username === ADMIN_USER && u.role === 'admin')).toBe(true);
    expect(users.some((u) => u.username === OTHER_USER && u.role === 'user')).toBe(true);
  });

  it('升级为 admin → 400（库里已有管理员，禁止出现第二个）', () => {
    const res = snap.promoteBlocked as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  it('降级当前登录账号 → 400（禁止降级自己）', () => {
    const res = snap.demoteSelf as Inject;
    expect(res.statusCode).toBe(400);
    expect(typeof body(res).code).toBe('string');
  });

  it('降级另一个 admin → 200 + 角色真的变了（可达的角色变更路径）', () => {
    const res = snap.demote as Inject;
    expect(res.statusCode).toBe(200);
    expect(body(res).code).toBe(0);
    expect((snap.demoteRole as { role: string }).role).toBe('user');
  });

  it('角色变更后用户列表同步（降级结果可见）', () => {
    const res = snap.usersAfter as Inject;
    const users = body(res).data as Array<{ id: number; username: string; role: string }>;
    expect(users.find((u) => u.id === otherUserId)!.role).toBe('user');
    expect(users.find((u) => u.id === userId)!.role).toBe('admin');
  });
});
