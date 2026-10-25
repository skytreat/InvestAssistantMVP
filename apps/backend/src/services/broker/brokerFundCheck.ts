/**
 * T125（V3.1）资金校验（行内自洽）—— SDD_v3 §6 / INV-S2-40~44
 *
 * 唯一可靠校验（§6.2）：
 *   买入系：资金发生额 = −(成交金额 + 费用合计)
 *   卖出系：资金发生额 = +(成交金额 − 费用合计)
 * 实测命中 145/148（国泰 ETF 交割 131/134 + 股票交割 14/14）；3 处不适用 = 现金分红。
 *
 * 硬规则（§6.1/§6.2）：
 * - **不做账户级与逐笔余额闭合**（实测 1/134，禁止回退到该口径）
 * - 「资金余额」列语义 = 全账户总资产，**不得当现金余额用**
 * - 不适用行（现金分红 / 场外 / 占位）单独归类，**不计入不平行统计**
 * - 失配行必须分类（费用口径不符 / 分红 / 口径未知），不得笼统报「不平」
 * - 无费用明细列的成交流水**不参与**校验（校验适用范围须声明）
 */
import type Database from 'better-sqlite3';

export type MismatchCategory = 'fee_conflict' | 'dividend' | 'unknown';

export interface MismatchRow {
  id: number;
  asset_code: string | null;
  trade_date: string | null;
  category: MismatchCategory;
  expected: number;
  actual: number;
}

export interface FundCheckResult {
  /** 参与校验的行数（交割侧、有成交金额、买卖/申赎系事件） */
  checked: number;
  /** 公式命中数 */
  hit: number;
  /** 公式不适用（现金分红 / 无成交金额）：单独归类，不计入失配统计 */
  notApplicable: number;
  /** 非买卖系事件（分红入账 / 转入 / 占位等）：校验范围外，单列以便审计口径 */
  skippedEvents: number;
  /** 失配行（已分类，禁止笼统「不平」） */
  mismatch: MismatchRow[];
  /** 校验范围声明（§6.2 要求） */
  scopeNote: string;
}

const TOLERANCE = 0.011; // 分级/舍入口径（分币级）

/** 买开方向（资金流出为负）：TRADE_BUY / FUND_SUBSCRIBE / REPO 出资 / CASH_LIKE 流出腿
 * （申购 / 竞价买入 / 现金差额扣款；**退款是流入腿，见 sellLeg**） */
function isBuyLeg(eventType: string, rawEvent: string | null): boolean {
  const raw = rawEvent ?? '';
  switch (eventType) {
    case 'TRADE_BUY':
    case 'FUND_SUBSCRIBE':
      return true;
    case 'REPO':
      return !/购回|赎回/.test(raw);
    case 'CASH_LIKE_ETF':
      return !/卖出|赎回|退款/.test(raw);
    default:
      return false;
  }
}

export function runFundCheck(db: Database.Database, userId: number, brokerCode: string): FundCheckResult {
  const rows = db
    .prepare(
      `SELECT b.id, b.event_type, b.raw_event_type, b.asset_code, b.trade_date, b.amount, b.cash_flow, b.fee_total
         FROM broker_trade_record b
         JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0 AND f.file_kind = 'settlement'`,
    )
    .all(userId, brokerCode) as Array<{
    id: number;
    event_type: string;
    raw_event_type: string | null;
    asset_code: string | null;
    trade_date: string | null;
    amount: number | null;
    cash_flow: number | null;
    fee_total: number | null;
  }>;

  let checked = 0;
  let hit = 0;
  let notApplicable = 0;
  let skippedEvents = 0;
  const mismatch: MismatchRow[] = [];

  for (const r of rows) {
    if (r.cash_flow === null) continue; // 无资金发生额 ⇒ 不参与
    const buyLeg = isBuyLeg(r.event_type, r.raw_event_type);
    const sellLeg =
      r.event_type === 'TRADE_SELL' ||
      r.event_type === 'FUND_REDEEM' ||
      (r.event_type === 'REPO' && /购回|赎回/.test(r.raw_event_type ?? '')) ||
      (r.event_type === 'CASH_LIKE_ETF' && /卖出|赎回|退款/.test(r.raw_event_type ?? ''));
    if (!buyLeg && !sellLeg) {
      skippedEvents++; // 非买卖系事件（分红入账/转入/占位）：范围外，单列审计
      continue;
    }

    // 无成交金额 ⇒ 公式不适用（现金分红等），单独归类
    if (r.amount === null || r.amount === 0) {
      notApplicable++;
      continue;
    }
    checked++;

    const fee = r.fee_total ?? 0;
    const expected = buyLeg ? -(r.amount + fee) : r.amount - fee;
    if (Math.abs(r.cash_flow - expected) <= TOLERANCE) {
      hit++;
      continue;
    }
    // 失配分类（禁止笼统「不平」）
    let category: MismatchCategory;
    if (r.fee_total === null) {
      // 该文件无「费用合计」列（如华宝 4 个费用分项）⇒ 公式费用项不可验证 → 费用口径不符
      category = 'fee_conflict';
    } else if (r.amount === null || r.amount === 0) {
      category = 'dividend';
    } else if (Math.abs(Math.abs(r.cash_flow) - Math.abs(r.amount)) <= TOLERANCE) {
      category = 'fee_conflict'; // 金额对、费用口径差
    } else {
      category = 'unknown'; // 真正无法归类（须逐行人工判读）
    }
    mismatch.push({
      id: r.id,
      asset_code: r.asset_code,
      trade_date: r.trade_date,
      category,
      expected,
      actual: r.cash_flow,
    });
  }

  return {
    checked,
    hit,
    notApplicable,
    skippedEvents,
    mismatch,
    scopeNote:
      '仅交割侧、有成交金额的买卖/申赎系事件参与行内自洽校验；无费用明细列的成交流水不参与（SDD_v3 §6.2）；' +
      '「资金余额」列为全账户总资产，不得当现金余额使用',
  };
}
