/**
 * pattern-reversal-plugins.test.ts — 形态类新增两个 monitor 插件
 *
 *   - `star_reversal`：早晨之星 / 黄昏之星（三根 K 线，以「实体分离」替代跳空缺口）
 *   - `piercing_darkcloud`：刺透 / 乌云盖顶（两根 K 线，penetration 显式参数）
 *
 * 覆盖：双向命中、判据边界（差一点点不成立）、无数据、量比不满足。
 * 用 mock context 隔离 DuckDB；SMA 复用 `src/services/indicators.ts` 真实实现。
 */
import { describe, it, expect } from 'vitest';
import {
  executePlugin,
  builtinPlugins,
  deriveDefaultParams,
  type Plugin,
  type PluginContext,
  type ParamField,
} from '../../src/services/pluginEngine.js';
import { calculateSMA } from '../../src/services/indicators.js';
import { calculateBoll, calculateRSI } from '@invest/core';
import type { DailyKline } from '@invest/core';

/** 构造一根日线：high / low 按实体外扩 1%，便于形态判据不受影线干扰 */
function bar(open: number, close: number, volume = 1_000_000, date = '2026-01-01'): DailyKline {
  const hi = Math.max(open, close) * 1.01;
  const lo = Math.min(open, close) * 0.99;
  return { date, open, high: hi, low: lo, close, volume, amount: close * volume };
}

/** 单调序列（close = open，量恒定） */
function trendBars(n: number, from: number, step: number, volume = 1_000_000): DailyKline[] {
  return Array.from({ length: n }, (_, i) =>
    bar(from + i * step, from + i * step, volume, `2026-01-${String(i + 1).padStart(2, '0')}`),
  );
}

