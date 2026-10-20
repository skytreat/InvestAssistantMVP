/**
 * pluginEngine.test.ts — Phase 2 SDD §12.3 单元测试
 *
 * 覆盖 src/services/pluginEngine.ts 的硬约束：
 *   P3 execute() 50ms 超时 → Promise.race 返回 TIMEOUT
 *   P4 execute() 抛异常 → 返回 ERROR + error.message
 *   P5 沙盒 globalThis Proxy → 外部全局不被污染
 *   P6 process/require → TypeError 被沙盒捕获
 *   P7 require('fs') → ReferenceError/TypeError 被沙盒捕获
 *
 * 所有测试绕过 buildPluginContext()（避免 DuckDB 依赖），手动传入 mock context。
 * Logger 的 SQLite 依赖由 logger.test.ts 处理，这里不传 context 也可但会碰 marketData → DuckDB。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  executePlugin,
  createPluginSandbox,
  buildPluginContext,
  PLUGIN_TIMEOUT_MS,
  type Plugin,
  type PluginContext,
} from '../../src/services/pluginEngine.js';

// === 最小 mock context（隔离 DuckDB 依赖） ===
const mockContext: PluginContext = {
  async getDailyKlines() {
    return [];
  },
  async batchGetDailyKlines() {
    return new Map();
  },
  calculateRSI: () => [],
  calculateMACD: () => ({ dif: [], dea: [], macd: [] }),
  calculateSMA: () => [],
};

// === 合法插件骨架（给手写 Plugin 对象用） ===
function makePlugin(overrides: Partial<Plugin>): Plugin {
  return {
    id: overrides.id ?? 'test-plugin',
    name: overrides.name ?? 'Test Plugin',
    category: overrides.category ?? 'monitor',
    paramSchema: overrides.paramSchema,
    execute: overrides.execute ?? (async () => []),
  };
}

describe('pluginEngine — P3 执行超时', () => {
  it(`execute() 永远不 resolve → Promise.race 返回 TIMEOUT，durationMs ≈ ${PLUGIN_TIMEOUT_MS}ms`, async () => {
    // 重要说明：
    // Node.js 主线程是单线程的，同步死循环（while(true) {}）会彻底阻塞事件循环，
    // Promise.race 的 setTimeout 根本没有机会执行。这是 JavaScript 的硬限制。
    // MVP 用 await new Promise(() => {}) 模拟"插件执行过程中等待的外部 API 永不返回"的真实超时场景。
    // 这种 async 永不 resolve 才是 Promise.race 能正确处理的情况。
    const plugin = createPluginSandbox(`
      return ({
        id: 'timeout-pending',
        name: '超时永不 resolve',
        category: 'monitor',
        async execute(ctx, params) {
          // 永不 resolve 的 Promise —— 模拟网络请求/DuckDB 查询永不返回
          await new Promise(function() {});
        }
      });
    `);

    const result = await executePlugin(plugin, {}, mockContext);

    expect(result.status).toBe('TIMEOUT');
    expect(result.pluginId).toBe('timeout-pending');
    // 超时时间 ±20ms 波动（Node event loop 调度开销）
    expect(result.durationMs).toBeGreaterThanOrEqual(PLUGIN_TIMEOUT_MS - 20);
    expect(result.durationMs).toBeLessThanOrEqual(PLUGIN_TIMEOUT_MS + 20);
    expect(result.signals).toEqual([]);
  }, 5000); // 整个测试的独立 timeout

  it('正常执行 < 50ms → 返回非 TIMEOUT（SKIP 或 SUCCESS）', async () => {
    const plugin = makePlugin({
      id: 'fast-plugin',
      execute: async () => [
        {
          symbol: 'sh600000',
          signalType: 'HOLD',
          pluginId: 'fast-plugin',
          timestamp: new Date().toISOString(),
          params: {},
        },
      ],
    });

    const result = await executePlugin(plugin, {}, mockContext);

    expect(result.status).not.toBe('TIMEOUT');
    expect(result.durationMs).toBeLessThan(PLUGIN_TIMEOUT_MS);
  });
});

describe('pluginEngine — P4 抛异常', () => {
  it('execute() throw new Error("boom") → status=ERROR 且 error 包含 boom', async () => {
    const plugin = makePlugin({
      id: 'boom-plugin',
      execute: async () => {
        throw new Error('boom');
      },
    });

    const result = await executePlugin(plugin, {}, mockContext);

    expect(result.status).toBe('ERROR');
    expect(result.pluginId).toBe('boom-plugin');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('boom');
    expect(result.signals).toEqual([]);
  });

  it('execute() throw 非 Error 对象 → 也被 catch 住', async () => {
    const plugin = makePlugin({
      id: 'string-throw',
      execute: async () => {
        throw 'just a string';
      },
    });

    const result = await executePlugin(plugin, {}, mockContext);

    expect(result.status).toBe('ERROR');
    // String(err) 会把非 Error 对象转成字符串
    expect(result.error).toContain('just a string');
  });

  it('execute() throw undefined → 也被 catch 住', async () => {
    const plugin = makePlugin({
      id: 'undefined-throw',
      execute: async () => {
        // eslint-disable-next-line no-throw-literal
        throw undefined;
      },
    });

    const result = await executePlugin(plugin, {}, mockContext);

    expect(result.status).toBe('ERROR');
    // err instanceof Error ? ... : String(err) → String(undefined) = 'undefined'
    expect(result.error).toBe('undefined');
  });
});

describe('pluginEngine — P5/P6/P7 沙盒隔离', () => {
  // 记录测试前的 globalThis 状态（确保测试本身不依赖 globalThis 上有什么）
  const preGlobalFoo = (globalThis as any).foo;
  const preGlobalBar = (globalThis as any).bar;

  it('P5: 源码里 globalThis.foo="bar" → 外部 globalThis 不被污染', async () => {
    const plugin = createPluginSandbox(`
      globalThis.foo = 'bar';
      return ({
        id: 'sandbox-global-pollution',
        name: '沙盒全局污染测试',
        category: 'monitor',
        async execute(ctx, params) {
          return [{
            symbol: 'test',
            signalType: 'HOLD',
            pluginId: 'sandbox-global-pollution',
            timestamp: new Date().toISOString(),
            params: {},
          }];
        }
      });
    `);

    // createPluginSandbox 本身能成功（源码里 globalThis.foo='bar' 被 Proxy set 拦截）
    expect(plugin.id).toBe('sandbox-global-pollution');

    // 外部全局仍然干净
    expect((globalThis as any).foo).toBe(preGlobalFoo);
    expect((globalThis as any).bar).toBe(preGlobalBar);

    // 再执行 execute()，也不会污染外部
    await plugin.execute(mockContext, {});
    expect((globalThis as any).foo).toBe(preGlobalFoo);
  });

  it('P6: 源码里访问 process.exit(0) → TypeError 被沙盒 catch → createPluginSandbox 抛 "插件源码执行失败"', () => {
    // process 在沙盒里是 undefined
    // process.exit(0) → TypeError: Cannot read properties of undefined (reading 'exit')
    // factory() 内部 catch → throw new Error('插件源码执行失败: ...')
    expect(() => {
      createPluginSandbox(`
        process.exit(0);
        return ({
          id: 'proc-exit',
          name: 'process.exit 测试',
          category: 'monitor',
          async execute() { return []; }
        });
      `);
    }).toThrow(/插件源码执行失败/);
  });

  it('P7: 源码里 require("fs") → TypeError 被沙盒 catch → createPluginSandbox 抛 "插件源码执行失败"', () => {
    // require 在沙盒里是 undefined
    // require('fs') → TypeError: require is not a function
    // factory() 内部 catch → throw new Error('插件源码执行失败: ...')
    expect(() => {
      createPluginSandbox(`
        const fs = require('fs');
        return ({
          id: 'req-fs',
          name: 'require fs 测试',
          category: 'monitor',
          async execute() { return []; }
        });
      `);
    }).toThrow(/插件源码执行失败/);
  });

  it('P7-额外: fetch 也是 undefined', () => {
    expect(() => {
      createPluginSandbox(`
        fetch('http://evil.com').then(r => r.text());
        return ({
          id: 'fetch-attack',
          name: 'fetch 测试',
          category: 'monitor',
          async execute() { return []; }
        });
      `);
    }).toThrow(/插件源码执行失败/);
  });
});

describe('pluginEngine — 边界覆盖', () => {
  it('空 signals → status=SKIP', async () => {
    const plugin = makePlugin({
      id: 'empty-signals',
      execute: async () => [],
    });

    const result = await executePlugin(plugin, {}, mockContext);
    expect(result.status).toBe('SKIP');
    expect(result.signals).toEqual([]);
  });

  it('单条 signal 会被包成数组', async () => {
    const singleSignal = {
      symbol: 'sh600000',
      signalType: 'HOLD' as const,
      pluginId: 'single',
      timestamp: new Date().toISOString(),
      params: {},
    };
    const plugin = makePlugin({
      id: 'single-signal',
      execute: async () => singleSignal,
    });

    const result = await executePlugin(plugin, {}, mockContext);
    expect(result.status).toBe('SUCCESS');
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].pluginId).toBe('single');
  });
});
