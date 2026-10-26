/**
 * T67 Dashboard 配套（后端）—— ① `/api/holding` enrich ② 今日信号批量工具 ③ 除权导入读端点 ④ 今日信号统计端点
 *
 * ── 为什么要这个文件 ──
 *   T67 卡片（plan §5 T67 ③⑦）明确要求后端配套四件事：
 *     ③ 持仓卡「信号标记」→ 需后端在持仓接口 enrich（建议 A：批量 IN 查信号）
 *     ⑦ 今日动态概览卡 → 需后端 enrich 加「昨收」+ signals 加「今日 count」
 *     ⑦ 今日除权导入 → 全仓无读取端点（只有 admin-only 的 system-log）→ 新增只读端点
 *     ⑦ 今日信号 ▲▼· → `/api/signal` 是分页接口，前端自数会漏 → 新增 1 次 GROUP BY 的统计端点
 *   本文件把这四件事的**契约**钉死（只加不改 + 降级不 500 + 不 N+1）。
 *
 * ── 测试策略（**不依赖真实行情库**）──
 *   DuckDB 层用 `vi.mock` 拦截 `src/db/duckdb.js` 的 `queryDuckDB`：
 *     ① 可以**构造**任意条数的日线 → 精确断言「昨收 = 倒数第二条」；
 *     ② 可以**计数** DuckDB 往返次数 → 断言「批量取数确实是一批」；
 *     ③ CI 环境只有 12KB 空壳行情库 → 本文件**不需要** `MARKET_DATA_AVAILABLE` 守卫，
 *        全部用例在 CI 也能跑（不产生「本地绿 / CI 红」的假象）。
 *   另有一个 **真实行情库交叉验证**用例（`MARKET_DATA_AVAILABLE` 守卫），
 *   把假数据的结论在真库上再验一遍（实测口径，AGENTS.md「权威来源只有实测」）。
 *
 * ── SQLite 隔离 ──
 *   `mkdtempSync` 临时库 + 覆盖 `SQLITE_DB_PATH`（必须在 import ConfigStore 之前）。
 *   ⚠️ **不覆盖 `DUCKDB_PATH`**：本文件 mock 掉了 duckdb 模块（应用代码不会真开库），
 *     而真实行情交叉验证用例要用环境里的真库路径；覆盖它会让本地也误判为「无行情库」。
 *
 * ── 日期一律**运行时派生** ──
 *   写死 '2026-10-20' 会造出定时炸弹（跑测当天恰好相等才通过，过了那天永久红）。
 *   ⇒ 「今天/昨天」一律由 `getTradeDate()`（东八区）算出。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../src/services/auth.js';
import { marketDataTier } from '../_marketData.js';

/** 真实行情库是否可用（顶层 await 判定一次） */
// 🔴 2026-10-21 **两层开关**：本文件用例全是**数值型**断言（价格 / 昨收 / 落库口径），
//    迷你库（真库的逐位一致子集）即可满足 → 用 `numeric` 能力守卫。
// ⚠️ 本文件**不需要** `MARKET_DATA_AVAILABLE` 守卫（主体用例用 mock 行情）；
//   只有「**真实行情库**交叉验证」那两个 describe 需要，用的是
//   `marketDataTier() === 'full'`（**不是** `MARKET_DATA_AVAILABLE`：
//   迷你库也是行情库、数值型能力为 true，但**真库专属**的断言在迷你库上不成立）。

// ── SQLite 隔离（必须在 import ConfigStore 之前设置）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t67-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't67.db');

/**
 * 假行情数据（构造日线序列，按日期**倒序**排列 → 倒数第一条 = 最新，倒数第二条 = 昨收）
 *
 * ⚠️ 条数刻意各不相同，覆盖「多根 / 两根 / 一根 / 没有」四种边界：
 *   - 3 根 → 有昨收
 *   - 2 根 → 有昨收（只有 1 根日线时无昨收）
 *   - 1 根 → **无昨收**（prevClose = null）
 *   - 0 根 → 无行情（currentPrice = null, prevClose = null）
 */
const H = vi.hoisted(() => {
  const bars: Record<string, Array<{ date: string; close: number }>> = {
    sh600001: [
      { date: '2026-10-12', close: 12.0 },
      { date: '2026-10-09', close: 11.0 },
      { date: '2026-10-08', close: 10.0 },
    ],
    sh600002: [
      { date: '2026-10-12', close: 22.5 },
      { date: '2026-10-09', close: 21.0 },
    ],
    sh600003: [{ date: '2026-10-12', close: 33.3 }],
    // sh600004 故意**没有**日线 → 无行情
  };
  /**
   * 假名称表（`raw_symbol_name` 的替身）
   *
   * ⚠️ **只覆盖 2 只** —— 刻意复刻真实库的「覆盖率约 70%，查不到是常态」
   *   （真库实测：`raw_symbol_name` 8726 行 vs `raw_symbol_class` 12449 行）。
   *   未命中的标的 → `name = null`（接口仍 200）。
   *
   * ⚠️ `sh600000 → 浦发银行` 是**真库实测值**（2026-10-20），
   *   与卡 1 的 A2 断言字面一致；`sh600002` 的名字是**纯假数据**
   *   （真库上 sh600002 反而查不到名 —— 缺失是常态）。
   */
  const names: Record<string, string> = {
    sh600000: '浦发银行',
    sh600002: '示例银行',
  };
  return {
    bars,
    names,
    /** 切到真实 DuckDB（真实行情交叉验证用例用） */
    useReal: { value: false },
    /** 让 queryDuckDB 直接抛错（DuckDB 不可用的降级用例） */
    failDuckDb: { value: false },
    /** 让信号查询直接抛错（SQLite 侧降级用例） */
    failSignalDb: { value: false },
  };
});

