/**
 * 组合策略执行器（T133，PA-06）—— 引擎接入
 *
 * 口径（方案 §6，owner 已定）：
 * - **D1：MVP 只做 AND** —— 由 {@link evaluateCombo} 保证；
 * - **D2：strength = min(各启用条件 strength)** —— 同上；
 * - **D3：先批量预生成信号、再跟随** —— 本执行器只产出信号（落 `user_strategy_signal`），
 *   回测/纸面由 `backtest/strategies/comboSignal.ts` 读取同一批信号，**判据只有一份**；
 * - **D4：历史不可变** —— 条件参数随组合配置落库；改配置只影响未来（本执行器每次读最新配置）。
 *
 * 职责边界：
 * - 本模块**不做行情 IO**：条件执行由引擎注入 `runCondition`（复用同一批预取 `ctx`）；
 * - 本模块**不落库**：信号由 `executeAllPlugins` 归并进 `results`，由既有
 *   `persistSignals` / `assignSignalGrades` / `assignSignalCooldowns` 链路统一落库；
 * - 失败隔离：单个组合配置异常 / 条件执行异常**只影响该组合该标的**，不影响普通插件。
 *
 * ⚠️ 组合信号的 `plugin_id` 编码固定为 `combo:<comboId>`、`plugin_category='monitor'`、
 *    `sub_category=NULL`（展示层合并 / 风险过滤都不依赖它）。见方案 §4.6。
 */
import type Database from 'better-sqlite3';
import { evaluateCombo, type ComboConditionResult, type ComboMatch } from './comboEvaluator.js';
import { listCombos, type Combo, type ComboAssetScope } from './comboRepo.js';
import { getAssetClass } from './assetClass.js';
import { fetchAssetClasses } from './marketData.js';
import { writeSystemLog } from './logger.js';
import type { Plugin, PluginExecutionResult, PluginSignal } from './pluginEngine.js';

/** 组合信号 plugin_id 前缀（`combo:<comboId>`） */
export const COMBO_PLUGIN_PREFIX = 'combo:';

/** 组合信号的 plugin_id */
export function comboPluginId(comboId: string): string {
  return `${COMBO_PLUGIN_PREFIX}${comboId}`;
}

/** 本批组合执行统计（与普通插件统计分列，不混入 `PluginBatchStats.total`） */
export interface ComboRunStats {
  /** 启用的组合数 */
  enabled: number;
  /** 实际跑过的组合数（含配置异常被跳过的） */
  ran: number;
  /** 产出的合成信号数 */
  matchedSignals: number;
  /** 配置级失败（插件不存在/非 monitor/适用品种不可解析） */
  failed: number;
}

export interface ComboBatchOutcome {
  /** 每个组合一条执行结果（`pluginId = combo:<id>`），供既有落库链路消费 */
  results: PluginExecutionResult[];
  /** 合成的组合信号（与 `results[].signals` 同源） */
  signals: PluginSignal[];
  stats: ComboRunStats;
}

export interface ExecuteCombosOptions {
  db: Database.Database;
  userId: number;
  /** 标的域（与普通插件共享同一批预取行情） */
  symbols: readonly string[];
  /** 可作为条件的插件（monitor 且未停用）；路由层创建时已做白名单校验 */
  plugins: readonly Plugin[];
  /** 执行单个条件插件（由引擎注入，复用同一 `PluginContext`） */
  runCondition: (
    plugin: Plugin,
    params: Record<string, unknown>,
    symbol: string,
  ) => Promise<PluginExecutionResult>;
}

type ScopeResolution = { ok: true; symbols: string[] } | { ok: false; reason: string };

/**
 * 解析组合的「适用品种」
 *
 * - `all` / `exclude_cash`：本地 SQLite 可判（`asset_class`）；
 * - `stock` / `etf`：走行情层 `raw_symbol_class`（**权威来源**，非代码前缀启发）；
 *   查不到分类的标的按「不属于该品种」处理（不猜）；
 * - `cross_border` / `exclude_cross_border`：**行情层无跨境分类字段**（该字段只存在于券商
 *   导入的成交事件里，不是标维分类），故无法解析 ⇒ 返回 `ok:false`（**失败即跳过，不猜**）。
 *
 * ⚠️ 宁可当天不产出信号，也不产出与用户声明品种不符的信号。
 */
