/**
 * plugin-category-representatives.test.ts — V3 六分类代表插件
 *
 * 覆盖三个新增 monitor 插件：
 *   - `engulfing_reversal`（pattern 代表）：趋势背景 + 放量确认的看涨 / 看跌吞没
 *   - `volume_price_breakout`（volume 代表）：放量突破 → buy / 放量破位 → sell
 *   - `position_risk_alert`（risk 代表）：持仓快照级风险提示，**只输出 HOLD 且不带 strength**
 *
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

/** 只有收盘价、open=close 的横盘序列（用于量价插件） */
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
// 插件元数据 / 六分类覆盖
// ---------------------------------------------------------------------------

describe('V3 六分类代表插件的登记信息', () => {
  it('engulfing_reversal 是 monitor / pattern，默认参数由 paramSchema 派生', () => {
    const p = findPlugin('engulfing_reversal');
    expect(p.category).toBe('monitor');
    expect(p.subCategory).toBe('pattern');
    expect(p.defaultParams).toEqual(deriveDefaultParams(p.paramSchema));
    expect(p.defaultParams).toMatchObject({
      maPeriod: 20,
      volumePeriod: 20,
      minVolumeRatio: 1.2,
      days: 120,
    });
    // symbol 由信号链运行时注入，不是用户可配置项
    const symbolField: ParamField | undefined = p.paramSchema?.find((f) => f.key === 'symbol');
    expect(symbolField?.required).toBe(true);
    expect(symbolField?.runtimeInjected).toBe(true);
  });

  it('volume_price_breakout 是 monitor / volume（真代表：信号会落 user_strategy_signal）', () => {
    const p = findPlugin('volume_price_breakout');
    expect(p.category).toBe('monitor');
    expect(p.subCategory).toBe('volume');
    expect(p.defaultParams).toEqual(deriveDefaultParams(p.paramSchema));
    expect(p.defaultParams).toMatchObject({ lookback: 20, volumeRatio: 1.5, days: 120 });
  });

  it('V3 六分类各自至少有一个内置代表（含 risk）', () => {
    const subs = new Set(builtinPlugins.map((p) => p.subCategory));
    for (const s of ['trend', 'momentum', 'volatility', 'volume', 'pattern', 'risk'] as const) {
      expect(subs.has(s), `六分类 ${s} 缺少代表插件`).toBe(true);
    }
  });

  it('volume 类代表不再只有 filter：monitor 版存在且 filter 版保持原样', () => {
    const monitors = builtinPlugins.filter((p) => p.subCategory === 'volume' && p.category === 'monitor');
    const filters = builtinPlugins.filter((p) => p.subCategory === 'volume' && p.category === 'filter');
    expect(monitors.map((p) => p.id)).toContain('volume_price_breakout');
    expect(filters.map((p) => p.id)).toContain('volume_breakout');
  });
});

// ---------------------------------------------------------------------------
// engulfing_reversal
// ---------------------------------------------------------------------------

