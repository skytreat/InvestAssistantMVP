/**
 * tests/http/pe2-scan.test.ts —— **PE2 验收：全市场条件选股 ≤ 3s（5000+ 标的）**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 📖 **SDD §12.5 性能验收组（权威口径，逐字照抄）**
 * ════════════════════════════════════════════════════════════════════════
 *   | PE2 | 选股 ≤ 3s（5000+ 标的）| curl -w %{time_total} ≤ 3.0s |
 *
 * ⚠️ **SDD 的工具是 `curl -w %{time_total}`** ⇒ 必须**真 listen + 真实 HTTP 往返**，
 *   `inject()` 测的是函数耗时，不是 API 延迟。
 *
 * ── 为什么本目录已有一份 PE2（`tests/integration/scan5000.test.ts`）还要再写一份 ──
 *   计划 §12.7 T60 ③ 要求「PE1‑PE5 放进 `tests/http/`」。
 *   本文件与那份的**区别**：
 *     · 本文件在 `tests/http/` 目录内（满足计划要求），且**不依赖** `vitest.pe2.config.ts`
 *       的独占运行约定；
 *     · 两者测的是**同一条 SQL 路径**（`POST /api/stockscan`），门槛值一致（3000ms）。
 *   ⇒ 数值上互为交叉验证（任一份漂移，另一份会红）。
 *
 * ── 测量环境隔离（性能门槛的通用要求）──
 *   本进程内的 DuckDB instance 是**单例**，它的内部缓冲会被前面的查询驱逐
 *   （实测：与全量套件同进程跑 10082ms vs 独占跑 2942ms）。
 *   ⇒ 本文件在 `beforeAll` 里**主动丢弃**当前 instance（`closeDuckDBInstance()`），
 *     让测量从一个干净的 instance 开始；再打一次**预热请求**排除首次建连开销。
 *
 * ⚠️ **规模型门槛必须真库**：迷你库只有 250 只标的（真库 12449 只）⇒ 用
 *   `marketDataUsableFor('scale')` 守卫，**skip 且留痕**，绝不假绿。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertRealListen, createHttpApp, type HttpTestApp } from './_helpers.js';
import { marketDataUsableFor, SKIP_REASON_NO_SCALE_DATA } from '../_marketData.js';

/** 规模型 + 性能型门槛 → 必须真库 */
const MARKET_SCALE_AVAILABLE = await marketDataUsableFor('scale');

/** SDD §12.5 PE2 的硬门槛：3.0s —— **不因档位而放宽** */
const SCAN_TIME_BUDGET_MS = 3000;

/** 候选池上限（`routes/stockscan.ts` 的 POOL_LIMIT）—— 不随行情库变动的上界 */
const POOL_LIMIT = 5000;

/** 选股插件（内置 filter 类插件，days 默认 120 → 预取窗口最大，最重） */
const PLUGIN_ID = 'rsi_oversold';

/** 测试用户 */
const TEST_UID = 92001;

let http: HttpTestApp;
let token = '';

/** 打一次选股请求（真实 HTTP 往返） */
async function scanOnce(): Promise<{
  status: number;
  body: Record<string, unknown>;
  elapsedMs: number;
}> {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${http.baseUrl}/api/stockscan`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ plugin_id: PLUGIN_ID, asset_type: 'stock', max_results: 100 }),
  });
  const text = await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, elapsedMs };
}

beforeAll(async () => {
  // 丢弃可能被前面用例污染的 DuckDB 单例（测量环境隔离，见文件头）
  const { closeDuckDBInstance } = await import('../../src/db/duckdb.js');
  await closeDuckDBInstance().catch(() => {});

  http = await createHttpApp({ portStart: 51240, portEnd: 51259 });

  const { signToken } = await import('../../src/services/auth.js');
  token = signToken({ sub: TEST_UID, username: 'pe2_user', role: 'user' });
}, 60_000);

afterAll(async () => {
  await http?.close();
}, 30_000);

describe('PE2 —— 全市场条件选股 ≤ 3s（SDD §12.5）', () => {
  const itScale = MARKET_SCALE_AVAILABLE ? it : it.skip;

  if (!MARKET_SCALE_AVAILABLE) {
    console.warn(
      '[PE2] ⚠️ 被**跳过**：' +
        SKIP_REASON_NO_SCALE_DATA +
        '。PE2 的 3.0s 门槛**未在本次运行中验证** —— 必须在 full 档真库上重跑并落档实测耗时。',
    );
  }

  it('前置守卫：本文件确实调用了 app.listen()（inject() 恒绿 = 没测）', async () => {
    const raw = await assertRealListen(http.app, http.port);
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
  });

  itScale(
    'scan_5000_target：全市场候选池选股 ≤ 3000ms，候选池非空且 ≤ 5000',
    async () => {
      // 预热（排除冷启动：DuckDB instance 首次创建 / JIT / ConfigStore 建表）
      const warm = await scanOnce();
      expect(warm.status, '预热请求应返回 200').toBe(200);
      expect(warm.body.code).toBe(0);

      // 正式计时
      const { status, body, elapsedMs } = await scanOnce();
      const data = body.data as {
        totalCandidates: number;
        total: number;
        results: Array<Record<string, unknown>>;
        tradeDate: string;
      };

      console.log(
        `[PE2] 候选池 ${data?.totalCandidates} 只 / 命中 ${data?.total} 只 / ` +
          `返回 ${data?.results?.length} 条 / 交易日 ${data?.tradeDate} / ` +
          `客户端耗时 ${elapsedMs.toFixed(0)}ms / 服务端耗时 ${String(body.timeMs)}ms`,
      );

      expect(status).toBe(200);
      expect(body.code).toBe(0);
      expect(data.totalCandidates).toBeGreaterThan(0);
      expect(data.totalCandidates).toBeLessThanOrEqual(POOL_LIMIT);
      expect(data.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.total).toBeGreaterThan(0);

      for (const item of data.results) {
        expect(typeof item.symbol).toBe('string');
        expect(String(item.symbol).length).toBeGreaterThan(0);
        expect(typeof item.score).toBe('number');
        expect(item.pluginId).toBe(PLUGIN_ID);
      }

      expect(elapsedMs, `全市场选股耗时 ${elapsedMs.toFixed(0)}ms 超过 3000ms 门槛`).toBeLessThanOrEqual(
        SCAN_TIME_BUDGET_MS,
      );
    },
    300_000,
  );
});
