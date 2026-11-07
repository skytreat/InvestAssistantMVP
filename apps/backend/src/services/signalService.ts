import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from './logger.js';
import { resolveLatestQuoteDate } from './marketData.js';
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
  const codes = rows.map((r) => r.asset_code).filter((s) => typeof s === 'string' && s.length > 0);
  // T133（V3.4）：现金类资产不产生任何策略信号（SDD_v3 §2 / INV-S4-15）
  // 无 asset_class 记录的标的默认 risk（安全侧），不静默排除
  const cashSet = new Set(
    (
      db
        .prepare(
          `SELECT symbol FROM asset_class WHERE asset_class = 'cash' AND symbol IN (${codes.map(() => '?').join(',') || "''"})`,
        )
        .all(...codes) as Array<{ symbol: string }>
    ).map((r) => r.symbol),
  );
  return codes.filter((c) => !cashSet.has(c));
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
 *
 * F 域区间回放：`origin` 区分 `live`（日常链路实时生成）/ `replay`（回放补算），
 * 两个持久化函数都通过参数绑定写入，不再依赖列默认值。
 */
export const SIGNAL_INSERT_SQL = `INSERT OR IGNORE INTO user_strategy_signal
     (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, origin, is_final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

/** 信号来源：live = 日常链路（17:02 定时 / 手动触发）；replay = 区间回放补算 */
export type SignalOrigin = 'live' | 'replay';

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
  origin: SignalOrigin = 'live',
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
        const info = stmt.run(
          userId,
          s.symbol,
          pluginId,
          pluginCategory,
          tradeDate,
          dir,
          s.label ?? s.signalType,
          s.strength ?? null,
          serializeMetrics(s.metrics),
          origin,
        );
        if (info.changes > 0) inserted++;
        else skipped++;
      } catch (err: unknown) {
        errors++;
        writeSystemLog({
          logType: 'signal_generate',
          level: 'ERROR',
          message: `信号持久化失败: ${pluginId}/${s.symbol}`,
          detail: String(err),
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
  origin: SignalOrigin = 'live',
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
          const info = stmt.run(
            userId,
            s.symbol,
            r.pluginId,
            r.pluginCategory,
            tradeDate,
            dir,
            s.label ?? s.signalType,
            s.strength ?? null,
            serializeMetrics(s.metrics),
            origin,
          );
          if (info.changes > 0) inserted++;
          else skipped++;
        } catch (err: unknown) {
          errors++;
          writeSystemLog({
            logType: 'signal_generate',
            level: 'ERROR',
            message: `信号持久化失败: ${r.pluginId}/${s.symbol}`,
            detail: String(err),
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
  const offset = 8 * 60; // UTC+8
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

/**
 * 「最近有信号日」= 该用户已落库信号里的 `MAX(trade_date)`（F 域 P0-1）
 *
 * 🔴 修复前：`GET /api/signal/stats` 未传 `trade_date` 时一律落到 `getTradeDate()`（**自然日今天**）
 *   ⇒ 周末 / 节假日 / 行情还没跑的日子，前端打开就是「今日 0 条」，用户以为「没信号」，
 *   实际是「今天本来就不该有信号」。
 *
 * @returns `YYYY-MM-DD`；该用户一条信号都没有时返回 null
 */
export function resolveLatestSignalDate(userId: number = SIGNAL_USER_ID): string | null {
  const db = ConfigStore.getInstance().db;
  const row = db
    .prepare(
      `SELECT MAX(trade_date) AS latest FROM user_strategy_signal
       WHERE user_id = ? AND is_deleted = 0`,
    )
    .get(userId) as { latest: string | null } | undefined;
  const latest = row?.latest;
  return typeof latest === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(latest) ? latest : null;
}

/** 默认交易日的解析结果（附带来源，便于前端/接口自解释） */
export interface DefaultSignalDate {
  /** 实际使用的交易日 */
  tradeDate: string;
  /** signal=最近有信号日；quote=最近行情日；today=都没有时的兜底（东八区今天） */
  source: 'signal' | 'quote' | 'today';
  /** 最近行情日（行情库不可读时为 null；仅在无信号、需要兜底时才查） */
  latestQuoteDate: string | null;
}

/**
 * 信号接口的**默认交易日口径**（F 域 P0-1）
 *
 * 优先级：最近有信号日 → 最近行情日（`resolveLatestQuoteDate()`）→ 东八区今天。
 *
 * ⚠️ 只有「一条信号都没有」时才会去查行情库 —— 正常运行（每天 17:02 生成信号后）
 * 只走一次 SQLite 聚合，不给 DuckDB 增加无谓的打开/关闭开销。
 */
export async function resolveDefaultSignalTradeDate(
  userId: number = SIGNAL_USER_ID,
): Promise<DefaultSignalDate> {
  const latestSignalDate = resolveLatestSignalDate(userId);
  if (latestSignalDate) {
    return { tradeDate: latestSignalDate, source: 'signal', latestQuoteDate: null };
  }
  const latestQuoteDate = await resolveLatestQuoteDate();
  if (latestQuoteDate) {
    return { tradeDate: latestQuoteDate, source: 'quote', latestQuoteDate };
  }
  return { tradeDate: getTradeDate(), source: 'today', latestQuoteDate: null };
}
