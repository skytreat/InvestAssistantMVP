/**
 * T129（V3.2）券商补录 —— SDD_v3 §9.3 / Requirements INV-S2-33~36、INV-S3-6~9
 *
 * 契约：
 * - 补录必须**显式确认**（导入端点不自动写业务层，INV-S2-33）；本服务只被 /confirm 端点调用
 * - 交易类型由系统推导 + 用户可修正（INV-S3-9：修正后不再被自动覆盖 —— 仅在 confirm 时刻生效一次，
 *   落库后不自动重算）
 * - 成交时间缺失留空（INV-S2-36），**不得填假时间**：无法解析的时间一律 NULL
 * - 可回溯：user_trade_record.source_broker_record_id ← broker_trade_record.id（INV-S2-34）
 * - 撤销只软删业务层（既有 /api/trade/:id/soft-delete），事实层永不删除（INV-S2-35）
 * - 一次确认整体一个事务，部分失败全回滚（INV-S2 契约；G5）
 *
 * 推导规则（Requirements §3.2）：
 * - 有「证券余额」（balance_after）→ 单行判定：卖&余额0=清仓；卖&余额>0=减仓；
 *   买&余额=量=建仓；买&余额>量=加仓（INV-S3-7）
 * - 无余额 → 按时间顺序回放该标的在该券商的**全部**可补录流水（INV-S3-2/3/8），
 *   已映射的历史行也参与回放（其推导结果早已冻结，本服务只为新行取值）
 * - 推导**必须按券商分组**（INV-S3-3：各券商持仓互不影响）
 */
import type Database from 'better-sqlite3';
import { queryDuckDB } from '../../db/duckdb.js';

/**
 * 补录事件 → 业务类型的**唯一判定点**（owner 可能调整口径时只改这一处）。
 *
 * - 成交族（buy/add/reduce/clear）由净持仓回放推导；
 * - 非成交族直接映射固定类型，不参与 buy/add 推导：
 *   - TRANSFER_IN    → transfer（Requirements §5.1「转增」：数量增加、成本基不变）
 *   - DIVIDEND_BONUS → bonus（同上）
 *   - DIVIDEND_CASH  → dividend（不改股数/成本，只用于「实际口径」加回分红）
 * - 其它（REPO / EXCLUDED_OFFEXCHANGE / PLACEHOLDER / IGNORE）→ 不进业务层（INV-S3-5）
 *
 * ⚠️ 若要「破例」把场外申购建成 transfer（4 只 LOF 的场景），只需在本表加一行
 *    `EXCLUDED_OFFEXCHANGE: 'transfer'`（并把该行从 match_status=EXCLUDED 的过滤中放行），
 *    其余补录/回放逻辑无需改动。
 */
const TRADE_EVENTS = new Set<string>(['TRADE_BUY', 'TRADE_SELL', 'FUND_SUBSCRIBE', 'FUND_REDEEM']);
const SELL_EVENTS = new Set<string>(['TRADE_SELL', 'FUND_REDEEM']);
const FIXED_EVENT_TRADE_TYPE: Readonly<Record<string, BusinessTradeType>> = {
  TRANSFER_IN: 'transfer',
  DIVIDEND_BONUS: 'bonus',
  DIVIDEND_CASH: 'dividend',
};
/** 非成交族（转入 / 送股 / 现金分红）—— 对账页需单独成分类展示并允许补录 */
export const NON_TRADE_EVENTS: readonly string[] = Object.keys(FIXED_EVENT_TRADE_TYPE);
export const CONFIRMABLE_EVENTS: readonly string[] = [...TRADE_EVENTS, ...NON_TRADE_EVENTS];

/** 该事件是否进业务层 */
export function shouldPromote(eventType: string): boolean {
  return TRADE_EVENTS.has(eventType) || FIXED_EVENT_TRADE_TYPE[eventType] !== undefined;
}

/** 非成交族的固定业务类型；成交族与不补录事件均返回 null（交回放推导 / 不补录） */
export function fixedTradeTypeOf(eventType: string): BusinessTradeType | null {
  return FIXED_EVENT_TRADE_TYPE[eventType] ?? null;
}

/** 用户可修正的 trade_type 白名单（buttonApply = 成交族 4 种；其他 3 种不在补录范围） */
export const CONFIRMABLE_TRADE_TYPES = ['buy', 'add', 'reduce', 'clear'] as const;
export type ConfirmTradeType = (typeof CONFIRMABLE_TRADE_TYPES)[number];

