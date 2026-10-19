/**
 * scan.test.ts — 选股扫描路径（SDD §12.5 F7 / PE2 的路径级测试载体）
 *
 * 被测路径（src/routes/stockscan.ts）：
 *   参数校验 → 取最近交易日 → DuckDB 候选池查询 → 1 次 IN 批量取日线
 *   → 逐标的执行 filter 插件 → 收集非 HOLD 信号 → score 降序 → LIMIT max_results
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 为什么行情层用 mock 而不是真连 DuckDB
 *   - 真连会让断言依赖本机 `data/quotes.duckdb` 的内容（CI 无行情库），
 *     且 5000 只全市场查询的耗时不可控；
 *   - 本文件测的是**扫描路径的控制流与口径**（谁被选中、score 排序、上限截断、
 *     查询次数），不是 SQL 正确性 —— SQL 正确性由 t55-stockscan-filter.test.ts
 *     在真实行情库上覆盖（视图白名单 / 过滤条件 / 参数量一致性）。
 *   - mock 只替换 `db/duckdb.js` 的 queryDuckDB，其余全部走真实代码
 *     （真实路由 + 真实插件引擎 + 真实信号收集）。
 * ──────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { DailyKline } from '@invest/core';

// ---------------------------------------------------------------------------
// SQLite 隔离（选股路由会经 writeSystemLog 打开 ConfigStore）
// ---------------------------------------------------------------------------
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-scan-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 'scan.db');

// ---------------------------------------------------------------------------
// 假行情：3 只上行（命中均线多头排列）+ 2 只下行（不命中）
// ---------------------------------------------------------------------------
const TRADE_DATE = '2026-10-12';
const BAR_COUNT = 60;

interface FakeSymbol {
  symbol: string;
  name: string;
  /** 收盘价斜率：>0 上行、<0 下行 */
  slope: number;
}

const FAKE_SYMBOLS: FakeSymbol[] = [
  { symbol: 'sh600001', name: '上行强', slope: 0.15 },
  { symbol: 'sh600002', name: '上行中', slope: 0.08 },
  { symbol: 'sh600003', name: '上行弱', slope: 0.04 },
  { symbol: 'sh600004', name: '下行一', slope: -0.2 },
  { symbol: 'sh600005', name: '下行二', slope: -0.05 },
];

function fakeKlines(symbol: string, slope: number, count: number): DailyKline[] {
  const out: DailyKline[] = [];
  for (let i = 0; i < count; i++) {
    const close = 10 + i * slope;
    out.push({
      date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      amount: close * 1_000_000,
    });
  }
  return out;
}

const { queryDuckDBMock } = vi.hoisted(() => ({
  queryDuckDBMock: vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>(),
}));

vi.mock('../../src/db/duckdb.js', () => ({
  queryDuckDB: queryDuckDBMock,
  closeDuckDBInstance: vi.fn(async () => { /* 测试不需要真实 instance */ }),
  duckdbHealthCheck: vi.fn(async () => { /* noop */ }),
}));

const { registerStockScanRoutes, parseScanFilters, buildPoolQuery } =
  await import('../../src/routes/stockscan.js');
type AppliedScanFilters = import('../../src/routes/stockscan.js').AppliedScanFilters;

/** 当前实现允许的候选池（mock 控制） */
let poolSymbols: FakeSymbol[] = [...FAKE_SYMBOLS];

