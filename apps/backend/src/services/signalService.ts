import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from './logger.js';
import type { PluginSignal } from './pluginEngine.js';

/**
 * 信号生成的目标用户 id
 *
 * MVP 为单用户部署：admin 账号固定 id=1（与 `persistSignals` 的 `userId = 1` 默认一致）。
 * 多用户扩展时改为遍历用户列表。
 */
export const SIGNAL_USER_ID = 1;

/**
 * 解析信号生成的**标的域**（T85b ① / I-19）
 *
 * PRD M4：「每日收盘后系统自动跑一遍**自选 + 持仓标的**的策略信号」
 * PRD §1.1 痛点：「没有一个工具能在收盘后自动给自己的**自选 + 持仓**标的跑一遍策略信号」
 *
 * 🔴 修复前：`executeAllPlugins()` 传空参 → 所有插件落到 `paramSchema` 的硬编码默认
 *   `symbol:'sh600000'` → 信号只对 **1 只**硬编码标的生效，用户的自选/持仓一只都跑不到。
 *
 * 口径：`user_asset_rel` 中 `rel_type IN ('watch','hold')` 的 `asset_code` **并集**，
 * 去重、排除软删（`is_deleted=1`）。`candidate`（候选池）**不算** —— 它不是持仓也不是自选。
 *
 * @returns 去重后的标的代码数组（升序）；无标的时返回空数组
 */
export function resolveSignalSymbols(userId: number = SIGNAL_USER_ID): string[] {
  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT DISTINCT asset_code FROM user_asset_rel
       WHERE user_id = ? AND rel_type IN ('watch', 'hold') AND is_deleted = 0
       ORDER BY asset_code`,
    )
    .all(userId) as Array<{ asset_code: string }>;
  return rows.map((r) => r.asset_code).filter((s) => typeof s === 'string' && s.length > 0);
}

/**
 * 信号持久化服务（T27 核心）
 *
 * executeAllPlugins() 返回的 PluginSignal[] 写入 user_strategy_signal
 * UNIQUE(user_id, asset_code, plugin_id, trade_date) + ON CONFLICT DO NOTHING 做幂等防重
 *
 * T93 契约对齐（SDD §5.3 StrategySignal）：
 *   - PluginSignal.params → metrics，序列化后落 user_strategy_signal.metrics_json
 *   - signalType（BUY/SELL/HOLD）经 DIRECTION_MAP 映射为 SDD 的 direction（buy/sell/hold）
 *   - signalType 枚举已去掉 'ALERT'（SDD §5.3 无告警向）
 *
 * T58 落库字段补全：
 *   - `metrics_json` 由 T93 先行落地（serializeMetrics），T58 不重复实现，只补测试
 *   - `is_final` 显式写 1（DDL 有 `DEFAULT 1`，但 INSERT 显式声明，避免后续默认值变更静默改语义）
 *
 * ⚠️ metrics_json 只序列化插件回传的数值明细（PluginSignal.metrics），
 *    **不包含 ctx / token / 任何凭证**，也不包含 PluginSignal.detail 自由文本。
 *
 * MVP 简化：固定 user_id=1（admin 默认 id=1），后续多用户扩展时按 user_asset_rel 分发
 */

const DIRECTION_MAP: Record<string, 'buy' | 'sell' | 'hold'> = {
  BUY: 'buy',
  SELL: 'sell',
  HOLD: 'hold',
};

/**
 * INSERT 列顺序（persistSignals / persistBatchSignals 共用）
 *
 * T58：显式写入 `is_final = 1`。这里是常量而非用户输入，故用 SQL 字面量而非占位符；
 * 真正来自外部的 9 个字段全部走 `?` 预编译绑定。
 */
export const SIGNAL_INSERT_SQL = `INSERT OR IGNORE INTO user_strategy_signal
     (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

/** metrics 序列化成 metrics_json（无 metrics 时写 NULL，不写 'null' 字符串） */
function serializeMetrics(metrics: Record<string, number> | undefined): string | null {
  if (!metrics) return null;
  return JSON.stringify(metrics);
}

export interface PersistResult {
  inserted: number;
  skipped: number;
  errors: number;
}

export function persistSignals(
  signals: PluginSignal[],
  pluginId: string,
  pluginCategory: 'monitor' | 'filter',
  tradeDate: string,
  userId: number = 1,
): PersistResult {
  const db = ConfigStore.getInstance().db;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const stmt = db.prepare(SIGNAL_INSERT_SQL);

  const tx = db.transaction(() => {
    for (const s of signals) {
      const dir = DIRECTION_MAP[s.signalType] ?? 'hold';
      try {
        const info = stmt.run(userId, s.symbol, pluginId, pluginCategory, tradeDate, dir, s.label ?? s.signalType, s.strength ?? null, serializeMetrics(s.metrics));
        if (info.changes > 0) inserted++;
        else skipped++;
      } catch (err: unknown) {
        errors++;
        writeSystemLog({
          logType: 'signal_generate', level: 'ERROR',
          message: `信号持久化失败: ${pluginId}/${s.symbol}`, detail: String(err),
        });
      }
    }
  });

  tx();
  return { inserted, skipped, errors };
}

/**
 * 批量持久化 PluginBatchResult——从 executeAllPlugins 拿到的完整 signals 列表
 * 因为 batch 里混了多个 plugin 的信号，这里不知道每个 signal 属于哪个 plugin
 * → 让调用方在 executePlugin 层就分别调用 persistSignals
 */
export function persistBatchSignals(
  results: Array<{ pluginId: string; pluginCategory: 'monitor' | 'filter'; signals: PluginSignal[] }>,
  tradeDate: string,
  userId: number = 1,
): PersistResult {
  const db = ConfigStore.getInstance().db;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const stmt = db.prepare(SIGNAL_INSERT_SQL);

  const tx = db.transaction(() => {
    for (const r of results) {
      for (const s of r.signals) {
        const dir = DIRECTION_MAP[s.signalType] ?? 'hold';
        try {
          const info = stmt.run(userId, s.symbol, r.pluginId, r.pluginCategory, tradeDate, dir, s.label ?? s.signalType, s.strength ?? null, serializeMetrics(s.metrics));
          if (info.changes > 0) inserted++;
          else skipped++;
        } catch (err: unknown) {
          errors++;
          writeSystemLog({
            logType: 'signal_generate', level: 'ERROR',
            message: `信号持久化失败: ${r.pluginId}/${s.symbol}`, detail: String(err),
          });
        }
      }
    }
  });

  tx();
  return { inserted, skipped, errors };
}

/**
 * 今日交易日（东八区日期，2026-10-15 格式）
 */
export function getTradeDate(): string {
  const now = new Date();
  const offset = 8 * 60;  // UTC+8
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}
