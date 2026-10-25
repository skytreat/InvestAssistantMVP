/**
 * T127（V3.1）现金类资产建模 —— SDD_v3 §7 / ADR-016 / INV-S4-18~26
 *
 * 逆回购 = **有期限债权**（不是持仓）：
 * - 「成交价格」= 年化收益率(%)，「成交数量」= 手数（1 手 = 1000 元）——**不得当单价处理**
 * - 利息 = 收回金额 − 出资金额（成交金额口径，**不用费率估算**）
 * - 配对必须**按时间顺序 FIFO**（实测坑：按数组顺序错配 ⇒ 利息被算成 −100 万量级）
 * - 未配对单独报告：出资无收回 = 在途头寸；收回无出资 = 数据不全
 * 实测基线（§7.1.5）：180 对 1 天期、利息合计 7,501.46 元 ±0.5、未配对 0。
 *
 * 货币 ETF（§7.2）：成本价 = 实付 ÷ 份额（面值/市价混用天然正确），
 * **收益按「市值变动 / 日结」口径，不用百分比涨跌幅**（0.05% 振幅下百分比口径失真）。
 */
import type Database from 'better-sqlite3';

export interface RepoPair {
  symbol: string;
  openDate: string;
  openAmount: number; // 出资金额（成交金额口径）
  closeDate: string;
  closeAmount: number; // 收回金额（|资金发生额|）
  interest: number; // = closeAmount − openAmount
}

export interface RepoModelResult {
  pairs: RepoPair[];
  unpairedOpens: number; // 在途头寸（未到期）
  unpairedCloses: number; // 收回无出资（数据不全）
  totalInterest: number;
  /** 隐含年化（§7.1.5 验收参照）：Σ利息 / Σ(面额×持有天数/365) */
  impliedAnnualRate: number;
}

/** 逆回购品种（T120 实测段 + 场内 LOF 无关；本函数只对 REPO 事件生效） */
export function modelRepoCashFlow(
  db: Database.Database,
  userId: number,
  brokerCode: string,
): RepoModelResult {
  const rows = db
    .prepare(
      `SELECT b.asset_code, b.trade_date, b.trade_time, b.amount, b.cash_flow, b.raw_event_type
         FROM broker_trade_record b
         JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0
          AND b.event_type = 'REPO' AND b.match_status != 'EXCLUDED'
        ORDER BY b.asset_code, b.trade_date, b.trade_time, b.id`,
    )
    .all(userId, brokerCode) as Array<{
    asset_code: string;
    trade_date: string;
    trade_time: string | null;
    amount: number | null;
    cash_flow: number | null;
    raw_event_type: string | null;
  }>;

  // D-21：腿别按事件语义（出资=开 / 购回=平），不按 cash_flow 符号（两文件符号约定不一致）
  const isOpenLeg = (r: (typeof rows)[number]) => !/购回|赎回/.test(r.raw_event_type ?? '');

  const bySymbol = new Map<string, Array<(typeof rows)[number]>>();
  for (const r of rows) {
    const k = r.asset_code ?? 'unknown';
    const arr = bySymbol.get(k);
    if (arr) arr.push(r);
    else bySymbol.set(k, [r]);
  }

  const pairs: RepoPair[] = [];
  let unpairedOpens = 0;
  let unpairedCloses = 0;
  let totalInterest = 0;
  let denom = 0; // Σ(面额 × 持有天数/365)

  for (const [symbol, syms] of bySymbol) {
    /**
     * 配对（D-24 v2，实测驱动）：
     * ① 同日多笔出资 + 收回腿**逐批/合并结算**（实测：0820 00:00 一笔 1,485,060.42
     *    = 0819 两笔出资 744000+741000 合并收回；两笔同日不同手数的收回也在次日 00:00 同刻）
     *    ⇒ 纯时间 FIFO 会跨配（大笔出资吃掉小笔收回 ⇒ 负利息）。
     * ② 单笔收回腿：在未匹配开仓中取「开仓日 ≤ 收回日 且 收回 ∈ [0.995,1.02]×开仓」中
     *    **|差值| 最小**的一笔（贪心；同日两笔 746000/744000 场景下正确归位）。
     * ③ 金额带外但 ≈ 同开仓日连续 2~3 笔出资之和（±0.5%）⇒ 合并收回，全部配对。
     * ④ 都不满足 ⇒ unpairedCloses（数据不全，单列报告）。
     * 1 天期利息 ≤ 本金×4%/365 + 微费 ⇒ 单笔 收回/出资 ∈ [0.9999, 1.0002]，带宽取 [0.995, 1.02] 容差。
     */
    const opens: Array<{ date: string; time: string | null; amount: number; matched: boolean }> = [];
    for (const r of syms) {
      if (isOpenLeg(r)) {
        opens.push({
          date: r.trade_date,
          time: r.trade_time ?? '',
          amount: r.amount ?? Math.abs(r.cash_flow ?? 0),
          matched: false,
        });
      }
    }
    opens.sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date < b.date ? -1 : 1));

    const closes = syms.filter((r) => (r.cash_flow ?? 0) > 0 && !isOpenLeg(r));
    for (const c of closes) {
      const cf = c.cash_flow!;
      // ② 单笔：最小差值贪心
      let best: (typeof opens)[number] | undefined;
      for (const o of opens) {
        if (o.matched) continue;
        if (dateDiffDays(o.date, c.trade_date) < 0) continue;
        const ratio = cf / o.amount;
        if (ratio < 0.995 || ratio > 1.02) continue;
        if (!best || Math.abs(cf - o.amount) < Math.abs(cf - best.amount)) best = o;
      }
      if (best) {
        best.matched = true;
        pairs.push({
          symbol,
          openDate: best.date,
          openAmount: best.amount,
          closeDate: c.trade_date,
          closeAmount: cf,
          interest: cf - best.amount,
        });
        totalInterest += cf - best.amount;
        const days = dateDiffDays(best.date, c.trade_date) || 1;
        denom += (best.amount * days) / 365;
        continue;
      }
      // ③ 合并收回：同开仓日连续 2~3 笔之和 ≈ cf（±0.5%）
      let handled = false;
      for (let i = 0; i + 2 < opens.length; i++) {
        const a = opens[i];
        if (a.matched) continue;
        const combos: Array<Array<(typeof opens)[number]>> = [
          [a, opens[i + 1]].filter((o) => !o.matched && o.date === a.date) as Array<(typeof opens)[number]>,
          [a, opens[i + 1], opens[i + 2]].filter((o) => !o.matched && o.date === a.date) as Array<
            (typeof opens)[number]
          >,
        ];
        for (const combo of combos) {
          if (combo.length < 2) continue;
          const sum = combo.reduce((s, o) => s + o.amount, 0);
          const ratio = cf / sum;
          if (ratio >= 0.995 && ratio <= 1.005) {
            for (const o of combo) o.matched = true;
            pairs.push({
              symbol,
              openDate: a.date,
              openAmount: sum,
              closeDate: c.trade_date,
              closeAmount: cf,
              interest: cf - sum,
            });
            totalInterest += cf - sum;
            const days = dateDiffDays(a.date, c.trade_date) || 1;
            denom += (sum * days) / 365;
            handled = true;
            break;
          }
        }
        if (handled) break;
      }
      if (!handled) {
        unpairedCloses++; // ④ 数据不全 / 无法配对
      }
    }
    unpairedOpens += opens.filter((o) => !o.matched).length;
  }

  const impliedAnnualRate = denom > 0 ? (totalInterest / denom) * 100 : 0;
  return { pairs, unpairedOpens, unpairedCloses, totalInterest, impliedAnnualRate };
}