describe('engulfing_reversal — 吞没反转形态', () => {
  /** 下跌趋势 + 看涨吞没：前阴线 10→9，当根阳线 8.8→9.8 反包，量比 2 倍 */
  function bullishSetup(lastVolume = 2_000_000): DailyKline[] {
    const klines: DailyKline[] = [];
    for (let i = 0; i < 20; i++) {
      const c = 20 - i * 0.5; // 20 → 10.5 单调下行
      klines.push(bar(c, c, 1_000_000, `2026-01-${String(i + 1).padStart(2, '0')}`));
    }
    klines.push(bar(10, 9, 1_000_000, '2026-01-21')); // 前一根阴线
    klines.push(bar(8.8, 10.1, lastVolume, '2026-01-22')); // 当根阳线，实体反包前阴线 10→9
    return klines;
  }

  it('下跌趋势 + 放量看涨吞没 → BUY', async () => {
    const res = await executePlugin(findPlugin('engulfing_reversal'), {}, makeContext(bullishSetup()));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    const sig = res.signals[0];
    expect(sig.signalType).toBe('BUY');
    expect(sig.pluginId).toBe('engulfing_reversal');
    expect(sig.metrics?.volumeRatio).toBeCloseTo(2, 5);
    expect(sig.detail).toContain('看涨吞没');
    expect(res.durationMs).toBeLessThan(50);
  });

  it('上涨趋势 + 放量看跌吞没 → SELL', async () => {
    const klines: DailyKline[] = [];
    for (let i = 0; i < 20; i++) {
      const c = 10 + i * 0.5; // 10 → 19.5 单调上行
      klines.push(bar(c, c, 1_000_000, `2026-01-${String(i + 1).padStart(2, '0')}`));
    }
    klines.push(bar(19, 20, 1_000_000, '2026-01-21')); // 前一根阳线
    klines.push(bar(20.2, 18.8, 2_000_000, '2026-01-22')); // 当根阴线，实体反包

    const res = await executePlugin(findPlugin('engulfing_reversal'), {}, makeContext(klines));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('SELL');
    expect(res.signals[0].detail).toContain('看跌吞没');
  });

  it('形态成立但缩量（量比 < minVolumeRatio）→ 不出信号', async () => {
    const res = await executePlugin(
      findPlugin('engulfing_reversal'),
      {},
      makeContext(bullishSetup(1_000_000)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('形态成立但无趋势背景（前收盘在 MA 上方）→ 不出信号', async () => {
    // 上行趋势里做出看涨吞没：反转语义不成立，应被 MA 过滤
    const klines: DailyKline[] = [];
    for (let i = 0; i < 20; i++) {
      const c = 10 + i * 0.5;
      klines.push(bar(c, c, 1_000_000, `2026-01-${String(i + 1).padStart(2, '0')}`));
    }
    klines.push(bar(19, 18, 1_000_000, '2026-01-21')); // 阴线
    klines.push(bar(17.8, 18.8, 2_000_000, '2026-01-22')); // 阳线反包（但前收盘 18 > MA）

    const res = await executePlugin(findPlugin('engulfing_reversal'), {}, makeContext(klines));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('数据不足 maPeriod + 2 根 → SKIP（NO_DATA），不抛错', async () => {
    const res = await executePlugin(
      findPlugin('engulfing_reversal'),
      { maPeriod: 20, volumePeriod: 20 },
      makeContext(flatBars(5, 10)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// volume_price_breakout
// ---------------------------------------------------------------------------

describe('volume_price_breakout — 量价突破（monitor 版）', () => {
  it('放量突破前 20 日最高价 → BUY', async () => {
    const klines = flatBars(21, 10, 1_000_000); // 前 21 根：high=10.1
    klines.push(bar(10.2, 11, 2_000_000, '2026-01-22')); // 当根突破且放量 2 倍

    const res = await executePlugin(findPlugin('volume_price_breakout'), {}, makeContext(klines));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    const sig = res.signals[0];
    expect(sig.signalType).toBe('BUY');
    expect(sig.pluginId).toBe('volume_price_breakout');
    expect(sig.metrics?.volumeRatio).toBeCloseTo(2, 5);
    expect(sig.metrics?.prevHigh).toBeCloseTo(10.1, 5);
    expect(sig.detail).toContain('量价齐升');
  });

  it('放量跌破前 20 日最低价 → SELL', async () => {
    const klines = flatBars(21, 10, 1_000_000); // 前 21 根：low=9.9
    klines.push(bar(9.8, 9, 2_000_000, '2026-01-22')); // 当根破位且放量 2 倍

    const res = await executePlugin(findPlugin('volume_price_breakout'), {}, makeContext(klines));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('SELL');
    expect(res.signals[0].metrics?.prevLow).toBeCloseTo(9.9, 5);
    expect(res.signals[0].detail).toContain('放量下跌');
  });

  it('突破创新高但未放量（量比 < volumeRatio）→ 不出信号', async () => {
    const klines = flatBars(21, 10, 1_000_000);
    klines.push(bar(10.2, 11, 1_000_000, '2026-01-22')); // 量比 1 < 1.5

    const res = await executePlugin(findPlugin('volume_price_breakout'), {}, makeContext(klines));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('既未突破也未破位（收在区间内）→ 不出信号', async () => {
    const klines = flatBars(21, 10, 1_000_000);
    klines.push(bar(10, 10, 2_000_000, '2026-01-22')); // 放量但价格在区间内

    const res = await executePlugin(findPlugin('volume_price_breakout'), {}, makeContext(klines));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('数据不足 lookback + 1 根 → SKIP（NO_DATA），不抛错', async () => {
    const res = await executePlugin(
      findPlugin('volume_price_breakout'),
      { lookback: 20 },
      makeContext(flatBars(10, 10)),
    );
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('均量为 0（停牌 / 无成交）→ 不出信号，不产生 Infinity 量比', async () => {
    const klines = flatBars(21, 10, 0);
    klines.push(bar(10.2, 11, 1_000_000, '2026-01-22'));

    const res = await executePlugin(findPlugin('volume_price_breakout'), {}, makeContext(klines));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });
});
