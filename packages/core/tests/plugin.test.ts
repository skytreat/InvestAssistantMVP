/**
 * plugin.test.ts — 插件契约 + SDD §12.5 指定的两个验收用例
 *
 * | SDD §12.5 | 指定用例 | 本文件对应 describe |
 * |---|---|---|
 * | F6 策略插件信号生成 + 状态机 | `state_machine_4_paths` | 「SDD §12.5 F6 — state_machine_4_paths」 |
 * | PE6 插件超时（50ms）不影响主流程 | `plugin_timeout_50ms` | 「SDD §12.5 PE6 — plugin_timeout_50ms」 |
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 【为什么本文件是「契约参考模型」而不是直接跑真实插件引擎】
 *
 * 真实的插件执行引擎在 **backend 包**：`apps/backend/src/services/pluginEngine.ts`
 * （它要注入 DuckDB 行情 IO，所以不能放在零依赖的 core 包里）。
 * 其引擎级覆盖（真实 4 态 + T88 计时边界）在：
 *   - `apps/backend/tests/unit/pluginEngine.test.ts`（P3 超时 / P4 异常 / P5-P7 沙盒）
 *   - `apps/backend/tests/unit/t88-plugin-timing.test.ts`（T88 IO 不计入 50ms 预算）
 *
 * core 包按 AGENTS.md 是「零业务依赖的纯算法层」，且 CI（.github/workflows/ci.yml）
 * **先跑 core 测试、且不构建 core/dist** —— backend 源码 import 的 `@invest/core`
 * 在 CI 里解析到 `packages/core/dist/*`（不存在）会直接解析失败。
 * 故 core 测试**不能** import backend 源码（实测会在 CI 挂掉，不是本地能验证的假设）。
 *
 * 因此本文件的做法是：
 *   1. 用 core 的**真实算法**（calculateRSI / calculateSMA，来自 `../src/index.js`）
 *      驱动「策略评估四态」的 4 条路径 —— 算法侧是真的，不是假算法断言；
 *   2. 把真实引擎的 50ms 计时边界（T88 口径：行情 IO 不计入预算）实现成**参考模型**，
 *      逐条对齐 `pluginEngine.ts` 的 arm/disarm/withIo 语义；
 *   3. 末尾的「契约同步守卫」直接读 `apps/backend/src/services/pluginEngine.ts` 源码，
 *      断言真实引擎的常量 / 状态枚举 / 计时边界**没有漂移** ——
 *      模型与实现一旦分家，测试立刻红，不会静默变绿。
 *
 * ⚠️ 本文件**不改**任何 src；模型与真实引擎的对应关系写在下面的注释里。
 * ──────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateRSI, calculateSMA, type DailyKline } from '../src/index.js';

// ---------------------------------------------------------------------------
// 插件契约（core 侧的最小契约）
//
// ⚠️ `src/plugin.ts` 只定义了 DailyKline —— 插件执行接口（Plugin / PluginContext /
//    PluginSignal）的**增强版**在 apps/backend/src/services/pluginEngine.ts。
//    core 包不 import backend（见文件头说明），故这里按 SDD §5.3 的字段在测试内
//    声明一份等价契约，供「插件可实例化 + 契约字段完备」断言使用。
// ---------------------------------------------------------------------------

interface ParamField {
  name: string;
  type: 'integer' | 'number' | 'string' | 'boolean';
  label: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
}

interface PluginSignal {
  direction: 'buy' | 'sell' | 'hold';
  label: string;
  strength?: number;
}

interface PluginContext {
  symbol: string;
  assetClass: 'stock' | 'etf' | 'index';
  klines: DailyKline[];
}

interface Plugin {
  name: string;
  pluginId: string;
  category: 'monitor' | 'filter';
  description: string;
  paramSchema: ParamField[];
  execute(ctx: PluginContext, params: Record<string, unknown>): PluginSignal;
}

// ---------------------------------------------------------------------------
// 50ms 预算参考模型（严格对齐 pluginEngine.ts 的 T88 口径）
//
//   计入预算：execute() 内的指标计算与判断
//   不计入  ：ctx.getDailyKlines() / ctx.batchGetDailyKlines()（行情 IO）
//   实现口径：取数前 disarm 计时器 → 取数后重置计时起点并重新挂满预算
// ---------------------------------------------------------------------------

const PLUGIN_TIMEOUT_MS = 50;

/** 插件执行四态（对应真实引擎的 PluginExecutionStatus） */
type PluginOutcome = 'PASS' | 'WARN' | 'ERROR' | 'SKIP';

