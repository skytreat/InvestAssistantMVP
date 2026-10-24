/**
 * t97-execution-params.test.ts — C11/C12「执行参数」单测
 *
 * T85 定「检什么」（校验定义），T97 定「怎么执行」（抽样 / 节流 / 退避 / 降级 / 总耗时上限）。
 * 本文件只覆盖 T97 的执行参数面，逐条对应 T97 验收点：
 *   ① EXEC_PARAMS 常量与需求一致
 *   ② C11 告警分级：mismatch 0/3/4/5/6 → PASS/WARN/WARN/WARN/ERROR
 *   ③ C12 告警分级：mismatch ≤5 → WARN；「>1 只差异 >0.1 元」→ ERROR（幅度条件）
 *   ④ 抽样规模恰为 C11=30 / C12=20
 *   ⑤ 节流 C11=100ms / C12=500ms（两个值不同，严禁统一）
 *   ⑥ C12 退避序列 200ms → 400ms（mock 前 2 次失败、第 3 次成功）
 *   ⑦ 外部源全部失败 / 被限流 → SKIP（不是 ERROR），且不阻塞后续校验
 *   ⑧ 总耗时超 30s → 提前中止，detail 含「超时」
 *   ⑨ SKIP 与 ERROR 严格区分
 *
 * ⚠️ C11/C12 会真的发网络请求 —— 本文件**完全 mock 掉 global.fetch**，否则无 token 会挂起。
 * ⚠️ C11(Tushare) 与 C12(东财) 共用同一个 global.fetch，故用**单一 URL 路由桩**，
 *    否则后装的 spy 会顶掉前一个，导致两条校验互相串味。
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-t97-'));
const TEST_DB = path.join(tmpDir, 't97-test.db');
const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { runAllChecks, EXEC_PARAMS } from '../../src/services/validator.js';
import type { CheckResult } from '../../src/services/validator.js';

// ─────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────

interface C11LocalFixture {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pre_close: number;
  volume: number;
  amount: number;
}

interface C12LocalFixture {
  symbol: string;
  local_qfq_close: number;
}

/** C11 本地行：各字段自洽，供 fetch 桩逐字段回放 */
function makeC11Rows(n: number): C11LocalFixture[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 10 + i * 0.1;
    return {
      symbol: `sh${600000 + i}`,
      open: +(close - 0.05).toFixed(2),
      high: +(close + 0.05).toFixed(2),
      low: +(close - 0.1).toFixed(2),
      close: +close.toFixed(2),
      pre_close: +(close - 0.05).toFixed(2),
      volume: 100000 + i,
      amount: 1000000 + i,
    };
  });
}

/**
 * C12 本地行：open=high=low=close 取同一价位。
 * 这样东财 klines 无论代码取第几个下标当收盘价，测试断言的差值口径都一致
 * —— 本用例只验「执行参数」，不验东财字段下标解析。
 */
function makeC12Rows(n: number): C12LocalFixture[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: `sh${600000 + i}`,
    local_qfq_close: 10 + i * 0.1,
  }));
}

