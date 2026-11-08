// src/services/pluginEngine.ts
// 插件引擎核心：加载 + 参数校验 + 沙盒执行 + 超时保护
// SDD §5.3 硬约束：沙盒禁止 global / process / require；
//                  execute() 50ms 预算**只覆盖纯计算，行情 IO 不计入**（T88 / DEC-12 B-3）

import { calculateRSI, calculateMACD, calculateBoll, type MACDResult, type BollResult } from '@invest/core';
import { calculateSMA } from './indicators.js';
import { batchGetDailyRange, batchGetLatestClose } from './marketData.js';
import { ConfigStore } from '../config/configStore.js';
import { SIGNAL_USER_ID } from './signalService.js';
import { calcAllPositions } from './positionCalculator.js';
import { getAssetClass } from './assetClass.js';
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
export const PLUGIN_ALLOWED_PATH = process.env.PLUGIN_ALLOWED_PATH ?? '/opt/invol/IA_Prod/plugins/strategies';

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
export type Period = 'daily'; // MVP 固定日线
export type PluginCategory = 'monitor' | 'filter';
/**
 * 插件归属子分类
 *
 * 🔴 对外口径 = V3 §4.1 **六分类**（趋势 / 动量 / 波动率 / 量价 / 形态 / 风险）。
 * `custom` 是**内部兜底值**（未分类）：仅用于契约字段缺失或旧插件值无法识别，
 * **不对外展示、不计入六类**，API 与 UI 必须显式过滤。
 *
 * 旧值迁移（2026-11-07 裁决）：`breakout → volume`、`mean_reversion → volatility`。
 * 映射只允许存在于 `normalizeSubCategory()` 一个入口，禁止在调用点各写一份。
 */
export type PluginSubCategory =
  | 'trend' // 趋势：MACD、均线排列
  | 'momentum' // 动量：RSI、KDJ
  | 'volatility' // 波动率：布林带、ATR 通道
  | 'volume' // 量价：放量突破、缩量回调、量价背离
  | 'pattern' // 形态：锤子线、吞没、缺口
  | 'risk' // 风险：ATR 止损、回撤、组合暴露
  | 'custom'; // 未分类（内部兜底，不对外展示）
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
  key: string; // 注意：core 包是 name，这里按规格用 key
  label: string;
  // 注：SDD §5.3 只列 number|string|select|boolean；本项目额外支持 integer（前后端表单按整数步进渲染）
  type: 'number' | 'string' | 'boolean' | 'integer' | 'select';
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[]; // select 类型的合法值
  unit?: string;
  description?: string;
  required?: boolean;
  /**
   * 运行时注入字段（T85b ①）
   *
   * 该参数**由调用方在执行时注入**（如 `symbol`），不是用户可配置项。
   * 标上此标记后，前端参数表单**不渲染**它（用户不该能改「跑哪些标的」）。
   */
  runtimeInjected?: boolean;
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
  /** 布林带（波动率通道，S3：`volatility` 类的数据来源） */
  calculateBoll(closes: number[], period?: number, stdDev?: number): BollResult;

  // ── 只读持仓视图（S2：风险类插件的数据来源） ──
  /** 持仓快照（构建期冻结，`execute()` 内零 IO） */
  positions(): readonly PluginPositionView[];
  /**
   * 现金类资产市值（`asset_class = 'cash'` 的持仓市值合计）。
   * 🔴 **不是「可用现金余额」** —— 本系统不建模现金余额，禁止拿它当加仓额度用。
   */
  readonly cash: number;
  /** 权益 = 现金类资产市值 + 全部风险资产市值 */
  readonly equity: number;
  /** 持仓快照是否可用：无 userId / 回放（asOfDate）/ 读取失败 → false */
  readonly positionsAvailable: boolean;
}

/** 插件侧只读持仓视图（不直接暴露业务层 DTO，避免插件依赖内部字段） */
export interface PluginPositionView {
  symbol: string;
  /** 持仓数量（已夹到 ≥ 0） */
  quantity: number;
  /** 移动加权平均成本（含手续费） */
  avgCost: number;
  /** 按最新收盘价估算的市值（取不到价时为 0） */
  marketValue: number;
  /**
   * 资产分类（`asset_class` 表口径，无记录默认 `risk`）
   *
   * 风险类插件只对 `risk` 类持仓做占比 / 止损判断：
   * 货币 ETF 等 `cash` 类持仓既不该有「浮亏止损」，也不该进「单票占比」分母之外的判断
   * （现金类市值仍计入 `equity`，见 `loadPositionSnapshot`）。
   */
  assetClass: 'risk' | 'cash';
}

/**
 * 持仓快照（构建期算一次，`execute()` 内零 IO）
 * 不可用时 `positions = []`、`cash/equity = 0`。
 */
export interface PluginPositionSnapshot {
  available: boolean;
  /** 不可用原因，仅用于日志与 SKIP 归因（`NO_USER` / `REPLAY` / `READ_FAILED`） */
  unavailableReason?: string;
  positions: readonly PluginPositionView[];
  cash: number;
  equity: number;
}

/** 空快照：无 userId / 回放 / 读取失败时的降级值 */
export const EMPTY_POSITION_SNAPSHOT: PluginPositionSnapshot = {
  available: false,
  positions: [],
  cash: 0,
  equity: 0,
};

/**
 * 「无用户语义」的快照（如全市场选股）：显式空持仓 + `NO_USER` 归因。
 *
 * 调用点必须**显式传入**，不要依赖 `buildPluginContext` 的默认值 ——
 * 默认值只是兜底，写出来才能让「这里没有用户」这件事在代码里可见：
 * 风险类插件据此 SKIP（`POSITION_UNAVAILABLE`），而不是按某个真实用户的持仓出结果。
 */
export const NO_USER_POSITION_SNAPSHOT: PluginPositionSnapshot = {
  ...EMPTY_POSITION_SNAPSHOT,
  unavailableReason: 'NO_USER',
};

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
  label?: string; // 人读标签（落 user_strategy_signal.label，缺省用 signalType）
  strength?: number; // 0-1 信号强度
  pluginId: string;
  timestamp: string; // ISO
  metrics?: Record<string, number>; // 指标明细，例如 { rsi: 28.5, period: 14 }
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
  category: PluginCategory; // monitor=每日收盘跑信号 / filter=全市场条件选股
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
  /**
   * 需要持仓视图才能工作（风险类插件）。
   * 持仓快照不可用（无 userId / 回放）时，引擎直接 SKIP 并标记 `POSITION_UNAVAILABLE`，
   * **不静默返回空信号** —— 否则「风险类在回放中不出信号」会变成查不出来的空洞。
   */
  readonly requiresPositions?: boolean;
  execute(context: PluginContext, params: Record<string, unknown>): Promise<PluginSignal[] | PluginSignal>;
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

/** 合法子分类集合（六类 + 内部兜底 `custom`） */
const SUB_CATEGORY_VALUES: ReadonlySet<string> = new Set<PluginSubCategory>([
  'trend',
  'momentum',
  'volatility',
  'volume',
  'pattern',
  'risk',
  'custom',
]);

/**
 * 旧子分类字面值 → 新口径（**唯一映射入口的映射表**）
 *
 * - `breakout → volume`：突破必须由量价确认，V3 六分类无独立「突破类」
 * - `mean_reversion → volatility`：均值回归在本项目只由波动率通道（布林带）承载
 */
const LEGACY_SUB_CATEGORY_MAP: Readonly<Record<string, PluginSubCategory>> = {
  breakout: 'volume',
  mean_reversion: 'volatility',
};

/**
 * 子分类归一化（**唯一入口**）—— 磁盘插件、契约兜底、内置插件都必须走这里
 *
 * | 输入 | 输出 | 是否告警 |
 * |---|---|---|
 * | 六类 + `custom` | 原值 | 否 |
 * | `breakout` / `mean_reversion` | 映射后的新值 | WARN（旧值需迁移） |
 * | 其它任意字符串 | `custom` | WARN（无法识别） |
 * | 非字符串 / 空串 | `custom` | 否（由契约缺失告警覆盖） |
 */
