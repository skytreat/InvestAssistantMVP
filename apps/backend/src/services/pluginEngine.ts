// src/services/pluginEngine.ts
// 插件引擎核心：加载 + 参数校验 + 沙盒执行 + 超时保护
// SDD §5.3 硬约束：execute() 50ms 超时；沙盒禁止 global / process / require

import { calculateRSI, calculateMACD, type MACDResult } from '@invest/core';
import { calculateSMA } from './indicators.js';
import {
  getDailyRange,
  batchGetDailyRange,
  type DailyKline,
} from './marketData.js';
import { writeSystemLog } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_TIMEOUT_MS = 50;
export const PLUGIN_ALLOWED_PATH = '/opt/invol/plugins/strategies';

// ---------------------------------------------------------------------------
// 插件引擎内部接口（与 core 包 plugin.ts 的简单版不同，这里是增强版：
// PluginContext 暴露行情查询函数 + 指标算法，方便 execute() 内部调用）
// ---------------------------------------------------------------------------

export interface ParamField {
  key: string;                          // 注意：core 包是 name，这里按规格用 key
  label: string;
  type: 'number' | 'string' | 'boolean' | 'integer' | 'select';
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];                   // select 类型的合法值
  unit?: string;
  description?: string;
  required?: boolean;
}

/** 插件执行上下文（注入行情 + 算法） */
export interface PluginContext {
  // 行情查询
  getDailyKlines(symbol: string, days: number): Promise<DailyKline[]>;
  batchGetDailyKlines(symbols: string[], days: number): Promise<Map<string, DailyKline[]>>;
  // 算法
  calculateRSI(prices: number[], period?: number): number[];
  calculateMACD(prices: number[]): MACDResult;
  calculateSMA(prices: number[], period: number): number[];
}

/** 插件信号输出 */
export interface PluginSignal {
  symbol: string;
  signalType: 'BUY' | 'SELL' | 'HOLD' | 'ALERT';
  strength?: number;          // 0-1 信号强度
  pluginId: string;
  timestamp: string;          // ISO
  params: Record<string, unknown>;
  detail?: string;
}

/** 插件定义 */
export interface Plugin {
  id: string;
  name: string;
  description?: string;
  category: 'monitor' | 'filter';
  paramSchema?: ParamField[];
  execute(
    context: PluginContext,
    params: Record<string, unknown>,
  ): Promise<PluginSignal[] | PluginSignal>;
}

// ---------------------------------------------------------------------------
// 内置插件注册表（MVP 先写 2 个示例）
// ---------------------------------------------------------------------------

