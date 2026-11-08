/**
 * T133 / PA-05 —— 组合策略适配器（信号跟随）
 *
 * 覆盖：买入/卖出映射、无前视（> asOf 丢弃）、HOLD 忽略、持仓保护、去重、缺参安全返回。
 */
import { describe, it, expect } from 'vitest';
import type { StrategyContext } from '../../src/services/backtest/strategy/types.js';
import {
  createComboSignalStrategy,
  type ComboSignalView,
} from '../../src/services/backtest/strategies/comboSignal.js';

function fakeCtx(
  patch: {
    asOf?: string;
    params?: Record<string, unknown>;
    positions?: Record<string, number>;
  } = {},
): StrategyContext {
  const asOf = patch.asOf ?? '2026-11-07';
  const positions = patch.positions ?? {};
  return {
    asOf,
    execDate: '2026-11-08',
    params: patch.params ?? { comboId: 'combo_1', weight: 0.1 },
    dayIndex: 1,
    position: (symbol: string) => (positions[symbol] ? ({ symbol, qty: positions[symbol] } as never) : null),
    log: () => {
      /* noop */
    },
  } as unknown as StrategyContext;
}

function sourceOf(signals: ComboSignalView[]) {
  return {
    listSignals: () => signals,
  };
}

describe('combo signal strategy', () => {
  it('买入信号 ⇒ 目标权重；未持仓才建仓', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([{ symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'buy', strength: 0.7 }]),
    });
    const decision = strategy.decide(fakeCtx());

    expect(decision).toEqual({
      targets: [{ symbol: 'sh600519', targetWeight: 0.1, reason: 'rebalance' }],
      mode: 'incremental',
    });
  });

  it('已持仓遇买入 ⇒ 不动（不每日再平衡）', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([{ symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'buy', strength: 0.7 }]),
    });
    const decision = strategy.decide(fakeCtx({ positions: { sh600519: 100 } }));

    expect(decision).toBeNull();
  });

  it('卖出信号只对已持仓生效，目标权重 0', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([{ symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'sell', strength: 0.6 }]),
    });

    expect(strategy.decide(fakeCtx({ positions: { sh600519: 100 } }))).toEqual({
      targets: [{ symbol: 'sh600519', targetWeight: 0, reason: 'rebalance' }],
      mode: 'incremental',
    });
    expect(strategy.decide(fakeCtx())).toBeNull();
  });

  it('无前视：tradeDate 晚于 asOf 的信号被丢弃', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([{ symbol: 'sh600519', tradeDate: '2026-11-08', direction: 'buy', strength: 0.9 }]),
    });

    expect(strategy.decide(fakeCtx({ asOf: '2026-11-07' }))).toBeNull();
  });

  it('HOLD 信号不产生操作', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([{ symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'hold', strength: 0.9 }]),
    });

    expect(strategy.decide(fakeCtx())).toBeNull();
  });

  it('同标的同日多方向 ⇒ 取 strength 最高的一条', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([
        { symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'sell', strength: 0.3 },
        { symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'buy', strength: 0.8 },
      ]),
    });
    const decision = strategy.decide(fakeCtx());

    expect(decision!.targets).toEqual([{ symbol: 'sh600519', targetWeight: 0.1, reason: 'rebalance' }]);
  });

  it('缺少 comboId ⇒ 返回 null（不静默出错）', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([{ symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'buy', strength: 0.7 }]),
    });

    expect(strategy.decide(fakeCtx({ params: { weight: 0.1 } }))).toBeNull();
  });

  it('参数 schema 默认值可派生，id/version 可用于注册解析', () => {
    const strategy = createComboSignalStrategy({
      source: sourceOf([]),
      comboId: 'combo_x',
      weight: 0.2,
    });

    expect(strategy.id).toBe('combo-signal-follow');
    expect(strategy.version).toBe('0.1.0');
    expect(strategy.defaultParams).toMatchObject({ comboId: 'combo_x', weight: 0.2 });
  });
});
