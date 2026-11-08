/**
 * T133 / PA-05 —— 组合求值（AND + min）
 *
 * 逐条对齐方案 §6.1 / §6.2：同向全成立才出信号；强度取最弱；异常/跳过不成立。
 */
import { describe, it, expect } from 'vitest';
import { evaluateCombo, type ComboConditionResult } from '../../src/services/comboEvaluator.js';

function result(pluginId: string, patch: Partial<ComboConditionResult> = {}): ComboConditionResult {
  return {
    pluginId,
    enabled: true,
    status: 'OK',
    signalType: 'BUY',
    strength: 0.8,
    ...patch,
  };
}

describe('combo evaluator', () => {
  it('全部条件 BUY ⇒ BUY，strength 取 min', () => {
    const matched = evaluateCombo([
      result('macd_cross', { strength: 0.9 }),
      result('volume_breakout', { strength: 0.6 }),
    ]);

    expect(matched).toMatchObject({
      direction: 'BUY',
      strength: 0.6,
      minPluginId: 'volume_breakout',
    });
    expect(matched!.matchedPluginIds).toEqual(['macd_cross', 'volume_breakout']);
  });

  it('全部条件 SELL ⇒ SELL', () => {
    const matched = evaluateCombo([
      result('a', { signalType: 'SELL', strength: 0.7 }),
      result('b', { signalType: 'SELL', strength: 0.5 }),
    ]);

    expect(matched!.direction).toBe('SELL');
    expect(matched!.strength).toBe(0.5);
    expect(matched!.minPluginId).toBe('b');
  });

  it('混合方向 ⇒ 不成立', () => {
    expect(
      evaluateCombo([result('a', { signalType: 'BUY' }), result('b', { signalType: 'SELL' })]),
    ).toBeNull();
  });

  it('HOLD / 缺方向 ⇒ 不成立', () => {
    expect(evaluateCombo([result('a'), result('b', { signalType: 'HOLD' })])).toBeNull();
    expect(evaluateCombo([result('a'), result('b', { signalType: null })])).toBeNull();
  });

  it('任一条件 SKIP / ERROR / TIMEOUT ⇒ 该标的本轮不成立', () => {
    for (const status of ['SKIP', 'ERROR', 'TIMEOUT'] as const) {
      expect(evaluateCombo([result('a'), result('b', { status })])).toBeNull();
    }
  });

  it('启用条件少于 2 个 ⇒ 不成立（组合语义要求多个条件）', () => {
    expect(evaluateCombo([])).toBeNull();
    expect(evaluateCombo([result('a')])).toBeNull();
    expect(evaluateCombo([result('a'), result('b', { enabled: false })])).toBeNull();
  });

  it('禁用条件不参与求值，也不进入 matchedPluginIds', () => {
    const matched = evaluateCombo([
      result('a', { strength: 0.9 }),
      result('b', { strength: 0.5 }),
      result('c', { enabled: false, signalType: 'SELL', strength: 0.1 }),
    ]);

    expect(matched!.direction).toBe('BUY');
    expect(matched!.strength).toBe(0.5);
    expect(matched!.matchedPluginIds).toEqual(['a', 'b']);
  });

  it('strength 缺失 / 越界 ⇒ 不成立（无法计算 min）', () => {
    for (const strength of [undefined, null, -0.1, 1.1, Number.NaN]) {
      expect(evaluateCombo([result('a'), result('b', { strength: strength as number })])).toBeNull();
    }
  });

  it('强度并列时取先出现的条件作为 min 解释项', () => {
    const matched = evaluateCombo([result('a', { strength: 0.5 }), result('b', { strength: 0.5 })]);
    expect(matched!.minPluginId).toBe('a');
  });

  it('strength 全为 1 时仍能给出 minPluginId', () => {
    const matched = evaluateCombo([result('a', { strength: 1 }), result('b', { strength: 1 })]);
    expect(matched!.strength).toBe(1);
    expect(matched!.minPluginId).toBe('a');
  });
});