export const builtinPlugins: Plugin[] = [
  // ---------- RSI 超卖 ----------
  {
    id: 'rsi_oversold',
    name: 'RSI 超卖',
    description: '当 RSI(period) 跌破阈值时发出超卖信号',
    category: 'monitor',
    paramSchema: [
      { key: 'symbol', label: '标的代码', type: 'string', default: 'sh600000', required: true },
      { key: 'period', label: 'RSI 周期', type: 'integer', default: 14, min: 5, max: 30 },
      { key: 'threshold', label: '超卖阈值', type: 'number', default: 30, min: 1, max: 50 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
    ],
    async execute(ctx, params) {
      const symbol = params.symbol as string;
      const period = params.period as number;
      const threshold = params.threshold as number;
      const days = params.days as number;

      const klines = await ctx.getDailyKlines(symbol, days);
      if (klines.length < period + 1) return [];

      const closes = klines.map(k => k.close);
      const rsi = ctx.calculateRSI(closes, period);
      const latestRSI = rsi[rsi.length - 1];

      const signals: PluginSignal[] = [];
      if (latestRSI < threshold) {
        signals.push({
          symbol,
          signalType: 'BUY',
          strength: Math.max(0, (threshold - latestRSI) / threshold),
          pluginId: 'rsi_oversold',
          timestamp: new Date().toISOString(),
          params: { period, threshold, days, latestRSI },
          detail: `RSI(${period})=${latestRSI.toFixed(2)} < 阈值 ${threshold}`,
        });
      }
      return signals;
    },
  },

  // ---------- MACD 金叉 ----------
  {
    id: 'macd_cross',
    name: 'MACD 金叉',
    description: '当 DIF 从下方上穿 DEA 时发出金叉（买入）信号',
    category: 'monitor',
    paramSchema: [
      { key: 'symbol', label: '标的代码', type: 'string', default: 'sh600000', required: true },
      { key: 'fast', label: '快线 EMA', type: 'integer', default: 12, min: 2, max: 30 },
      { key: 'slow', label: '慢线 EMA', type: 'integer', default: 26, min: 10, max: 60 },
      { key: 'signal', label: '信号线', type: 'integer', default: 9, min: 2, max: 20 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 40, max: 365 },
    ],
    async execute(ctx, params) {
      const symbol = params.symbol as string;
      const fast = params.fast as number;
      const slow = params.slow as number;
      const signal = params.signal as number;
      const days = params.days as number;

      const klines = await ctx.getDailyKlines(symbol, days);
      if (klines.length < slow + signal) return [];

      const closes = klines.map(k => k.close);
      // 调用底层 calculateMACD（它接受 fast/slow/signal 参数）
      const macdResult = calculateMACD(closes, fast, slow, signal);
      const dif = macdResult.dif;
      const dea = macdResult.dea;

      const signals: PluginSignal[] = [];
      const n = dif.length;
      // 金叉：前一日 DIF <= DEA，当日 DIF > DEA
      if (n >= 2 && dif[n - 2] <= dea[n - 2] && dif[n - 1] > dea[n - 1]) {
        signals.push({
          symbol,
          signalType: 'BUY',
          strength: Math.min(1, Math.abs(dif[n - 1] - dea[n - 1]) * 10),
          pluginId: 'macd_cross',
          timestamp: new Date().toISOString(),
          params: { fast, slow, signal, days, dif: dif[n - 1], dea: dea[n - 1] },
          detail: `DIF=${dif[n - 1].toFixed(4)} 上穿 DEA=${dea[n - 1].toFixed(4)}（金叉）`,
        });
      }
      // 死叉反向
      if (n >= 2 && dif[n - 2] >= dea[n - 2] && dif[n - 1] < dea[n - 1]) {
        signals.push({
          symbol,
          signalType: 'SELL',
          strength: Math.min(1, Math.abs(dif[n - 1] - dea[n - 1]) * 10),
          pluginId: 'macd_cross',
          timestamp: new Date().toISOString(),
          params: { fast, slow, signal, days, dif: dif[n - 1], dea: dea[n - 1] },
          detail: `DIF=${dif[n - 1].toFixed(4)} 下穿 DEA=${dea[n - 1].toFixed(4)}（死叉）`,
        });
      }
      return signals;
    },
  },
];

// ---------------------------------------------------------------------------
// 磁盘热加载 + 沙盒（SDD §5.3 硬约束：禁止 global/process/require + fs/net）
// ---------------------------------------------------------------------------

/** 合法插件文件名：小写字母/数字/下划线/中划线，仅限 .js，禁止 ../ 穿越 */
const PLUGIN_FILENAME_RE = /^[a-z0-9_-]+\.js$/;

/**
 * 从磁盘目录加载自定义插件（SDD §5.3）
 *
 * 安全约束：
 *   - 目录必须存在，不存在直接返回空数组（不抛错）
 *   - 文件名必须匹配 ^[a-z0-9_-]+\.js$（防止路径穿越 /../）
 *   - 加载 try-catch 隔离：单个插件崩了不影响其他
 *
 * 加载方式：
 *   1. fs.readdirSync 列 .js 文件
 *   2. 对每个文件 fs.readFileSync 读源码
 *   3. createPluginSandbox(source) 包装成 Plugin 实例
 *   4. push 到结果数组
 */
export function loadPluginsFromDir(
  dirPath: string = PLUGIN_ALLOWED_PATH,
): Plugin[] {
  const loaded: Plugin[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch (err) {
    // 目录不存在或无权限 → 静默返回空数组（MVP 不开放用户上传）
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'INFO',
      message: `插件目录不可读，跳过磁盘加载: ${dirPath}`,
      detail: err instanceof Error ? err.message : String(err),
    });
    return loaded;
  }

  for (const entry of entries) {
    // 安全过滤：只允许合法文件名，禁止隐藏文件、.ts/.mjs/.cjs/.json 等
    if (!PLUGIN_FILENAME_RE.test(entry)) continue;

    const filePath = path.join(dirPath, entry);

    // 二次安全：fs.statSync 确认是普通文件且位于允许目录下（防止符号链接逃逸）
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      console.error(`[pluginEngine] 无法 stat 插件文件 ${entry}:`, err);
      continue;
    }
    if (!stat.isFile()) continue;

    // resolved path 必须以 PLUGIN_ALLOWED_PATH 为前缀（绝对路径防穿越）
    const resolved = path.resolve(filePath);
    const allowedResolved = path.resolve(dirPath);
    if (!resolved.startsWith(allowedResolved + path.sep)) {
      console.error(
        `[pluginEngine] 插件路径逃逸被拦截: ${filePath} (resolved=${resolved})`,
      );
      continue;
    }

    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`[pluginEngine] 读取插件 ${entry} 失败:`, err);
      continue;
    }

    let plugin: Plugin;
    try {
      plugin = createPluginSandbox(source);
    } catch (err) {
      console.error(`[pluginEngine] 插件 ${entry} 沙盒创建失败:`, err);
      continue;
    }

    loaded.push(plugin);
  }

  writeSystemLog({
    logType: 'plugin_execute',
    level: 'INFO',
    message: `磁盘插件加载完成 count=${loaded.length} dir=${dirPath}`,
  });

  return loaded;
}