/**
 * mock `src/db/duckdb.js`
 *
 * 只拦 `queryDuckDB`（唯一出口），其余导出透传真实实现。
 * 假实现复刻两类查询的语义：
 *   ① `batchGetLatestAndPrevClose` 的窗口函数：按 symbol 分区、按 date 倒序编号 rn，取 rn <= 2；
 *   ② `batchGetSymbolNames` 的 IN 查询：`FROM raw_symbol_name WHERE symbol IN (...)`。
 *
 * 🔴 **2026-10-21（Wave 8 / T60）随实现调整**：批量取价从「打 `v_stock_qfq` **视图**」
 *   改成「**基表 + `symbol IN (…)` 下推**」（T60c 卡片 ① 的补做；
 *   视图口径实测 30 只标的 3.5–3.9s ⇒ PE4 的 200ms 门槛不可达）⇒
 *   ① SQL 文本变了（窗口函数从 `PARTITION BY symbol` 变成 `PARTITION BY s.symbol`）
 *   ② qfq 口径下 **CTE 与主查询各绑定一次**标的列表 ⇒ `params` 里同一批标的出现**两遍**
 *   ⇒ 假实现改为：① 用「语义标记」识别查询（`ROW_NUMBER() OVER` + `raw_kline_daily`，
 *     不再匹配脆弱的整段 SQL 文本）② 按**去重后**的标的集合造数（语义与改前完全一致）。
 */
vi.mock('../../src/db/duckdb.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/duckdb.js')>();

  /** 假 queryDuckDB：只认「按 symbol 分区取最近 N 根日线」的窗口查询 */
  function fakeQuery(sql: string, params?: unknown[]): Array<Record<string, unknown>> {
    // ② 名称批量查询（1 次 IN）
    if (sql.includes('FROM raw_symbol_name')) {
      const symbols = (params ?? []).map((p) => String(p));
      const rows: Array<Record<string, unknown>> = [];
      for (const symbol of symbols) {
        const name = H.names[symbol];
        // 查不到 → 不返回该行（调用方 Map 里没有 → name = null）
        if (name !== undefined) rows.push({ symbol, name });
      }
      return rows;
    }
    // ① 批量取价（窗口函数）—— 用**语义标记**识别，不匹配整段 SQL 文本
    if (!sql.includes('ROW_NUMBER() OVER') || !sql.includes('raw_kline_daily')) {
      throw new Error(`t67 测试：未预期的 DuckDB 查询 → ${sql.slice(0, 120)}`);
    }
    // ⚠️ qfq 口径下同一批标的被绑定两次（CTE + 主查询）⇒ 去重
    const symbols = Array.from(new Set((params ?? []).map((p) => String(p))));
    const rows: Array<Record<string, unknown>> = [];
    for (const symbol of symbols) {
      const list = [...(H.bars[symbol] ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1));
      list.forEach((bar, idx) => {
        if (idx < 2) rows.push({ symbol, date: bar.date, close: bar.close, rn: idx + 1 });
      });
    }
    return rows;
  }

  return {
    ...actual,
    queryDuckDB: vi.fn(async (sql: string, params?: unknown[]) => {
      if (H.failDuckDb.value) throw new Error('t67 测试：模拟 DuckDB 不可用');
      if (H.useReal.value) return actual.queryDuckDB(sql, params);
      return fakeQuery(sql, params);
    }),
  };
});

/**
 * mock `src/services/todaySignals.js`
 *
 * 只包一层 `getLatestSignalsByAssets`，用于制造「信号查询抛错」的降级场景
 * （持仓接口必须仍返回 200 且 signal=null）。
 * 其余导出透传真实实现 —— 测试自己直接调用的也是真实逻辑。
 */
vi.mock('../../src/services/todaySignals.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/todaySignals.js')>();
  return {
    ...actual,
    getLatestSignalsByAssets: vi.fn(async (userId: number, assetCodes: string[]) => {
      if (H.failSignalDb.value) throw new Error('t67 测试：模拟信号查询失败');
      return actual.getLatestSignalsByAssets(userId, assetCodes);
    }),
  };
});

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerTradeRoutes } = await import('../../src/routes/trade.js');
const { registerExDividendRoutes } = await import('../../src/routes/exDividend.js');
const { registerSignalRoutes } = await import('../../src/routes/signal.js');
const { getLatestSignalsByAssets, getTodaySignalStats } = await import('../../src/services/todaySignals.js');
const { getTradeDate } = await import('../../src/services/signalService.js');
const { queryDuckDB } = await import('../../src/db/duckdb.js');

