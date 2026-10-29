/**
 * T126（V3.1）对账报告 + 差额归因 —— SDD_v3 §9.2 / INV-S2-62~65
 *
 * 强制（Requirements §2.6.3）：
 * - 归因逐项（逆回购 / 货币 ETF / 分红 / 场外 / 未覆盖期间 / 口径差异 / 真实残差），**可下钻**
 * - **不得用「其他 / 未知」兜底**；无法解释的残差（residual）单独置顶
 * - 覆盖区间醒目声明（区间外不构成「已核对」）
 *
 * D-25：`/api/broker-reconcile/latest` 按需重算（事实层为唯一真相源，重算幂等；
 * MVP 规模性能达标，不引入报告表 —— 持久化报告属 T132 后视性能再定）。
 * returnSummary 为两口径占位版（现金类 = 逆回购利息；风险类 = 0，T132 实装），
 * 货币 ETF 市值收益需行情上下文，未计入。
 */
import type Database from 'better-sqlite3';
import { runFundCheck, type FundCheckResult } from './brokerFundCheck.js';
import { modelRepoCashFlow, type RepoModelResult } from './brokerCashModel.js';
import type { BackfillResult } from './brokerReconcile.js';

export interface ReconcileReport {
  brokerCode: string;
  coveredRange: { from: string; to: string };
  coverageNote: string;
  matchSummary: {
    factRows: number;
    matched: number;
    fuzzy: number;
    missing: number;
    extra: number;
  };
  attribution: {
    repo: number;
    cashLikeEtf: number;
    dividend: number;
    offExchange: number;
    uncoveredPeriod: number;
    caliberDiff: number;
    residual: number;
    order: Array<
      'residual' | 'repo' | 'cashLikeEtf' | 'dividend' | 'offExchange' | 'uncoveredPeriod' | 'caliberDiff'
    >;
  };
  fundCheck: FundCheckResult;
  timeBackfill: BackfillResult;
  repoModel: RepoModelResult;
  returnSummary: { risk: number; cash: number; total: number; note: string };
  generatedAt: string;
}

/**
 * 系统层（user_trade_record）与事实层的粗匹配（asset_code + trade_date 家族），精确匹配归 T129
 *
 * 🔴 **日期归一化**（2026-10-27 修复）：
 *    `broker_trade_record.trade_date` 因导入文件类型不同可能存 `YYYYMMDD`（交割单）或
 *    `YYYY-MM-DD`（成交流水），而 `user_trade_record.trade_date` 恒为 `YYYY-MM-DD`。
 *    匹配前统一用 `fmtDate()` 归一化为 `YYYY-MM-DD`，否则同一笔交易在两侧 key 不同，
 *    产生对称的「缺失 + 多余」误报。
 */
function matchVsSystem(
  db: Database.Database,
  userId: number,
  brokerCode: string,
): { missing: number; extra: number } {
  const dictCount = (db.prepare('SELECT COUNT(*) c FROM symbol_dict').get() as { c: number }).c;
  const validAssetSql = dictCount > 0 ? `AND asset_code IN (SELECT symbol FROM symbol_dict)` : '';

  const factKeys = db
    .prepare(
      `SELECT DISTINCT b.asset_code, b.trade_date
         FROM broker_trade_record b JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0
          AND b.match_status != 'EXCLUDED'
          AND b.event_type IN ('TRADE_BUY','TRADE_SELL','FUND_SUBSCRIBE','FUND_REDEEM')
          ${validAssetSql}`,
    )
    .all(userId, brokerCode) as Array<{ asset_code: string; trade_date: string }>;
  const sysKeys = db
    .prepare(
      `SELECT DISTINCT asset_code, trade_date FROM user_trade_record
        WHERE user_id = ? AND is_deleted = 0
          AND trade_type IN ('buy','add','reduce','clear','dividend','bonus')
          ${validAssetSql}`,
    )
    .all(userId) as Array<{ asset_code: string; trade_date: string }>;
  const factSet = new Set(factKeys.map((k) => `${k.asset_code}|${fmtDate(k.trade_date)}`));
  const sysSet = new Set(sysKeys.map((k) => `${k.asset_code}|${fmtDate(k.trade_date)}`));
  let missing = 0;
  let extra = 0;
  for (const k of factSet) if (!sysSet.has(k)) missing++;
  for (const k of sysSet) if (!factSet.has(k)) extra++;
  return { missing, extra };
}