/** 补录写入业务层的全部类型（成交族 4 种 + 非成交族 3 种） */
export type BusinessTradeType = ConfirmTradeType | 'dividend' | 'bonus' | 'transfer';

export interface ConfirmItem {
  sourceId: number;
  tradeType?: string;
}

export interface ConfirmResultRow {
  sourceId: number;
  status: 'imported' | 'already' | 'invalid' | 'manual_sheet';
  tradeType: BusinessTradeType | null;
  tradeRecordId?: number;
  reason?: string;
}

export interface ConfirmResult {
  brokerCode: string;
  imported: number;
  already: number;
  invalid: number;
  rows: ConfirmResultRow[];
}

interface FactRow {
  id: number;
  event_type: string;
  asset_code: string | null;
  trade_date: string | null;
  trade_time: string | null;
  price: number | null;
  quantity: number | null;
  /** 发生金额（红利行可能只给这个） */
  cash_flow?: number | null;
  balance_after: number | null;
  fee_total: number | null;
  match_status: string;
  source_kind: string;
  source_row_no: number | null;
  content_seq: number | null;
  /** 手工标记时的关联记录；补录写入后指向被写入的那条（撤销后仍保留该 id） */
  matched_trade_record_id?: number | null;
}

/** 日期 → 'YYYY-MM-DD'（兼容 YYYYMMDD / YYYY-MM-DD；事实层原始格式两券商并存，见 D-21） */
function normalizeDate(d: string | null): string | null {
  if (!d) return null;
  if (d.includes('-') && d.length === 10) return d;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * 成交时间归一（INV-S2-36：不填假时间）：
 * - 'HH:mm:ss' / 'HH:mm' → 补秒；'HHmmss' / 数字 5~6 位 → 拆解；
 * - 空串 / 无法解析 → **NULL**（绝不猜）
 */
function normalizeTime(t: string | null): string | null {
  if (!t) return null;
  const s = String(t).trim();
  let m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    if (h < 24 && Number(m[2]) < 60 && Number(m[3]) < 60) {
      return `${String(h).padStart(2, '0')}:${m[2]}:${m[3]}`;
    }
    return null;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    if (h < 24 && Number(m[2]) < 60) return `${String(h).padStart(2, '0')}:${m[2]}:00`;
    return null;
  }
  m = /^(\d{2})(\d{2})(\d{2})$/.exec(s) ?? /^(\d)(\d{2})(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    if (h < 24 && Number(m[2]) < 60 && Number(m[3]) < 60) {
      return `${String(h).padStart(2, '0')}:${m[2]}:${m[3]}`;
    }
  }
  return null;
}

/** 排序键：date, time（NULL 视为最大 => 排最后；同键按事实 id，等于批次内出现序，INV-S3-8） */
function sortKey(r: FactRow): string {
  const t = r.trade_time?.trim() ? r.trade_time : '99:99:99';
  return `${r.trade_date ?? ''}|${t}|${r.id}`;
}

/** 单行判定（INV-S3-7，balance_after 存在时的权威口径） */
function deriveFromBalance(eventType: string, dir: 1 | -1, qty: number, bal: number): ConfirmTradeType {
  if (dir === -1) return bal === 0 ? 'clear' : 'reduce';
  // dir === 1：买 & 余额==量 → 建仓；余额>量 → 加仓（余额 < 量 = 异常，保守按建仓）
  return bal <= qty ? 'buy' : 'add';
}

/**
 * 一行事实对「券商内净持仓」的影响（INV-S3-3 回放口径）。
 *
 * 成交买 / 场外申购 / 调帐转入 / 送股 → 增加；成交卖 / 场外赎回 → 减少；
 * 红利不改变股数（数量列是分红基数，不能当持仓增量）。
 */
function netQtyDelta(r: FactRow): number {
  const qty = r.quantity ?? 0;
  if (r.event_type === 'DIVIDEND_CASH') return 0;
  if (SELL_EVENTS.has(r.event_type)) return -qty;
  if (shouldPromote(r.event_type)) return qty;
  return 0;
}