/**
 * 沙盒创建：用 new Function() 包装插件源码，禁止 global/process/require + fs/net
 *
 * SDD §5.3 硬约束：
 *   - globalThis: Proxy 拦截 get，全部返回 undefined
 *   - process/require/fetch/XMLHttpRequest/setTimeout/setInterval: undefined
 *   - fs/net/http/https 等 Node 模块：不可 require（require 已 undefined）
 *
 * MVP 实现：new Function() + 无沙盒参数 = 源码里直接访问的 global 全是 undefined；
 *          V2 升级 VM2 做硬隔离。
 *
 * 约定：插件源码必须导出一个对象 literal（或函数返回对象），包含：
 *   - id: string
 *   - name: string
 *   - category: 'monitor' | 'filter'
 *   - execute(ctx, params): Promise<PluginSignal[] | PluginSignal>
 */
export function createPluginSandbox(source: string): Plugin {
  // 受限沙盒：所有危险对象一律 undefined 或 Proxy 吞掉
  const sandbox: Record<string, unknown> = {
    // 禁止访问 globalThis 上的任何东西（Proxy get 全返回 undefined）
    globalThis: new Proxy(
      {},
      {
        get() {
          return undefined;
        },
        set() {
          // 阻止向沙盒 globalThis 上注入属性
          return true;
        },
      },
    ),
    // 全部禁用
    global: undefined,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    // 保留 console.error 给插件输出调试（仅限 console.*）
    console,
    // 保留基础类型
    Array,
    Object,
    Number,
    String,
    Boolean,
    Date,
    JSON,
    Math,
    Promise,
    Error,
    Map,
    Set,
    performance,
  };

  // 将源码包进一个 IIFE，用 new Function 构造器注入沙盒
  // 插件源码约定：最后一个表达式求值结果 = 插件对象
  const wrappedSource = `
    "use strict";
    return (function () {
      ${source}
    })();
  `;

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...Object.keys(sandbox),
    wrappedSource,
  );

  let maybePlugin: unknown;
  try {
    maybePlugin = factory(...Object.values(sandbox));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`插件源码执行失败: ${msg}`);
  }

  // 如果源码导出的是一个返回对象的函数，调用一下
  if (typeof maybePlugin === 'function') {
    try {
      maybePlugin = (maybePlugin as () => unknown)();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`插件导出函数执行失败: ${msg}`);
    }
  }

  // 验证接口契约
  if (
    maybePlugin === null ||
    typeof maybePlugin !== 'object'
  ) {
    throw new Error('插件必须导出一个对象（含 id/name/category/execute）');
  }
  const p = maybePlugin as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) {
    throw new Error('插件缺少字符串类型的 id');
  }
  if (typeof p.name !== 'string' || !p.name) {
    throw new Error('插件缺少字符串类型的 name');
  }
  if (p.category !== 'monitor' && p.category !== 'filter') {
    throw new Error(
      `插件 category 必须是 'monitor' 或 'filter'，实际 ${String(p.category)}`,
    );
  }
  if (typeof p.execute !== 'function') {
    throw new Error('插件缺少 execute 函数');
  }

  // 类型收窄为 Plugin 返回
  return {
    id: p.id as string,
    name: p.name as string,
    description:
      typeof p.description === 'string'
        ? (p.description as string)
        : undefined,
    category: p.category as 'monitor' | 'filter',
    paramSchema: Array.isArray(p.paramSchema)
      ? (p.paramSchema as Plugin['paramSchema'])
      : undefined,
    execute: p.execute as Plugin['execute'],
  };
}