/** mock 的 queryDuckDB 实现：按 SQL 形状分派 */
function installDuckDBMock(): void {
  queryDuckDBMock.mockImplementation(async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    // 1. 交易日历（getLatestTradingDay）
    if (sql.includes('raw_holidays')) {
      return [{ date: TRADE_DATE }];
    }
    // 1b. 最新有行情数据的日期（T85b ② resolveLatestQuoteDate）
    //     —— 查行情必须落在真有数据的那天，否则查出来是 0 行
    if (sql.includes('MAX(d)')) {
      return [{ d: TRADE_DATE }];
    }
    // 2. 候选池（buildPoolQuery）
    if (sql.includes('raw_symbol_name')) {
      return poolSymbols.map((s, idx) => ({
        src_view: 'v_stock_qfq',
        symbol: s.symbol,
        amount: 1_000_000 * (poolSymbols.length - idx),
        name: s.name,
        totalmv: 10_000_000_000,
      }));
    }
    // 2b. 预取区间日线（T85b ①：按 view 分组的 1 次 IN 查询取整段区间）
    //     形状 = 同时含 BETWEEN 与 IN ( → 必须排在下面两条分支之前
    if (sql.includes('BETWEEN') && sql.includes('IN (')) {
      const symbols = (params ?? []).slice(2).map((p) => String(p));
      return symbols.flatMap((sym) => {
        const fake = FAKE_SYMBOLS.find((s) => s.symbol === sym);
        // ⚠️ 必须带 symbol —— 真实 SQL 是 `SELECT symbol, date, ...`，
        //    预取 map 以 symbol 为 key，缺了它缓存就永远 miss（会退化成逐只查库）
        return fakeKlines(sym, fake?.slope ?? 0, BAR_COUNT).map((k) => ({
          symbol: sym,
          ...k,
        })) as unknown as Record<string, unknown>[];
      });
    }
    // 3. 批量 IN 取日线（loadCandidateDaily）
    if (sql.includes('IN (')) {
      const symbols = (params ?? []).slice(1).map((p) => String(p));
      return symbols.map((sym) => {
        const fake = FAKE_SYMBOLS.find((s) => s.symbol === sym);
        const klines = fakeKlines(sym, fake?.slope ?? 0, BAR_COUNT);
        const last = klines[klines.length - 1];
        return { symbol: sym, ...last };
      });
    }
    // 4. 单标的区间取日线（ctx.getDailyKlines → getDailyRange）
    if (sql.includes('BETWEEN')) {
      const sym = String((params ?? [])[0] ?? '');
      const fake = FAKE_SYMBOLS.find((s) => s.symbol === sym);
      return fakeKlines(sym, fake?.slope ?? 0, BAR_COUNT) as unknown as Record<string, unknown>[];
    }
    return [];
  });
}

let app: Awaited<ReturnType<typeof Fastify>>;

beforeAll(async () => {
  installDuckDBMock();
  app = Fastify({ logger: false });
  await registerStockScanRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  (await import('../../src/config/configStore.js')).ConfigStore.resetInstance();
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// ===========================================================================
// ① 参数校验与候选池 SQL（纯函数）
// ===========================================================================

describe('scan — 参数校验与候选池 SQL（纯函数）', () => {
  it('默认口径：asset_type=stock、exclude_st=false、max_results=100', () => {
    const r = parseScanFilters({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      assetType: 'stock',
      excludeSt: false,
      industryCode: null,
      marketCapMaxYi: null,
      minAmount: 0,
      maxResults: 100,
    });
  });

  it('max_results 被夹到 [1, 500]，min_amount 负值归 0', () => {
    const tooBig = parseScanFilters({ max_results: 9999 });
    expect(tooBig.ok && tooBig.value.maxResults).toBe(500);
    const tooSmall = parseScanFilters({ max_results: 0 });
    expect(tooSmall.ok && tooSmall.value.maxResults).toBe(1);
    const negAmount = parseScanFilters({ min_amount: -100 });
    expect(negAmount.ok && negAmount.value.minAmount).toBe(0);
  });

  it('buildPoolQuery：占位符数量 = params 数量，用户输入不进 SQL 文本', () => {
    const filters: AppliedScanFilters = {
      assetType: 'stock',
      excludeSt: true,
      industryCode: 'BK0001',
      marketCapMaxYi: 50,
      minAmount: 1000,
    };
    const { sql, params } = buildPoolQuery(TRADE_DATE, filters);
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    expect(sql).not.toContain('BK0001');
    expect(params).toContain('BK0001');
    expect(params).toContain(50 * 100_000_000);
    expect(sql).toContain('FROM v_stock_qfq');
  });
});

// ===========================================================================
// ② 选股扫描路径（app.inject，不占端口）
// ===========================================================================

describe('scan — 选股扫描路径', () => {
  it('多头排列的标的入选、下行标的落选；结果按 score 降序', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'ma_bullish_alignment' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.tradeDate).toBe(TRADE_DATE);

    // 候选池 5 只全部被扫描
    expect(body.data.totalCandidates).toBe(5);
    // 其中 3 只满足 MA5 > MA10 > MA20 且收盘站上 MA20
    expect(body.data.total).toBe(3);
    expect(body.data.results.map((r: { symbol: string }) => r.symbol)).toEqual([
      'sh600001',
      'sh600002',
      'sh600003',
    ]);

    // score 降序（strength = (MA5/MA20-1)*10）
    const scores = body.data.results.map((r: { score: number }) => r.score);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[0]).toBeCloseTo((18.55 / 17.425 - 1) * 10, 3);
    expect(scores[2]).toBeCloseTo((12.28 / 11.98 - 1) * 10, 3);

    // 结果带 name / pluginId / signalType（PRD §5.6 结果表格口径）
    expect(body.data.results[0].name).toBe('上行强');
    expect(body.data.results[0].pluginId).toBe('ma_bullish_alignment');
    expect(body.data.results[0].signalType).toBe('BUY');
  });

  it('max_results 截断：上限 1 → 只返回 score 最高的 1 条（total 仍是命中总数）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'ma_bullish_alignment', max_results: 1 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.total).toBe(3);
    expect(body.data.results).toHaveLength(1);
    expect(body.data.results[0].symbol).toBe('sh600001');
  });

  it('生效的 filters 原样回显（前端据此确认口径）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: {
        plugin_id: 'ma_bullish_alignment',
        asset_type: 'stock',
        exclude_st: true,
        market_cap_max: 100,
        min_amount: 1000,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.filters).toMatchObject({
      assetType: 'stock',
      excludeSt: true,
      marketCapMaxYi: 100,
      minAmount: 1000,
    });
  });

  it('候选池为空 → 200 + totalCandidates=0（不是 500）', async () => {
    poolSymbols = [];
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/stockscan',
        payload: { plugin_id: 'ma_bullish_alignment' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.totalCandidates).toBe(0);
      expect(body.data.total).toBe(0);
      expect(body.data.results).toEqual([]);
    } finally {
      poolSymbols = [...FAKE_SYMBOLS];
    }
  });

  it('未知插件 → 400 PLUGIN_NOT_FOUND（参数校验前先判插件）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'no_such_plugin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PLUGIN_NOT_FOUND');
  });

  it('非法 asset_type / market_cap_max / exclude_st → 400 PARAM_INVALID（不静默回落）', async () => {
    for (const payload of [
      { plugin_id: 'ma_bullish_alignment', asset_type: 'bond' },
      { plugin_id: 'ma_bullish_alignment', market_cap_max: -1 },
      { plugin_id: 'ma_bullish_alignment', exclude_st: 'yes' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/stockscan', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe('PARAM_INVALID');
    }
  });
});

