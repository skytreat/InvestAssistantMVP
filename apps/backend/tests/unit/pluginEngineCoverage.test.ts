/**
 * pluginEngineCoverage.test.ts — T86b 覆盖率补齐（插件引擎分支覆盖）
 *
 * 🔴 **为什么需要这个文件**：T86b 要恢复 SDD §12.2 的「插件引擎 ≥90% 行 / ≥85% 分支」门槛。
 * 实测（2026-10-21，`MARKET_DATA_MODE=mini`）：`pluginEngine.ts` 行覆盖 91.08%、
 * **分支覆盖仅 72.31%**（175/242）—— 行覆盖勉强过线，分支覆盖差 13 个百分点。
 *
 * 本文件**只补分支**，不重复 `pluginEngine.test.ts`（P3/P4/P5/P6/P7）已覆盖的路径。
 *
 * 覆盖清单（按源码位置）：
 *   - `normalizePlugin`（:201-237）契约字段缺失 → 兜底值 + WARN
 *   - `parseFilterSymbols`（:266-278）非字符串入参
 *   - 内置插件分支：`rsi_oversold` RSI 为空、`macd_cross` 金叉/死叉、
 *     `ma_bullish_alignment` 样本不足/均线为 undefined/排序截断、
 *     `volume_breakout` 空标的/样本不足/均量为 0/正常突破
 *   - `loadPluginsFromDir`（:637-704）目录不可读 / stat 失败 / 读取失败 / 路径逃逸 / 沙盒失败
 *   - `createPluginSandbox`（:725-848）导出非对象 / 缺 id/name/category/execute / 导出函数 / 异常
 *   - `validatePluginParams`（:892-992）无 default 非必填 / number 越界 / select 非字符串 / 跨字段异常
 *   - `buildPluginContext`（:1020-1048）预取命中 / days=0 / period 缺省
 *   - `executeAllPlugins`（:1301-1408）标的域模式下 SUCCESS/TIMEOUT/ERROR/SKIP 四种统计分支
 *
 * ⚠️ **不依赖 DuckDB**：`marketData.ts` 的 `getDailyRange` / `batchGetDailyRange`
 * 一律 mock（`vi.spyOn` 对 Vite SSR 转换后的模块命名空间有效 —— 与
 * `validator_deep.test.ts` 对 `queryDuckDB` 的做法同一套路）。
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  builtinPlugins,
  buildPluginContext,
  createPluginSandbox,
  executeAllPlugins,
  executePlugin,
  loadPluginsFromDir,
  normalizePlugin,
  normalizeSubCategory,
  validatePluginParams,
  type Plugin,
  type PluginContext,
} from '../../src/services/pluginEngine.js';
import { calculateBoll, type DailyKline } from '@invest/core';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 构造一根日线 */
function kline(date: string, close: number, extra?: Partial<DailyKline>): DailyKline {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    amount: close * 1000,
    ...extra,
  };
}

/** 构造一段递增收盘价的日线（用于均线多头排列） */
function risingKlines(n: number): DailyKline[] {
  return Array.from({ length: n }, (_, i) =>
    kline(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 10 + i, {
      high: 10 + i + 0.5,
      low: 10 + i - 0.5,
    }),
  );
}

/**
 * MACD 金叉 / 死叉用的收盘价序列（121 根）
 *
 * ⚠️ **为什么是硬编码的序列**：`macd_cross` 插件调用的是 **core 的真实 `calculateMACD`**
 * （不是 `ctx.calculateMACD`）⇒ mock ctx 改不了它的 DIF/DEA。
 * 序列构造：前 120 根等差下跌（-0.5/根），最后一根急拉 +2.5
 * ⇒ DIF 在最后一根上穿 DEA（实测 `dif[119] <= dea[119] && dif[120] > dea[120]` 成立）。
 * 死叉序列取其镜像（200 - close）⇒ EMA 对取反线性 ⇒ 上下翻转成交叉。
 */
const MACD_GOLDEN_CLOSES = [
  100, 99.5, 99, 98.5, 98, 97.5, 97, 96.5, 96, 95.5, 95, 94.5, 94, 93.5, 93, 92.5, 92, 91.5, 91, 90.5, 90,
  89.5, 89, 88.5, 88, 87.5, 87, 86.5, 86, 85.5, 85, 84.5, 84, 83.5, 83, 82.5, 82, 81.5, 81, 80.5, 80, 79.5,
  79, 78.5, 78, 77.5, 77, 76.5, 76, 75.5, 75, 74.5, 74, 73.5, 73, 72.5, 72, 71.5, 71, 70.5, 70, 69.5, 69,
  68.5, 68, 67.5, 67, 66.5, 66, 65.5, 65, 64.5, 64, 63.5, 63, 62.5, 62, 61.5, 61, 60.5, 60, 59.5, 59, 58.5,
  58, 57.5, 57, 56.5, 56, 55.5, 55, 54.5, 54, 53.5, 53, 52.5, 52, 51.5, 51, 50.5, 50, 49.5, 49, 48.5, 48,
  47.5, 47, 46.5, 46, 45.5, 45, 44.5, 44, 43.5, 43, 42.5, 42, 41.5, 41, 40.5, 42.5,
];
/** 死叉序列 = 金叉序列的镜像 */
const MACD_DEAD_CLOSES = MACD_GOLDEN_CLOSES.map((c) => 200 - c);

