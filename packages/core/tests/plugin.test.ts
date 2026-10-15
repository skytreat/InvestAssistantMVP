import { describe, it, expect } from 'vitest';
import type { Plugin, PluginContext, PluginSignal } from '../src/plugin';

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
