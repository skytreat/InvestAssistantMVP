/**
 * F7 / PE2 — 全市场条件选股 ≤ 3s（SDD §12.5 功能组 F7 + 性能组 PE2）
 *
 * 用例名：**scan_5000_target**（SDD §12.5 两处指定的载体名）
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 2026-10-21：本文件是 SDD §12.5 里 F7 的**真实载体**（此前全仓 grep `scan_5000_target`
 *   只命中 tests/unit/t55-stockscan-filter.test.ts 的一句**注释**，没有任何真实用例）。
 *
 * 判据（SDD §12.5 原文）：
 *   F7  | 全市场条件选股 ≤ 3s | `time curl -X POST /api/stockscan` ≤ 3.0s
 *   PE2 | 选股 ≤ 3s（5000+ 标的）| curl -w %{time_total} ≤ 3.0s
 *
 * ── 为什么「5000 标的」不写死 ──────────────────────────────────────────────
 *   行情库的标的名数会随采集进度变化（实测本机 2026-10-12：股票 5561 只 / ETF 2074 只，
 *   候选池上限 POOL_LIMIT = 5000）。写死 5000 会让用例随行情库变动而失效，
 *   故本用例**跑「全市场」**（不传 min_amount / exclude_st / industry_code / market_cap_max），
 *   断言「候选池 > 0 且 ≤ POOL_LIMIT（5000）」这个**不随行情库变动的上界口径**，
 *   并把实测到的真实数量与耗时打进日志（供 wave 验收落档）。
 *
 * ── 计时口径 ──────────────────────────────────────────────────────────────
 *   - 用 `process.hrtime.bigint()`（纳秒），**不用 Date.now()**（毫秒精度不足以判 3.0s 边界）；
 *   - 计时**包含 HTTP 往返**（等价于 SDD 写的 `time curl`），从发请求前起算到收到响应体为止；
 *   - 先打一次**预热请求**再计时正式那次 —— 排除 DuckDB instance 首次创建、JIT 预热、
 *     ConfigStore 首次建表等冷启动开销。
 *
 * ── CI 行为 ───────────────────────────────────────────────────────────────
 *   本用例验证的是**规模型 + 性能型**门槛（5000+ 标的、≤3.0s）——
 *   **迷你库只有 250 只标的**（真库 12449 只），撑不起这个门槛 ⇒ 必须真库。
 *   → 用 `marketDataUsableFor('scale')` 守卫 **skip**（绝不 fail），
 *     也**不放宽** 3.0s 门槛（门槛是 SDD 硬判据，由本地真库实测把关）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import Fastify from 'fastify';

/**
 * 🔴 CI 教训（2026-10-19 实测）：CI 环境只有 12KB 空壳行情库（无 `v_stock_qfq` 等表），
 *   依赖**真实行情数据**的断言在本地全绿、CI 全红。
 *   → 需要真实行情库的用例一律 skip（与 smoke-m1 / t50 / t55 的既有做法一致）。
 *
 * 🔴 2026-10-21：**两层开关** —— F7/PE2 是**规模型 + 性能型**门槛，
 *   迷你库（250 只标的）**不能**用来判定它 ⇒ 用 `marketDataUsableFor('scale')` 守卫，
 *   而不是笼统的 `marketDataAvailable()`（那会把迷你库也放进来 → 假绿）。
 */
import { marketDataUsableFor, SKIP_REASON_NO_SCALE_DATA } from '../_marketData.js';

/** 是否有**真库**可用于规模/性能门槛（顶层 await 判定一次） */
const MARKET_DATA_SCALE_AVAILABLE = await marketDataUsableFor('scale');

// ── SQLite 隔离（选股路由会经 writeSystemLog 打开 ConfigStore）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-f7-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 'f7.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerRoutes } = await import('../../src/routes/index.js');
const { signToken } = await import('../../src/services/auth.js');
const { closeDuckDBInstance } = await import('../../src/db/duckdb.js');

/** SDD §12.5 F7/PE2 的硬门槛：3.0s —— **不因 CI 而放宽** */
const SCAN_TIME_BUDGET_MS = 3000;

/** 候选池上限（routes/stockscan.ts 的 POOL_LIMIT）—— 用于「不随行情库变动的上界」断言 */
const POOL_LIMIT = 5000;

/** 选股插件（内置 filter 类插件，paramSchema days 默认 120 → 预取窗口最大，最重） */
const PLUGIN_ID = 'rsi_oversold';

const HOST = '127.0.0.1';
let port = 0;
let app: Awaited<ReturnType<typeof Fastify>>;
let token = '';

/** 在 51200-51299 段里找一个空闲端口（AGENTS.md 端口分配表：其他测试用 51200-51999） */
async function findFreePort(start = 51200, end = 51299): Promise<number> {
  for (let p = start; p <= end; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, HOST);
    });
    if (free) return p;
  }
  throw new Error(`51200-51299 段没有空闲端口，F7 用例无法真实 listen`);
}