// ===========================================================================
// ③ DuckDB 查询次数（SDD §5.3 硬约束：禁止逐标的循环查询）
// ===========================================================================

describe('scan — DuckDB 查询次数', () => {
  it('候选池 1 次 + 日线 IN 查询 2 次（单日批量 + 区间预取），查询数与标的数无关', async () => {
    queryDuckDBMock.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'ma_bullish_alignment' },
    });
    expect(res.statusCode).toBe(200);

    const calls = queryDuckDBMock.mock.calls.map((c) => String(c[0]));
    const poolCalls = calls.filter((s) => s.includes('raw_symbol_name'));
    const batchCalls = calls.filter((s) => s.includes('IN ('));

    expect(poolCalls, '候选池查询应恰好 1 次').toHaveLength(1);
    // 1 次单日批量（loadCandidateDaily）+ 1 次区间预取（T85b ①）= 2 次，**与候选数无关**
    expect(batchCalls, '批量 IN 查询应恰好 2 次（单日 + 区间预取）').toHaveLength(2);
  });

  it('✅ 偏差已消除（T85b ①）：插件逐标的执行**不再**各查 1 次区间行情', () => {
    // 取证（修复前）：路由先用 loadCandidateDaily 做 1 次 IN 批量取回日线，但随后用
    //   buildPluginContext() 逐标的执行插件，ctx.getDailyKlines 会**再查一次** DuckDB
    //   → 总查询数 = 1（池）+ 1（IN 批量）+ N（逐标的区间），与 SDD §5.3
    //     「1 次 IN 查询 → N 插件共享」的硬约束存在差距（PR#15 交接文档 §4-C 记为偏差）。
    //
    // T85b ① 修复：ctx 改为带**预取缓存**（按 view 分组 1 次区间 IN 查询），
    //   插件执行时命中内存 → 逐标的区间查询归零。
    //   本用例从「锁定偏差」升级为「**断言偏差已消除**」—— 防止回归。
    queryDuckDBMock.mockClear();

    return app.inject({
      method: 'POST',
      url: '/api/stockscan',
      payload: { plugin_id: 'ma_bullish_alignment' },
    }).then((res) => {
      expect(res.statusCode).toBe(200);
      const calls = queryDuckDBMock.mock.calls.map((c) => String(c[0]));
      const rangeCalls = calls.filter((s) => s.includes('BETWEEN'));
      // 唯一一次 BETWEEN 查询 = 区间预取本身，不再有「每标的一次」
      expect(rangeCalls, '逐标的区间查询应归零（只剩 1 次区间预取）').toHaveLength(1);
      expect(rangeCalls.length, '区间查询次数必须与候选标的数无关').toBeLessThan(FAKE_SYMBOLS.length);
    });
  });
});