/**
 * 四态 ↔ 真实引擎状态枚举的一一对应（ADR-004 的「每条校验返回 PASS/WARN/ERROR/SKIP 四态」
 * 在插件侧的落法）：
 *
 * | 本模型 | 真实引擎 PluginExecutionStatus | 语义 |
 * |---|---|---|
 * | PASS  | SUCCESS | 正常执行并产出信号 |
 * | WARN  | TIMEOUT  | 超出 50ms 预算 → 降级跳过，**主流程正常完成**（SDD §12.5 PE6）|
 * | ERROR | ERROR    | 插件抛异常 → catch 隔离，不影响其他插件 |
 * | SKIP  | SKIP     | 正常执行但无信号（数据不足 / 未命中） |
 */
const OUTCOME_TO_ENGINE_STATUS: Record<PluginOutcome, 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'SKIP'> = {
  PASS: 'SUCCESS',
  WARN: 'TIMEOUT',
  ERROR: 'ERROR',
  SKIP: 'SKIP',
};

interface ModelSignal {
  symbol: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  strength?: number;
  detail?: string;
}

interface ModelResult {
  outcome: PluginOutcome;
  engineStatus: 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'SKIP';
  signals: ModelSignal[];
  /** execute() 纯计算耗时（不含行情 IO） */
  computeMs: number;
  /** 被排除在预算外的行情 IO 累计耗时 */
  ioMs: number;
  error?: string;
}

interface ModelContext {
  getDailyKlines(symbol: string, days: number): Promise<DailyKline[]>;
  batchGetDailyKlines(symbols: string[], days: number): Promise<Map<string, DailyKline[]>>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const round3 = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * 带 50ms 预算的执行器（参考模型）
 *
 * @param execute 插件的 execute()，入参 ctx 的行情方法会被 withIo 包装（IO 不计入预算）
 */
async function runPlugin(
  execute: (ctx: ModelContext) => Promise<ModelSignal[]>,
  ctx: ModelContext,
): Promise<ModelResult> {
  let computeStart = performance.now();
  let ioMs = 0;
  let ioDepth = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: (r: ModelResult) => void = () => { /* 未初始化占位 */ };

  const race = new Promise<ModelResult>((resolve) => { settle = resolve; });

  const disarm = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  const arm = (): void => {
    if (settled) return;
    disarm();
    timer = setTimeout(() => {
      timer = null;
      if (settled) return;
      settled = true;
      settle({
        outcome: 'WARN',
        engineStatus: OUTCOME_TO_ENGINE_STATUS.WARN,
        signals: [],
        computeMs: round3(performance.now() - computeStart),
        ioMs: round3(ioMs),
        error: `执行超过 ${PLUGIN_TIMEOUT_MS}ms 硬超时`,
      });
    }, PLUGIN_TIMEOUT_MS);
  };

  /** 行情 IO 包装：进入前 disarm，结束后重置计时起点并重新挂满预算 */
  const withIo = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (ioDepth > 0) return await fn();
    ioDepth += 1;
    disarm();
    const ioStart = performance.now();
    try {
      return await fn();
    } finally {
      ioMs += performance.now() - ioStart;
      ioDepth -= 1;
      computeStart = performance.now();
      arm();
    }
  };

  const timedCtx: ModelContext = {
    getDailyKlines: (symbol, days) => withIo(() => ctx.getDailyKlines(symbol, days)),
    batchGetDailyKlines: (symbols, days) => withIo(() => ctx.batchGetDailyKlines(symbols, days)),
  };

