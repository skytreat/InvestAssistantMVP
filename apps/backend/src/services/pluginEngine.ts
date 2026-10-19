// src/services/pluginEngine.ts
// 插件引擎核心：加载 + 参数校验 + 沙盒执行 + 超时保护
// SDD §5.3 硬约束：沙盒禁止 global / process / require；
//                  execute() 50ms 预算**只覆盖纯计算，行情 IO 不计入**（T88 / DEC-12 B-3）

import { calculateRSI, calculateMACD, type MACDResult } from '@invest/core';
import { calculateSMA } from './indicators.js';
import {
  getDailyRange,
  batchGetDailyRange,
} from './marketData.js';
import type { DailyKline } from '@invest/core';
import { writeSystemLog } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_TIMEOUT_MS = 50;

/**
 * 自定义插件目录（AGENTS.md 硬约束的默认路径）
 *
 * **支持 env 覆盖**：与同仓既有惯例一致（`SQLITE_DB_PATH` / `DUCKDB_PATH` / `BACKUP_DIR` 均为 env 优先），
 * 使插件目录不必硬编码到某个部署路径 —— 例如开发机无 `/opt/invol` 写权限时，
 * 可设 `PLUGIN_ALLOWED_PATH=<可写目录>` 而无需改代码。
 *
 * ⚠️ 目录必须是**绝对路径**（路径逃逸检查按 `path.resolve` 前缀比对，见 loadPluginsFromDir）。
 * ⚠️ 该目录不存在时**不报错**，只记 INFO 日志跳过磁盘加载（内置插件仍可用）。
 */
export const PLUGIN_ALLOWED_PATH = process.env.PLUGIN_ALLOWED_PATH ?? '/opt/invol/plugins/strategies';

/** 耗时取 3 位小数（微秒精度足够定位 50ms 预算问题，又不打日志刷屏） */
const round3 = (ms: number): number => Math.round(ms * 1000) / 1000;

/**
 * T88 / DEC-12 B-3：50ms 计时边界的口径定义
 *
 * | 计入 50ms 预算          | 不计入（IO / 序列化 / 落库） |
 * |-------------------------|------------------------------|
 * | execute() 内指标计算判断 | ctx.getDailyKlines()        |
 * |                         | ctx.batchGetDailyKlines()   |
 *
 * 实现：executePlugin() 用 withIo() 包住行情查询 —— 取数前 disarm 计时器，
 * 取数后重置计时起点并重新挂满预算（SDD §5.3「50ms 计时边界」）。
 *
 * ⚠️ **沙盒安全约束不受影响**：插件自身的死循环 / 阻塞仍必须被 reject 并标记 TIMEOUT。
 */

// ---------------------------------------------------------------------------
// 插件契约类型（SDD §5.3「所有内置插件与自定义插件必须严格遵循」）
// ---------------------------------------------------------------------------

export type PluginId = string;
export type Period = 'daily';                       // MVP 固定日线
export type PluginCategory = 'monitor' | 'filter';
export type PluginSubCategory =
  | 'momentum'       // 动量类：RSI、KDJ
  | 'trend'          // 趋势类：MACD、均线
  | 'volume'         // 量能类：OBV、量比
  | 'breakout'       // 突破类
  | 'mean_reversion' // 均值回归类
  | 'pattern'        // 形态类
  | 'custom';        // 自定义
export type PluginComplexity = 'simple' | 'medium' | 'complex';

/** 图表渲染元数据（前端 KLineChart 副图 / 叠加层渲染用） */
export interface ChartOverlayConfig {
  position: 'main' | 'sub';
  subChartHeightRatio?: number;
  lines?: {
    key: string;
    color: string;
    width?: number;
    style?: 'solid' | 'dashed';
  }[];
  /** 阈值线（例如 RSI 超买超卖线） */
  thresholdLines?: { value: number; color: string; label?: string }[];
  /** 填充区域（例如 MACD 柱状图正值红 / 负值绿） */
  fillAreas?: { above?: string; below?: string };
}