export async function resolveComboSymbols(
  scope: ComboAssetScope,
  symbols: readonly string[],
  db: Database.Database,
): Promise<ScopeResolution> {
  const unique = Array.from(new Set(symbols));
  if (scope === 'all') {
    return { ok: true, symbols: unique };
  }
  if (scope === 'exclude_cash') {
    return { ok: true, symbols: unique.filter((symbol) => getAssetClass(db, symbol) !== 'cash') };
  }
  if (scope === 'stock' || scope === 'etf') {
    let classes: Map<string, string>;
    try {
      classes = await fetchAssetClasses(unique);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `行情层品种分类不可用：${message}` };
    }
    return { ok: true, symbols: unique.filter((symbol) => classes.get(symbol) === scope) };
  }
  return {
    ok: false,
    reason: `适用品种 ${scope} 在行情层无标维分类字段（跨境分类仅存在于券商成交事件），本轮跳过`,
  };
}

/** 把 `PluginExecutionResult.status` 映射成求值器状态 */
function toConditionStatus(status: PluginExecutionResult['status']): 'OK' | 'SKIP' | 'ERROR' | 'TIMEOUT' {
  if (status === 'SUCCESS') return 'OK';
  if (status === 'SKIP') return 'SKIP';
  if (status === 'TIMEOUT') return 'TIMEOUT';
  return 'ERROR';
}

/** 组合条件白名单：必须是能产出 BUY/SELL 的逐标的 monitor 插件 */
export function isAllowedComboCondition(plugin: Plugin | undefined): plugin is Plugin {
  return (
    plugin !== undefined &&
    plugin.category === 'monitor' &&
    plugin.subCategory !== 'risk' &&
    plugin.requiresPositions !== true
  );
}

function synthesizeSignal(
  comboId: string,
  symbol: string,
  match: ComboMatch,
  timestamp: string,
): PluginSignal {
  return {
    symbol,
    signalType: match.direction,
    strength: match.strength,
    pluginId: comboPluginId(comboId),
    timestamp,
    label: match.direction === 'BUY' ? '组合买入' : '组合卖出',
    metrics: { strength: match.strength, conditionCount: match.matchedPluginIds.length },
    detail: `AND 成立：${match.matchedPluginIds.join(' + ')}（最弱一环 ${match.minPluginId}）`,
  };
}

/**
 * 执行全部启用组合
 *
 * 对每个组合、每个（按适用品种过滤后的）标的：
 *   ① 逐个执行启用条件（参数 = 条件参数 + 运行时 `symbol`，**不合并全局插件参数**，
 *      保证组合口径只由组合配置决定，见 INV-S3-19）；
 *   ② 交给 {@link evaluateCombo} 做 AND + min 求值；
 *   ③ 成立则合成一条 `combo:<id>` 信号。
 *
 * 条件结果按 `(pluginId, params, symbol)` 缓存，避免多个组合重复执行同一条件。
 */