  arm();
  void (async (): Promise<void> => {
    try {
      const raw = await execute(timedCtx);
      if (!settled) {
        settled = true;
        disarm();
        const signals = raw;
        const computeMs = round3(performance.now() - computeStart);
        if (signals.length === 0) {
          settle({
            outcome: 'SKIP',
            engineStatus: OUTCOME_TO_ENGINE_STATUS.SKIP,
            signals: [],
            computeMs,
            ioMs: round3(ioMs),
          });
        } else {
          settle({
            outcome: 'PASS',
            engineStatus: OUTCOME_TO_ENGINE_STATUS.PASS,
            signals,
            computeMs,
            ioMs: round3(ioMs),
          });
        }
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        disarm();
        const msg = err instanceof Error ? err.message : String(err);
        settle({
          outcome: 'ERROR',
          engineStatus: OUTCOME_TO_ENGINE_STATUS.ERROR,
          signals: [],
          computeMs: round3(performance.now() - computeStart),
          ioMs: round3(ioMs),
          error: msg,
        });
      }
    }
  })();

  return await race;
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 造 n 根日线，close 由 fn(i) 决定 */
function makeKlines(n: number, fn: (i: number) => number): DailyKline[] {
  const out: DailyKline[] = [];
  for (let i = 0; i < n; i++) {
    const close = fn(i);
    out.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
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

/** 单调下跌 → RSI 落到超卖区；单调上涨 → RSI 落不到超卖区 */
const downtrend = (n: number): DailyKline[] => makeKlines(n, (i) => 100 - i * 0.8);
const uptrend = (n: number): DailyKline[] => makeKlines(n, (i) => 10 + i * 0.2);

function makeContext(opts: {
  klines?: DailyKline[];
  ioDelayMs?: number;
} = {}): ModelContext {
  const klines = opts.klines ?? downtrend(30);
  return {
    async getDailyKlines() {
      if (opts.ioDelayMs) await sleep(opts.ioDelayMs);
      return klines;
    },
    async batchGetDailyKlines(symbols) {
      if (opts.ioDelayMs) await sleep(opts.ioDelayMs);
      return new Map(symbols.map((s) => [s, klines]));
    },
  };
}

// ===========================================================================
// ① 原有契约用例（保留）
// ===========================================================================

describe('Plugin 接口契约', () => {
  it('类型可编译：Plugin 实现', () => {
    const plugin: Plugin = {
      name: 'RSI Monitor',
      pluginId: 'rsi_monitor',
      category: 'monitor',
      description: 'RSI 超买超卖监控',
      paramSchema: [
        { name: 'period', type: 'integer', label: '周期', default: 14, min: 2, max: 50 },
        { name: 'oversold', type: 'number', label: '超卖阈值', default: 30, min: 0, max: 50 },
        { name: 'overbought', type: 'number', label: '超买阈值', default: 70, min: 50, max: 100 },
      ],
      execute(ctx, params) {
        const rsi = 50;  // 占位
        if (rsi <= (params.oversold as number)) return { direction: 'buy', label: 'RSI 超卖', strength: 0.8 };
        if (rsi >= (params.overbought as number)) return { direction: 'sell', label: 'RSI 超买', strength: 0.8 };
        return { direction: 'hold', label: 'RSI 中性' };
      },
    };

    expect(plugin.pluginId).toBe('rsi_monitor');
    expect(plugin.paramSchema.length).toBe(3);

    // 调用一次验证返回类型
    const ctx: PluginContext = {
      symbol: 'sh600000',
      assetClass: 'stock',
      klines: [{ date: '2026-10-14', open: 10, high: 11, low: 9, close: 10.5, volume: 1000, amount: 10500 }],
    };
    const result = plugin.execute(ctx, { period: 14, oversold: 30, overbought: 70 }) as PluginSignal;
    expect(['buy', 'sell', 'hold']).toContain(result.direction);
  });
});

// ===========================================================================
// ② SDD §12.5 F6 —— state_machine_4_paths
// ===========================================================================

describe('SDD §12.5 F6 — state_machine_4_paths（插件状态机 4 条路径）', () => {
  it('PASS 路径：RSI(14) 跌破超卖线 30 → 产出 BUY 信号（引擎状态 SUCCESS）', async () => {
    // 用 core 的真实算法算 RSI：30 根下跌 K 线 → RSI 必然落进超卖区
    const closes = downtrend(30).map((k) => k.close);
    const rsi = calculateRSI(closes, 14);
    expect(rsi[rsi.length - 1]).toBeLessThan(30);

    const res = await runPlugin(
      async (ctx) => {
        const klines = await ctx.getDailyKlines('sh600000', 30);
        const values = calculateRSI(klines.map((k) => k.close), 14);
        const latest = values[values.length - 1];
        if (latest >= 30) return [];
        return [{
          symbol: 'sh600000',
          signalType: 'BUY' as const,
          strength: (30 - latest) / 30,
          detail: `RSI(14)=${latest.toFixed(2)} < 30`,
        }];
      },
      makeContext({ klines: downtrend(30) }),
    );

    expect(res.outcome).toBe('PASS');
    expect(res.engineStatus).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('BUY');
    expect(res.computeMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
  });

  it('WARN 路径：execute() 纯计算超时 → 降级跳过，主流程正常完成（引擎状态 TIMEOUT）', async () => {
    const res = await runPlugin(
      async () => {
        await sleep(120);   // 纯计算超时（IO 不计入，这里没有任何 IO）
        return [];
      },
      makeContext(),
    );

    expect(res.outcome).toBe('WARN');
    expect(res.engineStatus).toBe('TIMEOUT');
    expect(res.signals).toEqual([]);
    expect(res.error).toContain(String(PLUGIN_TIMEOUT_MS));
    // 主流程正常完成：调用方拿到的是一个确定的结果对象，不是抛错
    expect(res.outcome).toBeDefined();
  });

  it('ERROR 路径：execute() 抛异常 → 被 catch 隔离（引擎状态 ERROR）', async () => {
    const res = await runPlugin(
      async () => {
        throw new Error('boom');
      },
      makeContext(),
    );

    expect(res.outcome).toBe('ERROR');
    expect(res.engineStatus).toBe('ERROR');
    expect(res.signals).toEqual([]);
    expect(res.error).toContain('boom');
  });

  it('SKIP 路径：行情数据不足（< period+1 根）→ 正常执行但无信号（引擎状态 SKIP）', async () => {
    const res = await runPlugin(
      async (ctx) => {
        const klines = await ctx.getDailyKlines('sh600000', 30);
        if (klines.length < 15) return [];      // period(14) + 1 不足 → 无法评估
        const values = calculateRSI(klines.map((k) => k.close), 14);
        const latest = values[values.length - 1];
        if (latest >= 30) return [];
        return [{ symbol: 'sh600000', signalType: 'BUY' as const, strength: 0.5 }];
      },
      makeContext({ klines: downtrend(10) }),
    );

    expect(res.outcome).toBe('SKIP');
    expect(res.engineStatus).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('四态齐全：PASS / WARN / ERROR / SKIP 各对应一个真实引擎状态枚举', () => {
    expect(Object.keys(OUTCOME_TO_ENGINE_STATUS).sort()).toEqual(['ERROR', 'PASS', 'SKIP', 'WARN']);
    expect(new Set(Object.values(OUTCOME_TO_ENGINE_STATUS)).size).toBe(4);
  });
});

// ===========================================================================
// ③ SDD §12.5 PE6 —— plugin_timeout_50ms（T88 口径）
// ===========================================================================

describe('SDD §12.5 PE6 — plugin_timeout_50ms（50ms 预算只覆盖 execute() 纯计算）', () => {
  it('行情 IO 耗时 120ms（远超 50ms）→ 不判超时，IO 单独计量（ioMs ≥ 100）', async () => {
    const res = await runPlugin(
      async (ctx) => {
        const klines = await ctx.getDailyKlines('sh600000', 30);
        const values = calculateRSI(klines.map((k) => k.close), 14);
        const latest = values[values.length - 1];
        if (latest >= 30) return [];
        return [{ symbol: 'sh600000', signalType: 'BUY' as const, strength: 0.5 }];
      },
      makeContext({ klines: downtrend(30), ioDelayMs: 120 }),
    );

    expect(res.outcome).toBe('PASS');
    expect(res.outcome).not.toBe('WARN');
    expect(res.computeMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
    expect(res.ioMs).toBeGreaterThanOrEqual(100);
  });

  it('批量行情 IO 耗时 150ms → 同样不计入预算（批量 IN 查询与单标的同口径）', async () => {
    const res = await runPlugin(
      async (ctx) => {
        const m = await ctx.batchGetDailyKlines(['sh600000', 'sz000001'], 30);
        if (m.size === 0) return [];
        return [{ symbol: 'sh600000', signalType: 'BUY' as const, strength: 0.5 }];
      },
      makeContext({ klines: downtrend(30), ioDelayMs: 150 }),
    );

    expect(res.outcome).toBe('PASS');
    expect(res.computeMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
    expect(res.ioMs).toBeGreaterThanOrEqual(100);
  });

  it('execute() 纯计算耗时 120ms（不取行情）→ 判超时降级（WARN / TIMEOUT）', async () => {
    const res = await runPlugin(
      async () => {
        await sleep(120);
        return [];
      },
      makeContext(),
    );

    expect(res.outcome).toBe('WARN');
    expect(res.engineStatus).toBe('TIMEOUT');
  });

  it('IO 之后的计算段各自享有完整预算：120ms IO + 120ms 计算 → 仍然超时', async () => {
    const res = await runPlugin(
      async (ctx) => {
        await ctx.getDailyKlines('sh600000', 30);   // IO 不计入
        await sleep(120);                            // 计算段超时
        return [];
      },
      makeContext({ klines: downtrend(30), ioDelayMs: 120 }),
    );

    expect(res.outcome).toBe('WARN');
    expect(res.ioMs).toBeGreaterThanOrEqual(100);
    expect(res.error).toContain(String(PLUGIN_TIMEOUT_MS));
  });

  it('快速计算 → 预算内完成，computeMs < 50ms', async () => {
    const res = await runPlugin(
      async (ctx) => {
        const klines = await ctx.getDailyKlines('sh600000', 30);
        const ma = calculateSMA(klines.map((k) => k.close), 5);
        if (ma[ma.length - 1] === undefined) return [];
        return [{ symbol: 'sh600000', signalType: 'BUY' as const, strength: 0.5 }];
      },
      makeContext({ klines: uptrend(30) }),
    );

    expect(res.outcome).toBe('PASS');
    expect(res.computeMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
    expect(res.ioMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
  });
});

// ===========================================================================
// ④ 契约同步守卫：参考模型镜像的真实引擎不得漂移
// ===========================================================================

describe('契约同步守卫 — 真实引擎 pluginEngine.ts 不得与本参考模型漂移', () => {
  const enginePath = fileURLToPath(
    new URL('../../../apps/backend/src/services/pluginEngine.ts', import.meta.url),
  );
  const engineSrc = fs.readFileSync(enginePath, 'utf-8');

  it('真实引擎的 50ms 常量未变（PLUGIN_TIMEOUT_MS = 50）', () => {
    expect(engineSrc).toContain(`export const PLUGIN_TIMEOUT_MS = ${PLUGIN_TIMEOUT_MS};`);
  });

  it('真实引擎的四态枚举与本模型一一对应（SUCCESS / TIMEOUT / ERROR / SKIP）', () => {
    expect(engineSrc).toContain(
      "export type PluginExecutionStatus = 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'SKIP';",
    );
    for (const status of Object.values(OUTCOME_TO_ENGINE_STATUS)) {
      expect(engineSrc).toContain(`'${status}'`);
    }
  });

  it('真实引擎仍保留 T88 的 IO 排除机制（withIo 包装 + 计时起点重置）', () => {
    expect(engineSrc).toContain('const withIo = async');
    expect(engineSrc).toContain('computeStart = performance.now();  // 取数后重置计时起点');
    expect(engineSrc).toContain('getDailyKlines: (symbol, days) => withIo(');
    expect(engineSrc).toContain('batchGetDailyKlines: (symbols, days) => withIo(');
  });

  it('真实引擎的 50ms 语义仍是「不含行情 IO」（日志文案 + 注释口径）', () => {
    expect(engineSrc).toContain('不含行情 IO');
    expect(engineSrc).toContain('只覆盖纯计算，行情 IO 不计入');
  });
});