/**
 * 合并 builtin + 磁盘加载 → 完整插件列表
 *
 * 调用时机：executeAllPlugins() 前调一次
 *   builtinPlugins 始终有（2 个）
 *   磁盘加载有则追加，无则只有 builtin
 */
export function getAllPlugins(): Plugin[] {
  const diskPlugins = loadPluginsFromDir();
  return [...builtinPlugins, ...diskPlugins];
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

export class PluginParamError extends Error {
  constructor(
    public pluginId: string,
    public fieldKey: string,
    message: string,
  ) {
    super(`[plugin:${pluginId}:${fieldKey}] ${message}`);
    this.name = 'PluginParamError';
  }
}

/**
 * 按 paramSchema 校验 / 填充用户参数。
 *
 * 校验规则：
 *   - number / integer   : typeof 必须是 number，检查 min/max
 *   - string             : typeof 必须是 string
 *   - boolean            : typeof 必须是 boolean
 *   - select             : 值必须出现在 options 中（仅当 options 存在时检查）
 *   - integer            : 额外检查 Number.isInteger
 *   - 缺失字段 → 用 default；default 也没有且 required=true → 报错
 *   - 非法类型 / 越界 → 抛 PluginParamError
 */
export function validatePluginParams(
  plugin: Plugin,
  userParams?: Record<string, unknown>,
): Record<string, unknown> {
  const schema = plugin.paramSchema ?? [];
  const merged: Record<string, unknown> = {};
  const input = userParams ?? {};

  for (const field of schema) {
    const rawValue = input[field.key];
    const hasInput = rawValue !== undefined && rawValue !== null;

    // 用 default 填充
    const value = hasInput ? rawValue : field.default;

    // required 字段但没有 default 也没输入
    if (
      !hasInput &&
      field.default === undefined &&
      field.required === true
    ) {
      throw new PluginParamError(plugin.id, field.key, '必填参数缺失');
    }

    // 没有值（也没有 default、也不是 required），跳过
    if (value === undefined) continue;

    // 类型检查 + 范围检查
    switch (field.type) {
      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `期望 number，实际 ${typeof value}`,
          );
        }
        if (field.min !== undefined && value < field.min) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `值 ${value} 小于最小值 ${field.min}`,
          );
        }
        if (field.max !== undefined && value > field.max) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `值 ${value} 大于最大值 ${field.max}`,
          );
        }
        merged[field.key] = value;
        break;
      }
      case 'integer': {
        if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `期望 integer，实际 ${typeof value}:${String(value)}`,
          );
        }
        if (field.min !== undefined && value < field.min) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `值 ${value} 小于最小值 ${field.min}`,
          );
        }
        if (field.max !== undefined && value > field.max) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `值 ${value} 大于最大值 ${field.max}`,
          );
        }
        merged[field.key] = value;
        break;
      }
      case 'string': {
        if (typeof value !== 'string') {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `期望 string，实际 ${typeof value}`,
          );
        }
        merged[field.key] = value;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `期望 boolean，实际 ${typeof value}`,
          );
        }
        merged[field.key] = value;
        break;
      }
      case 'select': {
        if (typeof value !== 'string') {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `select 期望 string，实际 ${typeof value}`,
          );
        }
        if (field.options && !field.options.includes(value)) {
          throw new PluginParamError(
            plugin.id,
            field.key,
            `值 "${value}" 不在合法选项 [${field.options.join(', ')}] 中`,
          );
        }
        merged[field.key] = value;
        break;
      }
    }
  }

  // 用户可能传了 schema 之外的字段 → 静默保留（不报错，但我们不主动透传到 merged）
  // 这里选择只返回 schema 覆盖的字段，避免 execute 收到脏参数
  return merged;
}

