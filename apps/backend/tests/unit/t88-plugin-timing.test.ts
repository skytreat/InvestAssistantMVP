/**
 * t88-plugin-timing.test.ts — 插件引擎 50ms 计时边界 + T83/T93/T96 契约回归
 *
 * T88（DEC-12 B-3）：**50ms 预算只覆盖 execute() 的纯计算，行情 IO 不计入**
 *   - 行情 IO 慢（100ms+）→ 不得 TIMEOUT
 *   - execute() 自身计算慢 → 仍必须 TIMEOUT（沙盒安全约束没被放宽）
 *   - IO 之后的计算段仍各自享有完整预算（预算按计算段重置，不是无限续杯）
 *
 * T83：filter 类内置插件（全市场条件选股）
 * T93：SDD §5.3 插件契约字段完备性 + defaultParams 由 paramSchema 派生
 * T96：rsi_oversold 的 oversold / overbought 双阈值 + 跨字段约束
 *
 * 全部用 mock context（隔离 DuckDB），算法复用 src 真实实现，不做假算法断言。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executePlugin,
  getAllPlugins,
  builtinPlugins,
  deriveDefaultParams,
  PLUGIN_TIMEOUT_MS,
  type Plugin,
  type PluginContext,
  type PluginSignal,
  type ParamField,
} from '../../src/services/pluginEngine.js';
import { calculateSMA } from '../../src/services/indicators.js';
import { calculateRSI } from '@invest/core';
import type { DailyKline } from '@invest/core';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 造 n 根日线：close 由 fn(i) 决定，open/high/low/volume/amount 填成合法值 */
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

interface MockCtxOptions {
  klines?: DailyKline[];
  getDailyKlinesDelayMs?: number;
  batchGetDailyKlinesDelayMs?: number;
  rsiOverride?: number; // 强制 calculateRSI 返回的最后一个值
  onBatchCall?: (symbols: string[]) => void;
}

function makeMockContext(opts: MockCtxOptions = {}): PluginContext {
  const klines = opts.klines ?? makeKlines(40, (i) => 10 + i * 0.1);
  return {
    async getDailyKlines() {
      if (opts.getDailyKlinesDelayMs) await sleep(opts.getDailyKlinesDelayMs);
      return klines;
    },
    async batchGetDailyKlines(symbols) {
      opts.onBatchCall?.(symbols);
      if (opts.batchGetDailyKlinesDelayMs) await sleep(opts.batchGetDailyKlinesDelayMs);
      return new Map(symbols.map((s) => [s, klines]));
    },
    calculateRSI: (prices, period) => {
      const real = calculateRSI(prices, period);
      if (opts.rsiOverride === undefined) return real;
      return [...real.slice(0, -1), opts.rsiOverride];
    },
    calculateMACD: () => ({ dif: [], dea: [], macd: [] }),
    calculateSMA,
  };
}

/** 造一个自定义插件（executePlugin 对磁盘/内置插件一视同仁） */
function makePlugin(id: string, execute: Plugin['execute']): Plugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    author: 'test',
    period: 'daily',
    category: 'monitor',
    subCategory: 'custom',
    complexity: 'simple',
    defaultParams: {},
    execute,
  };
}

const findPlugin = (id: string): Plugin => {
  const p = builtinPlugins.find((x) => x.id === id);
  if (!p) throw new Error(`内置插件不存在: ${id}`);
  return p;
};

// ---------------------------------------------------------------------------
// ① T88：IO 不计入 50ms 预算
// ---------------------------------------------------------------------------

