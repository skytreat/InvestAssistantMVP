/**
 * 组合信号的 DB 读取源（T133 / PA-09）—— 纸面/回测共用
 *
 * 口径（D3）：**先批量预生成信号、再跟随**。本文件只**读** `user_strategy_signal`，
 * 不重算条件；写入方是每日链路（`executeAllPlugins` → `persistSignals`）。
 *
 * 只取**最新一天**（`trade_date <= asOf` 的最大值）的组合信号 ⇒ 策略跟随的是
 * 组合的"当前状态"，而不是把历史某天的买入信号反复当成今日动作。
 * `strength IS NOT NULL` 与 F1 精选口径一致（风险 HOLD 行 `strength=NULL` 天然排除）。
 */
import type Database from 'better-sqlite3';
import { ConfigStore } from '../../config/configStore.js';
import { SIGNAL_USER_ID } from '../signalService.js';
import { comboPluginId } from '../comboStrategy.js';
import type { ComboSignalSource, ComboSignalView } from '../backtest/strategies/comboSignal.js';

interface SignalRow {
  asset_code: string;
  trade_date: string;
  direction: string;
  strength: number;
}

function normalizeDirection(value: string): 'buy' | 'sell' | 'hold' {
  if (value === 'buy' || value === 'BUY') return 'buy';
  if (value === 'sell' || value === 'SELL') return 'sell';
  return 'hold';
}

function listLatest(comboId: string, asOf: string, db: Database.Database): ComboSignalView[] {
  const rows = db
    .prepare(
      `SELECT asset_code, trade_date, direction, strength
         FROM user_strategy_signal
        WHERE user_id = ? AND plugin_id = ? AND trade_date <= ? AND is_deleted = 0
          AND strength IS NOT NULL
        ORDER BY trade_date DESC, strength DESC`,
    )
    .all(SIGNAL_USER_ID, comboPluginId(comboId), asOf) as SignalRow[];

  if (rows.length === 0) return [];
  const latest = rows[0].trade_date;
  return rows
    .filter((row) => row.trade_date === latest)
    .map((row) => ({
      symbol: row.asset_code,
      tradeDate: row.trade_date,
      direction: normalizeDirection(row.direction),
      strength: row.strength,
    }));
}

/** 纸面/回测使用的组合信号源（按 `combo:<id>` + `asOf` 截止，无前视） */
export const dbComboSignalSource: ComboSignalSource = {
  listSignals(comboId: string, asOf: string): readonly ComboSignalView[] {
    if (!comboId) return [];
    return listLatest(comboId, asOf, ConfigStore.getInstance().db);
  },
};

/**
 * 回放装载用：取区间内出现过的组合信号标的
 *
 * 仅用于把行情序列装进 `buildPaperMarketData`（决策仍按 `asOf` 逐日过滤，不构成前视）。
 */
export function loadComboSignalSymbols(comboId: string, from: string, to: string): string[] {
  if (!comboId) return [];
  try {
    const rows = ConfigStore.getInstance()
      .db.prepare(
        `SELECT DISTINCT asset_code
           FROM user_strategy_signal
          WHERE user_id = ? AND plugin_id = ? AND trade_date BETWEEN ? AND ? AND is_deleted = 0
          ORDER BY asset_code`,
      )
      .all(SIGNAL_USER_ID, comboPluginId(comboId), from, to) as Array<{ asset_code: string }>;
    return rows.map((row) => row.asset_code);
  } catch {
    // 读取失败只影响可交易标的范围，不应阻塞整条决策链路
    return [];
  }
}
