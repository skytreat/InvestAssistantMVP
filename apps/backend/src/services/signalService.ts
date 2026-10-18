import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from './logger.js';
import type { PluginSignal } from './pluginEngine.js';

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
 * MVP 简化：固定 user_id=1（admin 默认 id=1），后续多用户扩展时按 user_asset_rel 分发
 */

const DIRECTION_MAP: Record<string, 'buy' | 'sell' | 'hold'> = {
  BUY: 'buy',
  SELL: 'sell',
  HOLD: 'hold',
};

/** INSERT 列顺序（persistSignals / persistBatchSignals 共用） */
const INSERT_SQL = `INSERT OR IGNORE INTO user_strategy_signal
     (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

  const stmt = db.prepare(INSERT_SQL);

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

  const stmt = db.prepare(INSERT_SQL);

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