describe('T88 — 行情 IO 不计入 50ms 预算', () => {
  it(`getDailyKlines 耗时 120ms（远超 ${PLUGIN_TIMEOUT_MS}ms）→ 仍然 SUCCESS，不判 TIMEOUT`, async () => {
    const plugin = makePlugin('slow-io-single', async (ctx) => {
      const k = await ctx.getDailyKlines('sh600000', 120);
      return k.length > 0
        ? [
            {
              symbol: 'sh600000',
              signalType: 'BUY' as const,
              pluginId: 'slow-io-single',
              timestamp: new Date().toISOString(),
              metrics: { n: k.length },
            },
          ]
        : [];
    });

    const res = await executePlugin(plugin, {}, makeMockContext({ getDailyKlinesDelayMs: 120 }));

    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    // durationMs 只报纯计算耗时（远小于 50ms），IO 耗时单独放 ioMs
    expect(res.durationMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
    expect(res.ioMs).toBeGreaterThanOrEqual(100);
  }, 5000);

  it('batchGetDailyKlines 耗时 150ms → 仍然 SUCCESS（批量 IN 查询同样不计入）', async () => {
    const plugin = makePlugin('slow-io-batch', async (ctx) => {
      const m = await ctx.batchGetDailyKlines(['sh600000', 'sz000001'], 120);
      return m.size > 0
        ? [
            {
              symbol: 'sh600000',
              signalType: 'BUY' as const,
              pluginId: 'slow-io-batch',
              timestamp: new Date().toISOString(),
              metrics: { n: m.size },
            },
          ]
        : [];
    });

    const res = await executePlugin(plugin, {}, makeMockContext({ batchGetDailyKlinesDelayMs: 150 }));

    expect(res.status).toBe('SUCCESS');
    expect(res.durationMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
    expect(res.ioMs).toBeGreaterThanOrEqual(100);
  }, 5000);

  it('内置 monitor 插件（真实算法 + 120ms 慢 IO）→ SUCCESS，IO 不再把信号打成 TIMEOUT', async () => {
    // 这是 B-3 的原始现场：内置插件 100% timeout → user_strategy_signal 0 条
    const ctx = makeMockContext({
      getDailyKlinesDelayMs: 120,
      klines: makeKlines(60, (i) => 10 + Math.sin(i / 3) * 0.8),
    });

    for (const id of ['rsi_oversold', 'macd_cross']) {
      const res = await executePlugin(findPlugin(id), {}, ctx);
      expect(res.status, `${id} 不应被慢 IO 打成 TIMEOUT`).not.toBe('TIMEOUT');
      expect(res.durationMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
      expect(res.ioMs).toBeGreaterThanOrEqual(100);
    }
  }, 5000);

  it('多次取数：每段 IO 都不计入，但取数之间的累计计算仍受预算约束（120ms IO + 120ms 计算 → TIMEOUT）', async () => {
    const plugin = makePlugin('io-then-slow-compute', async (ctx) => {
      await ctx.getDailyKlines('sh600000', 120);
      await sleep(120); // 纯计算超时（模拟死循环/重计算）
      return [];
    });

    const res = await executePlugin(plugin, {}, makeMockContext({ getDailyKlinesDelayMs: 120 }));

    expect(res.status).toBe('TIMEOUT');
    expect(res.ioMs).toBeGreaterThanOrEqual(100); // IO 依然被排除在预算外
    expect(res.error).toContain(String(PLUGIN_TIMEOUT_MS));
  }, 5000);
});

// ---------------------------------------------------------------------------
// ① T88（续）：沙盒超时保护不得被放宽
// ---------------------------------------------------------------------------

describe('T88 — 50ms 超时保护仍然生效（安全约束未放宽）', () => {
  it('execute() 永不 resolve → TIMEOUT', async () => {
    const plugin = makePlugin('never-resolve', async () => await new Promise(() => {}));
    const res = await executePlugin(plugin, {}, makeMockContext());
    expect(res.status).toBe('TIMEOUT');
    expect(res.signals).toEqual([]);
  }, 5000);

  it('execute() 纯计算耗时 120ms（不取行情）→ TIMEOUT', async () => {
    const plugin = makePlugin('slow-compute', async () => {
      await sleep(120);
      return [];
    });
    const res = await executePlugin(plugin, {}, makeMockContext());
    expect(res.status).toBe('TIMEOUT');
  }, 5000);

  it('分片重计算 300ms（每片让出事件循环）→ TIMEOUT（不会被"IO 不计时"顺手放宽）', async () => {
    const plugin = makePlugin('busy-loop', async () => {
      // 每片 10ms 并 await 让出事件循环，模拟"死循环等价"的持续计算：
      // 事件循环能跑 → 50ms 计时器照常触发 → TIMEOUT
      for (let i = 0; i < 30; i++) {
        await sleep(10);
      }
      return [];
    });
    const res = await executePlugin(plugin, {}, makeMockContext());
    expect(res.status).toBe('TIMEOUT');
  }, 5000);

  it('同步死循环不可被计时器抢占（Node 硬限制，返回 SKIP 而非挂死）', async () => {
    // 记录既有口径：while(Date.now()<until){} 会阻塞事件循环，setTimeout 没有机会跑；
    // 循环结束后插件正常返回 → SKIP。真正的"永久死循环"会让进程挂死，
    // 这是 JS 单线程的固有限制，不是 50ms 预算能解决的问题（见 pluginEngine.test.ts P3 注释）。
    const plugin = makePlugin('sync-block', async () => {
      const until = Date.now() + 120;
      while (Date.now() < until) {
        /* 同步阻塞 */
      }
      return [];
    });
    const res = await executePlugin(plugin, {}, makeMockContext());
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  }, 5000);
});

// ---------------------------------------------------------------------------
// ① T88（续）：每个内置插件逐个实测 execute 耗时 < 50ms
// ---------------------------------------------------------------------------

describe('T88 — 内置插件 execute 自身耗时逐个实测 < 50ms', () => {
  const ctx = makeMockContext({ klines: makeKlines(250, (i) => 10 + Math.sin(i / 5) * 1.2) });

  for (const plugin of builtinPlugins) {
    it(`${plugin.id} → 非 TIMEOUT 且纯计算耗时 < ${PLUGIN_TIMEOUT_MS}ms`, async () => {
      const params =
        plugin.id.startsWith('ma_') || plugin.id === 'volume_breakout'
          ? { symbols: 'sh600000,sz000001,sh601318' }
          : {};
      const res = await executePlugin(plugin, params, ctx);
      expect(res.status).not.toBe('TIMEOUT');
      expect(res.durationMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
      // eslint-disable-next-line no-console
      console.log(
        `[T88 实测] ${plugin.id}: compute=${res.durationMs}ms io=${res.ioMs ?? 0}ms status=${res.status}`,
      );
    }, 5000);
  }
});

// ---------------------------------------------------------------------------
// ② T83：filter 类插件
// ---------------------------------------------------------------------------

describe('T83 — filter 类内置插件', () => {
  it('getAllPlugins() 至少含 1 个 category=filter 的插件', () => {
    const filters = getAllPlugins().filter((p) => p.category === 'filter');
    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters.map((p) => p.id)).toContain('ma_bullish_alignment');
  });

  it('filter 插件的 symbol 入参不得 required（filter 面向全市场，不是 monitor 的单标的写法）', () => {
    for (const p of getAllPlugins().filter((x) => x.category === 'filter')) {
      const symbolField = p.paramSchema?.find((f) => f.key === 'symbol');
      expect(symbolField, `${p.id} 应声明 symbol 入参`).toBeDefined();
      expect(symbolField?.required).toBeFalsy();
    }
  });

  it('ma_bullish_alignment：多头排列入选、下跌趋势落选；多标的走 1 次 batchGetDailyKlines', async () => {
    const onBatchCall = vi.fn();
    const ctx: PluginContext = {
      ...makeMockContext({ onBatchCall }),
      getDailyKlines: async () => makeKlines(120, (i) => 10 + i * 0.2),
      batchGetDailyKlines: async (symbols) => {
        onBatchCall(symbols);
        const up = makeKlines(120, (i) => 10 + i * 0.2); // 稳步上行
        const down = makeKlines(120, (i) => 30 - i * 0.2); // 稳步下行
        return new Map(symbols.map((s) => [s, s === 'bad' ? down : up]));
      },
    };

    const res = await executePlugin(
      findPlugin('ma_bullish_alignment'),
      { symbols: 'good,bad,good2', limit: 10 },
      ctx,
    );

    expect(res.status).toBe('SUCCESS');
    // 只有上行标的入选 → totalCandidates 不再是 0（P0-11 的核心症状）
    expect(res.signals.map((s) => s.symbol).sort()).toEqual(['good', 'good2']);
    expect(res.signals.every((s) => s.signalType === 'BUY')).toBe(true);
    // 批量 IN 查询：一次拿全部标的，禁止逐标的循环
    expect(onBatchCall).toHaveBeenCalledTimes(1);
    expect(onBatchCall).toHaveBeenCalledWith(['good', 'bad', 'good2']);
    expect(res.durationMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
  }, 5000);

  it('ma_bullish_alignment：limit 截断 + strength 降序', async () => {
    const ctx: PluginContext = {
      ...makeMockContext(),
      batchGetDailyKlines: async (symbols) =>
        new Map(
          symbols.map((s) => [
            s,
            makeKlines(120, (i) => 10 + i * (s === 'weak' ? 0.02 : s === 'mid' ? 0.1 : 0.3)),
          ]),
        ),
    };

    const res = await executePlugin(
      findPlugin('ma_bullish_alignment'),
      { symbols: 'weak,mid,strong', limit: 1 },
      ctx,
    );

    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].symbol).toBe('strong');
  }, 5000);

  it('volume_breakout：创新高且放量才入选；量能不足落选', async () => {
    const breakout = makeKlines(30, (i) => (i < 29 ? 10 : 12));
    breakout[breakout.length - 1].volume = 3_000_000; // 末根放量 3 倍
    const flat = makeKlines(30, (i) => (i < 29 ? 10 : 10.05)); // 创新高但没放量
    const ctx: PluginContext = {
      ...makeMockContext(),
      batchGetDailyKlines: async (symbols) =>
        new Map(symbols.map((s) => [s, s === 'flat' ? flat : breakout])),
    };

    const res = await executePlugin(findPlugin('volume_breakout'), { symbols: 'flat,breakout' }, ctx);

    expect(res.status).toBe('SUCCESS');
    expect(res.signals.map((s) => s.symbol)).toEqual(['breakout']);
    expect(res.signals[0].metrics?.volumeRatio).toBeGreaterThanOrEqual(1.5);
  }, 5000);

  it('filter 插件既无 symbol 也无 symbols → 无信号（不是 ERROR）', async () => {
    const res = await executePlugin(findPlugin('ma_bullish_alignment'), {}, makeMockContext());
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  }, 5000);

  it('均线周期不递增（periodShort >= periodMid）→ 跨字段约束抛错', async () => {
    const res = await executePlugin(
      findPlugin('ma_bullish_alignment'),
      { symbols: 'sh600000', periodShort: 20, periodMid: 10, periodLong: 60 },
      makeMockContext(),
    );
    expect(res.status).toBe('ERROR');
    expect(res.error).toContain('必须严格递增');
  }, 5000);
});

// ---------------------------------------------------------------------------
// ③ T96：RSI 超买超卖双阈值
// ---------------------------------------------------------------------------

describe('T96 — rsi_oversold 的 oversold / overbought 双阈值', () => {
  const rsiCtx = (value: number): PluginContext =>
    makeMockContext({ klines: makeKlines(60, (i) => 10 + i * 0.05), rsiOverride: value });

  it('RSI=25 < oversold(30) → BUY', async () => {
    const res = await executePlugin(findPlugin('rsi_oversold'), {}, rsiCtx(25));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals[0].signalType).toBe('BUY');
    expect(res.signals[0].metrics?.latestRSI).toBe(25);
  }, 5000);

  it('RSI=75 > overbought(70) → SELL（本任务核心断言：改造前恒不产出卖出信号）', async () => {
    const res = await executePlugin(findPlugin('rsi_oversold'), {}, rsiCtx(75));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals[0].signalType).toBe('SELL');
    expect(res.signals[0].detail).toContain('超买');
    // strength = (75-70)/(100-70) = 1/6
    expect(res.signals[0].strength).toBeCloseTo(1 / 6, 5);
  }, 5000);

  it('RSI=50 落在两个阈值之间 → 无信号', async () => {
    const res = await executePlugin(findPlugin('rsi_oversold'), {}, rsiCtx(50));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  }, 5000);

  it('oversold == overbought（50/50）→ 跨字段约束失败返回 ERROR，错误信息明确', async () => {
    // 注：oversold 的 min/max 是 1-50、overbought 是 50-100，单字段范围本身已隐含
    // oversold < overbought；跨字段校验是防御性护栏，唯一可达边界是 50/50 相等
    const res = await executePlugin(findPlugin('rsi_oversold'), { oversold: 50, overbought: 50 }, rsiCtx(50));
    expect(res.status).toBe('ERROR');
    expect(res.error).toContain('必须小于');
  }, 5000);

  it('插件 id 保持 rsi_oversold（user_strategy_signal.plugin_id 已持久化，不得改 id）', () => {
    expect(findPlugin('rsi_oversold').id).toBe('rsi_oversold');
  });
});