/**
 * 推导一个 (user, broker, asset) 范围内若干事实行的 trade_type。
 *
 * @param allRows 该标的在该券商**全部**可补录事实（含已映射行与非成交族，INV-S3-2/3），
 *                已按 sortKey 升序
 * @param targetIds 本次要确认的事实 id 集合
 * @param overrides 用户修正（sourceId → tradeType），修正优先（INV-S3-9）
 * @returns sourceId → tradeType（仅成交族）
 */
export function deriveTradeTypes(
  allRows: FactRow[],
  targetIds: Set<number>,
  overrides: Map<number, ConfirmTradeType>,
): Map<number, ConfirmTradeType> {
  const out = new Map<number, ConfirmTradeType>();
  let netQty = 0; // 券商内回放持仓（INV-S3-3）：从该券商流水**起点**回放
  for (const r of allRows) {
    // 非成交族（transfer/bonus/dividend）不推导 buy/add，只参与净持仓回放
    if (TRADE_EVENTS.has(r.event_type)) {
      const qty = r.quantity ?? 0;
      const dir = SELL_EVENTS.has(r.event_type) ? -1 : 1;
      // ① 用户修正优先（INV-S3-9）：修正后**不再被自动覆盖**
      if (targetIds.has(r.id) && overrides.has(r.id)) {
        out.set(r.id, overrides.get(r.id)!);
      } else if (r.balance_after != null && r.quantity != null) {
        // ② 单行判定（有证券余额 = 权威口径）
        const derived = deriveFromBalance(r.event_type, dir, r.quantity, r.balance_after);
        if (targetIds.has(r.id)) out.set(r.id, derived);
      } else {
        // ③ 回放判定（无余额）
        const derived: ConfirmTradeType =
          dir === 1 ? (netQty > 0 ? 'add' : 'buy') : netQty - qty > 0 ? 'reduce' : 'clear';
        if (targetIds.has(r.id)) out.set(r.id, derived);
      }
    }
    netQty += netQtyDelta(r);
  }
  return out;
}