// ---------------------------------------------------------------------------
// 插件引擎内部接口（与 core 包 plugin.ts 的简单版不同，这里是增强版：
// PluginContext 暴露行情查询函数 + 指标算法，方便 execute() 内部调用）
// ---------------------------------------------------------------------------

export interface ParamField {
  key: string;                          // 注意：core 包是 name，这里按规格用 key
  label: string;
  // 注：SDD §5.3 只列 number|string|select|boolean；本项目额外支持 integer（前后端表单按整数步进渲染）
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

/**
 * 插件信号输出
 *
 * T93 契约对齐（SDD §5.3 StrategySignal）：
 *   - `params` → **`metrics`**（SDD 命名为 metrics；signalService 落 user_strategy_signal.metrics_json）
 *   - `signalType` 去掉 `'ALERT'`（SDD §5.3 只有 buy/sell/hold 三向，无告警向）
 *   - `direction`（SDD 命名）在本引擎保持 `signalType` 大写枚举，落库时由
 *     signalService 的 DIRECTION_MAP 映射为 SDD 的 buy/sell/hold
 */
export interface PluginSignal {
  symbol: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  label?: string;                        // 人读标签（落 user_strategy_signal.label，缺省用 signalType）
  strength?: number;                     // 0-1 信号强度
  pluginId: string;
  timestamp: string;                     // ISO
  metrics?: Record<string, number>;       // 指标明细，例如 { rsi: 28.5, period: 14 }
  detail?: string;
}

/** 插件定义 —— SDD §5.3 StrategyPlugin 的增强版（execute 拿 ctx 而不是裸数组） */
export interface Plugin {
  readonly id: PluginId;
  readonly name: string;
  /** 语义化版本号，例如 '1.0.0' */
  readonly version: string;
  /** 作者 / 来源 */
  readonly author: string;
  /** 周期，MVP 固定 'daily' */
  readonly period: Period;
  category: PluginCategory;              // monitor=每日收盘跑信号 / filter=全市场条件选股
  /** 归属子分类（UI 分组用） */
  readonly subCategory: PluginSubCategory;
  /** 执行复杂度标记（日志统计用，非硬约束） */
  readonly complexity: PluginComplexity;
  description?: string;
  paramSchema?: ParamField[];
  /** 默认参数值 —— **由 paramSchema[].default 派生，禁止两处各写一份默认值** */
  readonly defaultParams: Record<string, unknown>;
  /** 图表渲染元数据（K 线图副图 / 叠加层渲染用） */
  readonly chartOverlay?: ChartOverlayConfig;
  /**
   * 跨字段约束（如 RSI 的 oversold 必须 < overbought），校验失败抛 PluginParamError。
   * 单字段的 min/max 走 paramSchema，这里只管字段之间的关系。
   */
  validateCrossFields?(params: Record<string, unknown>): void;
  execute(
    context: PluginContext,
    params: Record<string, unknown>,
  ): Promise<PluginSignal[] | PluginSignal>;
}

/**
 * 从 paramSchema[].default 派生 defaultParams（T93 裁决：paramSchema 是默认值的唯一真相源，
 * defaultParams 只是只读默认视图，禁止两处各写一份默认值导致漂移）
 */
export function deriveDefaultParams(schema?: ParamField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema ?? []) {
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** 插件定义入参：defaultParams 由 definePlugin 自动派生，调用方不允许手写 */
export type PluginSpec = Omit<Plugin, 'defaultParams'>;

/** 内置插件统一入口：自动补齐 defaultParams（+ 契约缺字段兜底） */
export function definePlugin(spec: PluginSpec): Plugin {
  return {
    ...spec,
    defaultParams: deriveDefaultParams(spec.paramSchema),
  };
}

/** 自定义（磁盘）插件的契约字段兜底值 —— 缺失时填这里并记 WARN，不静默填 undefined */
const CONTRACT_FALLBACK = {
  version: '0.0.0',
  author: 'custom',
  period: 'daily' as Period,
  subCategory: 'custom' as PluginSubCategory,
  complexity: 'simple' as PluginComplexity,
};

/**
 * 把任意插件对象补齐成完整契约（T93）
 * 内置插件与自定义插件走**同一条**归一化路径 —— 不对自定义插件放宽。
 */
export function normalizePlugin(plugin: Plugin): Plugin {
  const missing: string[] = [];
  if (typeof plugin.version !== 'string' || !plugin.version) missing.push('version');
  if (typeof plugin.author !== 'string' || !plugin.author) missing.push('author');
  if (plugin.period !== 'daily') missing.push('period');
  if (typeof plugin.subCategory !== 'string' || !plugin.subCategory) missing.push('sub_category');
  if (typeof plugin.complexity !== 'string' || !plugin.complexity) missing.push('complexity');

  if (missing.length > 0) {
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'WARN',
      message: `插件 ${plugin.id} 契约字段缺失，已按兜底值补齐: ${missing.join(',')}`,
      checkItem: plugin.id,
    });
  }