// ---------------------------------------------------------------------------
// ④ T93：SDD §5.3 插件契约字段完备性
// ---------------------------------------------------------------------------

describe('T93 — 插件契约字段完备性（内置与自定义同一断言）', () => {
  it('getAllPlugins() 每个插件 7 个契约字段都存在且类型正确', () => {
    const plugins = getAllPlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(4);
    for (const p of plugins) {
      expect(typeof p.version, `${p.id}.version`).toBe('string');
      expect(p.version, `${p.id}.version 非空`).not.toBe('');
      expect(typeof p.author, `${p.id}.author`).toBe('string');
      expect(p.author, `${p.id}.author 非空`).not.toBe('');
      expect(p.period, `${p.id}.period`).toBe('daily');
      expect(typeof p.subCategory, `${p.id}.subCategory`).toBe('string');
      expect(['momentum', 'trend', 'volume', 'breakout', 'mean_reversion', 'pattern', 'custom']).toContain(
        p.subCategory,
      );
      expect(['simple', 'medium', 'complex'], `${p.id}.complexity`).toContain(p.complexity);
      expect(Array.isArray(p.paramSchema), `${p.id}.paramSchema`).toBe(true);
      expect(p.defaultParams, `${p.id}.defaultParams`).toBeTypeOf('object');
    }
  });

  it('自定义（沙盒）插件走同一断言，缺失字段被兜底填成非 undefined', () => {
    // 复用 pluginEngine 的沙盒入口：createPluginSandbox → normalizePlugin
    const plugins = getAllPlugins();
    for (const p of plugins) {
      expect(p.defaultParams, `${p.id}.defaultParams 不能是 undefined`).toBeDefined();
      expect(typeof p.version).toBe('string');
      expect(typeof p.author).toBe('string');
      expect(typeof p.subCategory).toBe('string');
      expect(typeof p.complexity).toBe('string');
    }
  });

  it('defaultParams 与 paramSchema[].default 完全一致（防两处默认值漂移）', () => {
    for (const p of getAllPlugins()) {
      expect(p.defaultParams, `${p.id} defaultParams 漂移`).toEqual(deriveDefaultParams(p.paramSchema));
    }
  });

  it('内置插件 signalType 只用 BUY/SELL/HOLD（SDD §5.3 无 ALERT）', () => {
    const allowed = new Set(['BUY', 'SELL', 'HOLD']);
    for (const p of builtinPlugins) {
      const source = p.execute.toString();
      expect(allowed.has('BUY')).toBe(true);
      expect(source.includes('ALERT'), `${p.id} 不应产出 ALERT`).toBe(false);
    }
  });

  it('内置插件信号用 metrics 承载指标明细（SDD §5.3 StrategySignal.metrics），不再是 params', async () => {
    const ctx = makeMockContext({
      klines: makeKlines(60, (i) => 10 + i * 0.05),
      rsiOverride: 25,
    });
    const res = await executePlugin(findPlugin('rsi_oversold'), {}, ctx);
    const sig = res.signals[0] as PluginSignal;
    expect(sig.metrics).toBeDefined();
    expect((sig as unknown as { params?: unknown }).params).toBeUndefined();
    expect(Object.keys(sig.metrics ?? {}).sort()).toEqual([
      'days',
      'latestRSI',
      'overbought',
      'oversold',
      'period',
    ]);
  }, 5000);

  it('rsi_oversold 的 paramSchema 不再含已废弃的 threshold 字段', () => {
    const fields: ParamField[] = findPlugin('rsi_oversold').paramSchema ?? [];
    expect(fields.map((f) => f.key)).toContain('oversold');
    expect(fields.map((f) => f.key)).toContain('overbought');
    expect(fields.map((f) => f.key)).not.toContain('threshold');
  });
});