function loadFactRows(db: Database.Database, userId: number, brokerCode: string): FactRow[] {
  const placeholders = CONFIRMABLE_EVENTS.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, event_type, asset_code, trade_date, trade_time, price, quantity, amount, cash_flow,
              balance_after, fee_total, match_status, source_kind, source_row_no, content_seq,
              matched_trade_record_id
         FROM broker_trade_record
        WHERE user_id = ? AND broker_code = ? AND is_deleted = 0
          AND event_type IN (${placeholders})
          AND match_status != 'EXCLUDED'`,
    )
    .all(userId, brokerCode, ...CONFIRMABLE_EVENTS) as unknown as FactRow[];
}

/**
 * 红利现金额：优先 `cash_flow`（发生金额），否则 `price × quantity`。
 * 华宝成交单有 3 行红利只给了发生金额，明细列（价格/数量）为空。
 */
function dividendCash(r: FactRow): number {
  if (r.cash_flow != null && r.cash_flow > 0) return r.cash_flow;
  return (r.price ?? 0) * (r.quantity ?? 0);
}

/** 业务层落库的 (quantity, price, fee) —— 按业务类型取值 */
function businessValues(
  r: FactRow,
  type: BusinessTradeType,
): { quantity: number; price: number; fee: number } {
  switch (type) {
    case 'transfer':
    case 'bonus':
      // 送股 / 份额拆分 / 调账转入：增加股数，成本基不变 ⇒ price = 0（移动加权里保持总成本不变）
      //
      // ⚠️ 2026-11-06 实测（真实库 4 条 transfer 事实行 71/361/366/375）：
      // 券商标识为「调帐转入」，但原始备注列明确是 **「份额拆分」/「股份调账」**，
      // 且 tdx2db 复权因子在对应日期恰好翻倍（sz159516 3/31 1→2、sh515880 7/6 3→6…）。
      // 即这些行是**拆分/调账的股数增量**，不是外部券商仓位转入 —— 按转入日收盘价计成本
      // 会让已实现盈亏从 -88,946.66 恶化到 -298,240.85（未复权）/ -189,747.47（前复权），
      // 属重复计价。故**保持 price = 0**。仅当出现真正的跨券商过户（备注无「拆分/调账」）时
      // 才应改为按当日收盘价入账，且必须先取得该笔的外部成本证据。
      return { quantity: r.quantity ?? 0, price: 0, fee: 0 };
    case 'dividend': {
      // 分红：必须保证 price × quantity == 现金分红（「实际口径」按该乘积加回）
      const qty = r.quantity ?? 0;
      const price = r.price ?? 0;
      if (qty > 0 && price > 0) return { quantity: qty, price, fee: 0 };
      return { quantity: 1, price: Math.round(dividendCash(r) * 10000) / 10000, fee: 0 };
    }
    default:
      return { quantity: r.quantity ?? 0, price: r.price ?? 0, fee: r.fee_total ?? 0 };
  }
}

/** 事实行可补录性检查（INV-S2-44：manual_sheet 不进业务层；缺关键字段的行不可补） */
function inabilityReason(r: FactRow): string | null {
  if (r.source_kind !== 'broker') return 'manual_sheet 来源不可补录（INV-S2-44）';
  if (r.match_status === 'EXCLUDED') return '该行已被排除（场外/占位）';
  if (!shouldPromote(r.event_type)) return `该事件类型不进业务层：${r.event_type}`;
  if (!r.asset_code) return '事实行缺标的代码';
  if (!r.trade_date) return '事实行缺成交日期';
  const fixed = fixedTradeTypeOf(r.event_type);
  if (fixed === 'transfer' || fixed === 'bonus') {
    return r.quantity != null && r.quantity > 0 ? null : '事实行缺数量或数量非法';
  }
  if (fixed === 'dividend') {
    return dividendCash(r) > 0 ? null : '事实行缺分红金额';
  }
  if (r.quantity == null || r.quantity <= 0) return '事实行缺数量或数量非法';
  if (r.price == null || r.price < 0) return '事实行缺价格或价格非法';
  return null;
}

/**
 * 批量补录（一次确认 = 一个事务；部分失败整体回滚）。
 * 已被映射（source 已有活记录）的行 → 'already'，不插入（回溯幂等，G3）。
 */
export async function confirmTrades(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  items: ConfirmItem[],
): Promise<ConfirmResult> {
  const rows: ConfirmResultRow[] = [];
  const result: ConfirmResult = { brokerCode, imported: 0, already: 0, invalid: 0, rows };

  const requested = new Map<number, ConfirmItem>();
  for (const it of items) requested.set(Number(it.sourceId), it);
  const targetIds = new Set(requested.keys());

  // 载入该券商全部可补录成交事实（含已映射）——推导/回放的完整视角
  const allRows = loadFactRows(db, userId, brokerCode).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const byId = new Map(allRows.filter((r) => targetIds.has(r.id)).map((r) => [r.id, r]));

  // 已映射行 → already（在**事务外**读一次 + 事务内再查一次，防竞态漏判）
  const liveAnchors = db
    .prepare(
      `SELECT source_broker_record_id AS sid FROM user_trade_record
        WHERE user_id = ? AND is_deleted = 0
          AND source_broker_record_id IN (${[...targetIds].map(() => '?').join(',') || 'NULL'})`,
    )
    .all(userId, ...targetIds) as Array<{ sid: number }>;
  const alreadyIds = new Set(liveAnchors.map((x) => Number(x.sid)));

  /**
   * UX-02 / Q7：成交族（TRADE_*、FUND_*）被「标记为已手工记录」且未关联任何记录
   * （`matched_trade_record_id IS NULL`，即 `/diff/:id/match` 的默认结果）→ 视为 already，
   * 拒绝再次补录，否则同一事实行会对应两条活记录。
   *
   * 注意不能用「MATCHED 即拦截」：补录写入后事实行也是 MATCHED；若其业务记录被软删
   * （撤销），用户必须还能重新补录（G3 回溯幂等）。撤销时 matched_trade_record_id
   * 仍指向那条已删记录，故与本条判据天然区分。
   * 非成交族（transfer / bonus / dividend）不参与该拦截（Q7）。
   */
  const markedManualTradeIds = new Set<number>();
  for (const [id, fact] of byId) {
    if (
      !alreadyIds.has(id) &&
      fact.match_status === 'MATCHED' &&
      TRADE_EVENTS.has(fact.event_type) &&
      (fact.matched_trade_record_id ?? null) === null
    ) {
      markedManualTradeIds.add(id);
    }
  }

  // 分组回放（INV-S3-3）：按 asset 分桶
  const overrides = new Map<number, ConfirmTradeType>();
  for (const it of items) {
    const t = it.tradeType;
    if (t != null) {
      if (!(CONFIRMABLE_TRADE_TYPES as readonly string[]).includes(t)) {
        result.invalid++;
        rows.push({
          sourceId: it.sourceId,
          status: 'invalid',
          tradeType: null,
          reason: `tradeType 修正值非法：${t}`,
        });
      } else {
        overrides.set(it.sourceId, t as ConfirmTradeType);
      }
    }
  }

  // 请求里指向「不进业务层」或根本不存在的事实行 → invalid（显式告知，不静默吞掉）
  const missing = [...targetIds].filter((id) => !byId.has(id) && !alreadyIds.has(id));
  if (missing.length > 0) {
    const info = db
      .prepare(
        `SELECT id, event_type, match_status, is_deleted FROM broker_trade_record
          WHERE user_id = ? AND id IN (${missing.map(() => '?').join(',')})`,
      )
      .all(userId, ...missing) as Array<{
      id: number;
      event_type: string;
      match_status: string;
      is_deleted: number;
    }>;
    const infoById = new Map(info.map((x) => [x.id, x]));
    for (const id of missing) {
      const f = infoById.get(id);
      const reason =
        !f || f.is_deleted
          ? '事实行不存在或已撤销'
          : f.match_status === 'EXCLUDED'
            ? '该行已被排除（场外/占位）'
            : `该事件类型不进业务层：${f.event_type}`;
      result.invalid++;
      rows.push({ sourceId: id, status: 'invalid', tradeType: null, reason });
    }
  }

  const buckets = new Map<string, FactRow[]>();
  for (const r of allRows) {
    if (!r.asset_code) continue;
    const arr = buckets.get(r.asset_code);
    if (arr) arr.push(r);
    else buckets.set(r.asset_code, [r]);
  }

  // 存在性判定源：DuckDB raw_symbol_class（覆盖 raw_kline_daily 全部标的）；
  // symbol_dict 只做名称联想搜索，**不做存在性判定**。
  // 行情库不可读时**降级跳过校验**（与既有「字典未同步则放行」语义一致），不误拒。
  let dictSet: Set<string> | null = null;
  try {
    const symbols = await queryDuckDB<{ symbol: string }>(
      `SELECT symbol FROM raw_symbol_class WHERE class <> 'block'`,
    );
    dictSet = new Set(symbols.map((r) => r.symbol));
  } catch {
    dictSet = null;
  }

  const pending: Array<{ fact: FactRow; type: BusinessTradeType }> = [];
  for (const fact of byId.values()) {
    if (alreadyIds.has(fact.id) || markedManualTradeIds.has(fact.id)) continue;
    const reason = inabilityReason(fact);
    if (reason) {
      result.invalid++;
      rows.push({
        sourceId: fact.id,
        status: reason.includes('manual_sheet') ? 'manual_sheet' : 'invalid',
        tradeType: null,
        reason,
      });
      continue;
    }
    if (dictSet !== null && dictSet.size > 0 && fact.asset_code && !dictSet.has(fact.asset_code)) {
      result.invalid++;
      rows.push({
        sourceId: fact.id,
        status: 'invalid',
        tradeType: null,
        reason: `标的不存在于行情层：${fact.asset_code}`,
      });
      continue;
    }
    // 非成交族（transfer/bonus/dividend）直接定类型；成交族先占位，下方按桶推导
    const fixed = fixedTradeTypeOf(fact.event_type);
    pending.push({ fact, type: fixed ?? 'buy' });
  }

  for (const [, bucket] of buckets) {
    const ids = new Set(bucket.map((r) => r.id));
    const derived = deriveTradeTypes(bucket, ids, overrides);
    for (const p of pending) {
      if (!TRADE_EVENTS.has(p.fact.event_type)) continue; // 非成交族类型已定
      const got = derived.get(p.fact.id);
      if (got !== undefined) p.type = got;
    }
  }

  // ── 事务（G5：一次确认整体一个事务，部分失败全回滚）──
  const insertTrade = db.prepare(
    `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
        trade_reason, is_auto_import, is_deleted, broker_code, broker_seq, source_broker_record_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '券商补录', 1, 0, ?, ?, ?)`,
  );
  const markFact = db.prepare(
    `UPDATE broker_trade_record SET match_status = 'MATCHED', matched_trade_record_id = ?
      WHERE id = ? AND user_id = ? AND match_status != 'EXCLUDED'`,
  );
  const reCheckAnchor = db.prepare(
    `SELECT 1 AS x FROM user_trade_record
      WHERE user_id = ? AND is_deleted = 0 AND source_broker_record_id = ? LIMIT 1`,
  );

  const run = db.transaction(() => {
    for (const { fact, type } of pending) {
      // 事务内复检（同事务内已插入行也会被本查看到 ⇒ 防同批 sourceId 重复传入）
      if (reCheckAnchor.get(userId, fact.id)) continue;
      const { quantity, price, fee } = businessValues(fact, type);
      const info = insertTrade.run(
        userId,
        fact.asset_code,
        type,
        normalizeDate(fact.trade_date),
        normalizeTime(fact.trade_time),
        quantity,
        price,
        fee,
        brokerCode, // broker_code（INV-S3-1：借记所属券商）
        fact.content_seq ?? 0, // broker_seq == 事实层 content_seq
        fact.id, // source_broker_record_id（G3 回溯）
      );
      const tradeId = Number(info.lastInsertRowid);
      markFact.run(tradeId, fact.id, userId);
      result.imported++;
      rows.push({ sourceId: fact.id, status: 'imported', tradeType: type, tradeRecordId: tradeId });
    }
  });
  run();
  // 'already' 状态行统一补入（outside tx：纯读）
  for (const id of alreadyIds) {
    result.already++;
    rows.push({
      sourceId: id,
      status: 'already',
      tradeType: overrides.get(id) ?? null,
      reason: '该事实行已有活记录（可回溯 source_broker_record_id）',
    });
  }
  // UX-02/Q7：成交族已「标记为已手工记录」→ 同样回填 already 结果行（不静默跳过）
  const reportedIds = new Set(rows.map((r) => r.sourceId));
  for (const id of markedManualTradeIds) {
    if (alreadyIds.has(id) || reportedIds.has(id)) continue;
    result.already++;
    rows.push({
      sourceId: id,
      status: 'already',
      tradeType: overrides.get(id) ?? null,
      reason: '该事实行已被标记为「已手工记录」，成交族不再重复补录',
    });
  }
  result.rows.sort((a, b) => a.sourceId - b.sourceId);
  return result;
}

/**
 * 「标记为已手工记录」（SDD_v3 §9.3 /diff/:id/match）：
 * 把事实行 MATCHED 并可选关联到既有 user_trade_record（业务层不动，事实层不动）。
 * 仅fact一行；tradeRecordId 若给，须属当前用户且 asset 匹配（防错关联）。
 */
export function markAsManuallyRecorded(
  db: Database.Database,
  userId: number,
  factId: number,
  tradeRecordId: number | null,
): { ok: boolean; reason?: string } {
  const fact = db
    .prepare(
      `SELECT id, asset_code, match_status, source_kind FROM broker_trade_record
        WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    )
    .get(factId, userId) as
    { id: number; asset_code: string | null; match_status: string; source_kind: string } | undefined;
  if (!fact) return { ok: false, reason: 'NOT_FOUND：事实行不存在或已撤销' };
  if (fact.source_kind !== 'broker') return { ok: false, reason: 'manual_sheet 来源不可标记（INV-S2-44）' };
  if (fact.match_status === 'EXCLUDED') return { ok: false, reason: '该行已被排除，无需标记' };

  if (tradeRecordId != null) {
    const rec = db
      .prepare(`SELECT id, asset_code FROM user_trade_record WHERE id = ? AND user_id = ? AND is_deleted = 0`)
      .get(tradeRecordId, userId) as { id: number; asset_code: string } | undefined;
    if (!rec) return { ok: false, reason: 'trade_record 不存在或不属于当前用户' };
    if (fact.asset_code && rec.asset_code !== fact.asset_code) {
      return { ok: false, reason: `标的不一致：事实层 ${fact.asset_code} vs 业务层 ${rec.asset_code}` };
    }
  }
  db.prepare(
    `UPDATE broker_trade_record SET match_status = 'MATCHED', matched_trade_record_id = ?
      WHERE id = ? AND user_id = ?`,
  ).run(tradeRecordId, factId, userId);
  return { ok: true };
}