  return {
    ...plugin,
    version: typeof plugin.version === 'string' && plugin.version ? plugin.version : CONTRACT_FALLBACK.version,
    author: typeof plugin.author === 'string' && plugin.author ? plugin.author : CONTRACT_FALLBACK.author,
    period: plugin.period === 'daily' ? 'daily' : CONTRACT_FALLBACK.period,
    subCategory: typeof plugin.subCategory === 'string' && plugin.subCategory ? plugin.subCategory : CONTRACT_FALLBACK.subCategory,
    complexity: typeof plugin.complexity === 'string' && plugin.complexity ? plugin.complexity : CONTRACT_FALLBACK.complexity,
    defaultParams:
      plugin.defaultParams && Object.keys(plugin.defaultParams).length > 0
        ? plugin.defaultParams
        : deriveDefaultParams(plugin.paramSchema),
  };
}

// ---------------------------------------------------------------------------
// 内置插件注册表
//   monitor = 每日收盘跑信号（rsi_oversold / macd_cross）
//   filter  = 全市场条件选股（ma_bullish_alignment / volume_breakout）
//             ⚠️ filter 类插件的 paramSchema **不允许 required: true** —— filter 面向全市场，
//                由选股路由逐标的注入 symbol 或一次性传 symbols 批量筛选
// ---------------------------------------------------------------------------

/** filter 类插件的统一 symbol 入参（单标的 / 批量二选一，均非必填） */
const FILTER_SYMBOL_FIELDS: ParamField[] = [
  {
    key: 'symbol',
    label: '标的代码',
    type: 'string',
    default: '',
    description: '单标的筛选（选股路由会按标的注入此参数）；留空则必须提供 symbols',
  },
  {
    key: 'symbols',
    label: '批量标的',
    type: 'string',
    default: '',
    description: '逗号分隔的标的列表；给了就走一次 IN 批量查询（禁止逐标的循环查询）',
  },
];