export function normalizeSubCategory(raw: unknown, pluginId = '<unknown>'): PluginSubCategory {
  if (typeof raw === 'string' && SUB_CATEGORY_VALUES.has(raw)) {
    return raw as PluginSubCategory;
  }
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_SUB_CATEGORY_MAP, raw)) {
    const mapped = LEGACY_SUB_CATEGORY_MAP[raw];
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'WARN',
      message: `插件 ${pluginId} 的 sub_category '${raw}' 为旧口径，已迁移为 '${mapped}'`,
      checkItem: pluginId,
    });
    return mapped;
  }
  if (typeof raw === 'string' && raw) {
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'WARN',
      message: `插件 ${pluginId} 的 sub_category '${raw}' 无法识别，已降级为 'custom'`,
      checkItem: pluginId,
    });
  }
  return 'custom';
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
    version:
      typeof plugin.version === 'string' && plugin.version ? plugin.version : CONTRACT_FALLBACK.version,
    author: typeof plugin.author === 'string' && plugin.author ? plugin.author : CONTRACT_FALLBACK.author,
    period: plugin.period === 'daily' ? 'daily' : CONTRACT_FALLBACK.period,
    subCategory: normalizeSubCategory(plugin.subCategory, plugin.id),
    complexity:
      typeof plugin.complexity === 'string' && plugin.complexity
        ? plugin.complexity
        : CONTRACT_FALLBACK.complexity,
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
      {
        key: 'symbol',
        label: '标的代码',
        type: 'string',
        default: 'sh600000',
        required: true,
        runtimeInjected: true,
      },
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

      const closes = klines.map((k) => k.close);
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
            // F 域 P2-5：补 label（修复前落库恒为 BUY/SELL，违背 SDD §5.3「描述性文字」要求）
            label: `RSI 超卖买入（${latestRSI.toFixed(2)} < ${oversold}）`,
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
            label: `RSI 超买卖出（${latestRSI.toFixed(2)} > ${overbought}）`,
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
      lines: [
        { key: 'dif', color: '#e74c3c', width: 1 },
        { key: 'dea', color: '#3498db', width: 1 },
      ],
      fillAreas: { above: '#e74c3c', below: '#2ecc71' },
    },
    paramSchema: [
      {
        key: 'symbol',
        label: '标的代码',
        type: 'string',
        default: 'sh600000',
        required: true,
        runtimeInjected: true,
      },
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

      const closes = klines.map((k) => k.close);
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
          label: 'MACD 金叉（DIF 上穿 DEA）',
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
          label: 'MACD 死叉（DIF 下穿 DEA）',
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
          : new Map<string, DailyKline[]>([[symbols[0], await ctx.getDailyKlines(symbols[0], days)]]);

      const signals: PluginSignal[] = [];
      for (const symbol of symbols) {
        const klines = klineMap.get(symbol) ?? [];
        if (klines.length < periodLong + 1) continue;

        const closes = klines.map((k) => k.close);
        const maShort = ctx.calculateSMA(closes, periodShort);
        const maMid = ctx.calculateSMA(closes, periodMid);
        const maLong = ctx.calculateSMA(closes, periodLong);
        const i = closes.length - 1;
        const short = maShort[i];
        const mid = maMid[i];
        const long = maLong[i];
        if (
          short === undefined ||
          mid === undefined ||
          long === undefined ||
          Number.isNaN(short) ||
          Number.isNaN(mid) ||
          Number.isNaN(long)
        )
          continue;

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

  // ---------- 布林带回归（S3：V3 六分类的 volatility 代表） ----------
  definePlugin({
    id: 'boll_reversion',
    name: '布林带均值回归',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'monitor',
    subCategory: 'volatility',
    complexity: 'simple',
    description:
      '收盘跌破布林下轨（%B < pbBuy）发出超跌回归买入信号；冲破上轨（%B > pbSell）发出超涨回归卖出信号',
    chartOverlay: {
      position: 'sub',
      subChartHeightRatio: 0.3,
      thresholdLines: [
        { value: 0, color: '#2ecc71', label: '下轨 %B=0' },
        { value: 1, color: '#e74c3c', label: '上轨 %B=1' },
      ],
    },
    paramSchema: [
      {
        key: 'symbol',
        label: '标的代码',
        type: 'string',
        default: 'sh600000',
        required: true,
        runtimeInjected: true,
      },
      { key: 'period', label: '布林周期', type: 'integer', default: 20, min: 5, max: 120 },
      { key: 'stdDev', label: '标准差倍数', type: 'number', default: 2, min: 1, max: 4, step: 0.1 },
      { key: 'pbBuy', label: '买入 %B 阈值', type: 'number', default: 0, min: -1, max: 0.5, step: 0.05 },
      { key: 'pbSell', label: '卖出 %B 阈值', type: 'number', default: 1, min: 0.5, max: 2, step: 0.05 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
    ],
    // 跨字段约束：买入阈值必须低于卖出阈值，否则两条分支区间重叠、方向自相矛盾
    validateCrossFields(params) {
      const pbBuy = params.pbBuy;
      const pbSell = params.pbSell;
      if (typeof pbBuy === 'number' && typeof pbSell === 'number' && pbBuy >= pbSell) {
        throw new PluginParamError(
          'boll_reversion',
          'pbSell',
          `买入阈值 pbBuy(${pbBuy}) 必须小于卖出阈值 pbSell(${pbSell})`,
        );
      }
    },
    async execute(ctx, params) {
      const symbol = params.symbol as string;
      const period = params.period as number;
      const stdDev = params.stdDev as number;
      const pbBuy = params.pbBuy as number;
      const pbSell = params.pbSell as number;
      const days = params.days as number;

      const klines = await ctx.getDailyKlines(symbol, days);
      if (klines.length < period + 1) return [];

      const closes = klines.map((k) => k.close);
      const boll = ctx.calculateBoll(closes, period, stdDev);
      const i = closes.length - 1;
      const pb = boll.pb[i];
      // 带宽为 0（横盘无波动）时 %B 为 NaN → 不臆造信号
      if (pb === undefined || Number.isNaN(pb)) return [];

      const close = closes[i];
      const upper = boll.upper[i];
      const middle = boll.middle[i];
      const lower = boll.lower[i];

      const base = {
        symbol,
        pluginId: 'boll_reversion',
        timestamp: new Date().toISOString(),
        metrics: { period, stdDev, pbBuy, pbSell, days, close, upper, middle, lower, pb },
      };

      // 跌破下轨 → 超跌回归买入
      if (pb < pbBuy) {
        return [
          {
            ...base,
            signalType: 'BUY' as const,
            label: `布林下轨超跌买入（%B ${pb.toFixed(2)} < ${pbBuy}）`,
            strength: Math.min(1, pbBuy - pb),
            detail: `收盘 ${close.toFixed(2)} 低于布林下轨 ${lower.toFixed(2)}（%B=${pb.toFixed(2)}）`,
          },
        ];
      }
      // 冲破上轨 → 超涨回归卖出
      if (pb > pbSell) {
        return [
          {
            ...base,
            signalType: 'SELL' as const,
            label: `布林上轨超涨卖出（%B ${pb.toFixed(2)} > ${pbSell}）`,
            strength: Math.min(1, pb - pbSell),
            detail: `收盘 ${close.toFixed(2)} 高于布林上轨 ${upper.toFixed(2)}（%B=${pb.toFixed(2)}）`,
          },
        ];
      }
      // 带内 → 无信号
      return [];
    },
    requiresPositions: false,
  }),

  // ---------- 放量突破（T83：filter 类） ----------
  definePlugin({
    id: 'volume_breakout',
    name: '放量突破',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'filter',
    subCategory: 'volume',
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
          : new Map<string, DailyKline[]>([[symbols[0], await ctx.getDailyKlines(symbols[0], days)]]);

      const signals: PluginSignal[] = [];
      for (const symbol of symbols) {
        const klines = klineMap.get(symbol) ?? [];
        if (klines.length < lookback + 2) continue;

        const last = klines[klines.length - 1];
        const prev = klines.slice(-(lookback + 1), -1);
        if (prev.length < lookback) continue;

        const prevHigh = Math.max(...prev.map((k) => k.high));
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

  // ---------- 吞没反转（V3 六分类的 pattern 代表） ----------
  /*
   * ## 为什么选「吞没」而不是锤子线 / 缺口
   *
   * 1. **判据稳定**：吞没由两根 K 线的**实体包含关系**定义，不依赖影线长度的经验阈值。
   *    锤子线的「下影线 ≥ 实体 2 倍」在 10 元股与 300 元股、低波动与高波动行情下口径漂移，
   *    很难写成可验收的硬断言；
   * 2. **方向完整**：吞没能同时给出看涨 / 看跌两个方向，适合 monitor 类（可同时落 buy / sell）；
   * 3. **必须有趋势背景**：脱离趋势的吞没只是随机噪声，故叠加 MA(maPeriod) 趋势过滤。
   *
   * ## 计算口径（前复权 OHLC，按日期升序）
   *
   * - 看涨吞没：前一根为阴线（prev.close < prev.open）→ 当根为阳线（last.close > last.open），
   *   且当根实体**完全覆盖**前一根实体（last.open ≤ prev.close 且 last.close ≥ prev.open），
   *   同时前一根收盘价位于 MA(maPeriod) **下方**（下跌趋势背景）。
   * - 看跌吞没：前一根为阳线 → 当根为阴线，实体反包，且前一根收盘价位于 MA 上方。
   * - 量能确认：当根成交量 ≥ minVolumeRatio × 前 volumePeriod 根均量（默认 1.2 倍），
   *   过滤掉缩量假形态。
   *
   * ## 不臆造信号
   * 数据不足 / MA 为 NaN / 均量为 0 / 没有趋势背景 → 一律返回 `[]`。
   */
  definePlugin({
    id: 'engulfing_reversal',
    name: '吞没反转形态',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'monitor',
    subCategory: 'pattern',
    complexity: 'simple',
    description:
      '下跌趋势中出现放量看涨吞没 → 买入信号；上涨趋势中出现放量看跌吞没 → 卖出信号（前复权 OHLC 口径）',
    chartOverlay: { position: 'main' },
    paramSchema: [
      {
        key: 'symbol',
        label: '标的代码',
        type: 'string',
        default: 'sh600000',
        required: true,
        runtimeInjected: true,
      },
      { key: 'maPeriod', label: '趋势均线周期', type: 'integer', default: 20, min: 5, max: 120 },
      { key: 'volumePeriod', label: '均量周期', type: 'integer', default: 20, min: 5, max: 120 },
      {
        key: 'minVolumeRatio',
        label: '放量确认倍数',
        type: 'number',
        default: 1.2,
        min: 0.5,
        max: 5,
        step: 0.1,
      },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
    ],
    async execute(ctx, params) {
      const symbol = params.symbol as string;
      const maPeriod = params.maPeriod as number;
      const volumePeriod = params.volumePeriod as number;
      const minVolumeRatio = params.minVolumeRatio as number;
      const days = params.days as number;

      const klines = await ctx.getDailyKlines(symbol, days);
      // 需要前一根 + 均量窗口 + 当根，缺一根都不判形态
      if (klines.length < Math.max(maPeriod, volumePeriod) + 2) return [];

      const n = klines.length;
      const last = klines[n - 1];
      const prev = klines[n - 2];

      const closes = klines.map((k) => k.close);
      const ma = ctx.calculateSMA(closes, maPeriod)[n - 1];
      if (ma === undefined || Number.isNaN(ma)) return [];

      // 均量窗口必须**排除当根**，否则当根放量会自己抬高基准、稀释确认强度
      const volWindow = klines.slice(n - 1 - volumePeriod, n - 1);
      if (volWindow.length < volumePeriod) return [];
      const avgVolume = volWindow.reduce((acc, k) => acc + k.volume, 0) / volWindow.length;
      if (!(avgVolume > 0)) return [];

      const volumeRatio = last.volume / avgVolume;
      if (volumeRatio < minVolumeRatio) return [];

      const prevBearish = prev.close < prev.open;
      const prevBullish = prev.close > prev.open;
      const lastBullish = last.close > last.open;
      const lastBearish = last.close < last.open;

      const bullishEngulf = prevBearish && lastBullish && last.open <= prev.close && last.close >= prev.open;
      const bearishEngulf = prevBullish && lastBearish && last.open >= prev.close && last.close <= prev.open;

      const prevBody = Math.abs(prev.close - prev.open);
      const lastBody = Math.abs(last.close - last.open);
      // 实体反包幅度（当根实体 / 前一根实体）；趋势背景成立时 prevBody 必 > 0
      const engulfRatio = prevBody > 0 ? lastBody / prevBody : 0;
      const strength = Math.min(
        1,
        0.5 * Math.min(1, engulfRatio) + 0.5 * Math.min(1, volumeRatio / (minVolumeRatio * 2)),
      );

      const base = {
        symbol,
        pluginId: 'engulfing_reversal',
        timestamp: new Date().toISOString(),
        metrics: {
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
          prevOpen: prev.open,
          prevClose: prev.close,
          ma,
          volumeRatio,
          maPeriod,
          volumePeriod,
        },
      };

      // 下跌趋势 + 看涨吞没 → 买入（反转向上）
      if (bullishEngulf && prev.close < ma) {
        return [
          {
            ...base,
            signalType: 'BUY' as const,
            label: `看涨吞没（${last.close.toFixed(2)} 反包前阴线 ${prev.open.toFixed(2)}~${prev.close.toFixed(2)}）`,
            strength,
            detail: `前一根阴线 ${prev.open.toFixed(2)}→${prev.close.toFixed(2)} 且收盘低于 MA${maPeriod}=${ma.toFixed(2)}；当根阳线 ${last.open.toFixed(2)}→${last.close.toFixed(2)} 实体反包，量比 ${volumeRatio.toFixed(2)} ≥ ${minVolumeRatio}（看涨吞没反转）`,
          },
        ];
      }
      // 上涨趋势 + 看跌吞没 → 卖出（反转向下）
      if (bearishEngulf && prev.close > ma) {
        return [
          {
            ...base,
            signalType: 'SELL' as const,
            label: `看跌吞没（${last.close.toFixed(2)} 反包前阳线 ${prev.open.toFixed(2)}~${prev.close.toFixed(2)}）`,
            strength,
            detail: `前一根阳线 ${prev.open.toFixed(2)}→${prev.close.toFixed(2)} 且收盘高于 MA${maPeriod}=${ma.toFixed(2)}；当根阴线 ${last.open.toFixed(2)}→${last.close.toFixed(2)} 实体反包，量比 ${volumeRatio.toFixed(2)} ≥ ${minVolumeRatio}（看跌吞没反转）`,
          },
        ];
      }
      return [];
    },
  }),

  // ---------- 量价突破（V3 六分类的 volume 代表，monitor 版） ----------
  /*
   * ## 为什么新增 monitor 版，而不是改造 filter 版 `volume_breakout`
   *
   * 1. **语义不同**：filter 是「全市场条件选股」，由 `/api/stockscan` 调用、只返回候选、
   *    **不落 `user_strategy_signal`**；monitor 是「每日收盘对自选 ∪ 持仓逐标的跑信号并落库」。
   *    两者触发范围与结果去向都不同，合并会改变现有 filter 的选股行为与性能。
   * 2. **方向不同**：filter 只做 BUY 候选，而量价的风险一侧（放量下跌）只有 monitor 能承载。
   * 3. **不改现有 5 个插件的行为**：本插件是独立新增，`volume_breakout` 保持原样。
   *
   * ## 计算口径（前复权 OHLC，按日期升序）
   *
   * - 放量突破：当根收盘 > 前 lookback 日**最高价**，且成交量 ≥ volumeRatio × 前 lookback 日均量 → BUY
   * - 放量破位：当根收盘 < 前 lookback 日**最低价**，且成交量 ≥ volumeRatio × 前 lookback 日均量 → SELL
   * - ⚠️ 前 lookback 日**不含当根**，避免当根自己抬高 / 压低基准；均量为 0 时不臆造信号。
   */
  definePlugin({
    id: 'volume_price_breakout',
    name: '量价突破（信号版）',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'monitor',
    subCategory: 'volume',
    complexity: 'simple',
    description:
      '收盘放量突破前 lookback 日最高价 → 买入信号；收盘放量跌破前 lookback 日最低价 → 卖出信号（信号落 user_strategy_signal）',
    chartOverlay: { position: 'main' },
    paramSchema: [
      {
        key: 'symbol',
        label: '标的代码',
        type: 'string',
        default: 'sh600000',
        required: true,
        runtimeInjected: true,
      },
      { key: 'lookback', label: '突破回溯天数', type: 'integer', default: 20, min: 5, max: 120 },
      { key: 'volumeRatio', label: '放量倍数', type: 'number', default: 1.5, min: 1, max: 10 },
      { key: 'days', label: '回溯天数', type: 'integer', default: 120, min: 30, max: 365 },
    ],
    async execute(ctx, params) {
      const symbol = params.symbol as string;
      const lookback = params.lookback as number;
      const volumeRatio = params.volumeRatio as number;
      const days = params.days as number;

      const klines = await ctx.getDailyKlines(symbol, days);
      // 需要前 lookback 根 + 当根
      if (klines.length < lookback + 1) return [];

      const n = klines.length;
      const last = klines[n - 1];
      const prev = klines.slice(n - 1 - lookback, n - 1);
      if (prev.length < lookback) return [];

      const prevHigh = Math.max(...prev.map((k) => k.high));
      const prevLow = Math.min(...prev.map((k) => k.low));
      const avgVolume = prev.reduce((acc, k) => acc + k.volume, 0) / prev.length;
      if (!(avgVolume > 0)) return [];

      const ratio = last.volume / avgVolume;
      if (ratio < volumeRatio) return [];

      const base = {
        symbol,
        pluginId: 'volume_price_breakout',
        timestamp: new Date().toISOString(),
        metrics: {
          close: last.close,
          high: last.high,
          low: last.low,
          prevHigh,
          prevLow,
          volumeRatio: ratio,
          lookback,
          amount: last.amount,
        },
      };
      const strength = Math.min(1, ratio / (volumeRatio * 2));

      // 放量突破 → 买入
      if (last.close > prevHigh) {
        return [
          {
            ...base,
            signalType: 'BUY' as const,
            label: `放量突破（${last.close.toFixed(2)} > 前 ${lookback} 日高 ${prevHigh.toFixed(2)}）`,
            strength,
            detail: `收盘 ${last.close.toFixed(2)} 突破前 ${lookback} 日最高 ${prevHigh.toFixed(2)}，量比 ${ratio.toFixed(2)} ≥ ${volumeRatio}（量价齐升）`,
          },
        ];
      }
      // 放量破位 → 卖出
      if (last.close < prevLow) {
        return [
          {
            ...base,
            signalType: 'SELL' as const,
            label: `放量破位（${last.close.toFixed(2)} < 前 ${lookback} 日低 ${prevLow.toFixed(2)}）`,
            strength,
            detail: `收盘 ${last.close.toFixed(2)} 跌破前 ${lookback} 日最低 ${prevLow.toFixed(2)}，量比 ${ratio.toFixed(2)} ≥ ${volumeRatio}（放量下跌）`,
          },
        ];
      }
      return [];
    },
  }),

  // ---------- 持仓风险提示（V3 六分类的 risk 代表） ----------
  /*
   * ## 边界：只做**快照级**规则，不复制组合风险呈现
   *
   * 本插件只判断三条能由「持仓快照 + 最新估值」直接得出、且可逐标的归因的规则：
   *   ① 单票占比超限  weight = marketValue / equity > maxPositionWeight
   *   ② 浮亏触及止损  unrealizedRatio = price / avgCost - 1 ≤ -stopLossRatio
   *   ③ 仓位集中度    前 concentrationTopN 名市值合计 / equity > concentrationThreshold
   * 行业集中度与最大回撤**仍由 `portfolioRisk.ts` 的呈现承载**：
   *   前者需要行业分类（插件上下文没有），后者需要历史权益曲线（快照只有当日一帧），
   *   塞进插件会伪造数据来源。
   *
   * ## 为什么只输出 HOLD
   *
   * 「占比超限 / 浮亏止损 / 集中度」是**风险提示**，不是交易指令。
   * 用 SELL 冒充会让下游（信号页、纸面账户、持仓卡徽标）把它当成卖出建议，
   * 风险提示必须与方向性交易信号在数据上可区分，故恒为 `HOLD`。
   *
   * ## 为什么**不设置 strength**
   *
   * 交易信号的分级（强/中/弱）按**当日全部带 strength 的信号**分位计算；
   * 风险 HOLD 若带 strength 会稀释分母、把真实交易信号整体推档。
   * 故这里刻意不写 `strength`（落库为 NULL），使分级候选集（`strength IS NOT NULL`）自动排除风险提示。
   *
   * ## 为什么一个标的只出**一条**信号
   *
   * `user_strategy_signal` 唯一键是 `(user_id, asset_code, plugin_id, trade_date)`，
   * 同一插件同一标的一天只能落一条 ⇒ 三条规则命中时**合并**为一条，label 逐条列出、metrics 带各项实际值与阈值。
   *
   * ## 不臆造信号
   *
   * - 持仓快照不可用（无 userId / 回放 / 读取失败）：引擎按 `requiresPositions` 直接 SKIP（`POSITION_UNAVAILABLE`）；
   * - `equity <= 0`：无法计算占比，**不用 0 做分母**，直接不出信号；
   * - 标的 `marketValue <= 0`（取不到最新价）：跳过该标的，不把「无价」当成「零仓位风险」；
   * - `cash` 类持仓（货币 ETF 等）：不参与占比 / 止损判断（现金类市值仍计入 equity 分母）。
   */
  definePlugin({
    id: 'position_risk_alert',
    name: '持仓风险提示',
    version: '1.0.0',
    author: 'invest-core',
    period: 'daily',
    category: 'monitor',
    subCategory: 'risk',
    complexity: 'simple',
    description: '基于持仓快照的三条快照级规则（单票占比超限 / 浮亏触及止损 / 仓位集中度）输出 HOLD 风险提示',
    // 风险类是**组合级**插件：读整份持仓快照，不接受 symbol 参数（标的域循环里只执行一次）
    paramSchema: [
      {
        key: 'maxPositionWeight',
        label: '单票占比上限',
        type: 'number',
        default: 0.3,
        min: 0.05,
        max: 1,
        step: 0.05,
        description: '单标的市值占权益比例超过该值 → 提示（0.3 = 30%）',
      },
      {
        key: 'stopLossRatio',
        label: '浮亏止损线',
        type: 'number',
        default: 0.1,
        min: 0.01,
        max: 0.5,
        step: 0.01,
        description: '浮亏比例达到该值 → 提示（0.1 = 回撤 10%）',
      },
      {
        key: 'concentrationTopN',
        label: '集中度前 N 名',
        type: 'integer',
        default: 3,
        min: 1,
        max: 10,
        description: '取市值最大的 N 个标的计算合计占比',
      },
      {
        key: 'concentrationThreshold',
        label: '集中度上限',
        type: 'number',
        default: 0.6,
        min: 0.1,
        max: 1,
        step: 0.05,
        description: '前 N 名合计占比超过该值 → 提示（0.6 = 60%）',
      },
    ],
    async execute(ctx, params) {
      const positions = ctx.positions();
      if (positions.length === 0) return [];

      const equity = ctx.equity;
      // 权益 ≤ 0 时占比无意义：不拿 0 做分母
      if (!(equity > 0)) return [];

      const maxPositionWeight = params.maxPositionWeight as number;
      const stopLossRatio = params.stopLossRatio as number;
      const concentrationTopN = params.concentrationTopN as number;
      const concentrationThreshold = params.concentrationThreshold as number;

      // 只判断风险类且有估值的持仓：cash 类无止损语义；marketValue=0 说明取不到价，跳过
      const riskPositions = positions.filter(
        (p) => p.assetClass === 'risk' && p.quantity > 0 && p.marketValue > 0,
      );
      if (riskPositions.length === 0) return [];

      // 集中度是**组合级**判据：按市值降序取前 N 名，合计占比越高越集中
      const topSlice = [...riskPositions]
        .sort((a, b) => b.marketValue - a.marketValue)
        .slice(0, concentrationTopN);
      const topNWeight = topSlice.reduce((acc, p) => acc + p.marketValue, 0) / equity;
      const concentrated = topNWeight > concentrationThreshold;
      const topNSymbols = new Set(topSlice.map((p) => p.symbol));

      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      const signals: PluginSignal[] = [];

      for (const p of riskPositions) {
        const weight = p.marketValue / equity;
        // 现价用市值反推，避免再取一次行情（execute() 内零 IO）
        const price = p.marketValue / p.quantity;
        // 浮亏比例（负数为亏）；成本为 0 时不判浮亏
        const unrealizedRatio = p.avgCost > 0 ? price / p.avgCost - 1 : 0;

        const labels: string[] = [];
        const details: string[] = [];
        const metrics: Record<string, number> = { weight, maxPositionWeight, unrealizedRatio, stopLossRatio };

        // ① 浮亏触及止损（风险最高，放首位作为主标签）
        if (p.avgCost > 0 && unrealizedRatio <= -stopLossRatio) {
          labels.push(`浮亏触及止损（${pct(unrealizedRatio)} ≤ -${pct(stopLossRatio)}）`);
          details.push(
            `浮亏 ${pct(-unrealizedRatio)}（现价 ${price.toFixed(2)}，成本 ${p.avgCost.toFixed(2)}）已达止损线 ${pct(stopLossRatio)}`,
          );
        }
        // ② 单票占比超限
        if (weight > maxPositionWeight) {
          labels.push(`单票占比超限（${pct(weight)} > ${pct(maxPositionWeight)}）`);
          details.push(
            `单票占比 ${pct(weight)}（市值 ${p.marketValue.toFixed(2)} / 权益 ${equity.toFixed(2)}）超过上限 ${pct(maxPositionWeight)}`,
          );
        }
        // ③ 仓位集中度（只标记贡献集中度的前 N 名标的）
        if (concentrated && topNSymbols.has(p.symbol)) {
          labels.push(
            `仓位集中度偏高（前 ${concentrationTopN} 名合计 ${pct(topNWeight)} > ${pct(concentrationThreshold)}）`,
          );
          details.push(
            `前 ${concentrationTopN} 名标的合计占比 ${pct(topNWeight)} 超过上限 ${pct(concentrationThreshold)}`,
          );
          metrics.topNWeight = topNWeight;
          metrics.concentrationThreshold = concentrationThreshold;
          metrics.concentrationTopN = concentrationTopN;
        }

        if (labels.length === 0) continue;

        metrics.ruleCount = labels.length;
        signals.push({
          symbol: p.symbol,
          // 🔴 只用 HOLD：风险提示不是交易指令；且**不写 strength**（见上方注释）
          signalType: 'HOLD',
          label: labels.join(' + '),
          pluginId: 'position_risk_alert',
          timestamp: new Date().toISOString(),
          metrics,
          detail: details.join('；'),
        });
      }

      return signals;
    },
    requiresPositions: true,
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
export function loadPluginsFromDir(dirPath: string = PLUGIN_ALLOWED_PATH): Plugin[] {
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
      console.error(`[pluginEngine] 插件路径逃逸被拦截: ${filePath} (resolved=${resolved})`);
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
  const factory = new Function(...Object.keys(sandbox), wrappedSource);

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
  if (maybePlugin === null || typeof maybePlugin !== 'object') {
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
    throw new Error(`插件 category 必须是 'monitor' 或 'filter'，实际 ${String(p.category)}`);
  }
  if (typeof p.execute !== 'function') {
    throw new Error('插件缺少 execute 函数');
  }

  // 类型收窄为 Plugin 返回
  // T93：契约字段（version/author/period/sub_category/complexity）自定义插件缺省时走兜底值，
  // 不再静默填 undefined；defaultParams 一律由 paramSchema 派生，避免两处默认值漂移。
  const paramSchema = Array.isArray(p.paramSchema) ? (p.paramSchema as Plugin['paramSchema']) : undefined;

  return normalizePlugin({
    id: p.id as string,
    name: p.name as string,
    version: typeof p.version === 'string' ? (p.version as string) : CONTRACT_FALLBACK.version,
    author: typeof p.author === 'string' ? (p.author as string) : CONTRACT_FALLBACK.author,
    period: p.period === 'daily' ? 'daily' : CONTRACT_FALLBACK.period,
    category: p.category as 'monitor' | 'filter',
    // 磁盘插件旧值（breakout / mean_reversion）在这里收口，映射表不外泄到调用点
    subCategory: normalizeSubCategory(p.sub_category ?? p.subCategory, p.id as string),
    complexity:
      typeof p.complexity === 'string' ? (p.complexity as PluginComplexity) : CONTRACT_FALLBACK.complexity,
    description: typeof p.description === 'string' ? (p.description as string) : undefined,
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
    // 风险类插件声明：仅接受显式 boolean，缺失 = false（与内置插件语义一致）
    requiresPositions:
      typeof p.requires_positions === 'boolean'
        ? (p.requires_positions as boolean)
        : typeof p.requiresPositions === 'boolean'
          ? (p.requiresPositions as boolean)
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
    if (!hasInput && field.default === undefined && field.required === true) {
      throw new PluginParamError(plugin.id, field.key, '必填参数缺失');
    }

    // 没有值（也没有 default、也不是 required），跳过
    if (value === undefined) continue;

    // 类型检查 + 范围检查
    switch (field.type) {
      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new PluginParamError(plugin.id, field.key, `期望 number，实际 ${typeof value}`);
        }
        if (field.min !== undefined && value < field.min) {
          throw new PluginParamError(plugin.id, field.key, `值 ${value} 小于最小值 ${field.min}`);
        }
        if (field.max !== undefined && value > field.max) {
          throw new PluginParamError(plugin.id, field.key, `值 ${value} 大于最大值 ${field.max}`);
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
          throw new PluginParamError(plugin.id, field.key, `值 ${value} 小于最小值 ${field.min}`);
        }
        if (field.max !== undefined && value > field.max) {
          throw new PluginParamError(plugin.id, field.key, `值 ${value} 大于最大值 ${field.max}`);
        }
        merged[field.key] = value;
        break;
      }
      case 'string': {
        if (typeof value !== 'string') {
          throw new PluginParamError(plugin.id, field.key, `期望 string，实际 ${typeof value}`);
        }
        merged[field.key] = value;
        break;
      }
      case 'boolean': {
        if (typeof value !== 'boolean') {
          throw new PluginParamError(plugin.id, field.key, `期望 boolean，实际 ${typeof value}`);
        }
        merged[field.key] = value;
        break;
      }
      case 'select': {
        if (typeof value !== 'string') {
          throw new PluginParamError(plugin.id, field.key, `select 期望 string，实际 ${typeof value}`);
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

/**
 * 预取缓存：symbol → 按日期升序的日线
 *
 * 🔴 T85b ①（I-19 + PR#15 交接文档 §4-C）：
 *   插件引擎必须做到「**1 次 IN 查询 → N 插件共享**」（SDD §5.3 P8 / AGENTS.md 插件硬约束 2）。
 *   此前 `getDailyKlines(symbol, days)` **每只标的都单独查一次 DuckDB** ——
 *   全市场 5000 只 = 5000 次查询，实测把选股拖到 15s+（PE2 要求 ≤3s）。
 *
 *   修法：调用方（选股 / 信号生成）先**批量**取好日线塞进本缓存，
 *   context 命中缓存就不再打 DuckDB；未命中才回落到单查（保证正确性）。
 */
export interface PluginKlinePrefetch {
  /** symbol → 按日期升序的日线 */
  klines: Map<string, DailyKline[]>;
  /**
   * 预取窗口覆盖的**日历天数**。
   * ⚠️ 判据是「请求的天数 ≤ 窗口天数」，**不是**「取到的行数 ≥ 请求天数」——
   * 行情停更时窗口内有 120 天但只有 85 根 K 线，按行数判会永远 miss 而退化成逐只查库。
   */
  windowDays: number;
  /**
   * 取数窗口的**截止日**（`YYYY-MM-DD`）；缺省 = 今天。
   *
   * 🔴 无前视（区间回放）：回放第 T 天时必须传 T。缓存未命中的回落查询也以此日为终点，
   *    否则插件会读到 T 之后的行情 → 用未来数据算历史信号。
   */
  endDate?: string;
}

/** 以给定基准日（YYYY-MM-DD）前后平移 N 天（UTC 计算，避免本地时区把日期推错） */
export function shiftTradeDate(anchor: string, deltaDays: number): string {
  const d = new Date(`${anchor}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function buildPluginContext(
  prefetch?: PluginKlinePrefetch,
  snapshot: PluginPositionSnapshot = EMPTY_POSITION_SNAPSHOT,
): PluginContext {
  /** 取数窗口的终点：回放时锁在基准交易日，日常链路仍是今天 */
  const endDate = prefetch?.endDate ?? new Date().toISOString().slice(0, 10);
  /** 预取窗口：days 天之前的日期（与原单查口径一致） */
  const windowStart = (days: number): string => shiftTradeDate(endDate, -days);

  return {
    async getDailyKlines(symbol: string, days: number): Promise<DailyKline[]> {
      // 命中预取 → 内存返回（窗口覆盖不足时回落查库，保证序列长度语义不变）
      let cached = prefetch?.klines.get(symbol);
      // 🔴 无前视兜底：即使调用方传入了含未来行的预取缓存，也不让基准日之后的行进入插件
      if (cached && prefetch?.endDate) {
        const end = prefetch.endDate;
        cached = cached.filter((r) => r.date <= end);
      }
      if (cached && prefetch && days <= prefetch.windowDays) {
        return days > 0 ? cached.slice(-days) : cached;
      }
      const start = windowStart(days);
      /**
       * 🔴 必须走**批量入口**（F 域缺陷修复）：
       *   `getDailyRange(symbol, ...)` 只查 `v_stock_qfq` —— ETF 在该视图 **0 行**，
       *   预取缓存未命中时会**静默变成「无数据」→ SKIP**（信号凭空消失）。
       *   `batchGetDailyRange` 内部按品种分流（stock / etf），单标的也复用同一条 IN 查询。
       */
      const rows = await batchGetDailyRange([symbol], start, endDate);
      return rows.get(symbol) ?? [];
    },

    async batchGetDailyKlines(symbols: string[], days: number): Promise<Map<string, DailyKline[]>> {
      const start = windowStart(days);
      return await batchGetDailyRange(symbols, start, endDate);
    },

    // 直接透传（calculateMACD 带 fast/slow/signal 默认值，ctx 签名只暴露 prices）
    calculateRSI: (prices: number[], period?: number) => calculateRSI(prices, period ?? 14),
    calculateMACD: (prices: number[]) => calculateMACD(prices),
    calculateSMA,
    calculateBoll,
    positions: () => snapshot.positions,
    cash: snapshot.cash,
    equity: snapshot.equity,
    positionsAvailable: snapshot.available,
  };
}

// ---------------------------------------------------------------------------
// executePlugin：带 50ms 超时 + 异常保护
// ---------------------------------------------------------------------------

export type PluginExecutionStatus = 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'SKIP';

export interface PluginExecutionResult {
  pluginId: string;
  /**
   * 本次执行插件的子分类（六分类 + `custom` 兜底）
   *
   * 由执行结果携带，供持久化写入 `user_strategy_signal.sub_category` ——
   * 读取侧据此做**稳定判据**过滤（如「风险信号不进 Top5 / 不抢持仓卡徽标」），
   * 不依赖 plugin_id 字符串匹配（插件 id 可改名，子分类是契约字段）。
   * 仅 `status === 'SUCCESS'` 时写入；其余状态无信号可写，保持 undefined。
   */
  subCategory?: PluginSubCategory;
  status: PluginExecutionStatus;
  signals: PluginSignal[];
  /** execute() 的**纯计算**耗时（不含行情 IO，T88 口径） */
  durationMs: number;
  /** 被排除在 50ms 预算之外的行情 IO 累计耗时（毫秒），仅用于可观测性 */
  ioMs?: number;
  /**
   * 本次执行从 ctx 读到的**日线根数**（同一标的多次取数取最大值）。
   * 0 = 完全没取到行情；>0 说明行情可用、SKIP 是「指标未触发」。
   */
  klines?: number;
  /**
   * SKIP 的三种成因（F 域缺陷修复 / S2 持仓视图）：
   *   - `NO_DATA`   —— 取不到日线（行情缺失 / 标的不在该品种视图 / 数据不足到无法计算）
   *   - `NO_SIGNAL` —— 有日线，但指标条件未触发
   *   - `POSITION_UNAVAILABLE` —— 插件声明 `requiresPositions`，但持仓快照不可用
   *     （无 userId / 回放 asOfDate / 持仓读取失败）。**显式归因，不静默返回空信号**
   * 仅 `status === 'SKIP'` 时有值；SUCCESS / TIMEOUT / ERROR 为 undefined。
   */
  skipReason?: 'NO_DATA' | 'NO_SIGNAL' | 'POSITION_UNAVAILABLE';
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

  // 2.5 风险类插件必须有持仓视图：不可用时显式 SKIP（不得静默返回空信号）
  if (plugin.requiresPositions && !ctx.positionsAvailable) {
    const duration = performance.now() - validateStart;
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'SKIP',
      message: `插件 ${plugin.id} 需要持仓视图，但快照不可用（无 userId / 回放 / 读取失败），已跳过`,
      checkItem: plugin.id,
    });
    return {
      pluginId: plugin.id,
      status: 'SKIP',
      signals: [],
      durationMs: round3(duration),
      skipReason: 'POSITION_UNAVAILABLE',
    };
  }

  // === 3. T88：IO 感知的 50ms 预算窗口 ===
  let computeStart = performance.now(); // 计时起点（每次 IO 结束后重置）
  let ioMs = 0; // 被排除在预算外的 IO 累计耗时
  let ioDepth = 0; // 嵌套/并发 IO 计数（>0 时视为仍在 IO 段内）
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: (r: PluginExecutionResult) => void = () => {
    /* 未初始化占位 */
  };

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
    if (ioDepth > 0) return await fn(); // 已在 IO 段内（并发/嵌套），不重复重置
    ioDepth += 1;
    disarm();
    const ioStart = performance.now();
    try {
      return await fn();
    } finally {
      ioMs += performance.now() - ioStart;
      ioDepth -= 1;
      computeStart = performance.now(); // 取数后重置计时起点
      arm();
    }
  };

  /**
   * 本次执行读到的日线根数（F 域缺陷修复 P1-2）
   *
   * 用于区分 SKIP 的两种成因：`klinesRead === 0` ⇒ 没有行情（NO_DATA）；
   * `> 0` ⇒ 行情正常但指标未触发（NO_SIGNAL）。
   * 日志 detail 同时带上 `klines=N`，让运维能从计数与明细两处看出差别。
   */
  let klinesRead = 0;

  const timedCtx: PluginContext = {
    getDailyKlines: (symbol, days) =>
      withIo(async () => {
        const rows = await ctx.getDailyKlines(symbol, days);
        klinesRead = Math.max(klinesRead, rows.length);
        return rows;
      }),
    batchGetDailyKlines: (symbols, days) =>
      withIo(async () => {
        const map = await ctx.batchGetDailyKlines(symbols, days);
        for (const rows of map.values()) klinesRead = Math.max(klinesRead, rows.length);
        return map;
      }),
    calculateRSI: ctx.calculateRSI,
    calculateMACD: ctx.calculateMACD,
    calculateSMA: ctx.calculateSMA,
    calculateBoll: ctx.calculateBoll,
    // 🔴 显式拷贝（禁止 `...ctx` 展开：会绕过上面的 withIo 包装，把 IO 算进 50ms 预算）
    positions: ctx.positions,
    cash: ctx.cash,
    equity: ctx.equity,
    positionsAvailable: ctx.positionsAvailable,
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
          // 区分「没数据」与「没信号」：两者此前都只记一句「无信号」，计数上也分不开
          // ⚠️ 组合级插件（requiresPositions，如风险类）**按设计零行情 IO**，
          //    klinesRead 恒为 0，不能据此判成 NO_DATA（否则「持仓无风险」会被记成「无行情」）。
          const skipReason: 'NO_DATA' | 'NO_SIGNAL' =
            plugin.requiresPositions || klinesRead > 0 ? 'NO_SIGNAL' : 'NO_DATA';
          writeSystemLog({
            logType: 'plugin_execute',
            level: 'SKIP',
            message: `插件 ${plugin.id} 正常执行但无信号（${skipReason === 'NO_DATA' ? '无行情数据' : '指标未触发'}）`,
            detail: `klines=${klinesRead} compute=${durationMs}ms io=${round3(ioMs)}ms`,
            checkItem: plugin.id,
          });
          settle({
            pluginId: plugin.id,
            status: 'SKIP',
            signals: [],
            durationMs,
            ioMs: round3(ioMs),
            klines: klinesRead,
            skipReason,
          });
        } else {
          writeSystemLog({
            logType: 'plugin_execute',
            level: 'SUCCESS',
            message: `插件 ${plugin.id} 返回 ${signals.length} 个信号`,
            detail: `klines=${klinesRead} compute=${durationMs}ms io=${round3(ioMs)}ms`,
            checkItem: plugin.id,
          });
          settle({
            pluginId: plugin.id,
            subCategory: plugin.subCategory,
            status: 'SUCCESS',
            signals,
            durationMs,
            ioMs: round3(ioMs),
            klines: klinesRead,
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
  /** SKIP 总数 = noData + noSignal + positionUnavailable（保留既有字段语义，不拆多份） */
  skip: number;
  /** SKIP 中「取不到行情」的次数（`skipReason === 'NO_DATA'`），其余按 `skipReason` 细分 */
  noData: number;
  /** SKIP 中「需要持仓但快照不可用」的次数（`skipReason === 'POSITION_UNAVAILABLE'`） */
  positionUnavailable: number;
}

export interface PluginBatchResult {
  signals: PluginSignal[];
  stats: PluginBatchStats;
  results: PluginExecutionResult[];
}

/**
 * 批量执行参数（T85b ①）
 */
export interface ExecuteAllPluginsOptions {
  /**
   * 标的域。**不传** = 沿用旧行为（每个插件跑 1 次，用其 paramSchema 默认 symbol）。
   * 传了 = 对「每个标的 × 每个插件」各执行 1 次，symbol 由运行时注入。
   */
  symbols?: string[];
  /** 传给插件的用户参数（symbol 会被运行时覆盖） */
  userParams?: Record<string, unknown>;
  /** 预取窗口天数（默认 120，与内置插件 paramSchema 的 days 默认值一致） */
  prefetchDays?: number;
  /**
   * 计算基准交易日（`YYYY-MM-DD`），**仅区间回放使用**；缺省 = 今天（日常链路行为不变）。
   *
   * 🔴 无前视：预取窗口的终点 + 缓存未命中回落查询的终点都锁在这一天，
   *    故第 T 天的计算不可能读到 T 之后的行情。
   */
  asOfDate?: string;
  /**
   * 持仓快照的用户（S2）。缺省 = `SIGNAL_USER_ID`（与 `user_plugin_config` 读取口径一致）。
   * 回放（传了 `asOfDate`）时快照统一不可用：`POSITION_UNAVAILABLE`。
   */
  userId?: number;
}

/** 用户级插件配置（`user_plugin_config` 的一行解析结果） */
interface UserPluginConfig {
  enabled: boolean;
  params: Record<string, unknown>;
}

/**
 * 读取用户的插件配置（F 域缺陷修复 P1-3）
 *
 * 🔴 修复前：`executeAllPlugins()` **既不读 `user_plugin_config.enabled`，也不读 `params_json`**
 *   ⇒ 管理界面上「停用某个插件」「改某个插件的参数」**全都不生效**，
 *   `admin.ts`（手动触发）与 `scheduler.ts`（每日收盘）两条调用链都是如此。
 *
 * 现在按 `SIGNAL_USER_ID` 读配置：
 *   - `enabled = 0` 的插件**不参与执行**（也不计入 `stats.total`）；
 *   - `params_json` 合并进每次 `executePlugin` 的 `userParams`（运行时 `symbol` 仍然覆盖它）。
 *
 * 降级策略（配置读不出来时**宁可多跑，不可少跑**）：
 *   - 表不可读 / 查询异常 → 视为「全部启用 + 无参数」，并记 WARN（不静默丢插件）；
 *   - 单行 `params_json` 是坏 JSON → 该插件按「无参数」执行，并记 WARN（不整批失败）。
 */
function loadUserPluginConfigs(userId: number): Map<string, UserPluginConfig> {
  const configs = new Map<string, UserPluginConfig>();
  try {
    const db = ConfigStore.getInstance().db;
    const rows = db
      .prepare('SELECT plugin_id, enabled, params_json FROM user_plugin_config WHERE user_id = ?')
      .all(userId) as Array<{ plugin_id: string; enabled: number; params_json: string | null }>;
    for (const row of rows) {
      let params: Record<string, unknown> = {};
      const raw = row.params_json;
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            params = parsed as Record<string, unknown>;
          } else {
            writeSystemLog({
              logType: 'plugin_execute',
              level: 'WARN',
              message: `插件 ${row.plugin_id} 的 params_json 不是对象，已按无参数执行`,
              detail: raw.slice(0, 200),
              checkItem: row.plugin_id,
            });
          }
        } catch (err) {
          writeSystemLog({
            logType: 'plugin_execute',
            level: 'WARN',
            message: `插件 ${row.plugin_id} 的 params_json 解析失败，已按无参数执行`,
            detail: `${String(err)}；原始值=${raw.slice(0, 200)}`,
            checkItem: row.plugin_id,
          });
        }
      }
      configs.set(row.plugin_id, { enabled: row.enabled !== 0, params });
    }
  } catch (err) {
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'WARN',
      message: '读取 user_plugin_config 失败，本次按「全部启用 + 无参数」执行',
      detail: String(err),
    });
  }
  return configs;
}

/**
 * 构建持仓快照（S2）—— 只读、**在构建期算一次**，`execute()` 内零 IO。
 *
 * 口径：
 * - `cash` = `asset_class = 'cash'` 的持仓**市值**合计。🔴 不是「可用现金余额」，
 *   本系统不建模现金余额，禁止把它当加仓额度；
 * - `equity` = 现金类 + 全部风险资产市值；
 * - 市值按最新收盘价估算，取不到价记 0（不阻断快照可用性）。
 *
 * 不可用（降级为 `EMPTY_POSITION_SNAPSHOT`）：
 * - 回放（`asOfDate`）：业务层没有历史持仓快照，无法重建当日持仓 → `REPLAY`；
 * - 读取失败 → `READ_FAILED`（记 WARN，不静默）。
 */
async function loadPositionSnapshot(userId: number, asOfDate?: string): Promise<PluginPositionSnapshot> {
  if (asOfDate) {
    return { ...EMPTY_POSITION_SNAPSHOT, unavailableReason: 'REPLAY' };
  }
  try {
    const positions = calcAllPositions(userId).filter((p) => p.totalQuantity > 0);
    if (positions.length === 0) {
      return { available: true, positions: [], cash: 0, equity: 0 };
    }

    const prices = await batchGetLatestClose(positions.map((p) => p.asset_code));
    const db = ConfigStore.getInstance().db;
    const views: PluginPositionView[] = [];
    let cash = 0;
    let equity = 0;
    for (const p of positions) {
      const marketValue = (prices.get(p.asset_code)?.close ?? 0) * p.totalQuantity;
      // 分类只取一次：既用于现金累计，也写进插件视图（避免同标的重复查同一张表）
      const assetClass = getAssetClass(db, p.asset_code);
      if (assetClass === 'cash') cash += marketValue;
      equity += marketValue;
      views.push({
        symbol: p.asset_code,
        quantity: p.totalQuantity,
        avgCost: p.avgCost,
        marketValue,
        assetClass,
      });
    }
    return { available: true, positions: views, cash, equity };
  } catch (err) {
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'WARN',
      message: '读取持仓快照失败，需要持仓视图的插件将跳过（POSITION_UNAVAILABLE）',
      detail: String(err),
    });
    return { ...EMPTY_POSITION_SNAPSHOT, unavailableReason: 'READ_FAILED' };
  }
}

/**
 * 依次执行所有内置 monitor 类插件（MVP 暂不并发，避免同时打 DuckDB）。
 * 自定义插件将来从 PLUGIN_ALLOWED_PATH 加载后追加执行。
 *
 * 🔴 T85b ①（I-19）：修复前恒定 `executePlugin(plugin, {}, ctx)` 传空参 →
 *   插件落到 paramSchema 的硬编码默认 `symbol:'sh600000'` → **信号只对 1 只标的生效**，
 *   用户的自选/持仓一只都跑不到（违反 PRD M4）。
 *   现在支持传入**标的域**（自选 ∪ 持仓），并对整个标的域**批量预取**日线
 *   （SDD §5.3 P8「1 次 IN 查询 → N 插件共享」）。
 *
 * 🔴 F 域 P1-3：**用户插件配置在这里统一生效** —— `enabled=0` 的插件被过滤，
 *   `params_json` 合并进每个插件的执行参数。`admin.ts` 与 `scheduler.ts`
 *   两条调用链共用本函数，故无需各自再读一次配置。
 */
export async function executeAllPlugins(options: ExecuteAllPluginsOptions = {}): Promise<PluginBatchResult> {
  // 用户配置（enabled 过滤 + params 合并）
  const userId = options.userId ?? SIGNAL_USER_ID;
  const userConfigs = loadUserPluginConfigs(userId);
  // 合并内置 + 磁盘加载（SDD §5.3 磁盘热加载）
  // 只有**显式 enabled=0** 才停用；配置里没有记录的插件保持启用（默认行为不变）
  const monitorPlugins = getAllPlugins()
    .filter((p) => p.category === 'monitor')
    .filter((p) => userConfigs.get(p.id)?.enabled !== false);
  const symbols = options.symbols;

  // ── 标的域模式：批量预取 + 逐标的执行 ──
  // ⚠️ 用 `symbols !== undefined` 判定（不是 `symbols.length > 0`）——
  //    传了**空数组**表示「用户没有自选/持仓」→ 不该退回旧行为去跑硬编码 symbol。
  if (symbols !== undefined) {
    if (symbols.length === 0) {
      const emptyStats: PluginBatchStats = {
        total: 0,
        success: 0,
        timeout: 0,
        error: 0,
        skip: 0,
        noData: 0,
        positionUnavailable: 0,
      };
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'INFO',
        message: '批量执行跳过：标的域为空（用户无自选/持仓）',
        detail: JSON.stringify(emptyStats),
      });
      return { signals: [], stats: emptyStats, results: [] };
    }
    const days = options.prefetchDays ?? 120;
    // 回放时窗口终点锁在 asOfDate（无前视）；日常链路仍是今天
    const end = options.asOfDate ?? new Date().toISOString().slice(0, 10);
    const start = shiftTradeDate(end, -days);
    // 1 次 IN 查询拿回整个标的域的日线（N 个插件共享）
    const prefetchKlines = await batchGetDailyRange(symbols, start, end);
    const snapshot = await loadPositionSnapshot(userId, options.asOfDate);
    const ctx = buildPluginContext({ klines: prefetchKlines, windowDays: days, endDate: end }, snapshot);

    const stats: PluginBatchStats = {
      // 组合级插件（requiresPositions，如风险类）只执行 1 次，不按标的重数统计
      total: monitorPlugins.reduce((acc, p) => acc + (p.requiresPositions ? 1 : symbols.length), 0),
      success: 0,
      timeout: 0,
      error: 0,
      skip: 0,
      noData: 0,
      positionUnavailable: 0,
    };
    const allSignals: PluginSignal[] = [];
    const results: PluginExecutionResult[] = [];

    /**
     * 一次执行 + 归并结果（两条路径共用，避免统计分支各写一份）
     */
    const runOnce = async (plugin: Plugin, params: Record<string, unknown>): Promise<void> => {
      const res = await executePlugin(plugin, params, ctx);
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
        if (res.skipReason === 'NO_DATA') stats.noData += 1;
        else if (res.skipReason === 'POSITION_UNAVAILABLE') stats.positionUnavailable += 1;
      }
    };

    for (const plugin of monitorPlugins) {
      const userParams = { ...(options.userParams ?? {}), ...(userConfigs.get(plugin.id)?.params ?? {}) };
      /**
       * 🔴 组合级插件（`requiresPositions`）**只执行一次**：
       *   它读的是整份持仓快照，与「逐标的」正交；按标的重复执行会产出 N 份相同信号
       *   （落库虽被唯一键去重，但 stats / results / 日志会被放大 N 倍）。
       *   这类插件也不接受注入的 `symbol`（其 paramSchema 无该字段，注入值会被校验丢弃）。
       */
      if (plugin.requiresPositions) {
        await runOnce(plugin, userParams);
        continue;
      }
      for (const symbol of symbols) {
        // 参数优先级：调用方入参 < 用户配置 < 运行时注入的 symbol
        await runOnce(plugin, { ...userParams, symbol });
      }
    }

    writeSystemLog({
      logType: 'plugin_execute',
      level: 'INFO',
      message: `批量执行完成（标的域 ${symbols.length} 只、插件 ${monitorPlugins.length} 个） total=${stats.total} success=${stats.success} timeout=${stats.timeout} error=${stats.error} skip=${stats.skip} noData=${stats.noData} positionUnavailable=${stats.positionUnavailable}`,
      detail: JSON.stringify({ ...stats, symbolCount: symbols.length, pluginCount: monitorPlugins.length }),
    });

    return { signals: allSignals, stats, results };
  }

  // ── 旧行为（未传标的域）：每个插件跑 1 次 ──
  // 回放给了 asOfDate 时同样锁住取数终点（空预取 → 每次取数都走回落，但终点仍受控）
  const snapshot = await loadPositionSnapshot(userId, options.asOfDate);
  const ctx = buildPluginContext(
    options.asOfDate ? { klines: new Map(), windowDays: 0, endDate: options.asOfDate } : undefined,
    snapshot,
  );

  const stats: PluginBatchStats = {
    total: monitorPlugins.length,
    success: 0,
    timeout: 0,
    error: 0,
    skip: 0,
    noData: 0,
    positionUnavailable: 0,
  };
  const allSignals: PluginSignal[] = [];
  const results: PluginExecutionResult[] = [];

  for (const plugin of monitorPlugins) {
    // 参数优先级：调用方入参 < 用户配置（symbol 由插件自身的 paramSchema 默认值兜底）
    const params = { ...(options.userParams ?? {}), ...(userConfigs.get(plugin.id)?.params ?? {}) };
    const res = await executePlugin(plugin, params, ctx);
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
      if (res.skipReason === 'NO_DATA') stats.noData += 1;
      else if (res.skipReason === 'POSITION_UNAVAILABLE') stats.positionUnavailable += 1;
    }
  }

  writeSystemLog({
    logType: 'plugin_execute',
    level: 'INFO',
    message: `批量执行完成 total=${stats.total} success=${stats.success} timeout=${stats.timeout} error=${stats.error} skip=${stats.skip} noData=${stats.noData} positionUnavailable=${stats.positionUnavailable}`,
    detail: JSON.stringify(stats),
  });

  return { signals: allSignals, stats, results };
}