/** YYYYMMDD / YYYY-MM-DD 差日（跨文件两种格式并存，同 T124 toTimeMs） */
function dateDiffDays(a: string, b: string): number {
  const toUtc = (d: string) => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(d);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  };
  const x = toUtc(a);
  const y = toUtc(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return Math.round((y - x) / 86400000);
}

/**
 * 货币 ETF 收益（§7.2）：市值变动口径。
 * @param latestClose 标的 → 最新收盘价（行情层）；缺失时该持仓按 0 计并计入 warning
 * 收益 = 未赎回份额×最新价 + 已变现现金 − 累计实付（成本 = 实付÷份额 移动加权，面值/市价混用天然正确）
 */
export function cashLikeEtfReturn(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  latestClose: Map<string, number>,
): {
  unitsHeld: number;
  cashRealized: number;
  totalPaid: number;
  marketValue: number;
  returnAmount: number;
  missingPrice: string[];
} {
  const rows = db
    .prepare(
      `SELECT b.asset_code, b.raw_event_type, b.quantity, b.amount, b.cash_flow, f.file_kind
         FROM broker_trade_record b JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0 AND b.event_type = 'CASH_LIKE_ETF'
        ORDER BY b.trade_date, b.trade_time, b.id`,
    )
    .all(userId, brokerCode) as Array<{
    asset_code: string;
    raw_event_type: string | null;
    quantity: number | null;
    amount: number | null;
    cash_flow: number | null;
    file_kind: string;
  }>;

  const units = new Map<string, number>();
  const cash = new Map<string, number>();
  const paid = new Map<string, number>();
  const missingPrice: string[] = [];

  for (const r of rows) {
    const sym = r.asset_code ?? '';
    const raw = r.raw_event_type ?? '';
    const out = /卖出|赎回|退款/.test(raw);
    const in_ = !out; // 申购 / 竞价买入 / 扣款
    if (in_) {
      // 申购：份额 += quantity；实付 = 成交金额（现金申购 = 面值×份额）
      units.set(sym, (units.get(sym) ?? 0) + (r.quantity ?? 0));
      paid.set(sym, (paid.get(sym) ?? 0) + (r.amount ?? 0));
    } else if (out) {
      // 卖出/赎回：份额 −=；变现现金 += 资金发生额（退款同理入账）
      units.set(sym, Math.max(0, (units.get(sym) ?? 0) - (r.quantity ?? 0)));
      if (r.cash_flow !== null && r.cash_flow > 0) cash.set(sym, (cash.get(sym) ?? 0) + r.cash_flow);
    }
  }

  let unitsHeld = 0;
  let marketValue = 0;
  let totalPaid = 0;
  let cashRealized = 0;
  for (const [sym, u] of units) {
    unitsHeld += u;
    totalPaid += paid.get(sym) ?? 0;
    cashRealized += cash.get(sym) ?? 0;
    const px = latestClose.get(sym);
    if (px === undefined) {
      if (u > 0) missingPrice.push(sym);
      continue; // 无行情：不假设价格（不得用 100 面值顶替市价）
    }
    marketValue += u * px;
  }
  return {
    unitsHeld,
    cashRealized,
    totalPaid,
    marketValue,
    returnAmount: marketValue + cashRealized - totalPaid,
    missingPrice,
  };
}
