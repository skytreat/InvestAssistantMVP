import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from './logger.js';
import { calcClosedTradePnLs } from './positionCalculator.js';
import { isTradingDay, resolveLatestQuoteDate } from './marketData.js';
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

// ─────────────────────────────────────────────────────────────────
// F1：信号分级（PRD_v3 §4.2「强 / 中 / 弱，默认只显示强」）
// ─────────────────────────────────────────────────────────────────

/** 信号分级枚举（与 DDL `grade` 的 CHECK 约束一一对应）*/
export type SignalGrade = 'strong' | 'medium' | 'weak';

/**
 * 候选充足时的**纯分数分位**边界（用户口径，不可改）
 *
 * 强 = 当日候选前 20%；中 = 20%–50%；弱 = 后 50%。
 */
const GRADE_STRONG_RATIO = 0.2;
const GRADE_MEDIUM_RATIO = 0.5;

/**
 * 候选不足时的**绝对分值兜底**阈值
 *
 * 当日可分级信号 < {@link GRADE_MIN_CANDIDATES} 只时，百分位没有统计意义，
 * 退回按强度绝对分值定档：≥0.6 强 / ≥0.3 中 / 其余弱。
 *
 * ⚠️ 这两个常量是**兜底口径的唯一来源**（插件 `strength` 均归一化到 0~1，
 * 但各插件分布差异大，故阈值只做「保守的绝对判断」，主路径永远是分位）。
 */
const GRADE_MIN_CANDIDATES = 10;
const GRADE_ABS_STRONG_MIN = 0.6;
const GRADE_ABS_MEDIUM_MIN = 0.3;

/**
 * 有效期（交易日）：强 3 / 中 2 / 弱 1
 *
 * 到期日写入 `expires_at`，过期信号**置灰不删**（前端标注「生成于 X 天前」）。
 */
const GRADE_TTL_TRADING_DAYS: Record<SignalGrade, number> = {
  strong: 3,
  medium: 2,
  weak: 1,
};

/** `YYYY-MM-DD` + n 天（UTC 日历运算，不做时区偏移）*/
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 求 `tradeDate` 之后第 n 个交易日
 *
 * 主路径：逐日 `isTradingDay()`（工作日 + `raw_holidays` 休市黑名单，见 marketData.ts）。
 * 兜底：行情日历不可用（`isTradingDay()` 恒 false）时按**纯工作日**推算 ——
 * 这样离线/空壳库环境下 `expires_at` 仍有确定值，而不是 NULL。
 */
async function nthTradingDayAfter(tradeDate: string, n: number): Promise<string> {
  const dates: string[] = [];
  let cursor = tradeDate;
  // 45 天窗口足够覆盖国庆/春节长假（最长约 9 个休市日）
  for (let i = 0; i < 45 && dates.length < n; i++) {
    cursor = addDays(cursor, 1);
    if (await isTradingDay(cursor)) dates.push(cursor);
  }
  if (dates.length >= n) return dates[n - 1];

  // 兜底：纯工作日推算（节假日不准，但不会因行情层不可用而卡住）
  let fallback = tradeDate;
  let count = 0;
  while (count < n) {
    fallback = addDays(fallback, 1);
    const dow = new Date(`${fallback}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return fallback;
}

/** 按规则给「当日各信号强度」定档（纯函数，便于单测）*/
export function gradeSignalStrengths(strengths: number[]): SignalGrade[] {
  if (strengths.length === 0) return [];
  if (strengths.length < GRADE_MIN_CANDIDATES) {
    return strengths.map((s) =>
      s >= GRADE_ABS_STRONG_MIN ? 'strong' : s >= GRADE_ABS_MEDIUM_MIN ? 'medium' : 'weak',
    );
  }
  const strongEnd = Math.ceil(strengths.length * GRADE_STRONG_RATIO);
  const mediumEnd = Math.ceil(strengths.length * GRADE_MEDIUM_RATIO);
  return strengths.map((_, i) => (i < strongEnd ? 'strong' : i < mediumEnd ? 'medium' : 'weak'));
}

export interface GradeResult {
  graded: number;
  strong: number;
  medium: number;
  weak: number;
}

/**
 * 给某一交易日的全部信号回填 `grade` + `expires_at`（F1）
 *
 * 口径：
 * - **纯分数分位**（按 `strength` 降序排名，`id` 升序做确定性 tie-break）；
 * - 只处理 `strength` 非空的行 —— 无强度的信号保持 `grade = NULL`（未分级）；
 * - `expires_at` = 交易日之后第 强3 / 中2 / 弱1 个交易日；
 * - **幂等**：重复调用只会覆盖同样的定档结果（当天信号集合不变时）。
 *
 * ⚠️ 本函数**只改 `grade` / `expires_at` 两列**，不新增/删除任何信号行，
 *    因此对信号生成链路（scheduler / admin 手动触发 / 区间回放）无副作用。
 */
export async function assignSignalGrades(
  tradeDate: string,
  userId: number = SIGNAL_USER_ID,
): Promise<GradeResult> {
  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT id, strength FROM user_strategy_signal
       WHERE user_id = ? AND trade_date = ? AND is_deleted = 0 AND strength IS NOT NULL
       ORDER BY strength DESC, id ASC`,
    )
    .all(userId, tradeDate) as Array<{ id: number; strength: number }>;

  const result: GradeResult = { graded: 0, strong: 0, medium: 0, weak: 0 };
  if (rows.length === 0) return result;

  const grades = gradeSignalStrengths(
    rows.map((r) => {
      const n = Number(r.strength);
      return Number.isFinite(n) ? n : 0;
    }),
  );

  const expiryByGrade: Record<SignalGrade, string> = {
    strong: await nthTradingDayAfter(tradeDate, GRADE_TTL_TRADING_DAYS.strong),
    medium: await nthTradingDayAfter(tradeDate, GRADE_TTL_TRADING_DAYS.medium),
    weak: await nthTradingDayAfter(tradeDate, GRADE_TTL_TRADING_DAYS.weak),
  };

  const stmt = db.prepare(
    'UPDATE user_strategy_signal SET grade = ?, expires_at = ? WHERE id = ? AND user_id = ?',
  );
  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      const grade = grades[i];
      stmt.run(grade, expiryByGrade[grade], row.id, userId);
      result.graded += 1;
      result[grade] += 1;
    });
  });
  tx();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// F6 · 冷却（**仅展示层合并去重**，不改生成/交易链路，也不改回测口径）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 冷却窗口默认根数（PRD_v3 §4.1「冷却 [3] 根 K 线内不重复」）
 *
 * 可通过 `SIGNAL_COOLDOWN_BARS` 覆盖（1~20），也可由 `GET /api/signal`
 * 的 `cooldown_bars` 查询参数临时覆盖（排查/演示用）。
 */