/** sh600000 → 600000.SH（与 validator.ts 的 convertToTsCode 同规则） */
function toTsCode(symbol: string): string {
  return `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
}

/** sh600000 → 1.600000（与 fetchEastMoneyQfq 的 secid 规则一致） */
function toSecid(symbol: string): string {
  const market = symbol.slice(0, 2).toLowerCase() === 'sh' ? '1' : '0';
  return `${market}.${symbol.slice(2)}`;
}

/** 1.600000 → sh600000 */
function fromSecid(secid: string): string {
  const [market, code] = secid.split('.');
  return `${market === '1' ? 'sh' : 'sz'}${code}`;
}

// ─────────────────────────────────────────────────────────────────
// 计时桩：记录延时并立即回调，测试零等待
// ─────────────────────────────────────────────────────────────────

const timerDelays: number[] = [];

function installTimerStub(): void {
  timerDelays.length = 0;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    cb: (...args: unknown[]) => void,
    ms?: number,
  ): ReturnType<typeof setTimeout> => {
    timerDelays.push(ms ?? 0);
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
}

// ─────────────────────────────────────────────────────────────────
// DuckDB 桩
// ─────────────────────────────────────────────────────────────────

/** 按 SQL 分派：C11 走 raw_kline_daily，C12 走 local_qfq_close（两者互不歧义） */
async function stubDuckDB(c11Rows: C11LocalFixture[], c12Rows: C12LocalFixture[]): Promise<void> {
  const mod = await import('../../src/db/duckdb.js');
  vi.spyOn(mod, 'queryDuckDB').mockImplementation(async (sql: string): Promise<unknown[]> => {
    if (sql.includes('raw_kline_daily')) return c11Rows;
    if (sql.includes('local_qfq_close')) return c12Rows;
    return [];
  });
}

// ─────────────────────────────────────────────────────────────────
// 单一 fetch 路由桩（C11 / C12 共用，按 URL 分流并分别计数）
// ─────────────────────────────────────────────────────────────────

interface FetchRoutes {
  c11Rows: C11LocalFixture[];
  c12Rows: C12LocalFixture[];
  /** C11 中这些标的返回偏移价 → 判为不匹配 */
  tushareMismatch?: Set<string>;
  /** C12 各标的的价差幅度（元），缺省 0 */
  emDelta?: Map<string, number>;
  /** Tushare 前 N 次请求抛网络异常（模拟连接失败 / 超时） */
  tushareThrowFirstN?: number;
  /** 东财前 N 次请求抛网络异常（触发退避重试） */
  emThrowFirstN?: number;
  /** Tushare 恒返回 429（模拟被限流） */
  tushareRateLimit?: boolean;
  /** 东财恒返回 429（模拟被限流，命中即跳过该只、不重试） */
  emRateLimit?: boolean;
  /** 每次 Tushare 请求把系统时间往前拨的毫秒数（用于测总耗时守卫） */
  advanceMsPerTushareCall?: number;
}

interface FetchCounters {
  tushare: () => number;
  em: () => number;
}

function installFetchRouter(routes: FetchRoutes): FetchCounters {
  const tushareRows = new Map(routes.c11Rows.map((r) => [toTsCode(r.symbol), r]));
  let tushareCalls = 0;
  let emCalls = 0;

  vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);

    // ── C11：Tushare ──
    if (url.includes('tushare')) {
      tushareCalls++;
      if (routes.advanceMsPerTushareCall !== undefined) {
        vi.setSystemTime(Date.now() + routes.advanceMsPerTushareCall);
      }
      if (routes.tushareThrowFirstN !== undefined && tushareCalls <= routes.tushareThrowFirstN) {
        throw new TypeError('fetch failed');
      }
      if (routes.tushareRateLimit) return new Response(null, { status: 429 });

      const body = JSON.parse(String(init?.body ?? '{}')) as {
        params?: { ts_code?: string };
      };
      const tsCode = String(body.params?.ts_code ?? '');
      const row = tushareRows.get(tsCode);
      if (!row) return new Response(null, { status: 404 });

      const off = routes.tushareMismatch?.has(row.symbol) ?? false;
      const px = (v: number): number => (off ? +(v + 0.5).toFixed(2) : v);
      const fields = ['ts_code', 'open', 'high', 'low', 'close', 'pre_close', 'vol', 'amount'];
      const items = [
        [
          tsCode,
          px(row.open),
          px(row.high),
          px(row.low),
          px(row.close),
          px(row.pre_close),
          px(row.volume / 100), // Tushare vol 单位：手（1手=100股）
          px(row.amount / 1000), // Tushare amount 单位：千元
        ],
      ];
      return new Response(JSON.stringify({ code: 0, data: { fields, items } }), { status: 200 });
    }

    // ── C12：东方财富 ──
    if (url.includes('eastmoney')) {
      emCalls++;
      if (routes.emThrowFirstN !== undefined && emCalls <= routes.emThrowFirstN) {
        throw new TypeError('fetch failed');
      }
      if (routes.emRateLimit) return new Response(null, { status: 429 });

      const secid = /secid=([01]\.\d+)/.exec(url)?.[1];
      const row = secid ? routes.c12Rows.find((r) => toSecid(r.symbol) === secid) : undefined;
      if (!row) return new Response(null, { status: 404 });

      const delta = routes.emDelta?.get(fromSecid(String(secid))) ?? 0;
      const px = row.local_qfq_close + delta;
      // 东财 klines 字段序：date,open,high,low,close,volume,amount,...
      // （本夹具 open=high=low=close，见 makeC12Rows）
      const kline = [
        '2026-10-15',
        px.toFixed(2),
        px.toFixed(2),
        px.toFixed(2),
        px.toFixed(2),
        '1234567',
        '12967890.00',
      ].join(',');
      return new Response(JSON.stringify({ data: { klines: [kline] } }), { status: 200 });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch);

  return { tushare: () => tushareCalls, em: () => emCalls };
}

/** 默认路由：Tushare 全部匹配、东财全部匹配 */
function happyRoutes(c11Rows: C11LocalFixture[], c12Rows: C12LocalFixture[]): FetchRoutes {
  return { c11Rows, c12Rows, tushareMismatch: new Set(), emDelta: new Map() };
}

// ─────────────────────────────────────────────────────────────────
// 执行入口
// ─────────────────────────────────────────────────────────────────

const ORIGINAL_TOKEN = process.env.TUSHARE_TOKEN;

async function runAndPick(checkId: string): Promise<{ result: CheckResult; detail: string }> {
  const summaries = await runAllChecks('2026-10-15');
  const hit = summaries.find((s) => s.checkId === checkId);
  expect(hit, `${checkId} 应出现在 runAllChecks 结果中`).toBeDefined();
  return { result: hit!.result, detail: hit!.detail ?? '' };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  // T81：用例体内改的 TUSHARE_TOKEN 必须逐个用例还原，不能只靠 afterAll
  if (ORIGINAL_TOKEN !== undefined) process.env.TUSHARE_TOKEN = ORIGINAL_TOKEN;
  else delete process.env.TUSHARE_TOKEN;
});

afterAll(() => {
  try {
    const store = (ConfigStore as unknown as { _instance: { db: { close: () => void } } | null })._instance;
    if (store) store.db.close();
  } catch {
    /* ignore */
  }
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TEST_DB + ext);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_PATH;
  else delete process.env.SQLITE_DB_PATH;
  if (ORIGINAL_TOKEN !== undefined) process.env.TUSHARE_TOKEN = ORIGINAL_TOKEN;
  else delete process.env.TUSHARE_TOKEN;
});

// ─────────────────────────────────────────────────────────────────
// ① EXEC_PARAMS 执行参数常量
// ─────────────────────────────────────────────────────────────────

describe('T97 ① — EXEC_PARAMS 执行参数常量', () => {
  it('抽样规模：C11=30 / C12=20（Requirements §7.3）', () => {
    expect(EXEC_PARAMS.C11_SAMPLE_SIZE).toBe(30);
    expect(EXEC_PARAMS.C12_SAMPLE_SIZE).toBe(20);
  });

  it('节流：C11=100ms / C12=500ms，**两者不同**（C11 有额度硬限，C12 只是会被限流）', () => {
    expect(EXEC_PARAMS.C11_THROTTLE_MS).toBe(100);
    expect(EXEC_PARAMS.C12_THROTTLE_MS).toBe(500);
    expect(EXEC_PARAMS.C11_THROTTLE_MS).not.toBe(EXEC_PARAMS.C12_THROTTLE_MS);
  });

  it('C12 单只超时 10s；C12 退避序列 = [200, 400]（SDD §7.3）', () => {
    expect(EXEC_PARAMS.C12_TIMEOUT_MS).toBe(10_000);
    expect([...EXEC_PARAMS.RETRY_BACKOFF_MS]).toEqual([200, 400]);
  });

  it('跨源校验总耗时上限 30s（SDD §7.3 鲁棒性）', () => {
    expect(EXEC_PARAMS.MAX_TOTAL_MS).toBe(30_000);
  });

  it('告警阈值：C11 WARN@3 / ERROR@5；C12 WARN@5 / 幅度 0.1 元（Requirements §7.3）', () => {
    expect(EXEC_PARAMS.C11_WARN_AT).toBe(3);
    expect(EXEC_PARAMS.C11_ERROR_AT).toBe(5);
    expect(EXEC_PARAMS.C12_WARN_AT).toBe(5);
    expect(EXEC_PARAMS.C12_ERROR_GT).toBe(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────
// ② C11 告警分级
// ─────────────────────────────────────────────────────────────────

describe('T97 ② — C11 告警分级（mismatch → PASS / WARN / ERROR）', () => {
  const CASES: Array<[number, CheckResult]> = [
    [0, 'PASS'],
    [3, 'WARN'],
    [4, 'WARN'],
    [5, 'WARN'],
    [6, 'ERROR'],
  ];

  it.each(CASES)('mismatch=%i → %s', async (mismatch, expected) => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();

    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      // 前 mismatch 只返回偏移价 → 全部判为不匹配
      tushareMismatch: new Set(c11Rows.slice(0, mismatch).map((r) => r.symbol)),
    });

    const c11 = await runAndPick('C11');
    expect(c11.result).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────
// ③ C12 告警分级（ERROR 只由幅度触发）
// ─────────────────────────────────────────────────────────────────

describe('T97 ③ — C12 告警分级（计数只决定 WARN，ERROR 只由幅度触发）', () => {
  /** 构造 n 只价差 0.05 元的标的（≥容差 0.02 但 < ERROR 幅度线 0.1） */
  function smallDiffDelta(rows: C12LocalFixture[], n: number): Map<string, number> {
    return new Map(rows.slice(0, n).map((r) => [r.symbol, 0.05]));
  }

  async function runC12With(delta: Map<string, number>): Promise<{ result: CheckResult; detail: string }> {
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    installFetchRouter({ ...happyRoutes(c11Rows, c12Rows), emDelta: delta });
    return runAndPick('C12');
  }

  it('mismatch=5（每只差 0.05 元）→ WARN，不到 ERROR', async () => {
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    expect((await runC12With(smallDiffDelta(c12Rows, 5))).result).toBe('WARN');
  });

  it('mismatch=8 > C12_WARN_AT 但每只差 0.05 元 → 仍 WARN（计数不触发 ERROR）', async () => {
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    expect((await runC12With(smallDiffDelta(c12Rows, 8))).result).toBe('WARN');
  });

  it('2 只差异 >0.1 元（> C12_ERROR_COUNT_GT）→ ERROR', async () => {
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    const delta = smallDiffDelta(c12Rows, 6);
    delta.set(c12Rows[0].symbol, 0.5);
    delta.set(c12Rows[1].symbol, 0.8);

    const c12 = await runC12With(delta);
    expect(c12.result).toBe('ERROR');
    expect(c12.detail).toContain('其中 2 只差异');
  });

  it('仅 1 只差异 >0.1 元 → WARN（不满足「>1 只」条件）', async () => {
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    const delta = smallDiffDelta(c12Rows, 6);
    delta.set(c12Rows[0].symbol, 0.5);

    expect((await runC12With(delta)).result).toBe('WARN');
  });
});

// ─────────────────────────────────────────────────────────────────
// ④ 抽样规模
// ─────────────────────────────────────────────────────────────────

describe('T97 ④ — 抽样规模恰为 C11=30 / C12=20', () => {
  it('DuckDB 返回 40 行时，C11 恰好发 30 次请求', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(40);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    const fetchStub = installFetchRouter(happyRoutes(c11Rows, c12Rows));

    await runAllChecks('2026-10-15');
    expect(fetchStub.tushare()).toBe(EXEC_PARAMS.C11_SAMPLE_SIZE);
    expect(fetchStub.tushare()).toBe(30);
  });

  it('DuckDB 返回 25 行时，C12 恰好发 20 次请求', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(25);
    await stubDuckDB(c11Rows, c12Rows);
    const fetchStub = installFetchRouter(happyRoutes(c11Rows, c12Rows));

    await runAllChecks('2026-10-15');
    expect(fetchStub.em()).toBe(EXEC_PARAMS.C12_SAMPLE_SIZE);
    expect(fetchStub.em()).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────
// ⑤ 节流
// ─────────────────────────────────────────────────────────────────

describe('T97 ⑤ — 节流：C11=100ms / C12=500ms 两个值并存', () => {
  it('C11 逐只 sleep 100ms × 30；C12 逐只 sleep 500ms × 20，互不串用', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    installFetchRouter(happyRoutes(c11Rows, c12Rows));

    await runAllChecks('2026-10-15');

    expect(timerDelays.filter((d) => d === EXEC_PARAMS.C11_THROTTLE_MS)).toHaveLength(30);
    expect(timerDelays.filter((d) => d === EXEC_PARAMS.C12_THROTTLE_MS)).toHaveLength(20);
  });
});

// ─────────────────────────────────────────────────────────────────
// ⑥ C12 退避重试 200ms → 400ms
// ─────────────────────────────────────────────────────────────────

describe('T97 ⑥ — C12 退避重试 200ms → 400ms', () => {
  it('前 2 次网络失败、第 3 次成功 → 退避序列恰为 200/400，该只仍算 match', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    const fetchStub = installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      emThrowFirstN: 2,
    });

    const c12 = await runAndPick('C12');

    expect(c12.result).toBe('PASS');
    expect(fetchStub.em()).toBe(2 + EXEC_PARAMS.C12_SAMPLE_SIZE);
    expect(timerDelays.filter((d) => d === 200)).toHaveLength(1);
    expect(timerDelays.filter((d) => d === 400)).toHaveLength(1);
    // C12 是最后一项校验：其末尾 22 次延时恰为「首只退避 200/400 + 20 只节流 500」
    const c12Delays = timerDelays.slice(-(EXEC_PARAMS.RETRY_BACKOFF_MS.length + EXEC_PARAMS.C12_SAMPLE_SIZE));
    expect(c12Delays).toEqual([
      ...EXEC_PARAMS.RETRY_BACKOFF_MS,
      ...Array<number>(EXEC_PARAMS.C12_SAMPLE_SIZE).fill(EXEC_PARAMS.C12_THROTTLE_MS),
    ]);
  });

  it('重试预算耗尽仍失败 → 该只记 fetchFail，继续下一只（不抛错、不中断整项）', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    // 第 1 只耗尽 3 次尝试全部失败；其余 19 只正常
    const fetchStub = installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      emThrowFirstN: 3,
    });

    const c12 = await runAndPick('C12');

    expect(c12.result).toBe('PASS');
    expect(c12.detail).toContain('fetchFail=1');
    expect(fetchStub.em()).toBe(3 + (EXEC_PARAMS.C12_SAMPLE_SIZE - 1));
  });
});

// ─────────────────────────────────────────────────────────────────
// ⑦ + ⑨ 降级：外部源不可用 → SKIP（不是 ERROR）
// ─────────────────────────────────────────────────────────────────

describe('T97 ⑦⑨ — 跨源降级：SKIP 与 ERROR 严格区分', () => {
  it('C11 全部请求失败 → SKIP（不是 ERROR）', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      tushareThrowFirstN: Number.MAX_SAFE_INTEGER,
    });

    const c11 = await runAndPick('C11');
    expect(c11.result).toBe('SKIP');
    expect(c11.result).not.toBe('ERROR');
    expect(c11.detail).toContain('整体不可用');
  });

  it('C12 全部请求失败 → 连续 5 只触发整项 SKIP，并立即中止剩余标的', async () => {
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    const fetchStub = installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      emThrowFirstN: Number.MAX_SAFE_INTEGER,
    });

    const c12 = await runAndPick('C12');
    expect(c12.result).toBe('SKIP');
    expect(c12.result).not.toBe('ERROR');
    // 连续失败达阈值即中止：只打了 5 只 × 3 次尝试
    expect(fetchStub.em()).toBe(EXEC_PARAMS.C12_SKIP_CONSECUTIVE_FAILS * 3);
  });

  it('C12 被限流（429）→ 跳过该只、不重试；连续 5 只 → 整项 SKIP', async () => {
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    const fetchStub = installFetchRouter({ ...happyRoutes(c11Rows, c12Rows), emRateLimit: true });

    const c12 = await runAndPick('C12');
    expect(c12.result).toBe('SKIP');
    // 429 不消耗重试预算：5 只 × 1 次
    expect(fetchStub.em()).toBe(EXEC_PARAMS.C12_SKIP_CONSECUTIVE_FAILS);
  });

  it('C11 被限流（429）→ 降级为 SKIP，且不阻塞后续校验（12 项全部返回）', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    installFetchRouter({ ...happyRoutes(c11Rows, c12Rows), tushareRateLimit: true });

    const summaries = await runAllChecks('2026-10-15');
    expect(summaries).toHaveLength(12);
    expect(summaries.find((s) => s.checkId === 'C11')!.result).toBe('SKIP');
    // C12 仍照常执行并出结论 —— 不被 C11 的降级阻塞
    const c12 = summaries.find((s) => s.checkId === 'C12')!;
    expect(c12.result).toBe('PASS');
  });

  it('数值不可信仍是 ERROR，不与 SKIP 混淆（C11 mismatch=6）', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      tushareMismatch: new Set(c11Rows.slice(0, 6).map((r) => r.symbol)),
    });

    const summaries = await runAllChecks('2026-10-15');
    expect(summaries.find((s) => s.checkId === 'C11')!.result).toBe('ERROR');
  });

  it('DuckDB 无当日数据 → C11/C12 均 SKIP 而非 ERROR（ADR-004）', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    await stubDuckDB([], []);
    installFetchRouter(happyRoutes([], []));

    expect((await runAndPick('C11')).result).toBe('SKIP');
    expect((await runAndPick('C12')).result).toBe('SKIP');
  });
});

// ─────────────────────────────────────────────────────────────────
// ⑧ 总耗时 ≤ 30s 守卫
// ─────────────────────────────────────────────────────────────────

describe('T97 ⑧ — 总耗时超 30s 提前中止', () => {
  it('每次 Tushare 请求把系统时间前拨 15s → 第 3 只前中止，detail 含「超时」', async () => {
    process.env.TUSHARE_TOKEN = 'test-token-t97';
    installTimerStub();
    vi.useFakeTimers({ toFake: ['Date'] });

    const c11Rows = makeC11Rows(EXEC_PARAMS.C11_SAMPLE_SIZE);
    const c12Rows = makeC12Rows(EXEC_PARAMS.C12_SAMPLE_SIZE);
    await stubDuckDB(c11Rows, c12Rows);
    const fetchStub = installFetchRouter({
      ...happyRoutes(c11Rows, c12Rows),
      advanceMsPerTushareCall: 15_000,
    });

    const c11 = await runAndPick('C11');

    // 只比对了 2 只（15s / 30s 各一只），第 3 只前触发中止
    expect(fetchStub.tushare()).toBe(2);
    expect(c11.detail).toContain('超时');
    expect(c11.detail).toContain('提前中止');
    expect(c11.detail).toContain('2/30');
    // 已比对的结果照常出结论（无 mismatch → PASS，但带中止说明）
    expect(c11.result).toBe('PASS');
  });
});