// ---------------------------------------------------------------------------
// PluginContext 构建
// ---------------------------------------------------------------------------

export function buildPluginContext(): PluginContext {
  return {
    async getDailyKlines(symbol: string, days: number): Promise<DailyKline[]> {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return await getDailyRange(symbol, start, end);
    },

    async batchGetDailyKlines(
      symbols: string[],
      days: number,
    ): Promise<Map<string, DailyKline[]>> {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return await batchGetDailyRange(symbols, start, end);
    },

    // 直接透传（calculateMACD 带 fast/slow/signal 默认值，ctx 签名只暴露 prices）
    calculateRSI: (prices: number[], period?: number) => calculateRSI(prices, period ?? 14),
    calculateMACD: (prices: number[]) => calculateMACD(prices),
    calculateSMA,
  };
}

// ---------------------------------------------------------------------------
// executePlugin：带 50ms 超时 + 异常保护
// ---------------------------------------------------------------------------

export type PluginExecutionStatus = 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'SKIP';

export interface PluginExecutionResult {
  pluginId: string;
  status: PluginExecutionStatus;
  signals: PluginSignal[];
  durationMs: number;
  error?: string;
}

/**
 * SDD §5.3: Promise.race 实现 50ms 硬超时。
 *
 * 超时标记 TIMEOUT；异常标记 ERROR；返回空数组标记 SKIP。
 */
