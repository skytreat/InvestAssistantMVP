/**
 * volume-stall.test.ts — `volume_stall`（高位放量滞涨，monitor / volume，只输出 SELL）
 *
 * 覆盖：高位放量滞涨命中、低位放量不涨不命中（位置条件生效）、放量且大涨不命中、
 * 量能不足不命中、历史不足不命中、均量为 0 不命中。
 * 用 mock context 隔离 DuckDB，不依赖真实行情库。
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

/** 构造一根日线：high / low 按实体外扩 1% */
function bar(open: number, close: number, volume = 1_000_000, date = '2026-01-01'): DailyKline {
  return {
    date,
    open,
    high: Math.max(open, close) * 1.01,
    low: Math.min(open, close) * 0.99,
    close,
    volume,
    amount: close * volume,
  };
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

const plugin: Plugin = builtinPlugins.find((p) => p.id === 'volume_stall') as Plugin;

/**
 * 高位放量滞涨序列（63 根）：
 *   0..42   8.00 → 9.20（慢涨）
 *   43..59  9.20 → 10.36（20 日内涨 12.5%，满足 minRise=10%）
 *   60..62  10.30 / 10.32 / 10.35（3 日滞涨 -0.1%，满足 maxGain=2%）
 *   当根放量 2 倍（满足 volumeRatio=1.8），距 60 日最高回撤约 1.1%（满足 5%）
 */
function highPositionStallSetup(lastVolume = 2_000_000, lastClose = 10.35): DailyKline[] {
  const klines: DailyKline[] = [];
  for (let i = 0; i < 43; i++) {
    const c = 8 + (1.2 * i) / 42;
    klines.push(bar(c, c));
  }
  for (let i = 1; i <= 17; i++) {
    const c = 9.2 + (1.16 * i) / 17;
    klines.push(bar(c, c));
  }
  klines.push(bar(10.3, 10.32));
  klines.push(bar(10.32, 10.33));
  klines.push(bar(10.33, lastClose, lastVolume));
  return klines;
}

/**
 * 低位放量不涨序列（63 根）——用于证明位置条件生效：
 *   0..39   10.00 横盘（60 日高点约 10.10）
 *   40..41  急跌到 8.86
 *   42..59  温和反弹到 9.15
 *   60..62  9.18 → 9.30 放量，3 日涨幅 1.6% 满足滞胀，
 *           但「距 60 日高点回撤 7.9% > 5%」且「20 日涨幅 4.8% < 10%」→ 默认参数不出信号
 */
function lowPositionStallSetup(): DailyKline[] {
  const klines: DailyKline[] = [];
  for (let i = 0; i < 40; i++) klines.push(bar(10, 10));
  klines.push(bar(10, 9.43));
  klines.push(bar(9.43, 8.86));
  for (let i = 1; i <= 18; i++) {
    const c = 8.86 + i * 0.0161;
    klines.push(bar(c, c));
  }
  klines.push(bar(9.18, 9.2));
  klines.push(bar(9.2, 9.25));
  klines.push(bar(9.25, 9.3, 2_000_000));
  return klines;
}

describe('volume_stall — 高位放量滞涨', () => {
  it('元数据：monitor / volume，只输出 SELL；阈值全部暴露为参数', () => {
    expect(plugin.category).toBe('monitor');
    expect(plugin.subCategory).toBe('volume');
    expect(plugin.defaultParams).toEqual(deriveDefaultParams(plugin.paramSchema));
    expect(plugin.defaultParams).toMatchObject({
      volumePeriod: 20,
      volumeRatio: 1.8,
      stallDays: 3,
      maxGain: 0.02,
      highLookback: 60,
      maxDrawdownFromHigh: 0.05,
      riseLookback: 20,
      minRise: 0.1,
      days: 120,
    });
    const symbolField: ParamField | undefined = plugin.paramSchema?.find((f) => f.key === 'symbol');
    expect(symbolField?.required).toBe(true);
    expect(symbolField?.runtimeInjected).toBe(true);
    // 所有判据阈值都必须是可调参数，而不是硬编码
    expect(plugin.paramSchema?.map((f) => f.key)).toEqual([
      'symbol',
      'volumePeriod',
      'volumeRatio',
      'stallDays',
      'maxGain',
      'highLookback',
      'maxDrawdownFromHigh',
      'riseLookback',
      'minRise',
      'days',
    ]);
  });

  it('高位放量滞涨 → SELL（带 strength，参与 F1 分级）', async () => {
    const res = await executePlugin(plugin, {}, makeContext(highPositionStallSetup()));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    const sig = res.signals[0];
    expect(sig.signalType).toBe('SELL');
    expect(sig.pluginId).toBe('volume_stall');
    expect(sig.strength).toBeDefined();
    expect(sig.strength!).toBeGreaterThan(0);
    expect(sig.strength!).toBeLessThanOrEqual(1);
    expect(sig.metrics?.volumeRatio).toBeCloseTo(2, 5);
    expect(sig.metrics?.stallGain).toBeLessThan(0.02);
    expect(sig.detail).toContain('减仓提示');
    expect(res.durationMs).toBeLessThan(50);
  });

  it('低位放量不涨（吸筹特征）→ 不出信号（位置条件生效）', async () => {
    const res = await executePlugin(plugin, {}, makeContext(lowPositionStallSetup()));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('同一序列去掉位置条件后会多出 1 条 SELL —— 证明位置条件是唯一边界', async () => {
    // 仅放宽位置组（回撤上限 50%、前置涨幅下限 0），其余判据保持默认
    const res = await executePlugin(
      plugin,
      { maxDrawdownFromHigh: 0.5, minRise: 0 },
      makeContext(lowPositionStallSetup()),
    );
    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].signalType).toBe('SELL');
  });

  it('放量且大涨（3 日涨幅 > maxGain）→ 不出信号', async () => {
    // 当根从 10.33 涨到 10.80（3 日累计 +4.25% > 2%），其余条件仍满足
    const res = await executePlugin(plugin, {}, makeContext(highPositionStallSetup(2_000_000, 10.8)));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('量能不足（量比 < volumeRatio）→ 不出信号', async () => {
    const res = await executePlugin(plugin, {}, makeContext(highPositionStallSetup(1_000_000)));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('历史不足（少于所需 60 根高点窗口）→ 不出信号', async () => {
    const klines = Array.from({ length: 30 }, (_, i) => bar(10, 10, 1_000_000, `2026-01-${i + 1}`));
    const res = await executePlugin(plugin, {}, makeContext(klines));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });

  it('均量为 0 → 不出信号', async () => {
    const klines = highPositionStallSetup().map((k, i, arr) =>
      i === arr.length - 1 ? k : { ...k, volume: 0 },
    );
    const res = await executePlugin(plugin, {}, makeContext(klines));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toEqual([]);
  });
});