/**
 * 「今天 / 昨天」= **运行时计算**，不写死日期
 *
 * ⚠️ 写死 '2026-10-20' 会造出**定时炸弹**：跑测当天恰好等于该日期才通过，
 *   过了那天就永久红。⇒ 一律用 `getTradeDate()`（东八区）派生。
 */
const TODAY = getTradeDate();
const YESTERDAY = (() => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

// ── 测试用户 ──
const TEST_UID = 6701;
const OTHER_UID = 6702;
const USER_PAYLOAD: JwtPayload = {
  sub: TEST_UID,
  username: 't67_user',
  role: 'user',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

let app: FastifyInstance;
let store: InstanceType<typeof ConfigStore>;

/** 批量查询用的标的集合（20 只 → 用于断言「批量是一批」） */
const BATCH_CODES = Array.from({ length: 20 }, (_, i) => `sh6001${String(i).padStart(2, '0')}`);

/**
 * 所有持仓标的（含边界样本）
 *
 * ⚠️ `sh600005` 也在列：它是「手工补录的分红」（`is_auto_import = 0`），
 *    而 `user_trade_record` 里有记录就会进 `calcAllPositions` → 也是一条 position。
 * ⚠️ `sh600000` 也在列：卡 1 的 A2 用它断言「命中 raw_symbol_name → 浦发银行」。
 */
const ALL_CODES = ['sh600000', 'sh600001', 'sh600002', 'sh600003', 'sh600004', 'sh600005', ...BATCH_CODES];

/** 插入一笔买入（造持仓用） */
function insertBuy(userId: number, assetCode: string, quantity = 100, price = 10, date = '2026-10-01'): void {
  store.db
    .prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
       VALUES (?, ?, 'buy', ?, '09:30:00', ?, ?, 0, 't67 测试造数', 0)`,
    )
    .run(userId, assetCode, date, quantity, price);
}

/** 插入一条信号 */
function insertSignal(
  userId: number,
  assetCode: string,
  opts: { pluginId: string; direction: string; label: string; tradeDate: string; isDeleted?: number },
): void {
  store.db
    .prepare(
      `INSERT INTO user_strategy_signal
       (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final, is_deleted)
       VALUES (?, ?, ?, 'monitor', ?, ?, ?, NULL, NULL, 1, ?)`,
    )
    .run(userId, assetCode, opts.pluginId, opts.tradeDate, opts.direction, opts.label, opts.isDeleted ?? 0);
}

/** 取持仓接口返回的 position 列表 */
async function getHolding(): Promise<Array<Record<string, any>>> {
  const res = await app.inject({ method: 'GET', url: '/api/holding' });
  expect(res.statusCode).toBe(200);
  return res.json().data as Array<Record<string, any>>;
}

beforeAll(async () => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  store = ConfigStore.getInstance();

  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(TEST_UID, 't67_user', 'dummy-hash');
  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(OTHER_UID, 't67_other', 'dummy-hash');

  // ── 造持仓 ──
  for (const code of ALL_CODES) insertBuy(TEST_UID, code);

  // ── 造信号（sh600001 有 3 条，验证取「最新」；含 1 条软删）──
  insertSignal(TEST_UID, 'sh600001', {
    pluginId: 'rsi_oversold',
    direction: 'buy',
    label: 'RSI<28',
    tradeDate: '2026-10-10',
  });
  insertSignal(TEST_UID, 'sh600001', {
    pluginId: 'macd_cross',
    direction: 'sell',
    label: '死叉',
    tradeDate: '2026-10-12',
  });
  insertSignal(TEST_UID, 'sh600001', {
    pluginId: 'volume_spike',
    direction: 'hold',
    label: '放量',
    tradeDate: '2026-10-11',
  });
  // 软删的信号必须被忽略
  insertSignal(TEST_UID, 'sh600001', {
    pluginId: 'deleted_plugin',
    direction: 'buy',
    label: '已软删',
    tradeDate: '2026-10-13',
    isDeleted: 1,
  });
  insertSignal(TEST_UID, 'sh600002', {
    pluginId: 'rsi_oversold',
    direction: 'buy',
    label: 'RSI<25',
    tradeDate: '2026-10-12',
  });
  // 别的用户的信号不能串到本用户
  insertSignal(OTHER_UID, 'sh600003', {
    pluginId: 'other_user_plugin',
    direction: 'buy',
    label: '别人的信号',
    tradeDate: '2026-10-12',
  });

  // ── 造「今日」信号（2 buy / 1 sell / 3 hold），供 ⑤ 服务函数与 ⑦ 端点断言复用 ──
  //    ⚠️ 日期用 TODAY（运行时算），不写死 —— 写死会变成定时炸弹
  insertSignal(TEST_UID, 'sh600010', {
    pluginId: 'p1',
    direction: 'buy',
    label: '买1',
    tradeDate: TODAY,
  });
  insertSignal(TEST_UID, 'sh600011', {
    pluginId: 'p2',
    direction: 'buy',
    label: '买2',
    tradeDate: TODAY,
  });
  insertSignal(TEST_UID, 'sh600012', {
    pluginId: 'p3',
    direction: 'sell',
    label: '卖1',
    tradeDate: TODAY,
  });
  for (const code of ['sh600013', 'sh600014', 'sh600015']) {
    insertSignal(TEST_UID, code, {
      pluginId: 'p4',
      direction: 'hold',
      label: '观望',
      tradeDate: TODAY,
    });
  }

  // ── 造除权导入记录（is_auto_import = 1）──
  //    ⚠️ 日期**相对今天**派生（不写死）—— 端点缺省「今天」是运行时算出来的
  const insertImport = store.db.prepare(
    `INSERT INTO user_trade_record
     (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_auto_import, is_deleted)
     VALUES (?, ?, ?, ?, '00:00:00', ?, ?, 0, ?, 1, 0)`,
  );
  insertImport.run(TEST_UID, 'sh600001', 'dividend', TODAY, 1000, 0.5, `自动导入-分红-${TODAY}`);
  insertImport.run(TEST_UID, 'sh600002', 'bonus', TODAY, 300, 0, `自动导入-送转-${TODAY}`);
  // 非当日
  insertImport.run(TEST_UID, 'sh600003', 'dividend', YESTERDAY, 500, 0.3, `自动导入-分红-${YESTERDAY}`);
  // 别的用户
  insertImport.run(OTHER_UID, 'sh600004', 'dividend', TODAY, 700, 0.2, `自动导入-分红-${TODAY}`);
  // 手工录入（非自动导入）→ 不该出现在「除权导入」列表里
  store.db
    .prepare(
      `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_auto_import, is_deleted)
       VALUES (?, 'sh600005', 'dividend', ?, '10:00:00', 200, 0.1, 0, '手工补录', 0, 0)`,
    )
    .run(TEST_UID, TODAY);

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user?: JwtPayload }).user = USER_PAYLOAD;
  });
  await registerTradeRoutes(app);
  await registerExDividendRoutes(app);
  await registerSignalRoutes(app);
});

afterAll(async () => {
  await app.close();
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const { closeDuckDBInstance } = await import('../../src/db/duckdb.js');
  await closeDuckDBInstance();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // ⚠️ 三个开关都要复位 —— 用例内若抛错，开关会残留 → 污染后续用例
  //   （vitest 会打乱用例顺序，这种残留会变成随机失败）
  H.useReal.value = false;
  H.failDuckDb.value = false;
  H.failSignalDb.value = false;
  (queryDuckDB as unknown as { mockClear: () => void }).mockClear();
});

// ══════════════════════════════════════════════════════════
// ① `/api/holding` enrich —— 字段齐全 + 只加不改
// ══════════════════════════════════════════════════════════

describe('T67-① /api/holding enrich —— 字段齐全（只加不改）', () => {
  it('每个 position 都带 prevClose 与 signal 字段（值可为 null，但字段必须在）', async () => {
    const items = await getHolding();
    expect(items.length).toBe(ALL_CODES.length);
    for (const p of items) {
      expect(Object.prototype.hasOwnProperty.call(p, 'prevClose')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(p, 'signal')).toBe(true);
      expect(p.prevClose === null || typeof p.prevClose === 'number').toBe(true);
      expect(p.signal === null || typeof p.signal === 'object').toBe(true);
    }
  });

  it('既有字段的路径与形状完全不变（契约未破坏，只多了 2 个字段）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const items = body.data as Array<Record<string, any>>;
    const p = items.find((i) => i.asset_code === 'sh600001');
    expect(p).toBeDefined();
    for (const key of [
      'asset_code',
      'totalQuantity',
      'totalCostBasis',
      'avgCost',
      'realizedPnL',
      'currentPrice',
      'priceDate',
      'marketValue',
      'unrealizedPnl',
      'unrealizedYield',
      'weight',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(p, key), `缺少既有字段 ${key}`).toBe(true);
    }
    // summary 仍在**顶层**（T89a 契约）
    expect(body.summary).toBeDefined();
    expect(body.summary.positionCount).toBe(ALL_CODES.length);
    expect(body.summary.priceDate).toBe('2026-10-12');
    // 既有字段数值未被 enrich 影响
    expect(p.totalQuantity).toBe(100);
    expect(p.totalCostBasis).toBe(1000);
    expect(p.avgCost).toBe(10);
    expect(p.currentPrice).toBe(12);
    expect(p.marketValue).toBe(1200);
    expect(p.unrealizedPnl).toBe(200);
    expect(p.unrealizedYield).toBeCloseTo(0.2, 10);
  });
});

// ══════════════════════════════════════════════════════════
// ② prevClose —— 上一交易日的收盘价（**倒数第二条**）
// ══════════════════════════════════════════════════════════

describe('T67-② prevClose —— 上一交易日收盘价', () => {
  it('3 根日线：prevClose = 倒数第二条的收盘价，currentPrice = 最后一条', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600001');
    expect(p!.currentPrice).toBe(12.0); // 2026-10-12
    expect(p!.prevClose).toBe(11.0); // 2026-10-09（上一交易日）
    expect(p!.priceDate).toBe('2026-10-12');
  });

  it('2 根日线：prevClose = 最早那根', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600002');
    expect(p!.currentPrice).toBe(22.5);
    expect(p!.prevClose).toBe(21.0);
  });

  it('只有 1 根日线 → prevClose = null（但字段必须在，接口不 500）', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600003');
    expect(p!.currentPrice).toBe(33.3);
    expect(p!.prevClose).toBeNull();
  });

  it('完全无行情 → currentPrice = null 且 prevClose = null（不 500）', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600004');
    expect(p!.currentPrice).toBeNull();
    expect(p!.prevClose).toBeNull();
    expect(p!.marketValue).toBeNull();
    expect(p!.unrealizedPnl).toBeNull();
  });

  it('DuckDB 不可用 → prevClose / currentPrice 全为 null，**接口仍 200**', async () => {
    H.failDuckDb.value = true;
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    H.failDuckDb.value = false;
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, any>>;
    expect(items.length).toBe(ALL_CODES.length);
    for (const p of items) {
      expect(p.prevClose).toBeNull();
      expect(p.currentPrice).toBeNull();
      expect(p.signal === null || typeof p.signal === 'object').toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════
// ③ signal —— 该标的的**最新一条**信号
// ══════════════════════════════════════════════════════════

describe('T67-③ signal —— 最新一条信号', () => {
  it('多条信号 → 取 trade_date 最新的一条（软删的忽略）', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600001');
    expect(p!.signal).toEqual({
      plugin_id: 'macd_cross',
      direction: 'sell',
      label: '死叉',
      trade_date: '2026-10-12',
    });
  });

  it('无信号 → signal = null（字段必须在）', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600003');
    expect(p!.signal).toBeNull();
  });

  it('别的用户的信号不会串过来（按 user_id 隔离）', async () => {
    const items = await getHolding();
    const p = items.find((i) => i.asset_code === 'sh600003');
    expect(p!.signal).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════
// ④ 批量取数 —— **是一批**，不是 N+1
// ══════════════════════════════════════════════════════════

describe('T67-④ 批量取数 —— 禁止 N+1', () => {
  it('20 只持仓 → DuckDB 只查 2 次（行情 1 + 名称 1），不随标的数线性增长', async () => {
    const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
    spy.mockClear();
    await getHolding();
    // ⚠️ T67 卡 1 起 DuckDB 往返 = **2 次**（行情 1 + 名称 1），仍是**常数**
    //   —— 与持仓数无关（25 只 → 2 次；若退化成 N+1 则是 25 次）
    expect(spy.mock.calls.length).toBe(2);
    // 且这两次查询都带了全部 20+ 个标的（IN 批量，不是逐个）
    for (const call of spy.mock.calls) {
      const params = call[1] as unknown[];
      expect(params.length).toBeGreaterThanOrEqual(ALL_CODES.length);
    }
  });

  it('20 只持仓 → 信号只查 1 次（SQLite 侧同样是 IN 批量）', async () => {
    const prepareSpy = vi.spyOn(store.db, 'prepare');
    prepareSpy.mockClear();
    await getHolding();
    const signalSqls = prepareSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes('user_strategy_signal'));
    expect(signalSqls.length).toBe(1);
    expect(signalSqls[0]).toContain('asset_code IN (');
    prepareSpy.mockRestore();
  });

  it('getLatestSignalsByAssets：一次查询覆盖全部标的，返回 Map<asset_code, SignalRow>', async () => {
    const map = await getLatestSignalsByAssets(TEST_UID, [
      'sh600001',
      'sh600002',
      'sh600003',
      'sh600001', // 重复标的 → 应去重
    ]);
    expect(map.size).toBe(2);
    expect(map.get('sh600001')?.plugin_id).toBe('macd_cross');
    expect(map.get('sh600002')?.direction).toBe('buy');
    expect(map.has('sh600003')).toBe(false);
  });

  it('getLatestSignalsByAssets：空数组 → 空 Map（不打库）', async () => {
    const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
    spy.mockClear();
    const map = await getLatestSignalsByAssets(TEST_UID, []);
    expect(map.size).toBe(0);
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// ⑤ 今日信号统计
// ══════════════════════════════════════════════════════════

describe('T67-⑤ getTodaySignalStats —— 今日 ▲▼· 计数', () => {
  it('按 direction 分组计数正确（buy→up / sell→down / hold→hold）', async () => {
    // 「今日」信号在 beforeAll 里已按 TODAY 造好：2 buy / 1 sell / 3 hold
    const stats = await getTodaySignalStats(TEST_UID, TODAY);
    expect(stats.up).toBe(2);
    expect(stats.down).toBe(1);
    expect(stats.hold).toBe(3);
    expect(stats.total).toBe(6);
  });

  it('不同交易日互不串（只统计指定 trade_date）', async () => {
    const stats = await getTodaySignalStats(TEST_UID, '2026-10-12');
    // 2026-10-12 当天：sh600001(sell) + sh600002(buy) = 2 条（sh600003 是别的用户）
    expect(stats.total).toBe(2);
    expect(stats.up).toBe(1);
    expect(stats.down).toBe(1);
    expect(stats.hold).toBe(0);
  });

  it('无信号的日期 → 全 0', async () => {
    const stats = await getTodaySignalStats(TEST_UID, '2020-01-01');
    expect(stats).toEqual({ total: 0, up: 0, down: 0, hold: 0 });
  });

  it('软删的信号不计入', async () => {
    // ⚠️ 插在**今天**（与上面 6 条同一交易日）→ 计数若变成 7 就说明软删没被过滤
    insertSignal(TEST_UID, 'sh600016', {
      pluginId: 'p5',
      direction: 'buy',
      label: '软删',
      tradeDate: TODAY,
      isDeleted: 1,
    });
    const stats = await getTodaySignalStats(TEST_UID, TODAY);
    expect(stats.total).toBe(6);
    expect(stats.up).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════
// ⑥ 除权导入读取端点（普通用户可读）
// ══════════════════════════════════════════════════════════

describe('T67-⑥ GET /api/ex-dividend/imports —— 今日除权导入', () => {
  it('返回当前用户当日自动导入的 dividend/bonus 记录 + 计数', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ex-dividend/imports?date=${TODAY}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    const data = body.data as {
      from: string;
      to: string;
      items: Array<{ asset_code: string; trade_type: string }>;
      summary: { total: number; dividendCount: number; bonusCount: number };
    };
    expect(data.from).toBe(TODAY);
    expect(data.to).toBe(TODAY);
    expect(data.summary.total).toBe(2);
    expect(data.summary.dividendCount).toBe(1);
    expect(data.summary.bonusCount).toBe(1);
    expect(data.items.map((i) => i.asset_code).sort()).toEqual(['sh600001', 'sh600002']);
    expect(data.items.map((i) => i.trade_type).sort()).toEqual(['bonus', 'dividend']);
  });

  it('不返回别人的记录，也不返回手工录入（非自动导入）的记录', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/ex-dividend/imports?date=${TODAY}`,
    });
    const data = res.json().data as { items: Array<{ asset_code: string }> };
    expect(data.items.some((i) => i.asset_code === 'sh600004')).toBe(false); // 别人的
    expect(data.items.some((i) => i.asset_code === 'sh600005')).toBe(false); // 手工录入
  });

  it('days 参数可查最近 N 天（含今天）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ex-dividend/imports?days=2',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { from: string; to: string; summary: { total: number } };
    // 区间 = [今天-1, 今天]
    expect(data.from).toBe(YESTERDAY);
    expect(data.to).toBe(TODAY);
    // 今天 2 条（分红 + 送转）+ 昨天 1 条（分红）= 3
    expect(data.summary.total).toBe(3);
    expect(data.summary.dividendCount).toBe(2);
    expect(data.summary.bonusCount).toBe(1);
  });

  it('date 格式非法 → 400 PARAM_INVALID', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ex-dividend/imports?date=2026/10/20' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });

  it('无记录的日期 → 200 + 空列表 + 计数全 0（不是 404）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ex-dividend/imports?date=2020-01-01',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { items: unknown[]; summary: { total: number } };
    expect(data.items).toEqual([]);
    expect(data.summary.total).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// ⑦ 今日信号统计端点（T67「今日动态概览卡 · 今日信号 ▲▼·」）
// ══════════════════════════════════════════════════════════

describe('T67-⑦ GET /api/signal/stats —— 今日信号 ▲▼· 统计', () => {
  it('按 direction 统计指定交易日（buy→up / sell→down / hold→hold）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/signal/stats?trade_date=${TODAY}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.trade_date).toBe(TODAY);
    expect(body.data).toEqual({ total: 6, up: 2, down: 1, hold: 3 });
  });

  it('trade_date 缺省 = 今天（东八区）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signal/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json().trade_date).toBe(TODAY);
  });

  it('trade_date 格式非法 → 400 PARAM_INVALID', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signal/stats?trade_date=2026-10' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });

  it('无信号的日期 → 全 0（不是 404）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signal/stats?trade_date=2020-01-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ total: 0, up: 0, down: 0, hold: 0 });
  });
});