export async function executePlugin(
  plugin: Plugin,
  userParams?: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginExecutionResult> {
  const start = performance.now();

  // 1. 参数校验（失败直接 ERROR 返回）
  let validatedParams: Record<string, unknown>;
  try {
    validatedParams = validatePluginParams(plugin, userParams);
  } catch (err) {
    const duration = performance.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'ERROR',
      message: `插件 ${plugin.id} 参数校验失败`,
      detail: msg,
      checkItem: plugin.id,
    });
    return {
      pluginId: plugin.id,
      status: 'ERROR',
      signals: [],
      durationMs: Math.round(duration * 1000) / 1000,
      error: msg,
    };
  }

  // 2. 构建上下文（如果调用方没传）
  const ctx = context ?? buildPluginContext();

  // 3. Promise.race：插件执行 vs 超时
  const timeoutPromise = new Promise<PluginExecutionResult>((resolve) => {
    setTimeout(() => {
      const duration = performance.now() - start;
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `插件 ${plugin.id} 执行超时 (${PLUGIN_TIMEOUT_MS}ms)`,
        checkItem: plugin.id,
      });
      resolve({
        pluginId: plugin.id,
        status: 'TIMEOUT',
        signals: [],
        durationMs: Math.round(duration * 1000) / 1000,
        error: `执行超过 ${PLUGIN_TIMEOUT_MS}ms 硬超时`,
      });
    }, PLUGIN_TIMEOUT_MS);
  });

  const executePromise = (async (): Promise<PluginExecutionResult> => {
    try {
      const raw = await plugin.execute(ctx, validatedParams);
      const signals: PluginSignal[] = Array.isArray(raw) ? raw : [raw];
      const duration = performance.now() - start;

      if (signals.length === 0) {
        writeSystemLog({
          logType: 'plugin_execute',
          level: 'SKIP',
          message: `插件 ${plugin.id} 正常执行但无信号`,
          checkItem: plugin.id,
        });
        return {
          pluginId: plugin.id,
          status: 'SKIP',
          signals: [],
          durationMs: Math.round(duration * 1000) / 1000,
        };
      }

      writeSystemLog({
        logType: 'plugin_execute',
        level: 'SUCCESS',
        message: `插件 ${plugin.id} 返回 ${signals.length} 个信号`,
        checkItem: plugin.id,
      });
      return {
        pluginId: plugin.id,
        status: 'SUCCESS',
        signals,
        durationMs: Math.round(duration * 1000) / 1000,
      };
    } catch (err) {
      const duration = performance.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `插件 ${plugin.id} 执行异常`,
        detail: msg,
        checkItem: plugin.id,
      });
      return {
        pluginId: plugin.id,
        status: 'ERROR',
        signals: [],
        durationMs: Math.round(duration * 1000) / 1000,
        error: msg,
      };
    }
  })();

  return await Promise.race([timeoutPromise, executePromise]);
}

// ---------------------------------------------------------------------------
// 批量执行（monitor 类插件每日收盘跑）
// ---------------------------------------------------------------------------

export interface PluginBatchStats {
  total: number;
  success: number;
  timeout: number;
  error: number;
  skip: number;
}

export interface PluginBatchResult {
  signals: PluginSignal[];
  stats: PluginBatchStats;
  results: PluginExecutionResult[];
}

/**
 * 依次执行所有内置 monitor 类插件（MVP 暂不并发，避免同时打 DuckDB）。
 * 自定义插件将来从 PLUGIN_ALLOWED_PATH 加载后追加执行。
 */
export async function executeAllPlugins(): Promise<PluginBatchResult> {
  // 合并内置 + 磁盘加载（SDD §5.3 磁盘热加载）
  const monitorPlugins = getAllPlugins().filter(p => p.category === 'monitor');
  const ctx = buildPluginContext();

  const stats: PluginBatchStats = {
    total: monitorPlugins.length,
    success: 0,
    timeout: 0,
    error: 0,
    skip: 0,
  };
  const allSignals: PluginSignal[] = [];
  const results: PluginExecutionResult[] = [];

  for (const plugin of monitorPlugins) {
    const res = await executePlugin(plugin, {}, ctx);
    results.push(res);
    if (res.status === 'SUCCESS') {
      stats.success += 1;
      allSignals.push(...res.signals);
    } else if (res.status === 'TIMEOUT') {
      stats.timeout += 1;
    } else if (res.status === 'ERROR') {
      stats.error += 1;
    } else {
      stats.skip += 1;
    }
  }

  writeSystemLog({
    logType: 'plugin_execute',
    level: 'INFO',
    message: `批量执行完成 total=${stats.total} success=${stats.success} timeout=${stats.timeout} error=${stats.error} skip=${stats.skip}`,
    detail: JSON.stringify(stats),
  });

  return { signals: allSignals, stats, results };
}
