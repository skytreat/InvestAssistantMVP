/**
 * pluginParam.test.ts — 单元测试 validatePluginParams（SDD §5.3 参数校验）
 *
 * 覆盖 src/services/pluginEngine.ts 的 validatePluginParams：
 *   - 合法参数原样返回
 *   - 缺失字段用 default 填充
 *   - 越界 min/max → 抛 PluginParamError
 *   - required 字段缺失且无 default → 抛 PluginParamError
 *   - select 类型非法值 → 抛 PluginParamError
 *   - integer 非整数 → 抛 PluginParamError
 */
import { describe, it, expect } from 'vitest';
import { validatePluginParams, PluginParamError, builtinPlugins } from '../../src/services/pluginEngine.js';
import type { Plugin } from '../../src/services/pluginEngine.js';

// 取 rsi_oversold 插件的 paramSchema 做测试模板
const rsiPlugin = builtinPlugins.find((p) => p.id === 'rsi_oversold')!;

describe('validatePluginParams — 合法参数', () => {
  it('空 params → 返回默认值', () => {
    const result = validatePluginParams(rsiPlugin, {});
    expect(result.symbol).toBe('sh600000');
    expect(result.period).toBe(14);
    // 按 T96 新契约：threshold 已拆为 oversold / overbought 两个字段
    expect(result.oversold).toBe(30);
    expect(result.overbought).toBe(70);
    expect(result.days).toBe(120);
  });

  it('部分参数 → 缺的用 default 填充', () => {
    const result = validatePluginParams(rsiPlugin, { symbol: 'sz000001' });
    expect(result.symbol).toBe('sz000001');
    expect(result.period).toBe(14); // default
    expect(result.oversold).toBe(30);
    expect(result.overbought).toBe(70);
    expect(result.days).toBe(120);
  });

  it('全部传参 → 原样返回', () => {
    const result = validatePluginParams(rsiPlugin, {
      symbol: 'sh601318',
      period: 10,
      oversold: 25,
      overbought: 75,
      days: 60,
    });
    expect(result).toEqual({
      symbol: 'sh601318',
      period: 10,
      oversold: 25,
      overbought: 75,
      days: 60,
    });
  });
});

describe('validatePluginParams — 边界/错误', () => {
  it('period < min(5) → 抛 PluginParamError', () => {
    expect(() => validatePluginParams(rsiPlugin, { period: 3 })).toThrow(PluginParamError);
    expect(() => validatePluginParams(rsiPlugin, { period: 3 })).toThrow('小于最小值 5');
  });

  it('period > max(30) → 抛 PluginParamError', () => {
    expect(() => validatePluginParams(rsiPlugin, { period: 50 })).toThrow(PluginParamError);
    expect(() => validatePluginParams(rsiPlugin, { period: 50 })).toThrow('大于最大值 30');
  });

  it('oversold 非 number → 抛 PluginParamError', () => {
    expect(() => validatePluginParams(rsiPlugin, { oversold: 'abc' as any })).toThrow('期望 number');
  });

  it('oversold == overbought(50/50) → 跨字段约束失败，抛 PluginParamError（按 T96 新契约）', () => {
    // 注：oversold 范围 1-50、overbought 范围 50-100，单字段范围已隐含大小关系；
    // 跨字段校验是不可绕过的防御性护栏，唯一可达边界是 50/50 相等
    expect(() => validatePluginParams(rsiPlugin, { oversold: 50, overbought: 50 })).toThrow(PluginParamError);
    expect(() => validatePluginParams(rsiPlugin, { oversold: 50, overbought: 50 })).toThrow('必须小于');
  });

  it('oversold < overbought → 通过', () => {
    const result = validatePluginParams(rsiPlugin, { oversold: 20, overbought: 80 });
    expect(result.oversold).toBe(20);
    expect(result.overbought).toBe(80);
  });

  it('symbol 非 string → 抛 PluginParamError', () => {
    expect(() => validatePluginParams(rsiPlugin, { symbol: 123 as any })).toThrow('期望 string');
  });

  it('days 非整数 → 抛 PluginParamError', () => {
    expect(() => validatePluginParams(rsiPlugin, { days: 12.5 as any })).toThrow('期望 integer');
  });
});

describe('validatePluginParams — 含 select 类型的插件', () => {
  // 构造一个带 select 字段的插件
  const selectPlugin: Plugin = {
    id: 'select-test',
    name: 'Select Test',
    category: 'monitor',
    paramSchema: [
      { key: 'mode', type: 'select', default: 'fast', options: ['fast', 'slow'] },
      { key: 'name', type: 'string', required: true },
    ],
    async execute() {
      return [];
    },
  };

  it('select 合法值 → 通过', () => {
    const result = validatePluginParams(selectPlugin, { mode: 'fast', name: 'test' });
    expect(result.mode).toBe('fast');
    expect(result.name).toBe('test');
  });

  it('select 非法值 → 抛错', () => {
    expect(() => validatePluginParams(selectPlugin, { mode: 'xyz' as any, name: 'test' })).toThrow(
      '不在合法选项',
    );
  });

  it('required 字段缺失且无 default → 抛错', () => {
    expect(() => validatePluginParams(selectPlugin, { mode: 'fast' })).toThrow('必填参数缺失');
  });
});

describe('validatePluginParams — boolean 类型', () => {
  const boolPlugin: Plugin = {
    id: 'bool-test',
    name: 'Bool Test',
    category: 'monitor',
    paramSchema: [{ key: 'enabled', type: 'boolean', default: true }],
    async execute() {
      return [];
    },
  };

  it('boolean 合法 → 通过', () => {
    const result = validatePluginParams(boolPlugin, { enabled: false });
    expect(result.enabled).toBe(false);
  });

  it('boolean 传入 string → 抛错', () => {
    expect(() => validatePluginParams(boolPlugin, { enabled: 'true' as any })).toThrow('期望 boolean');
  });
});

describe('validatePluginParams — 数字边界：正好等于 min/max', () => {
  it('period 正好 = min(5) → 通过', () => {
    const result = validatePluginParams(rsiPlugin, { period: 5 });
    expect(result.period).toBe(5);
  });

  it('period 正好 = max(30) → 通过', () => {
    const result = validatePluginParams(rsiPlugin, { period: 30 });
    expect(result.period).toBe(30);
  });
});