/** 日期归一化：`YYYYMMDD` → `YYYY-MM-DD`；已含横杠则原样返回；空 → 空串 */
function fmtDate(d: string | null): string {
  if (!d) return '';
  if (d.includes('-')) return d;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/**
 * 纯读取报告构建（不修改数据库），供 /latest 端点使用。
 * 幂等：同一用户/券商多次调用结果一致。
 */
export function buildReconcileReport(
  db: Database.Database,
  userId: number,
  brokerCode: string,
): ReconcileReport {
  // ① 系统层粗匹配
  const { missing, extra } = matchVsSystem(db, userId, brokerCode);

  const statusCounts = db
    .prepare(
      `SELECT match_status, COUNT(*) n FROM broker_trade_record
        WHERE user_id = ? AND broker_code = ? AND is_deleted = 0
        GROUP BY match_status`,
    )
    .all(userId, brokerCode) as Array<{ match_status: string; n: number }>;
  const sc: Record<string, number> = {};
  for (const row of statusCounts) sc[row.match_status] = row.n;
  const factRows = statusCounts.reduce((s, x) => s + x.n, 0);

  // ② 归因统计（只读，按事件类型累加 cash_flow 绝对值）
  const catSum = (types: string[]): number => {
    const ph = types.map(() => '?').join(',');
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(ABS(COALESCE(cash_flow, 0))), 0) AS s FROM broker_trade_record
          WHERE user_id = ? AND broker_code = ? AND is_deleted = 0 AND event_type IN (${ph})`,
      )
      .get(userId, brokerCode, ...types) as { s: number };
    return Number(r.s);
  };
  const repoVal = catSum(['REPO']);
  const cashLikeEtfVal = catSum(['CASH_LIKE_ETF']);
  const dividendVal = catSum(['DIVIDEND_CASH']);
  const offExchangeVal = catSum(['EXCLUDED_OFFEXCHANGE', 'PLACEHOLDER', 'IGNORE']);
  const unknownVal = catSum(['UNKNOWN']);

  // ③ 回填状态快照（只读：统计 trade_time 填充情况，不落库）
  const totalNeededRow = db
    .prepare(
      `SELECT COUNT(*) n FROM broker_trade_record b
         JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0
          AND f.file_kind = 'settlement' AND b.event_type IN ('TRADE_BUY','TRADE_SELL')`,
    )
    .get(userId, brokerCode) as { n: number };
  const hasTimeRow = db
    .prepare(
      `SELECT COUNT(*) n FROM broker_trade_record b
         JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0
          AND f.file_kind = 'settlement' AND b.event_type IN ('TRADE_BUY','TRADE_SELL')
          AND b.trade_time IS NOT NULL`,
    )
    .get(userId, brokerCode) as { n: number };
  const totalNeeded = Number(totalNeededRow.n);
  const filled = Number(hasTimeRow.n);
  const timeBackfill: BackfillResult = {
    totalNeeded,
    matched: filled,
    byLevel: { L1: 0, L2: 0, L3: 0 },
    lowConfidence: 0,
    unmatched: totalNeeded - filled,
  };

  // ④ 资金校验（只读）
  const fundCheck = runFundCheck(db, userId, brokerCode);
  const caliberDiff = fundCheck.mismatch.filter((m) => m.category === 'fee_conflict').length;

  // ⑤ 逆回购模型（只读）
  const repoModel = modelRepoCashFlow(db, userId, brokerCode);

  // ⑥ 覆盖区间（事实层日期范围；区间外不构成「已核对」）
  const range = db
    .prepare(
      `SELECT MIN(trade_date) lo, MAX(trade_date) hi FROM broker_trade_record
        WHERE user_id = ? AND broker_code = ? AND is_deleted = 0`,
    )
    .get(userId, brokerCode) as { lo: string | null; hi: string | null };
  const from = fmtDate(range.lo);
  const to = fmtDate(range.hi);

  // ⑦ 收益两口径占位（D-25）：现金类 = 逆回购利息；风险类待 T132
  const risk = 0;
  const cash = repoModel.totalInterest;

  return {
    brokerCode,
    coveredRange: { from, to },
    coverageNote: '覆盖区间 = 事实层记录日期范围；区间外不构成「已核对」。在途逆回购头寸不计入收益。',
    matchSummary: {
      factRows,
      matched: Number(sc.MATCHED ?? 0),
      fuzzy: Number(sc.FUZZY ?? 0),
      missing,
      extra,
    },
    attribution: {
      repo: repoVal,
      cashLikeEtf: cashLikeEtfVal,
      dividend: dividendVal,
      offExchange: offExchangeVal,
      uncoveredPeriod: 0,
      caliberDiff,
      residual: unknownVal,
      order: ['residual', 'repo', 'cashLikeEtf', 'dividend', 'offExchange', 'uncoveredPeriod', 'caliberDiff'],
    },
    fundCheck,
    timeBackfill,
    repoModel,
    returnSummary: {
      risk,
      cash,
      total: risk + cash,
      note: '两口径占位版（D-25）：现金类 = 逆回购利息（货币 ETF 市值收益需行情上下文，未计）；风险类待 T132',
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 归因下钻（§9.2 diff 端点）：按归因类别取事实层明细，支持分页。
 * 类别：repo / cashLikeEtf / dividend / offExchange / unknown / unmatched
 */
export function attributionDrilldown(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  category: 'repo' | 'cashLikeEtf' | 'dividend' | 'offExchange' | 'unknown' | 'unmatched',
  page = 1,
  pageSize = 50,
): { rows: Array<Record<string, unknown>>; total: number; page: number } {
  const cond: Record<string, string> = {
    repo: "b.event_type = 'REPO'",
    cashLikeEtf: "b.event_type = 'CASH_LIKE_ETF'",
    dividend: "b.event_type IN ('DIVIDEND_CASH','DIVIDEND_BONUS')",
    offExchange: "b.event_type IN ('EXCLUDED_OFFEXCHANGE','PLACEHOLDER','IGNORE')",
    unknown: "b.event_type = 'UNKNOWN'",
    unmatched:
      "(b.match_status IN ('MISSING','FUZZY') AND b.event_type IN ('TRADE_BUY','TRADE_SELL','FUND_SUBSCRIBE','FUND_REDEEM'))",
  };
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) n FROM broker_trade_record b
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0 AND ${cond[category]}`,
    )
    .get(userId, brokerCode) as { n: number };
  const total = Number(totalRow.n);
  const rows = db
    .prepare(
      `SELECT b.id, b.event_type, b.raw_event_type, b.asset_code, b.trade_date, b.trade_time,
              b.price, b.quantity, b.amount, b.cash_flow, b.fee_total, b.match_status,
              b.exclude_reason, b.source_file
         FROM broker_trade_record b
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0 AND ${cond[category]}
        ORDER BY b.trade_date, b.id
        LIMIT ? OFFSET ?`,
    )
    .all(userId, brokerCode, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
  return { rows, total, page };
}