const DEFAULT_COOLDOWN_BARS = 3;
const MAX_COOLDOWN_BARS = 20;

/** 读取冷却窗口根数（**惰性读 env**，避免模块顶层求值——CI coverage 陷阱）*/
export function resolveSignalCooldownBars(): number {
  const n = Number(process.env.SIGNAL_COOLDOWN_BARS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_COOLDOWN_BARS;
  return Math.min(MAX_COOLDOWN_BARS, Math.floor(n));
}

/** `YYYY-MM-DD` + n 个**工作日**（仅在 `cooldown_until` 缺失时做兜底窗口）*/
function addWeekdays(date: string, n: number): string {
  let cursor = date;
  let count = 0;
  while (count < n) {
    cursor = addDays(cursor, 1);
    const dow = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return cursor;
}

/**
 * 给某一交易日的全部信号回填 `cooldown_until`（F6）
 *
 * ⚠️ **只写展示判断用的列**：信号生成照旧一条不少（不因冷却而抑制），
 * 交易链路与回测口径都不读取该列。
 */
export async function assignSignalCooldowns(
  tradeDate: string,
  userId: number = SIGNAL_USER_ID,
  bars: number = resolveSignalCooldownBars(),
): Promise<{ updated: number; cooldownUntil: string }> {
  const db = ConfigStore.getInstance().db;
  const cooldownUntil = await nthTradingDayAfter(tradeDate, bars);
  const info = db
    .prepare(
      `UPDATE user_strategy_signal SET cooldown_until = ?
       WHERE user_id = ? AND trade_date = ? AND is_deleted = 0`,
    )
    .run(cooldownUntil, userId, tradeDate);
  return { updated: info.changes, cooldownUntil };
}

/** 冷却合并所需字段（`SELECT *` 行够用）*/
export interface CooldownRowFields {
  plugin_id: string;
  asset_code: string;
  direction: string;
  trade_date: string;
  created_at?: string | null;
  id?: number;
  cooldown_until?: string | null;
}

/** 合并后的展示行：附带「连续第 N 日选中」计数 */
export type CooldownCollapsed<T> = T & { consecutive_days: number };

/**
 * 展示层冷却合并去重（纯函数，便于单测）
 *
 * 口径（用户指定）：
 * - 同一 **策略 + 标的 + 方向** 的信号，在冷却窗口（默认 3 根 K 线）内合并为**一条**；
 * - 窗口判定优先用行上的 `cooldown_until`（生成时照写）；历史行无该值时
 *   用 `trade_date + bars` 个**工作日**兜底；
 * - 合并后保留**最新一条**（其分级/强度/标签即为展示值），并标注 `consecutive_days`；
 * - 输出按 `trade_date ASC, created_at ASC, id ASC` 排序（与列表契约一致）。
 */
export function collapseSignalsByCooldown<T extends CooldownRowFields>(
  rows: T[],
  bars: number = resolveSignalCooldownBars(),
): Array<CooldownCollapsed<T>> {
  const windowEndOf = (row: T): string => {
    const raw = row.cooldown_until;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return addWeekdays(row.trade_date, bars);
  };

  // 入参已按升序查询；这里再排一次保证纯函数对任意输入顺序都确定
  const ordered = [...rows].sort(
    (a, b) =>
      a.trade_date.localeCompare(b.trade_date) ||
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
      (a.id ?? 0) - (b.id ?? 0),
  );

  const active = new Map<string, { row: CooldownCollapsed<T>; end: string }>();
  const out: Array<CooldownCollapsed<T>> = [];
  const flush = (): void => {
    for (const chain of active.values()) out.push(chain.row);
    active.clear();
  };

  for (const row of ordered) {
    const key = `${row.plugin_id}|${row.asset_code}|${row.direction}`;
    const chain = active.get(key);
    if (!chain) {
      active.set(key, { row: { ...row, consecutive_days: 1 }, end: windowEndOf(row) });
      continue;
    }
    if (row.trade_date <= chain.end) {
      // 窗口内 → 合并进当前链，代表行换成最新一条，窗口顺延
      chain.row = { ...row, consecutive_days: chain.row.consecutive_days + 1 };
      const end = windowEndOf(row);
      if (end > chain.end) chain.end = end;
    } else {
      out.push(chain.row);
      active.set(key, { row: { ...row, consecutive_days: 1 }, end: windowEndOf(row) });
    }
  }
  flush();
  return out.sort(
    (a, b) =>
      a.trade_date.localeCompare(b.trade_date) ||
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
      (a.id ?? 0) - (b.id ?? 0),
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * F2 —— 信号 → 交易关联（**只做手动交易那条路**）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 口径（本轮实现钉死）：
 *   ① 关联方向：`user_strategy_signal.linked_trade_id → user_trade_record.id`
 *      （字段在**信号表**上指向成交记录，不是交易表反指信号）
 *   ② 纸面账户的自关联（纸面账本内的 `signal_id`）**不复用、不改动**
 *   ③ 关联**可选**：交易录入不传 `signal_id` 时照常落库
 *   ④ 一条成交可被**多条**信号关联（成交是事实，信号是判断）——
 *      采纳率的分母是「信号」，不会因多对一而重复计数
 *   ⑤ 同一条信号只能指向**一条**成交；改指向需显式 `overwrite`
 *   ⑥ 成交被软删 → 关联视为**断链**（`link_broken`），不静默当作已成交
 */

/** 信号的处理状态（展示派生，不落库） */
export type SignalTradeStatus = 'traded' | 'ignored' | 'adopted' | 'pending';

/** 状态 → 中文文案（前端与后端共用同一套字面量） */
export const SIGNAL_TRADE_STATUS_LABEL: Record<SignalTradeStatus, string> = {
  traded: '已成交',
  ignored: '已忽略',
  adopted: '已采纳',
  pending: '未处理',
};

/** 派生状态所需的最小字段集（列表行 / 详情行都满足） */
export interface SignalLinkFields {
  adopted?: number | null;
  ignored?: number | null;
  linked_trade_id?: number | null;
}

/** 列表行补充的关联信息 */
export interface SignalLinkAnnotation {
  trade_status: SignalTradeStatus;
  /** `linked_trade_id` 指向的成交已被软删 / 不存在（关联断链） */
  link_broken: boolean;
}

/**
 * 派生单行状态（优先级：已成交 > 已忽略 > 已采纳 > 未处理）
 *
 * ⚠️ 断链时**不算已成交** —— 否则用户会看到「已成交」但点不开任何成交记录。
 */
export function deriveSignalTradeStatus(row: SignalLinkFields, linkBroken = false): SignalTradeStatus {
  const linkId = row.linked_trade_id;
  if (!linkBroken && typeof linkId === 'number' && linkId > 0) return 'traded';
  if (row.ignored === 1) return 'ignored';
  if (row.adopted === 1) return 'adopted';
  return 'pending';
}

/**
 * 批量给信号列表行补 `trade_status` / `link_broken`
 *
 * 用**一次 IN 查询**判定关联成交是否存活（不逐行查，避免 N+1）。
 */
export function annotateSignalTradeStatus<T extends SignalLinkFields>(
  rows: T[],
  userId: number,
): Array<T & SignalLinkAnnotation> {
  const ids = Array.from(
    new Set(rows.map((r) => r.linked_trade_id).filter((v): v is number => typeof v === 'number' && v > 0)),
  );
  const live = new Set<number>();
  if (ids.length > 0) {
    const db = ConfigStore.getInstance().db;
    const placeholders = ids.map(() => '?').join(',');
    const found = db
      .prepare(
        `SELECT id FROM user_trade_record
         WHERE user_id = ? AND is_deleted = 0 AND id IN (${placeholders})`,
      )
      .all(userId, ...ids) as Array<{ id: number }>;
    for (const r of found) live.add(r.id);
  }
  return rows.map((row) => {
    const linkId = row.linked_trade_id;
    const broken = typeof linkId === 'number' && linkId > 0 && !live.has(linkId);
    return { ...row, trade_status: deriveSignalTradeStatus(row, broken), link_broken: broken };
  });
}

/** 交易类型 → 方向（7 类交易：买入类 / 卖出类 / 权益类） */
export function tradeTypeDirection(tradeType: string): 'buy' | 'sell' | 'other' {
  if (tradeType === 'buy' || tradeType === 'add') return 'buy';
  if (tradeType === 'reduce' || tradeType === 'clear') return 'sell';
  return 'other';
}

/** 关联成交的展示字段（金额 / 方向 / 成交日 / 盈亏） */
export interface LinkedTradeSummary {
  id: number;
  asset_code: string;
  trade_type: string;
  direction: 'buy' | 'sell' | 'other';
  trade_date: string;
  trade_time: string | null;
  quantity: number;
  price: number;
  fee: number;
  /** 成交金额 = quantity * price（不含费用） */
  amount: number;
  /**
   * 已实现盈亏：仅**平仓类**（reduce / clear）可得（复用 `calcClosedTradePnLs` 口径）；
   * 买入类尚未卖出 → null（不臆造未实现盈亏）
   */
  realized_pnl: number | null;
}

/** `GET /api/signal/:id/linked-trade` 的响应体 */
export interface SignalTradeLinkView {
  signal_id: number;
  asset_code: string;
  trade_date: string;
  direction: string;
  linked_trade_id: number | null;
  trade_status: SignalTradeStatus;
  link_broken: boolean;
  trade: LinkedTradeSummary | null;
}

/** 按信号 id 取关联成交详情（信号不存在返回 null） */
export function getSignalTradeLink(userId: number, signalId: number): SignalTradeLinkView | null {
  const db = ConfigStore.getInstance().db;
  const signal = db
    .prepare(
      `SELECT id, asset_code, trade_date, direction, adopted, ignored, linked_trade_id
       FROM user_strategy_signal
       WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    )
    .get(signalId, userId) as
    | (SignalLinkFields & {
        id: number;
        asset_code: string;
        trade_date: string;
        direction: string;
      })
    | undefined;
  if (!signal) return null;

  const linkId = signal.linked_trade_id;
  if (typeof linkId !== 'number' || linkId <= 0) {
    return {
      signal_id: signal.id,
      asset_code: signal.asset_code,
      trade_date: signal.trade_date,
      direction: signal.direction,
      linked_trade_id: null,
      trade_status: deriveSignalTradeStatus(signal),
      link_broken: false,
      trade: null,
    };
  }

  const trade = db
    .prepare(
      `SELECT id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee
       FROM user_trade_record
       WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    )
    .get(linkId, userId) as
    | {
        id: number;
        asset_code: string;
        trade_type: string;
        trade_date: string;
        trade_time: string | null;
        quantity: number;
        price: number;
        fee: number;
      }
    | undefined;

  if (!trade) {
    return {
      signal_id: signal.id,
      asset_code: signal.asset_code,
      trade_date: signal.trade_date,
      direction: signal.direction,
      linked_trade_id: linkId,
      trade_status: deriveSignalTradeStatus(signal, true),
      link_broken: true,
      trade: null,
    };
  }

  const closed = trade.trade_type === 'reduce' || trade.trade_type === 'clear';
  const realized = closed
    ? (calcClosedTradePnLs(userId).find((c) => c.trade_id === trade.id)?.realized_pnl ?? null)
    : null;

  return {
    signal_id: signal.id,
    asset_code: signal.asset_code,
    trade_date: signal.trade_date,
    direction: signal.direction,
    linked_trade_id: linkId,
    trade_status: 'traded',
    link_broken: false,
    trade: {
      ...trade,
      direction: tradeTypeDirection(trade.trade_type),
      amount: trade.quantity * trade.price,
      realized_pnl: realized,
    },
  };
}