/** 只有收盘价、open=close 的横盘序列 */
function flatBars(n: number, close: number, volume = 1_000_000): DailyKline[] {
  return Array.from({ length: n }, (_, i) =>
    bar(close, close, volume, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`),
  );
}

function makeContext(klines: DailyKline[]): PluginContext {
  return {
    async getDailyKlines() {
      return klines;
    },
    async batchGetDailyKlines(symbols) {
      return new Map(symbols.map((s) => [s, klines]));
    },
    calculateRSI,
    calculateMACD: () => ({ dif: [], dea: [], macd: [] }),
    calculateSMA,
    calculateBoll,
    positions: () => [],
    cash: 0,
    equity: 0,
    positionsAvailable: false,
  };
}

const findPlugin = (id: string): Plugin => {
  const p = builtinPlugins.find((x) => x.id === id);
  if (!p) throw new Error(`内置插件不存在: ${id}`);
  return p;
};

// ---------------------------------------------------------------------------
// star_reversal
// ---------------------------------------------------------------------------

describe('star_reversal — 星线反转形态', () => {
  /** 下跌趋势（20 根 20→10.5）+ 早晨之星：c1 阴 10→9，星线 8.6→8.8，c3 阳 8.9→9.6 */
  function morningStarSetup(c3Volume = 2_000_000, starClose = 8.8): DailyKline[] {
    const klines = trendBars(20, 20, -0.5);
    klines.push(bar(10, 9, 1_000_000, '2026-01-21')); // 第 1 根阴线
    klines.push(bar(8.6, starClose, 1_000_000, '2026-01-22')); // 星线（实体 8.6~starClose）
    klines.push(bar(8.9, 9.6, c3Volume, '2026-01-23')); // 第 3 根阳线收复 9
    return klines;
  }

  /** 上涨趋势（20 根 10→19.5）+ 黄昏之星：c1 阳 19→20，星线 20.2→20.4，c3 阴 20.1→19.4 */
  function eveningStarSetup(c3Volume = 2_000_000, starClose = 20.4): DailyKline[] {
    const klines = trendBars(20, 10, 0.5);
    klines.push(bar(19, 20, 1_000_000, '2026-01-21')); // 第 1 根阳线
    klines.push(bar(20.2, starClose, 1_000_000, '2026-01-22')); // 星线（实体 20.2~starClose）
    klines.push(bar(20.1, 19.4, c3Volume, '2026-01-23')); // 第 3 根阴线跌破 20
    return klines;
  }

  it('元数据：monitor / pattern，默认参数由 paramSchema 派生，symbol 运行时注入', () => {
    const p = findPlugin('star_reversal');
    expect(p.category).toBe('monitor');
    expect(p.subCategory).toBe('pattern');
    expect(p.defaultParams).toEqual(deriveDefaultParams(p.paramSchema));
    expect(p.defaultParams).toMatchObject({
      maPeriod: 20,
      volumePeriod: 20,
      minVolumeRatio: 1.2,
      days: 120,
    });
    const symbolField: ParamField | undefined = p.paramSchema?.find((f) => f.key === 'symbol');
    expect(symbolField?.required).toBe(true);
    expect(symbolField?.runtimeInjected).toBe(true);
    // 不引入影线长度 / 星线实体比例等经验阈值参数
    expect(p.paramSchema?.map((f) => f.key)).toEqual([
      'symbol',
      'maPeriod',
      'volumePeriod',
      'minVolumeRatio',
      'days',
    ]);
  });

  it('下跌趋势 + 实体分离的早晨之星 → BUY', async () => {
    const res = await executePlugin(findPlugin('star_reversal'), {}, makeContext(morningStarSetup()));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    const sig = res.signals[0];
    expect(sig.signalType).toBe('BUY');
    expect(sig.pluginId).toBe('star_reversal');
    expect(sig.metrics?.volumeRatio).toBeCloseTo(2, 5);
    expect(sig.detail).toContain('早晨之星');
    expect(res.durationMs).toBeLessThan(50);
  });

  it('上涨趋势 + 实体分离的黄昏之星 → SELL', async () => {
    const res = await executePlugin(findPlugin('star_reversal'), {}, makeContext(eveningStarSetup()));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('SELL');
    expect(res.signals[0].detail).toContain('黄昏之星');
  });

  it('边界：星线实体恰好接触第 1 根收盘（未分离）→ 不出信号（不静默放宽）', async () => {
    // 早晨之星：星线实体上沿 = 9.0 = 第 1 根收盘，实体分离不成立
    const res = await executePlugin(
      findPlugin('star_reversal'),
      {},
      makeContext(morningStarSetup(2_000_000, 9.0)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('边界：黄昏之星实体下沿恰好接触第 1 根收盘 → 不出信号', async () => {
    const res = await executePlugin(
      findPlugin('star_reversal'),
      {},
      makeContext(eveningStarSetup(2_000_000, 20.0)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('形态成立但缩量（量比 < minVolumeRatio）→ 不出信号', async () => {
    const res = await executePlugin(
      findPlugin('star_reversal'),
      {},
      makeContext(morningStarSetup(1_000_000)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('数据不足 maPeriod + 2 根 → SKIP（NO_DATA），不抛错', async () => {
    const res = await executePlugin(findPlugin('star_reversal'), {}, makeContext(flatBars(5, 10)));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// piercing_darkcloud
// ---------------------------------------------------------------------------

describe('piercing_darkcloud — 刺透 / 乌云盖顶形态', () => {
  /**
   * 下跌趋势 + 刺透：c1 阴 10→9，c2 阳低开 8.8 → 收 close（默认 9.7，穿透 70% > 50%）
   */
  function piercingSetup(c2Volume = 2_000_000, c2Close = 9.7, c2Open = 8.8): DailyKline[] {
    const klines = trendBars(20, 20, -0.5);
    klines.push(bar(10, 9, 1_000_000, '2026-01-21')); // 第 1 根阴线
    klines.push(bar(c2Open, c2Close, c2Volume, '2026-01-22')); // 第 2 根阳线
    return klines;
  }

  /** 上涨趋势 + 乌云盖顶：c1 阳 19→20，c2 阴高开 20.2 → 收 close（默认 19.3，跌穿 70% > 50%） */
  function darkCloudSetup(c2Volume = 2_000_000, c2Close = 19.3, c2Open = 20.2): DailyKline[] {
    const klines = trendBars(20, 10, 0.5);
    klines.push(bar(19, 20, 1_000_000, '2026-01-21')); // 第 1 根阳线
    klines.push(bar(c2Open, c2Close, c2Volume, '2026-01-22')); // 第 2 根阴线
    return klines;
  }

  it('元数据：monitor / pattern；penetration 作为无法避免的阈值显式暴露', () => {
    const p = findPlugin('piercing_darkcloud');
    expect(p.category).toBe('monitor');
    expect(p.subCategory).toBe('pattern');
    expect(p.defaultParams).toEqual(deriveDefaultParams(p.paramSchema));
    expect(p.defaultParams).toMatchObject({
      maPeriod: 20,
      volumePeriod: 20,
      minVolumeRatio: 1.2,
      penetration: 0.5,
      days: 120,
    });
    const penetration = p.paramSchema?.find((f) => f.key === 'penetration');
    expect(penetration?.default).toBe(0.5);
    expect(penetration?.min).toBeDefined();
    expect(penetration?.max).toBeDefined();
  });

  it('下跌趋势 + 低开穿透前实体 50% 以上的刺透 → BUY', async () => {
    const res = await executePlugin(findPlugin('piercing_darkcloud'), {}, makeContext(piercingSetup()));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    const sig = res.signals[0];
    expect(sig.signalType).toBe('BUY');
    expect(sig.pluginId).toBe('piercing_darkcloud');
    expect(sig.metrics?.volumeRatio).toBeCloseTo(2, 5);
    expect(sig.metrics?.penetration).toBe(0.5);
    expect(sig.detail).toContain('刺透反转');
    expect(res.durationMs).toBeLessThan(50);
  });

  it('上涨趋势 + 高开跌穿前实体 50% 以上的乌云盖顶 → SELL', async () => {
    const res = await executePlugin(findPlugin('piercing_darkcloud'), {}, makeContext(darkCloudSetup()));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('SELL');
    expect(res.signals[0].detail).toContain('乌云盖顶反转');
  });

  it('边界：收盘恰好落在前实体中点（差一点点不达 penetration）→ 不出信号', async () => {
    // 前一根实体 10→9，中点 9.5；收盘 = 9.5 必须严格大于才成立
    const res = await executePlugin(
      findPlugin('piercing_darkcloud'),
      {},
      makeContext(piercingSetup(2_000_000, 9.5)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('边界：乌云盖顶收盘恰好落在前实体中点 → 不出信号', async () => {
    // 前一根实体 19→20，中点 19.5
    const res = await executePlugin(
      findPlugin('piercing_darkcloud'),
      {},
      makeContext(darkCloudSetup(2_000_000, 19.5)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('边界：当根开盘未低于前一根收盘（无低开）→ 不出信号', async () => {
    const res = await executePlugin(
      findPlugin('piercing_darkcloud'),
      {},
      makeContext(piercingSetup(2_000_000, 9.7, 9.0)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('形态成立但缩量（量比 < minVolumeRatio）→ 不出信号', async () => {
    const res = await executePlugin(
      findPlugin('piercing_darkcloud'),
      {},
      makeContext(piercingSetup(1_000_000)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('数据不足 maPeriod + 1 根 → SKIP（NO_DATA），不抛错', async () => {
    const res = await executePlugin(findPlugin('piercing_darkcloud'), {}, makeContext(flatBars(5, 10)));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });
});