/** 打一次选股请求，返回响应体与客户端实测耗时（毫秒，纳秒精度） */
async function scanOnce(): Promise<{ status: number; body: Record<string, unknown>; elapsedMs: number }> {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`http://${HOST}:${port}/api/stockscan`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ plugin_id: PLUGIN_ID, asset_type: 'stock', max_results: 100 }),
  });
  const text = await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    status: res.status,
    body: JSON.parse(text) as Record<string, unknown>,
    elapsedMs,
  };
}

beforeAll(async () => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;

  // 真实鉴权链路：/api/stockscan 不在 PUBLIC_ROUTES 里 → 必须带 Bearer token
  // ⚠️ 只验签不查库，故无需 seed 用户
  token = signToken({ sub: 990001, username: 'f7_scan_user', role: 'user' });

  port = await findFreePort();
  app = Fastify({ logger: false });
  await registerRoutes(app);
  // ⚠️ 必须**真 listen**：AGENTS.md「测试分层与端口依赖」——
  //   `app.inject()` 走内存，不经 HTTP 传输层，测不了真实往返耗时（性能类用例必须真 listen）
  await app.listen({ port, host: HOST });
}, 30000);

afterAll(async () => {
  if (app) await app.close().catch(() => {});
  await closeDuckDBInstance().catch(() => {});
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 30000);

describe('F7 / PE2 — 全市场条件选股 ≤ 3s（SDD §12.5）', () => {
  // 规模型 + 性能型门槛 → **必须真库**（迷你库只有 250 只标的，撑不起 5000+ 候选）
  const itReal = MARKET_DATA_SCALE_AVAILABLE ? it : it.skip;

  if (!MARKET_DATA_SCALE_AVAILABLE) {
    // 🔴 **skip 必须可见** —— F7 是 🔒 硬门槛，静默 skip = 假绿。
    //   wave 验收落档时必须看到这行，并确认「本地真库实测已跑过」。
    console.warn(
      '[F7] ⚠️ scan_5000_target 被**跳过**：' +
        SKIP_REASON_NO_SCALE_DATA +
        '。F7/PE2 的 3.0s 门槛**未在本次运行中验证** —— 必须在有真行情库的机器上重跑并落档实测耗时。',
    );
  }

  itReal(
    'scan_5000_target：全市场候选池选股 ≤ 3000ms，返回非空且字段完整',
    async () => {
      // ---- 预热请求（排除冷启动：DuckDB instance 首次创建 / JIT / ConfigStore 建表）----
      const warm = await scanOnce();
      expect(warm.status, '预热请求应返回 200').toBe(200);
      expect(warm.body.code).toBe(0);

      // ---- 正式计时请求 ----
      const { status, body, elapsedMs } = await scanOnce();

      const data = body.data as {
        totalCandidates: number;
        total: number;
        results: Array<Record<string, unknown>>;
        tradeDate: string;
      };

      console.log(
        `[F7] scan_5000_target：候选池 ${data?.totalCandidates} 只 / 命中 ${data?.total} 只 / ` +
          `返回 ${data?.results?.length} 条 / 交易日 ${data?.tradeDate} / ` +
          `客户端耗时 ${elapsedMs.toFixed(0)}ms / 服务端耗时 ${String(body.timeMs)}ms`,
      );

      // ---- 契约断言 ----
      expect(status).toBe(200);
      expect(body.code).toBe(0);
      expect(body.code).toBe(0);

      // 候选池：全市场口径（非空，且不超过 POOL_LIMIT 这个稳定上界）
      expect(data.totalCandidates).toBeGreaterThan(0);
      expect(data.totalCandidates).toBeLessThanOrEqual(POOL_LIMIT);
      // 交易日形如 YYYY-MM-DD
      expect(data.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // 结果非空（不脆弱：不断言具体命中数量 —— 随行情库与插件参数变化）
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.total).toBeGreaterThan(0);

      // 每条结果的必要字段（以实现为准，见 routes/stockscan.ts 的 StockScanResult）
      for (const item of data.results) {
        expect(typeof item.symbol).toBe('string');
        expect(item.symbol.length).toBeGreaterThan(0);
        expect(item.name === null || typeof item.name === 'string').toBe(true);
        expect(typeof item.score).toBe('number');
        expect(typeof item.signalType).toBe('string');
        expect(item.pluginId).toBe(PLUGIN_ID);
      }

      // ---- 性能硬门槛（SDD §12.5：≤ 3.0s）----
      expect(elapsedMs, `全市场选股耗时 ${elapsedMs.toFixed(0)}ms 超过 3000ms 门槛`).toBeLessThanOrEqual(
        SCAN_TIME_BUDGET_MS,
      );
    },
    120000,
  );
});