/** 把收盘价序列转成日线 */
function closesToKlines(closes: number[]): DailyKline[] {
  return closes.map((c, i) =>
    kline(
      `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      c,
    ),
  );
}

/**
 * 可配置的 mock context
 *
 * ⚠️ `calculateSMA` 用**简化实现**（等比均值）而不是真实 SMA ——
 * 插件引擎只关心「均线数组在末尾位置是否 undefined / 满足 short>mid>long」，
 * 不需要真实 SMA 的数值口径（真实口径由 `apps/backend/tests/unit/t51-indicators.test.ts` 覆盖）。
 */
function makeCtx(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    async getDailyKlines() {
      return [];
    },
    async batchGetDailyKlines() {
      return new Map<string, DailyKline[]>();
    },
    calculateRSI: () => [],
    calculateMACD: () => ({ dif: [], dea: [], macd: [] }),
    calculateSMA: (prices: number[], period: number) => {
      const out: (number | undefined)[] = [];
      for (let i = 0; i < prices.length; i += 1) {
        if (i < period - 1) {
          out.push(undefined);
          continue;
        }
        const win = prices.slice(i - period + 1, i + 1);
        out.push(win.reduce((a, b) => a + b, 0) / win.length);
      }
      return out;
    },
    ...overrides,
  };
}

/** 取内置插件（找不到直接失败，避免用例静默跳过） */
function builtin(id: string): Plugin {
  const p = builtinPlugins.find((x) => x.id === id);
  if (!p) throw new Error(`内置插件 ${id} 不存在`);
  return p;
}

/**
 * 插件引擎的磁盘加载目录（临时目录，测试结束删除）
 *
 * 🔴 **必须用 `vi.hoisted`**：`pluginEngine.ts` 在**模块加载时**求值
 * `PLUGIN_ALLOWED_PATH = process.env.PLUGIN_ALLOWED_PATH ?? 默认值` ——
 * 而 `import` 语句会被提升到模块体之前 ⇒ 普通的 `process.env.X = ...`
 * 赋值跑得太晚，引擎读到的仍是默认值。
 * `vi.hoisted` 的回调在**所有 import 之前**执行 ⇒ 时序成立。
 */
const pluginDir: string = await vi.hoisted(async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'invest-plugin-cov-'));
  // ⚠️ 源码必须**内联在回调里** —— `vi.hoisted` 会被提升到模块体之前，
  //    引用模块体里的 const 会撞 TDZ。
  fsMod.writeFileSync(
    pathMod.join(dir, 'probe.js'),
    `return {
  id: 'probe',
  name: '探针插件',
  version: '1.0.0',
  author: 'test',
  period: 'daily',
  category: 'monitor',
  sub_category: 'custom',
  complexity: 'simple',
  paramSchema: [
    { key: 'mode', label: '模式', type: 'string', default: 'ok' },
  ],
  async execute(ctx, params) {
    const mode = params.mode;
    if (mode === 'timeout') {
      await new Promise(() => {});
      return [];
    }
    if (mode === 'error') throw new Error('probe boom');
    if (mode === 'skip') return [];
    return [{
      symbol: 'sh600000',
      signalType: 'BUY',
      strength: 0.5,
      pluginId: 'probe',
      timestamp: new Date().toISOString(),
      metrics: {},
      detail: 'probe ok',
    }];
  },
};`,
    'utf-8',
  );
  process.env.PLUGIN_ALLOWED_PATH = dir;
  return dir;
});

/** 原始的 PLUGIN_ALLOWED_PATH（测试结束后还原，避免漏给下一个测试文件） */
const ORIGINAL_PLUGIN_ALLOWED_PATH = process.env.PLUGIN_ALLOWED_PATH;

afterAll(() => {
  try {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_PLUGIN_ALLOWED_PATH !== undefined) {
    process.env.PLUGIN_ALLOWED_PATH = ORIGINAL_PLUGIN_ALLOWED_PATH;
  } else {
    delete process.env.PLUGIN_ALLOWED_PATH;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. normalizePlugin —— 契约字段缺失 → 兜底值
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — normalizePlugin 契约兜底', () => {
  it('契约字段全缺 → 按兜底值补齐（version/author/period/sub_category/complexity）', () => {
    const p = normalizePlugin({
      id: 'no-contract',
      name: '缺契约字段的插件',
      category: 'monitor',
      execute: async () => [],
    } as unknown as Plugin);

    expect(p.version).toBe('0.0.0');
    expect(p.author).toBe('custom');
    expect(p.period).toBe('daily');
    expect(p.subCategory).toBe('custom');
    expect(p.complexity).toBe('simple');
    // 无 paramSchema → defaultParams 为空对象
    expect(p.defaultParams).toEqual({});
  });

  it('契约字段齐全 → 原样保留，不触发兜底', () => {
    const p = normalizePlugin({
      id: 'full-contract',
      name: '契约齐全',
      version: '2.3.4',
      author: 'someone',
      period: 'daily',
      category: 'monitor',
      subCategory: 'momentum',
      complexity: 'complex',
      execute: async () => [],
    } as unknown as Plugin);

    expect(p.version).toBe('2.3.4');
    expect(p.author).toBe('someone');
    expect(p.subCategory).toBe('momentum');
    expect(p.complexity).toBe('complex');
  });

  it('自带非空 defaultParams → 优先于 paramSchema 派生值', () => {
    const p = normalizePlugin({
      id: 'has-defaults',
      name: '自带默认值',
      version: '1.0.0',
      author: 'a',
      period: 'daily',
      category: 'monitor',
      subCategory: 'custom',
      complexity: 'simple',
      defaultParams: { x: 1 },
      paramSchema: [{ key: 'x', label: 'x', type: 'number', default: 9 }],
      execute: async () => [],
    } as unknown as Plugin);

    expect(p.defaultParams).toEqual({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
// 1b. normalizeSubCategory —— 旧值映射的唯一入口（V3 §4.1 六分类）
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — normalizeSubCategory 旧值映射', () => {
  it('六类原值直通，不改写', () => {
    for (const v of ['trend', 'momentum', 'volatility', 'volume', 'pattern', 'risk', 'custom'] as const) {
      expect(normalizeSubCategory(v, 'p')).toBe(v);
    }
  });

  it('breakout（旧口径）→ volume', () => {
    expect(normalizeSubCategory('breakout', 'legacy-breakout')).toBe('volume');
  });

  it('mean_reversion（旧口径）→ volatility', () => {
    expect(normalizeSubCategory('mean_reversion', 'legacy-mr')).toBe('volatility');
  });

  it('无法识别的字符串 → custom（降级不抛错）', () => {
    expect(normalizeSubCategory('unknown-class', 'weird')).toBe('custom');
  });

  it('非字符串 / 空串 → custom', () => {
    expect(normalizeSubCategory(undefined, 'no-field')).toBe('custom');
    expect(normalizeSubCategory(null, 'null-field')).toBe('custom');
    expect(normalizeSubCategory('', 'empty')).toBe('custom');
  });

  it('内置 volume_breakout 已迁移到 volume（无 breakout 残留）', () => {
    const p = builtinPlugins.find((x) => x.id === 'volume_breakout');
    expect(p?.subCategory).toBe('volume');
  });
});

// ---------------------------------------------------------------------------
// 2. 内置插件的分支
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — 内置插件分支', () => {
  it('rsi_oversold：RSI 序列为空 → 无信号', async () => {
    const ctx = makeCtx({ calculateRSI: () => [] });
    const signals = await builtin('rsi_oversold').execute(ctx, {
      symbol: 'sh600000',
      period: 14,
      oversold: 30,
      overbought: 70,
      days: 120,
    });
    expect(signals).toEqual([]);
  });

  it('macd_cross：金叉 → 产出 BUY 信号', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return closesToKlines(MACD_GOLDEN_CLOSES);
      },
    });
    const signals = await builtin('macd_cross').execute(ctx, {
      symbol: 'sh600000',
      fast: 12,
      slow: 26,
      signal: 9,
      days: 120,
    });
    expect(Array.isArray(signals)).toBe(true);
    expect((signals as { signalType: string }[])[0].signalType).toBe('BUY');
  });

  it('macd_cross：死叉 → 产出 SELL 信号', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return closesToKlines(MACD_DEAD_CLOSES);
      },
    });
    const signals = await builtin('macd_cross').execute(ctx, {
      symbol: 'sh600000',
      fast: 12,
      slow: 26,
      signal: 9,
      days: 120,
    });
    expect((signals as { signalType: string }[])[0].signalType).toBe('SELL');
  });

  it('macd_cross：K 线不足 → 无信号', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return closesToKlines(MACD_GOLDEN_CLOSES.slice(0, 10));
      },
    });
    const signals = await builtin('macd_cross').execute(ctx, {
      symbol: 'sh600000',
      fast: 12,
      slow: 26,
      signal: 9,
      days: 120,
    });
    expect(signals).toEqual([]);
  });

  it('ma_bullish_alignment：K 线不足 → 跳过该标的', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return risingKlines(3);
      },
    });
    const signals = await builtin('ma_bullish_alignment').execute(ctx, {
      symbol: 'sh600000',
      periodShort: 5,
      periodMid: 10,
      periodLong: 20,
      days: 120,
      limit: 10,
    });
    expect(signals).toEqual([]);
  });

  it('ma_bullish_alignment：均线数组为空（undefined）→ 跳过该标的', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return risingKlines(25);
      },
      calculateSMA: () => [],
    });
    const signals = await builtin('ma_bullish_alignment').execute(ctx, {
      symbol: 'sh600000',
      periodShort: 5,
      periodMid: 10,
      periodLong: 20,
      days: 120,
      limit: 10,
    });
    expect(signals).toEqual([]);
  });

  it('ma_bullish_alignment：多头排列 → 产出 BUY 信号并按 strength 排序截断', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return risingKlines(25);
      },
    });
    const signals = (await builtin('ma_bullish_alignment').execute(ctx, {
      symbol: 'sh600000',
      periodShort: 5,
      periodMid: 10,
      periodLong: 20,
      days: 120,
      limit: 10,
    })) as { signalType: string; symbol: string }[];
    expect(signals.length).toBe(1);
    expect(signals[0].signalType).toBe('BUY');
    expect(signals[0].symbol).toBe('sh600000');
  });

  it('ma_bullish_alignment：批量模式（多标的）→ 走 batchGetDailyKlines', async () => {
    const batchCalls: string[][] = [];
    const ctx = makeCtx({
      async batchGetDailyKlines(symbols: string[]) {
        batchCalls.push(symbols);
        return new Map<string, DailyKline[]>();
      },
    });
    const signals = await builtin('ma_bullish_alignment').execute(ctx, {
      symbols: 'sh600000,sz000001',
      periodShort: 5,
      periodMid: 10,
      periodLong: 20,
      days: 120,
      limit: 10,
    });
    expect(batchCalls).toEqual([['sh600000', 'sz000001']]);
    expect(signals).toEqual([]);
  });

  it('ma_bullish_alignment：symbols 非字符串 → 忽略该入参', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return [];
      },
    });
    const signals = await builtin('ma_bullish_alignment').execute(ctx, {
      symbols: 123,
      symbol: 'sh600000',
      periodShort: 5,
      periodMid: 10,
      periodLong: 20,
      days: 120,
      limit: 10,
    });
    expect(signals).toEqual([]);
  });

  it('volume_breakout：标的为空 → 无信号', async () => {
    const ctx = makeCtx();
    const signals = await builtin('volume_breakout').execute(ctx, {
      symbol: '',
      symbols: '',
      lookback: 20,
      volumeRatio: 1.5,
      days: 120,
      limit: 10,
    });
    expect(signals).toEqual([]);
  });

  it('volume_breakout：K 线不足 → 跳过该标的', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return risingKlines(5);
      },
    });
    const signals = await builtin('volume_breakout').execute(ctx, {
      symbol: 'sh600000',
      lookback: 20,
      volumeRatio: 1.5,
      days: 120,
      limit: 10,
    });
    expect(signals).toEqual([]);
  });

  it('volume_breakout：前窗口成交量为 0 → 跳过该标的', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        return Array.from({ length: 25 }, (_, i) =>
          kline(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 10 + i, { volume: 0, amount: 0 }),
        );
      },
    });
    const signals = await builtin('volume_breakout').execute(ctx, {
      symbol: 'sh600000',
      lookback: 20,
      volumeRatio: 1.5,
      days: 120,
      limit: 10,
    });
    expect(signals).toEqual([]);
  });

  it('volume_breakout：收盘创新高且放量 → 产出 BUY 信号', async () => {
    const ctx = makeCtx({
      async getDailyKlines() {
        const bars = Array.from({ length: 24 }, (_, i) =>
          kline(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 10 + i * 0.1, {
            high: 10 + i * 0.1 + 0.05,
            volume: 1000,
          }),
        );
        // 最后一根：收盘创新高 + 成交量放大 5 倍
        bars.push(kline('2026-02-01', 20, { high: 20.5, volume: 5000 }));
        return bars;
      },
    });
    const signals = (await builtin('volume_breakout').execute(ctx, {
      symbol: 'sh600000',
      lookback: 20,
      volumeRatio: 1.5,
      days: 120,
      limit: 10,
    })) as { signalType: string }[];
    expect(signals.length).toBe(1);
    expect(signals[0].signalType).toBe('BUY');
  });
});

// ---------------------------------------------------------------------------
// 3. loadPluginsFromDir —— 磁盘加载的异常与边界路径
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — loadPluginsFromDir 磁盘加载', () => {
  it('目录不存在 → 返回空数组（不抛错）', () => {
    const loaded = loadPluginsFromDir(path.join(os.tmpdir(), 'invest-plugin-not-exist-xyz'));
    expect(loaded).toEqual([]);
  });

  it('readdirSync 抛非 Error → detail 走 String(err) 分支', () => {
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      // ⚠️ 故意抛**非 Error**（字符串）—— 覆盖 `err instanceof Error ? err.message : String(err)`
      //    的 else 分支。生产代码不会这么抛，但 `catch` 的兜底分支必须被测到。
      // eslint-disable-next-line no-throw-literal
      throw 'plain-string-error';
    });
    const loaded = loadPluginsFromDir(pluginDir);
    expect(loaded).toEqual([]);
  });

  it('statSync 失败 → 跳过该文件，其余正常加载', () => {
    const realStat = fs.statSync.bind(fs);
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p).endsWith('probe.js')) throw new Error('stat failed');
      return realStat(p);
    }) as typeof fs.statSync);
    const loaded = loadPluginsFromDir(pluginDir);
    expect(loaded).toEqual([]);
  });

  it('readFileSync 失败 → 跳过该文件', () => {
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('probe.js')) throw new Error('read failed');
      return (realRead as (...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const loaded = loadPluginsFromDir(pluginDir);
    expect(loaded).toEqual([]);
  });

  it('路径逃逸（resolved 不在允许目录内）→ 拦截并跳过', () => {
    const realResolve = path.resolve.bind(path);
    vi.spyOn(path, 'resolve').mockImplementation(((p: string, ...rest: string[]) => {
      if (typeof p === 'string' && p.endsWith('probe.js')) return '/outside/escape.js';
      return (realResolve as (...a: string[]) => string)(p, ...rest);
    }) as typeof path.resolve);
    const loaded = loadPluginsFromDir(pluginDir);
    expect(loaded).toEqual([]);
  });

  it('沙盒创建失败（源码语法错误）→ 跳过该文件', () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-plugin-bad-'));
    fs.writeFileSync(path.join(badDir, 'broken.js'), 'return { this is not valid js', 'utf-8');
    const loaded = loadPluginsFromDir(badDir);
    fs.rmSync(badDir, { recursive: true, force: true });
    expect(loaded).toEqual([]);
  });

  it('合法插件文件 → 正常加载（走完整沙盒链路）', () => {
    const loaded = loadPluginsFromDir(pluginDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe('probe');
    expect(loaded[0].category).toBe('monitor');
  });

  it('非 .js / 非法文件名的文件 → 直接跳过', () => {
    const mixedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-plugin-mixed-'));
    fs.writeFileSync(path.join(mixedDir, 'readme.md'), '# 不是插件', 'utf-8');
    fs.writeFileSync(path.join(mixedDir, 'BadName.js'), 'return {};', 'utf-8');
    fs.writeFileSync(
      path.join(mixedDir, 'ok.js'),
      "return { id: 'ok', name: 'OK', category: 'monitor', execute: async () => [] };",
      'utf-8',
    );
    const loaded = loadPluginsFromDir(mixedDir);
    fs.rmSync(mixedDir, { recursive: true, force: true });
    // 只允许 `ok.js`（BadName.js 大写不匹配 /^[a-z0-9_-]+\.js$/，readme.md 非 .js）
    expect(loaded.map((p) => p.id)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// 4. createPluginSandbox —— 契约校验与异常路径
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — createPluginSandbox 契约校验', () => {
  const validBody = `id: 'x', name: 'X', category: 'monitor', execute: async () => []`;

  it('导出非对象 → 抛「插件必须导出一个对象」', () => {
    expect(() => createPluginSandbox('return 42;')).toThrow(/必须导出一个对象/);
  });

  it('导出 null → 抛「插件必须导出一个对象」', () => {
    expect(() => createPluginSandbox('return null;')).toThrow(/必须导出一个对象/);
  });

  it('缺少 id → 抛「插件缺少字符串类型的 id」', () => {
    expect(() =>
      createPluginSandbox(`return { name: 'X', category: 'monitor', execute: async () => [] };`),
    ).toThrow(/缺少字符串类型的 id/);
  });

  it('缺少 name → 抛「插件缺少字符串类型的 name」', () => {
    expect(() =>
      createPluginSandbox(`return { id: 'x', category: 'monitor', execute: async () => [] };`),
    ).toThrow(/缺少字符串类型的 name/);
  });

  it('category 非法 → 抛「插件 category 必须是」', () => {
    expect(() =>
      createPluginSandbox(`return { id: 'x', name: 'X', category: 'other', execute: async () => [] };`),
    ).toThrow(/category 必须是/);
  });

  it('缺少 execute → 抛「插件缺少 execute 函数」', () => {
    expect(() => createPluginSandbox(`return { id: 'x', name: 'X', category: 'monitor' };`)).toThrow(
      /缺少 execute 函数/,
    );
  });

  it('导出的是一个函数 → 调用它取回插件对象', () => {
    const p = createPluginSandbox(`return function () { return { ${validBody} }; };`);
    expect(p.id).toBe('x');
  });

  it('导出的函数执行时抛错 → 抛「插件导出函数执行失败」', () => {
    expect(() => createPluginSandbox(`return function () { throw new Error('fn boom'); };`)).toThrow(
      /插件导出函数执行失败/,
    );
  });

  it('源码抛非 Error（字符串）→ 抛「插件源码执行失败: plain」', () => {
    expect(() => createPluginSandbox(`throw 'plain';`)).toThrow(/插件源码执行失败: plain/);
  });

  it('契约字段用 snake_case / camelCase 两种写法都能识别', () => {
    const snake = createPluginSandbox(`return {
      id: 'x', name: 'X', category: 'monitor',
      version: '9.9.9', author: 'me', period: 'daily',
      sub_category: 'momentum', complexity: 'complex',
      description: '说明', chartOverlay: { position: 'main', lines: [] },
      validateCrossFields: () => {},
      paramSchema: [{ key: 'a', label: 'A', type: 'number', default: 1 }],
      execute: async () => [],
    };`);
    expect(snake.subCategory).toBe('momentum');
    expect(snake.complexity).toBe('complex');
    expect(snake.description).toBe('说明');
    expect(snake.chartOverlay).toBeDefined();
    expect(typeof snake.validateCrossFields).toBe('function');

    const camel = createPluginSandbox(`return {
      id: 'y', name: 'Y', category: 'monitor',
      subCategory: 'trend',
      paramSchema: 'not-an-array',
      execute: async () => [],
    };`);
    expect(camel.subCategory).toBe('trend');
    // paramSchema 不是数组 → 视为未声明
    expect(camel.paramSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. validatePluginParams —— 边界与异常
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — validatePluginParams 边界', () => {
  const plugin: Plugin = {
    id: 'vp',
    name: 'VP',
    version: '1.0.0',
    author: 'a',
    period: 'daily',
    category: 'monitor',
    subCategory: 'custom',
    complexity: 'simple',
    defaultParams: {},
    paramSchema: [
      { key: 'a', label: 'A', type: 'number', min: 1, max: 10 },
      { key: 'b', label: 'B', type: 'number' },
      { key: 'c', label: 'C', type: 'select', options: ['x', 'y'] },
      { key: 'd', label: 'D', type: 'string' },
    ],
    execute: async () => [],
  };

  it('不传参数 → 全部走 default，无 default 的字段被跳过', () => {
    const merged = validatePluginParams(plugin);
    expect(merged).toEqual({});
  });

  it('number 类型小于 min → 抛错', () => {
    expect(() => validatePluginParams(plugin, { a: 0 })).toThrow(/小于最小值/);
  });

  it('number 类型大于 max → 抛错', () => {
    expect(() => validatePluginParams(plugin, { a: 99 })).toThrow(/大于最大值/);
  });

  it('select 类型传非字符串 → 抛错', () => {
    expect(() => validatePluginParams(plugin, { c: 123 })).toThrow(/select 期望 string/);
  });

  it('schema 之外的字段被丢弃', () => {
    const merged = validatePluginParams(plugin, { d: 'ok', unknown: 'x' });
    expect(merged).toEqual({ d: 'ok' });
  });

  it('validateCrossFields 抛普通 Error → 包成 PluginParamError', () => {
    const withCross: Plugin = {
      ...plugin,
      validateCrossFields() {
        throw new Error('cross boom');
      },
    };
    expect(() => validatePluginParams(withCross, { d: 'ok' })).toThrow(/跨字段约束校验失败/);
  });
});

// ---------------------------------------------------------------------------
// 6. buildPluginContext —— 预取缓存
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — buildPluginContext 预取缓存', () => {
  it('命中预取 → 返回缓存尾部 days 根', async () => {
    const bars = risingKlines(50);
    const ctx = buildPluginContext({ klines: new Map([['sh600000', bars]]), windowDays: 120 });
    const got = await ctx.getDailyKlines('sh600000', 10);
    expect(got.length).toBe(10);
    expect(got[got.length - 1].date).toBe(bars[bars.length - 1].date);
  });

  it('命中预取且 days=0 → 返回全部缓存', async () => {
    const bars = risingKlines(7);
    const ctx = buildPluginContext({ klines: new Map([['sh600000', bars]]), windowDays: 120 });
    const got = await ctx.getDailyKlines('sh600000', 0);
    expect(got.length).toBe(7);
  });

  it('窗口覆盖不足 → 回落查库（走批量入口，保证 ETF 也能取到）', async () => {
    const md = await import('../../src/services/marketData.js');
    // F 域 P3-6：回落取数统一走 `batchGetDailyRange`（内部按品种分流），
    // 不再直连只含 v_stock_qfq 的 `getDailyRange` —— 否则 ETF 会静默变成「无数据」。
    const spy = vi.spyOn(md, 'batchGetDailyRange').mockResolvedValue(new Map());
    const bars = risingKlines(5);
    const ctx = buildPluginContext({ klines: new Map([['sh600000', bars]]), windowDays: 3 });
    const got = await ctx.getDailyKlines('sh600000', 10);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toEqual(['sh600000']);
    expect(got).toEqual([]);
  });

  it('calculateRSI 不传 period → 走默认 14', () => {
    const ctx = buildPluginContext();
    const out = ctx.calculateRSI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 7. executePlugin —— 参数校验失败 / 不传 context
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — executePlugin 参数与 context', () => {
  it('参数校验失败 → status=ERROR 且带 error 信息', async () => {
    const plugin: Plugin = {
      id: 'bad-param',
      name: 'Bad Param',
      version: '1.0.0',
      author: 'a',
      period: 'daily',
      category: 'monitor',
      subCategory: 'custom',
      complexity: 'simple',
      defaultParams: {},
      paramSchema: [{ key: 'n', label: 'N', type: 'number', min: 1, max: 5 }],
      execute: async () => [],
    };
    const res = await executePlugin(plugin, { n: 999 });
    expect(res.status).toBe('ERROR');
    expect(res.error).toContain('大于最大值');
  });

  it('不传 context → 引擎自建 context（插件不查行情时可用）', async () => {
    const plugin: Plugin = {
      id: 'no-ctx',
      name: 'No Ctx',
      version: '1.0.0',
      author: 'a',
      period: 'daily',
      category: 'monitor',
      subCategory: 'custom',
      complexity: 'simple',
      defaultParams: {},
      execute: async () => [
        { symbol: 'sh600000', signalType: 'HOLD', pluginId: 'no-ctx', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const res = await executePlugin(plugin);
    expect(res.status).toBe('SUCCESS');
    expect(res.signals.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. executeAllPlugins —— 统计分支
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — executeAllPlugins 统计分支', () => {
  /** 隔离 DuckDB：行情查询一律 mock 成空结果（含 S2 持仓快照的取价） */
  async function mockMarketData(): Promise<void> {
    const md = await import('../../src/services/marketData.js');
    vi.spyOn(md, 'batchGetDailyRange').mockResolvedValue(new Map());
    vi.spyOn(md, 'getDailyRange').mockResolvedValue([]);
    vi.spyOn(md, 'batchGetLatestClose').mockResolvedValue(new Map());
  }

  it('标的域模式：SUCCESS 被统计（probe 插件产出信号）', async () => {
    await mockMarketData();
    const res = await executeAllPlugins({ symbols: ['sh600000'], userParams: { mode: 'ok' } });
    expect(res.stats.total).toBeGreaterThan(0);
    expect(res.stats.success).toBeGreaterThan(0);
    expect(res.signals.length).toBeGreaterThan(0);
  });

  it('标的域模式：ERROR 被统计（probe 插件抛异常）', async () => {
    await mockMarketData();
    const res = await executeAllPlugins({ symbols: ['sh600000'], userParams: { mode: 'error' } });
    expect(res.stats.error).toBeGreaterThan(0);
  });

  it('标的域模式：TIMEOUT 被统计（probe 插件永不 resolve）', async () => {
    await mockMarketData();
    const res = await executeAllPlugins({ symbols: ['sh600000'], userParams: { mode: 'timeout' } });
    expect(res.stats.timeout).toBeGreaterThan(0);
  });

  it('标的域模式：SKIP 被统计（内置插件无信号）', async () => {
    await mockMarketData();
    const res = await executeAllPlugins({ symbols: ['sh600000'], userParams: { mode: 'skip' } });
    expect(res.stats.skip).toBeGreaterThan(0);
  });

  it('标的域模式：空标的域 → 直接返回空统计', async () => {
    const res = await executeAllPlugins({ symbols: [] });
    expect(res.stats.total).toBe(0);
    expect(res.signals).toEqual([]);
  });

  it('旧行为模式（不传标的域）：SUCCESS / ERROR / TIMEOUT 分别被统计', async () => {
    await mockMarketData();

    const ok = await executeAllPlugins({ userParams: { mode: 'ok' } });
    expect(ok.stats.success).toBeGreaterThan(0);

    const err = await executeAllPlugins({ userParams: { mode: 'error' } });
    expect(err.stats.error).toBeGreaterThan(0);

    const to = await executeAllPlugins({ userParams: { mode: 'timeout' } });
    expect(to.stats.timeout).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. S2 —— 只读持仓视图（positions / cash / equity / POSITION_UNAVAILABLE）
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — S2 持仓视图', () => {
  const snapshot = {
    available: true,
    positions: [{ symbol: 'sh600000', quantity: 100, avgCost: 10, marketValue: 1200 }],
    cash: 500,
    equity: 1700,
  };

  /** 需要持仓视图的插件 */
  function makeRiskPlugin(execute: Plugin['execute']): Plugin {
    return {
      id: 'risk-probe',
      name: '风险探针',
      version: '1.0.0',
      author: 'test',
      period: 'daily',
      category: 'monitor',
      subCategory: 'risk',
      complexity: 'simple',
      defaultParams: {},
      requiresPositions: true,
      execute,
    };
  }

  it('buildPluginContext 注入快照：positions() / cash / equity / positionsAvailable', () => {
    const ctx = buildPluginContext(undefined, snapshot);
    expect(ctx.positionsAvailable).toBe(true);
    expect(ctx.positions()).toEqual(snapshot.positions);
    expect(ctx.cash).toBe(500);
    expect(ctx.equity).toBe(1700);
  });

  it('不传快照 → 空快照（positions 为空、cash/equity=0、不可用）', () => {
    const ctx = buildPluginContext();
    expect(ctx.positionsAvailable).toBe(false);
    expect(ctx.positions()).toEqual([]);
    expect(ctx.cash).toBe(0);
    expect(ctx.equity).toBe(0);
  });

  it('requiresPositions 且快照不可用 → SKIP + POSITION_UNAVAILABLE，execute 不被调用', async () => {
    let called = false;
    const plugin = makeRiskPlugin(async () => {
      called = true;
      return [];
    });

    const res = await executePlugin(plugin);
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('POSITION_UNAVAILABLE');
    expect(res.signals).toEqual([]);
    expect(called).toBe(false);
  });

  it('timedCtx 显式拷贝快照字段（execute 内读到 cash / equity / positions）', async () => {
    let seen: Record<string, unknown> | undefined;
    const plugin = makeRiskPlugin(async (ctx) => {
      seen = {
        cash: ctx.cash,
        equity: ctx.equity,
        available: ctx.positionsAvailable,
        count: ctx.positions().length,
      };
      return [];
    });

    const res = await executePlugin(plugin, {}, buildPluginContext(undefined, snapshot));
    // 返回空信号 → 有快照但本插件零行情 IO，归为 NO_SIGNAL（不是 NO_DATA / POSITION_UNAVAILABLE）
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('NO_SIGNAL');
    expect(seen).toEqual({ cash: 500, equity: 1700, available: true, count: 1 });
  });

  it('executeAllPlugins：回放（asOfDate）→ positionUnavailable 被统计', async () => {
    const md = await import('../../src/services/marketData.js');
    vi.spyOn(md, 'batchGetDailyRange').mockResolvedValue(new Map());
    vi.spyOn(md, 'getDailyRange').mockResolvedValue([]);
    vi.spyOn(md, 'batchGetLatestClose').mockResolvedValue(new Map());

    const plugin = makeRiskPlugin(async () => []);
    builtinPlugins.push(plugin);
    try {
      const res = await executeAllPlugins({ symbols: ['sh600000'], asOfDate: '2026-01-05' });
      // 回放不给持仓快照 ⇒ 所有组合级插件（含内置 position_risk_alert）都会记一次
      const positionalCount = builtinPlugins.filter((p) => p.requiresPositions).length;
      expect(res.stats.positionUnavailable).toBe(positionalCount);
      expect(res.results.find((r) => r.pluginId === 'risk-probe')?.skipReason).toBe('POSITION_UNAVAILABLE');
    } finally {
      builtinPlugins.splice(builtinPlugins.indexOf(plugin), 1);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. S3 —— boll_reversion（V3 六分类的 volatility 代表）
// ---------------------------------------------------------------------------

describe('pluginEngine 覆盖 — S3 boll_reversion', () => {
  const plugin = builtinPlugins.find((p) => p.id === 'boll_reversion');
  if (!plugin) throw new Error('内置插件 boll_reversion 不存在');

  function ctxWithCloses(closes: number[]): PluginContext {
    const klines: DailyKline[] = closes.map((close, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      amount: close * 1_000_000,
    }));
    const map = new Map([['sh600000', klines]]);
    return {
      getDailyKlines: async () => klines,
      batchGetDailyKlines: async () => map,
      calculateRSI: () => [],
      calculateMACD: () => ({ dif: [], dea: [], macd: [] }),
      calculateSMA: () => [],
      calculateBoll,
      positions: () => [],
      cash: 0,
      equity: 0,
      positionsAvailable: false,
    };
  }

  // 25 根在 100 附近小幅波动的收盘价（留出周期 20 的稳定带宽）
  const baseCloses = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i / 3) * 2);

  it('元数据：volatility + monitor，且不依赖持仓视图', () => {
    expect(plugin.subCategory).toBe('volatility');
    expect(plugin.category).toBe('monitor');
    expect(plugin.requiresPositions).toBe(false);
  });

  it('跨字段校验：pbBuy >= pbSell → 参数校验失败（ERROR）', async () => {
    const res = await executePlugin(plugin, { pbBuy: 0.5, pbSell: 0.5 }, ctxWithCloses(baseCloses));
    expect(res.status).toBe('ERROR');
    expect(res.error).toContain('pbBuy');
  });

  it('收盘跌破下轨 → BUY（带描述性 label 与 %B 指标）', async () => {
    const res = await executePlugin(plugin, { days: 120 }, ctxWithCloses([...baseCloses, 80]));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('BUY');
    expect(res.signals[0].label).toContain('布林下轨');
    expect(res.signals[0].metrics?.pb).toBeLessThan(0);
  });

  it('收盘冲破上轨 → SELL', async () => {
    const res = await executePlugin(plugin, { days: 120 }, ctxWithCloses([...baseCloses, 120]));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('SELL');
  });

  it('带内 → SKIP + NO_SIGNAL', async () => {
    const res = await executePlugin(plugin, { days: 120 }, ctxWithCloses(baseCloses));
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('NO_SIGNAL');
  });

  it('带宽为 0（横盘）→ %B=NaN，不臆造信号', async () => {
    const flat = Array.from({ length: 30 }, () => 100);
    const res = await executePlugin(plugin, { days: 120 }, ctxWithCloses(flat));
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('NO_SIGNAL');
  });

  it('空日线 → SKIP + NO_DATA；样本不足（< period+1）→ 不产出信号', async () => {
    const empty = await executePlugin(plugin, { days: 120 }, ctxWithCloses([]));
    expect(empty.status).toBe('SKIP');
    expect(empty.skipReason).toBe('NO_DATA');

    const short = await executePlugin(plugin, { days: 120 }, ctxWithCloses(baseCloses.slice(0, 20)));
    expect(short.status).toBe('SKIP');
    expect(short.signals).toEqual([]);
  });
});