export async function executeCombos(options: ExecuteCombosOptions): Promise<ComboBatchOutcome> {
  const stats: ComboRunStats = { enabled: 0, ran: 0, matchedSignals: 0, failed: 0 };
  const results: PluginExecutionResult[] = [];
  const signals: PluginSignal[] = [];

  let combos: Combo[];
  try {
    combos = listCombos(options.db, options.userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeSystemLog({
      logType: 'plugin_execute',
      level: 'WARN',
      message: `组合策略读取失败（不影响普通插件）：${message}`,
    });
    return { results, signals, stats };
  }

  stats.enabled = combos.length;
  if (combos.length === 0) {
    return { results, signals, stats };
  }

  const pluginById = new Map(options.plugins.map((plugin) => [plugin.id, plugin]));
  const cache = new Map<string, Promise<PluginExecutionResult>>();

  const runCached = (plugin: Plugin, params: Record<string, unknown>, symbol: string) => {
    const key = `${plugin.id}\u0000${JSON.stringify(params)}\u0000${symbol}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = options.runCondition(plugin, params, symbol);
      cache.set(key, pending);
    }
    return pending;
  };

  for (const combo of combos) {
    stats.ran += 1;
    const pluginId = comboPluginId(combo.id);

    // ① 适用品种
    const scope = await resolveComboSymbols(combo.assetScope, options.symbols, options.db);
    if (!scope.ok) {
      stats.failed += 1;
      results.push({ pluginId, status: 'ERROR', signals: [], durationMs: 0, error: scope.reason });
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'WARN',
        message: `组合「${combo.name}」(${combo.id}) 跳过：${scope.reason}`,
      });
      continue;
    }

    // ② 条件白名单（配置型错误：插件被停用 / 改成风险类 / 被删除）
    const enabledConditions = combo.conditions.filter((condition) => condition.enabled);
    if (enabledConditions.length < 2) {
      stats.failed += 1;
      const reason = `启用条件不足 2 个（当前 ${enabledConditions.length} 个），AND 组合不成立`;
      results.push({
        pluginId,
        status: 'SKIP',
        signals: [],
        durationMs: 0,
        skipReason: 'NO_SIGNAL',
        error: reason,
      });
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'WARN',
        message: `组合「${combo.name}」(${combo.id}) 跳过：${reason}`,
      });
      continue;
    }
    const conditionPlugins: Array<{ plugin: Plugin; params: Record<string, unknown> }> = [];
    let invalidReason: string | null = null;
    for (const condition of enabledConditions) {
      const plugin = pluginById.get(condition.pluginId);
      if (!isAllowedComboCondition(plugin)) {
        invalidReason = `条件插件「${condition.pluginId}」不可用（需未停用的 monitor 且非风险/组合级插件）`;
        break;
      }
      conditionPlugins.push({ plugin, params: condition.params });
    }
    if (invalidReason !== null) {
      stats.failed += 1;
      results.push({ pluginId, status: 'ERROR', signals: [], durationMs: 0, error: invalidReason });
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'WARN',
        message: `组合「${combo.name}」(${combo.id}) 跳过：${invalidReason}`,
      });
      continue;
    }

    // ③ 逐标的求值
    const startedAt = Date.now();
    const timestamp = new Date().toISOString();
    const comboSignals: PluginSignal[] = [];
    try {
      for (const symbol of scope.symbols) {
        const conditionResults: ComboConditionResult[] = [];
        for (const { plugin, params } of conditionPlugins) {
          let exec: PluginExecutionResult;
          try {
            exec = await runCached(plugin, params, symbol);
          } catch (err) {
            // 失败隔离：单个条件抛错 ⇒ 该标的视为不成立，不影响其他标的/组合
            const message = err instanceof Error ? err.message : String(err);
            exec = { pluginId: plugin.id, status: 'ERROR', signals: [], durationMs: 0, error: message };
          }
          const signal =
            exec.signals.find(
              (s) => s.symbol === symbol && (s.signalType === 'BUY' || s.signalType === 'SELL'),
            ) ?? exec.signals.find((s) => s.symbol === symbol);
          conditionResults.push({
            pluginId: plugin.id,
            enabled: true,
            status: toConditionStatus(exec.status),
            signalType: signal?.signalType ?? null,
            strength: signal?.strength ?? null,
          });
        }
        const match = evaluateCombo(conditionResults);
        if (match) {
          comboSignals.push(synthesizeSignal(combo.id, symbol, match, timestamp));
        }
      }
    } catch (err) {
      stats.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        pluginId,
        status: 'ERROR',
        signals: [],
        durationMs: Date.now() - startedAt,
        error: message,
      });
      writeSystemLog({
        logType: 'plugin_execute',
        level: 'WARN',
        message: `组合「${combo.name}」(${combo.id}) 执行失败（已隔离）：${message}`,
      });
      continue;
    }

    stats.matchedSignals += comboSignals.length;
    results.push({
      pluginId,
      status: comboSignals.length > 0 ? 'SUCCESS' : 'SKIP',
      signals: comboSignals,
      durationMs: Date.now() - startedAt,
      ...(comboSignals.length === 0 ? { skipReason: 'NO_SIGNAL' as const } : {}),
    });
    signals.push(...comboSignals);

    writeSystemLog({
      logType: 'plugin_execute',
      level: 'INFO',
      message: `组合「${combo.name}」(${combo.id}) 求值完成：条件 ${conditionPlugins.length} 个、标的 ${scope.symbols.length} 只、产出 ${comboSignals.length} 条信号`,
      detail: JSON.stringify({
        comboId: combo.id,
        configVersion: combo.configVersion,
        assetScope: combo.assetScope,
        symbols: scope.symbols.length,
        signals: comboSignals.length,
        pluginIds: conditionPlugins.map((item) => item.plugin.id),
      }),
    });
  }

  return { results, signals, stats };
}