// ══════════════════════════════════════════════════════════
// ⑧ 信号查询失败 → 降级为 signal=null，接口仍 200
// ══════════════════════════════════════════════════════════

describe('T67-⑧ 信号查询降级', () => {
  it('信号查询抛错 → signal 全为 null，接口仍 200（不 500）', async () => {
    H.failSignalDb.value = true;
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    H.failSignalDb.value = false;
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, any>>;
    expect(items.length).toBe(ALL_CODES.length);
    for (const p of items) {
      expect(p.signal).toBeNull();
      // 行情部分不受影响
      expect(p.prevClose === null || typeof p.prevClose === 'number').toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════
// ⑨ 真实行情库交叉验证（本地有真库时才跑；CI 无行情库 → 跳过）
// ══════════════════════════════════════════════════════════

describe('T67-⑨ 真实行情库交叉验证', () => {
  // 🔴 **必须是 full 档专属**（2026-10-20 实测修正）：
  //   这两个 describe 验的是「**真实行情库**上的行为」（prevClose 与 latest 差一根 K 线、
  //   `sh600001` 无名是常态）—— 迷你库是**真库的子集**，历史深度与标的覆盖都不同
  //   ⇒ 在迷你库上跑这些断言没有意义（实测 mini 档下「倒数第二条」断言红）。
  const itReal = marketDataTier() === 'full' ? it : it.skip;

  itReal('真库上 prevClose 仍是「倒数第二条」且与 latest 差一根 K 线', async () => {
    H.useReal.value = true;
    const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
    spy.mockClear();
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    H.useReal.value = false;
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, any>>;

    // 假数据里 sh600001 有行情；真库上 sh600001 是真实股票 → 应能取到现价与昨收
    const p = items.find((i) => i.asset_code === 'sh600001');
    expect(p).toBeDefined();
    expect(typeof p!.currentPrice).toBe('number');
    expect(typeof p!.prevClose).toBe('number');
    expect(p!.prevClose).not.toBe(p!.currentPrice);
    // 仍是常数次的批量查询（行情 1 + 名称 1）
    expect(spy.mock.calls.length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════
// ⑩ T67 卡 1 —— `/api/holding` 补 `name`（中文名）+ `industry`（契约预留）
// ══════════════════════════════════════════════════════════
//
// ── 取数口径（实测，2026-10-20 `/opt/invol/quotes.duckdb`）──
//   `DESCRIBE raw_symbol_name` → `(symbol VARCHAR, name VARCHAR, class VARCHAR)`
//   8726 行；`symbol` 无重复；`name` 无 NULL/空串。
//   全市场 12449 只（`raw_symbol_class`）→ **覆盖率约 70%，查不到是常态**。
//   `raw_tdx_blocks_member` / `raw_tdx_blocks_info` 均 **0 行** → 行业恒 null。

describe('T67-⑩ /api/holding enrich —— name（中文名）+ industry（契约预留）', () => {
  it('GET /api/holding enrich: 每个持仓带 name（raw_symbol_name 命中时）', async () => {
    const items = await getHolding();
    // A2 的字面例子：命中 raw_symbol_name → 中文名
    const p = items.find((i) => i.asset_code === 'sh600000');
    expect(p).toBeDefined();
    expect(p!.name).toBe('浦发银行');
    // 字段**必须在**（查不到时是 null，而不是「没有这个字段」）
    for (const item of items) {
      expect(Object.prototype.hasOwnProperty.call(item, 'name')).toBe(true);
      expect(item.name === null || typeof item.name === 'string').toBe(true);
    }
  });

  it('GET /api/holding enrich: name 未命中时为 null 且不报错', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, any>>;
    const p = items.find((i) => i.asset_code === 'sh600003');
    expect(p).toBeDefined();
    expect(p.name).toBeNull();
    // 没有名字**不影响**其他字段（现价 / 市值照常）
    expect(p.currentPrice).toBe(33.3);
    // ⚠️ 用 toBeCloseTo：33.3 * 100 在 IEEE754 下是 3330.0000000000005
    expect(p.marketValue).toBeCloseTo(3330, 10);
  });

  it('GET /api/holding enrich: DuckDB 不可用时 name/industry 为 null 且仍返回 200', async () => {
    H.failDuckDb.value = true;
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    H.failDuckDb.value = false;
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, any>>;
    expect(items.length).toBe(ALL_CODES.length);
    for (const p of items) {
      expect(p.name).toBeNull();
      expect(p.industry).toBeNull();
    }
  });

  it('GET /api/holding enrich: 批量查名只发 1 次 IN 查询（无 N+1）', async () => {
    const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
    spy.mockClear();
    await getHolding();
    const nameCalls = spy.mock.calls.filter((c) => String(c[0]).includes('FROM raw_symbol_name'));
    // 25 只持仓 → 查名**只发 1 次**（退化成 N+1 则是 25 次）
    expect(nameCalls.length).toBe(1);
    expect(String(nameCalls[0][0])).toMatch(/WHERE symbol IN \(/);
    // 且这一次查询带了全部标的（IN 批量，不是逐个）
    const params = nameCalls[0][1] as unknown[];
    expect(params.length).toBe(ALL_CODES.length);
  });

  it('GET /api/holding enrich: 只加不改 —— prevClose/signal/weight/summary 回归', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const items = body.data as Array<Record<string, any>>;
    const p = items.find((i) => i.asset_code === 'sh600001')!;
    // 既有字段的值与「加 name 之前」完全一致
    expect(p.asset_code).toBe('sh600001');
    expect(p.totalQuantity).toBe(100);
    expect(p.totalCostBasis).toBe(1000);
    expect(p.avgCost).toBe(10);
    expect(p.currentPrice).toBe(12);
    expect(p.prevClose).toBe(11);
    expect(p.marketValue).toBe(1200);
    expect(p.unrealizedPnl).toBe(200);
    expect(p.unrealizedYield).toBeCloseTo(0.2, 10);
    expect(p.signal).toEqual({
      plugin_id: 'macd_cross',
      direction: 'sell',
      label: '死叉',
      trade_date: '2026-10-12',
    });
    // weight = marketValue / totalMarketValue
    // ⚠️ T119（V3.0）后 sh600002 的 300 股送转计入持仓（100→400）⇒ 市值 22.5×400=9000
    //    ⇒ totalMarketValue = 1200(sh600001) + 9000(sh600002) + 3330(sh600003) = 13530
    //    （T119 前送转被过滤，sh600002 市值为 2250，合计 6780 —— 旧期望已随口径作废）
    expect(p.weight).toBeCloseTo(1200 / 13530, 10);
    // summary 仍在**顶层**（T89a 契约），数值不受 name 影响
    expect(body.summary.totalMarketValue).toBe(13530);
    expect(body.summary.positionCount).toBe(ALL_CODES.length);
  });

  it('summary 的键集合仍为 6 个（不多不少）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holding' });
    expect(res.statusCode).toBe(200);
    // ⚠️ summary 的键是 **`realizedPnl`**（小写 l），与 position 的 `realizedPnL`（大写 L）
    //    **不同** —— 实测 `routes/trade.ts:500` 用的是 `realizedPnl`，
    //    前端 `Dashboard.tsx:461` 读的也是 `realizedPnl`。
    //    （卡 1 的 A7 把 summary 键写成 `realizedPnL` 是笔误，此处按实测口径断言。）
    expect(Object.keys(res.json().summary).sort()).toEqual([
      'positionCount',
      'priceDate',
      'realizedPnl',
      'totalCostBasis',
      'totalMarketValue',
      'unrealizedPnl',
    ]);
  });

  it('industry 恒为 null（板块数据源实测 0 行）→ 前端据此显式降级行业筛选', async () => {
    const items = await getHolding();
    for (const p of items) {
      expect(Object.prototype.hasOwnProperty.call(p, 'industry')).toBe(true);
      expect(p.industry).toBeNull();
    }
  });
});

// ══════════════════════════════════════════════════════════
// ⑪ 卡 1 · 真实行情库交叉验证（本地有真库时才跑；CI 无行情库 → 跳过）
// ══════════════════════════════════════════════════════════

describe('T67-⑪ 真实行情库 —— name 的命中与缺失', () => {
  // 🔴 **必须是 full 档专属**（2026-10-20 实测修正）：
  //   这两个 describe 验的是「**真实行情库**上的行为」（prevClose 与 latest 差一根 K 线、
  //   `sh600001` 无名是常态）—— 迷你库是**真库的子集**，历史深度与标的覆盖都不同
  //   ⇒ 在迷你库上跑这些断言没有意义（实测 mini 档下「倒数第二条」断言红）。
  const itReal = marketDataTier() === 'full' ? it : it.skip;

  // ⚠️ 真实库上 `/api/holding` 会触发 `v_stock_qfq` 的全量扫描（实测约 3s/次）
  //   → 合并成**一次**调用，避免多开 DuckDB 实例（文件锁 + page cache 驱逐）
  itReal(
    '真库上 sh600000 = 浦发银行、sh600001 无名（缺失是常态，不报错），且查名仍只 1 次 IN 查询',
    async () => {
      H.useReal.value = true;
      const spy = queryDuckDB as unknown as { mock: { calls: unknown[][] } };
      spy.mockClear();
      const res = await app.inject({ method: 'GET', url: '/api/holding' });
      H.useReal.value = false;
      expect(res.statusCode).toBe(200);
      const items = res.json().data as Array<Record<string, any>>;

      // 真库实测：`raw_symbol_name` 有 sh600000（浦发银行），**没有** sh600001
      const named = items.find((i) => i.asset_code === 'sh600000');
      expect(named).toBeDefined();
      expect(named!.name).toBe('浦发银行');

      const unnamed = items.find((i) => i.asset_code === 'sh600001');
      expect(unnamed).toBeDefined();
      expect(unnamed!.name).toBeNull();

      // 查名仍是 1 次 IN 查询（无 N+1）
      const nameCalls = spy.mock.calls.filter((c) => String(c[0]).includes('FROM raw_symbol_name'));
      expect(nameCalls.length).toBe(1);
      const params = nameCalls[0][1] as unknown[];
      expect(params.length).toBe(ALL_CODES.length);
    },
  );
});