/** 解析 filter 插件的 symbol / symbols 入参 → 待筛选标的列表 */
function parseFilterSymbols(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    for (const part of raw.split(/[,;\s]+/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  };
  push(params.symbols);
  push(params.symbol);
  return [...new Set(out)];
}

export const builtinPlugins: Plugin[] = [
  // ---------- RSI 超买超卖（T96：threshold 拆为 oversold/overbought） ----------
  definePlugin({
    id: 'rsi_oversold',
    name: 'RSI(14) 超买超卖',
    version: '2.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'monitor',
    subCategory: 'momentum',
    complexity: 'simple',
    description: 'RSI 跌破超卖线发出买入信号；RSI 升破超买线发出卖出信号（Requirements §5.5）',
    chartOverlay: {
      position: 'sub',
      subChartHeightRatio: 0.3,
      thresholdLines: [
        { value: 30, color: '#2ecc71', label: '超卖 30' },
        { value: 70, color: '#e74c3c', label: '超买 70' },
      ],
    },
    paramSchema: [
      { key: 'symbol', label: '标的代码', type: 'string', default: 'sh600000', required: true },
      { key: 'period', label: 'RSI 周期', type: 'integer', default: 14, min: 5, max: 30 },
      { key: 'oversold', label: '超卖阈值', type: 'number', default: 30, min: 1, max: 50 },
      { key: 'overbought', label: '超买阈值', type: 'number', default: 70, min: 50, max: 100 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
    ],
    // 跨字段约束：超卖线必须低于超买线，否则两个区间互相吞掉、信号方向自相矛盾
    validateCrossFields(params) {
      const oversold = params.oversold;
      const overbought = params.overbought;
      if (typeof oversold === 'number' && typeof overbought === 'number' && oversold >= overbought) {
        throw new PluginParamError(
          'rsi_oversold',
          'overbought',
          `超卖阈值 oversold(${oversold}) 必须小于超买阈值 overbought(${overbought})`,
        );
      }
    },
    async execute(ctx, params) {
      const symbol = params.symbol as string;
      const period = params.period as number;
      const oversold = params.oversold as number;
      const overbought = params.overbought as number;
      const days = params.days as number;

      const klines = await ctx.getDailyKlines(symbol, days);
      if (klines.length < period + 1) return [];

      const closes = klines.map(k => k.close);
      const rsi = ctx.calculateRSI(closes, period);
      const latestRSI = rsi[rsi.length - 1];
      if (latestRSI === undefined || Number.isNaN(latestRSI)) return [];

      const base = {
        symbol,
        pluginId: 'rsi_oversold',
        timestamp: new Date().toISOString(),
        metrics: { period, oversold, overbought, days, latestRSI },
      };

      // 超卖 → 买入
      if (latestRSI < oversold) {
        return [
          {
            ...base,
            signalType: 'BUY' as const,
            strength: Math.max(0, (oversold - latestRSI) / oversold),
            detail: `RSI(${period})=${latestRSI.toFixed(2)} < 超卖线 ${oversold}（超卖买入）`,
          },
        ];
      }
      // 超买 → 卖出（T96 新增：原先只有超卖分支，RSI 升到 70 以上恒不发信号）
      if (latestRSI > overbought) {
        return [
          {
            ...base,
            signalType: 'SELL' as const,
            strength: Math.min(1, (latestRSI - overbought) / (100 - overbought)),
            detail: `RSI(${period})=${latestRSI.toFixed(2)} > 超买线 ${overbought}（超买卖出）`,
          },
        ];
      }
      // 中间地带 → 无信号
      return [];
    },
  }),

  // ---------- MACD 金叉死叉 ----------
  definePlugin({
    id: 'macd_cross',
    name: 'MACD 金叉死叉',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'monitor',
    subCategory: 'trend',
    complexity: 'simple',
    description: '当 DIF 从下方上穿 DEA 时发出金叉（买入）信号，下穿时发出死叉（卖出）信号',
    chartOverlay: {
      position: 'sub',
      subChartHeightRatio: 0.3,
      lines: [{ key: 'dif', color: '#e74c3c', width: 1 }, { key: 'dea', color: '#3498db', width: 1 }],
      fillAreas: { above: '#e74c3c', below: '#2ecc71' },
    },
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
          metrics: { fast, slow, signal, days, dif: dif[n - 1], dea: dea[n - 1] },
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
          metrics: { fast, slow, signal, days, dif: dif[n - 1], dea: dea[n - 1] },
          detail: `DIF=${dif[n - 1].toFixed(4)} 下穿 DEA=${dea[n - 1].toFixed(4)}（死叉）`,
        });
      }
      return signals;
    },
  }),

  // ---------- 均线多头排列（T83：filter 类，全市场条件选股） ----------
  definePlugin({
    id: 'ma_bullish_alignment',
    name: '均线多头排列',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'filter',
    subCategory: 'trend',
    complexity: 'simple',
    description: '筛选出短中期均线呈多头排列且收盘价站上长期均线的标的（Requirements §4.2 全市场条件选股）',
    chartOverlay: {
      position: 'main',
      lines: [
        { key: 'ma_short', color: '#f39c12', width: 1 },
        { key: 'ma_mid', color: '#3498db', width: 1 },
        { key: 'ma_long', color: '#9b59b6', width: 1 },
      ],
    },
    paramSchema: [
      ...FILTER_SYMBOL_FIELDS,
      { key: 'periodShort', label: '短期均线', type: 'integer', default: 5, min: 2, max: 60 },
      { key: 'periodMid', label: '中期均线', type: 'integer', default: 10, min: 3, max: 120 },
      { key: 'periodLong', label: '长期均线', type: 'integer', default: 20, min: 5, max: 250 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
      { key: 'limit', label: '候选返回上限', type: 'integer', default: 50, min: 1, max: 500 },
    ],
    validateCrossFields(params) {
      const s = params.periodShort;
      const m = params.periodMid;
      const l = params.periodLong;
      if (typeof s === 'number' && typeof m === 'number' && typeof l === 'number' && !(s < m && m < l)) {
        throw new PluginParamError(
          'ma_bullish_alignment',
          'periodLong',
          `均线周期必须严格递增 periodShort(${s}) < periodMid(${m}) < periodLong(${l})`,
        );
      }
    },
    async execute(ctx, params) {
      const periodShort = params.periodShort as number;
      const periodMid = params.periodMid as number;
      const periodLong = params.periodLong as number;
      const days = params.days as number;
      const limit = params.limit as number;

      const symbols = parseFilterSymbols(params);
      if (symbols.length === 0) return [];

      // 批量模式一次 IN 查询拿全部标的日线（禁止逐标的循环查 DuckDB）
      const klineMap =
        symbols.length > 1
          ? await ctx.batchGetDailyKlines(symbols, days)
          : new Map<string, DailyKline[]>([
              [symbols[0], await ctx.getDailyKlines(symbols[0], days)],
            ]);

      const signals: PluginSignal[] = [];
      for (const symbol of symbols) {
        const klines = klineMap.get(symbol) ?? [];
        if (klines.length < periodLong + 1) continue;

        const closes = klines.map(k => k.close);
        const maShort = ctx.calculateSMA(closes, periodShort);
        const maMid = ctx.calculateSMA(closes, periodMid);
        const maLong = ctx.calculateSMA(closes, periodLong);
        const i = closes.length - 1;
        const short = maShort[i];
        const mid = maMid[i];
        const long = maLong[i];
        if (
          short === undefined || mid === undefined || long === undefined
          || Number.isNaN(short) || Number.isNaN(mid) || Number.isNaN(long)
        ) continue;

        const close = closes[i];
        if (!(short > mid && mid > long && close > long)) continue;

        signals.push({
          symbol,
          signalType: 'BUY',
          strength: Math.min(1, Math.max(0, (short / long - 1) * 10)),
          pluginId: 'ma_bullish_alignment',
          timestamp: new Date().toISOString(),
          metrics: { maShort: short, maMid: mid, maLong: long, close, periodShort, periodMid, periodLong },
          detail: `MA${periodShort}=${short.toFixed(2)} > MA${periodMid}=${mid.toFixed(2)} > MA${periodLong}=${long.toFixed(2)}，收盘 ${close.toFixed(2)} 站上长期均线`,
        });
      }

      signals.sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
      return signals.slice(0, limit);
    },
  }),

  // ---------- 放量突破（T83：filter 类） ----------
  definePlugin({
    id: 'volume_breakout',
    name: '放量突破',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'filter',
    subCategory: 'breakout',
    complexity: 'simple',
    description: '筛选出收盘价创 N 日新高且成交量放大到 N 日均量指定倍数的标的',
    paramSchema: [
      ...FILTER_SYMBOL_FIELDS,
      { key: 'lookback', label: '突破回溯天数', type: 'integer', default: 20, min: 5, max: 120 },
      { key: 'volumeRatio', label: '放量倍数', type: 'number', default: 1.5, min: 1, max: 10 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
      { key: 'limit', label: '候选返回上限', type: 'integer', default: 50, min: 1, max: 500 },
    ],
    async execute(ctx, params) {
      const lookback = params.lookback as number;
      const volumeRatio = params.volumeRatio as number;
      const days = params.days as number;
      const limit = params.limit as number;

      const symbols = parseFilterSymbols(params);
      if (symbols.length === 0) return [];

      const klineMap =
        symbols.length > 1
          ? await ctx.batchGetDailyKlines(symbols, days)
          : new Map<string, DailyKline[]>([
              [symbols[0], await ctx.getDailyKlines(symbols[0], days)],
            ]);

      const signals: PluginSignal[] = [];
      for (const symbol of symbols) {
        const klines = klineMap.get(symbol) ?? [];
        if (klines.length < lookback + 2) continue;

        const last = klines[klines.length - 1];
        const prev = klines.slice(-(lookback + 1), -1);
        if (prev.length < lookback) continue;

        const prevHigh = Math.max(...prev.map(k => k.high));
        const avgVolume = prev.reduce((acc, k) => acc + k.volume, 0) / prev.length;
        if (!(avgVolume > 0)) continue;
        const ratio = last.volume / avgVolume;
        if (!(last.close > prevHigh && ratio >= volumeRatio)) continue;

        signals.push({
          symbol,
          signalType: 'BUY',
          strength: Math.min(1, ratio / (volumeRatio * 2)),
          pluginId: 'volume_breakout',
          timestamp: new Date().toISOString(),
          metrics: { close: last.close, prevHigh, volumeRatio: ratio, lookback, amount: last.amount },
          detail: `收盘 ${last.close.toFixed(2)} 突破前 ${lookback} 日最高 ${prevHigh.toFixed(2)}，量比 ${ratio.toFixed(2)} ≥ ${volumeRatio}`,
        });
      }

      signals.sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
      return signals.slice(0, limit);
    },
  }),
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
 *   - id: string（必填）
 *   - name: string（必填）
 *   - category: 'monitor' | 'filter'（必填）
 *   - execute(ctx, params): Promise<PluginSignal[] | PluginSignal>（必填）
 *   - version / author / period / sub_category / complexity / paramSchema / chartOverlay（可选，
 *     缺失时走 CONTRACT_FALLBACK 兜底值并记 WARN，不静默填 undefined —— T93）
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
  // T93：契约字段（version/author/period/sub_category/complexity）自定义插件缺省时走兜底值，
  // 不再静默填 undefined；defaultParams 一律由 paramSchema 派生，避免两处默认值漂移。
  const paramSchema = Array.isArray(p.paramSchema)
    ? (p.paramSchema as Plugin['paramSchema'])
    : undefined;

  return normalizePlugin({
    id: p.id as string,
    name: p.name as string,
    version: typeof p.version === 'string' ? (p.version as string) : CONTRACT_FALLBACK.version,
    author: typeof p.author === 'string' ? (p.author as string) : CONTRACT_FALLBACK.author,
    period: p.period === 'daily' ? 'daily' : CONTRACT_FALLBACK.period,
    category: p.category as 'monitor' | 'filter',
    subCategory: typeof p.sub_category === 'string'
      ? (p.sub_category as PluginSubCategory)
      : typeof p.subCategory === 'string'
        ? (p.subCategory as PluginSubCategory)
        : CONTRACT_FALLBACK.subCategory,
    complexity: typeof p.complexity === 'string'
      ? (p.complexity as PluginComplexity)
      : CONTRACT_FALLBACK.complexity,
    description:
      typeof p.description === 'string'
        ? (p.description as string)
        : undefined,
    paramSchema,
    defaultParams: deriveDefaultParams(paramSchema),
    chartOverlay:
      p.chartOverlay && typeof p.chartOverlay === 'object'
        ? (p.chartOverlay as ChartOverlayConfig)
        : undefined,
    validateCrossFields:
      typeof p.validateCrossFields === 'function'
        ? (p.validateCrossFields as Plugin['validateCrossFields'])
        : undefined,
    execute: p.execute as Plugin['execute'],
  });
}

/**
 * 合并 builtin + 磁盘加载 → 完整插件列表
 *
 * 调用时机：executePlugin() 前调一次
 *   builtinPlugins 始终有（monitor 2 个 + filter 2 个）
 *   磁盘加载有则追加，无则只有 builtin
 *
 * T93：两者都过 normalizePlugin —— 内置与自定义走同一条契约归一化路径，不对自定义放宽。
 */
export function getAllPlugins(): Plugin[] {
  const diskPlugins = loadPluginsFromDir();
  return [...builtinPlugins, ...diskPlugins].map(normalizePlugin);
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
 *   - 全部单字段校验通过后跑 plugin.validateCrossFields()（跨字段约束，如 oversold < overbought）
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

  // 跨字段约束（如 RSI 的 oversold < overbought）—— 必须在所有单字段校验通过后跑
  if (plugin.validateCrossFields) {
    try {
      plugin.validateCrossFields(merged);
    } catch (err) {
      if (err instanceof PluginParamError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new PluginParamError(plugin.id, '*', `跨字段约束校验失败: ${msg}`);
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
  /** execute() 的**纯计算**耗时（不含行情 IO，T88 口径） */
  durationMs: number;
  /** 被排除在 50ms 预算之外的行情 IO 累计耗时（毫秒），仅用于可观测性 */
  ioMs?: number;
  error?: string;
}

/**
 * SDD §5.3: execute() 硬限制 50ms 超时（Promise.race 语义）。
 *
 * T88（DEC-12 B-3）计时边界：
 *   ✅ 计入 —— execute() 内的指标计算与判断
 *   ❌ 不计入 —— ctx.getDailyKlines / ctx.batchGetDailyKlines（DuckDB IO）
 *   实现：把注入给 execute 的 ctx 包一层 timedCtx，行情函数走 withIo()
 *         （取数前 disarm 计时器 → 取数后重置计时起点并重新挂满预算）。
 *
 * ⚠️ 安全约束不变：execute() 自身死循环 / 阻塞仍会被 reject 并标记 TIMEOUT。
 *
 * 超时标记 TIMEOUT；异常标记 ERROR；返回空数组标记 SKIP。
 */
export async function executePlugin(
  plugin: Plugin,
  userParams?: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginExecutionResult> {
  const validateStart = performance.now();

  // 1. 参数校验（失败直接 ERROR 返回；参数校验本身不计入 execute() 的 50ms 预算）
  let validatedParams: Record<string, unknown>;
  try {
    validatedParams = validatePluginParams(plugin, userParams);
  } catch (err) {
    const duration = performance.now() - validateStart;
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
      durationMs: round3(duration),
      error: msg,
    };
  }

  // 2. 构建上下文（如果调用方没传）
  const ctx = context ?? buildPluginContext();

  // === 3. T88：IO 感知的 50ms 预算窗口 ===
  let computeStart = performance.now();   // 计时起点（每次 IO 结束后重置）
  let ioMs = 0;                           // 被排除在预算外的 IO 累计耗时
  let ioDepth = 0;                        // 嵌套/并发 IO 计数（>0 时视为仍在 IO 段内）
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: (r: PluginExecutionResult) => void = () => { /* 未初始化占位 */ };

  const race = new Promise<PluginExecutionResult>((resolve) => {
    settle = resolve;
  });

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (): void => {
    if (settled) return;
    disarm();
    timer = setTimeout(() => {
      timer = null;
      if (settled) return;
      settled = true;
      // ⚠️ 必须先取耗时再写日志：writeSystemLog 首次调用会触发 ConfigStore 懒加载（建表/迁移 ~50ms），
      //    把它算进 durationMs 会污染计时口径
      const durationMs = round3(performance.now() - computeStart);
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'ERROR',
        message: `插件 ${plugin.id} 执行超时 (${PLUGIN_TIMEOUT_MS}ms，不含行情 IO)`,
        checkItem: plugin.id,
      });
      settle({
        pluginId: plugin.id,
        status: 'TIMEOUT',
        signals: [],
        durationMs,
        ioMs: round3(ioMs),
        error: `执行超过 ${PLUGIN_TIMEOUT_MS}ms 硬超时`,
      });
    }, PLUGIN_TIMEOUT_MS);
  };

  /** 行情 IO 包装：进入前 disarm 计时器，结束后重置计时起点并重新挂满预算 */
  const withIo = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (ioDepth > 0) return await fn();   // 已在 IO 段内（并发/嵌套），不重复重置
    ioDepth += 1;
    disarm();
    const ioStart = performance.now();
    try {
      return await fn();
    } finally {
      ioMs += performance.now() - ioStart;
      ioDepth -= 1;
      computeStart = performance.now();  // 取数后重置计时起点
      arm();
    }
  };

  const timedCtx: PluginContext = {
    getDailyKlines: (symbol, days) => withIo(() => ctx.getDailyKlines(symbol, days)),
    batchGetDailyKlines: (symbols, days) => withIo(() => ctx.batchGetDailyKlines(symbols, days)),
    calculateRSI: ctx.calculateRSI,
    calculateMACD: ctx.calculateMACD,
    calculateSMA: ctx.calculateSMA,
  };

  // 4. 计时开始 → 执行插件（IO 不计入，见上方 withIo）
  //
  // ⚠️ 必须把执行放进**游离的 async IIFE**，不能 `await` 在主流程里：
  //    插件永不 resolve 时，`await plugin.execute()` 会把整个 executePlugin 卡住，
  //    根本走不到下面的 `return await race`，超时保护形同虚设。
  arm();
  void (async (): Promise<void> => {
    try {
      const raw = await plugin.execute(timedCtx, validatedParams);
      if (!settled) {
        settled = true;
        disarm();
        const signals: PluginSignal[] = Array.isArray(raw) ? raw : [raw];
        const durationMs = round3(performance.now() - computeStart);

        if (signals.length === 0) {
          writeSystemLog({
            logType: 'plugin_execute',
            level: 'SKIP',
            message: `插件 ${plugin.id} 正常执行但无信号`,
            checkItem: plugin.id,
          });
          settle({
            pluginId: plugin.id,
            status: 'SKIP',
            signals: [],
            durationMs,
            ioMs: round3(ioMs),
          });
        } else {
          writeSystemLog({
            logType: 'plugin_execute',
            level: 'SUCCESS',
            message: `插件 ${plugin.id} 返回 ${signals.length} 个信号`,
            detail: `compute=${durationMs}ms io=${round3(ioMs)}ms`,
            checkItem: plugin.id,
          });
          settle({
            pluginId: plugin.id,
            status: 'SUCCESS',
            signals,
            durationMs,
            ioMs: round3(ioMs),
          });
        }
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        disarm();
        const msg = err instanceof Error ? err.message : String(err);
        writeSystemLog({
          logType: 'plugin_execute',
          level: 'ERROR',
          message: `插件 ${plugin.id} 执行异常`,
          detail: msg,
          checkItem: plugin.id,
        });
        settle({
          pluginId: plugin.id,
          status: 'ERROR',
          signals: [],
          durationMs: round3(performance.now() - computeStart),
          ioMs: round3(ioMs),
          error: msg,
        });
      }
    }
  })();

  return await race;
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
