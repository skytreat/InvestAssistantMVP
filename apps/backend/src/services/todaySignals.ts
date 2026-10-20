/**
 * todaySignals.ts —— 信号的**读取侧**（T67 Dashboard 配套）
 *
 * 与 `services/signalService.ts` 的分工：
 *   - `signalService.ts` = 信号**写入**侧（插件产出 → `persistSignals` 落库）
 *   - 本文件 = 信号**读取**侧（Dashboard 持仓卡 enrich + 今日动态概览统计）
 *
 * ── 落点表名（**实测**，勿照抄任务描述）──
 *   信号表是 **`user_strategy_signal`**（`configStore.ts:70`），
 *   **不存在 `user_signal` 表**（全仓 grep 无此表名）。
 *   列口径：`direction TEXT NOT NULL CHECK (direction IN ('buy','sell','hold'))`。
 *   实测本地库 `data/business.db` 的现存取值：`buy` / `hold`（`sell` 由 CHECK 允许但暂无数据）。
 *
 * ── 硬约束 ──
 *   1. **禁止 N+1**：所有查询都是「1 次 IN 查询拿全量」，绝不逐标的循环
 *      （与 AGENTS.md「DuckDB 批量查询用 IN」同源约束，此处作用于 SQLite）。
 *   2. **全部预编译参数化**：IN 列表只拼 `?` 占位符，占位符个数由数组长度生成，
 *      真实值一律走绑定参数 —— 禁止把 asset_code 拼进 SQL 文本。
 */

import { ConfigStore } from '../config/configStore.js';

/** 信号方向（与 DDL 的 CHECK 约束一致） */
export type SignalDirection = 'buy' | 'sell' | 'hold';

/**
 * 持仓卡 / 重点关注用的**精简信号**（只挑前端要展示的 4 个字段）
 *
 * ⚠️ 不含 `metrics_json`（可能很大，前端展示用不上）——
 *    需要参数摘要时前端可另查 `/api/signal`。
 */
export interface SignalRow {
  /** 产出该信号的插件 id */
  plugin_id: string;
  /** 方向：buy=买入 / sell=卖出 / hold=持仓 */
  direction: SignalDirection;
  /** 面向用户的标签（如「金叉」「RSI<28」） */
  label: string;
  /** 信号所属交易日 */
  trade_date: string;
}

/** 今日信号统计（Dashboard 今日动态概览卡的「今日信号 ▲▼·」） */
export interface TodaySignalStats {
  /** 今日信号总数 */
  total: number;
  /** 买入信号数（▲） */
  up: number;
  /** 卖出信号数（▼） */
  down: number;
  /** 持仓/观望信号数（·） */
  hold: number;
}

/**
 * 批量取「每个标的的**最新一条**信号」（**1 次查询**，无 N+1）
 *
 * 「最新」= `ORDER BY trade_date DESC, id DESC` 取第一条
 * （`trade_date` 为主序；同一交易日内按 `id` 倒序兜底，保证确定性 —— 同日多插件信号
 *  时取最后落库的那条，而不是随机的）。
 *
 * ⚠️ 过滤 `is_deleted = 0`（软删除语义，AGENTS.md：业务记录只软删）。
 * ⚠️ 不按 `is_final` 过滤 —— 与既有 `GET /api/signal` 端点口径保持一致
 *    （该端点也不过滤，且当前落库方恒写 `is_final = 1`）。
 *
 * @param userId 用户 id（信号按用户隔离）
 * @param assetCodes 标的代码列表（内部去重）
 * @returns Map<asset_code, SignalRow>；**没有信号的标的不出现在结果里**（调用方取不到即为 null）
 */
export async function getLatestSignalsByAssets(
  userId: number,
  assetCodes: string[],
): Promise<Map<string, SignalRow>> {
  const result = new Map<string, SignalRow>();
  const unique = Array.from(new Set(assetCodes.filter((c) => typeof c === 'string' && c.length > 0)));
  if (unique.length === 0) return result;

  const db = ConfigStore.getInstance().db;
  // ⚠️ 只拼占位符（长度由数组决定），真实值一律走绑定参数
  const placeholders = unique.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT asset_code, plugin_id, direction, label, trade_date FROM (
         SELECT asset_code, plugin_id, direction, label, trade_date,
                ROW_NUMBER() OVER (PARTITION BY asset_code ORDER BY trade_date DESC, id DESC) AS rn
         FROM user_strategy_signal
         WHERE user_id = ? AND is_deleted = 0 AND asset_code IN (${placeholders})
       ) WHERE rn = 1`,
    )
    .all(userId, ...unique) as Array<{
    asset_code: string;
    plugin_id: string;
    direction: string;
    label: string;
    trade_date: string;
  }>;

  for (const row of rows) {
    result.set(row.asset_code, {
      plugin_id: row.plugin_id,
      // ⚠️ 断言是安全的：`direction` 的取值集合由 DDL CHECK 约束保证
      //   （`CHECK (direction IN ('buy','sell','hold'))`，configStore.ts:77），
      //   不可能落库非法值。实测本地库现存取值 = buy / hold（sell 暂无数据）。
      direction: row.direction as SignalDirection,
      label: row.label,
      trade_date: row.trade_date,
    });
  }

  return result;
}

/**
 * 统计指定交易日的信号数量（**1 次 GROUP BY 查询**）
 *
 * 口径：`user_strategy_signal` 中 `user_id = ? AND is_deleted = 0 AND trade_date = ?`，
 * 按 `direction` 分组计数。
 * - `buy`  → `up`（▲）
 * - `sell` → `down`（▼）
 * - `hold` → `hold`（·）
 *
 * ⚠️ `total` = **各方向之和**（含未来新增的未知方向），故 `total >= up + down + hold`；
 *   当前 DDL 的 CHECK 只允许 3 个取值 → 三者之和恒等于 total。
 *
 * @param tradeDate 交易日 YYYY-MM-DD（由调用方用「今天」或具体日期传入，**本函数不自算日历**）
 */
export async function getTodaySignalStats(userId: number, tradeDate: string): Promise<TodaySignalStats> {
  const stats: TodaySignalStats = { total: 0, up: 0, down: 0, hold: 0 };

  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT direction, COUNT(*) AS cnt
         FROM user_strategy_signal
        WHERE user_id = ? AND is_deleted = 0 AND trade_date = ?
        GROUP BY direction`,
    )
    .all(userId, tradeDate) as Array<{ direction: string; cnt: number }>;

  for (const row of rows) {
    const cnt = Number(row.cnt) || 0;
    stats.total += cnt;
    if (row.direction === 'buy') stats.up += cnt;
    else if (row.direction === 'sell') stats.down += cnt;
    else if (row.direction === 'hold') stats.hold += cnt;
  }

  return stats;
}
