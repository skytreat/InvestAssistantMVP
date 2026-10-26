/**
 * T130（V3.3）交易对视图 —— SDD_v3 §9.7 / Requirements INV-S6-6~9
 *
 * 一次「开仓 → 平仓」为一行；加仓/减仓正确归并到原开仓（INV-S6-7）；
 * 未平仓单独成组（INV-S6-9）；列结构与用户手工表对齐（INV-S6-8）。
 *
 * 配对算法（按标的分桶、按时间排序）：
 *   - buy/add  → 累加开仓数量与成本基（加仓合并入原开仓，不另起 pair）
 *   - reduce/clear → 按移动加权均价结转，生成一个已平仓 pair；
 *                    部分平仓保留剩余开仓继续配对
 *   - bonus → 股数 +n，成本基不变（摊薄均价，不生成 pair）
 *   - dividend → 不影响数量/成本，不生成 pair
 *   - 末尾仍有未平仓数量 → 生成一个「open」pair（close 字段 null）
 *
 * 已实现盈亏 per pair = closeQty × closePrice − closeFee − closeQty × avgCostAtClose
 * 持仓天数 = close_date − open_date（日历天，含两端）；未平仓为 null。
 */
import { ConfigStore } from '../config/configStore.js';

export interface ReviewPair {
  id: number; // 主锚交易 id（已平仓=平仓交易 id；未平仓=开仓交易 id）
  asset_code: string;
  open_trade_id: number;
  close_trade_id: number | null;
  open_date: string;
  close_date: string | null;
  open_price: number;
  close_price: number | null;
  open_quantity: number;
  closed_quantity: number;
  remaining_quantity: number;
  realized_pnl: number | null;
  holding_days: number | null;
  buy_reason: string | null;
  sell_reason: string | null;
  emotion_status: string | null;
  broker_code: string | null;
  status: 'closed' | 'open';
}

interface DbRow {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  trade_time: string | null;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
  buy_reason: string | null;
  sell_reason: string | null;
  emotion_status: string | null;
  broker_code: string | null;
  is_deleted: number;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00').getTime();
  const db = new Date(b + 'T00:00:00').getTime();
  return Math.round((db - da) / 86400000);
}

export function buildReviewPairs(userId: number): ReviewPair[] {
  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
              trade_reason, buy_reason, sell_reason, emotion_status, broker_code, is_deleted
         FROM user_trade_record
        WHERE user_id = ? AND is_deleted = 0
        ORDER BY asset_code ASC, trade_date ASC, trade_time ASC, id ASC`,
    )
    .all(userId) as DbRow[];

  // 按标的分桶
  const byAsset = new Map<string, DbRow[]>();
  for (const r of rows) {
    const arr = byAsset.get(r.asset_code);
    if (arr) arr.push(r);
    else byAsset.set(r.asset_code, [r]);
  }

  const pairs: ReviewPair[] = [];

  for (const [asset, trades] of byAsset) {
    // 开仓状态
    let openQty = 0;
    let openCost = 0;
    let openDate = '';
    let openTradeId = 0;
    let openPrice = 0;
    let buyReason: string | null = null;
    let emotionStatus: string | null = null;
    let brokerCode: string | null = null;
    let originalOpenQty = 0;

    for (const t of trades) {
      const qty = t.quantity ?? 0;
      const price = t.price ?? 0;
      const fee = t.fee ?? 0;

      if (t.trade_type === 'buy' || t.trade_type === 'add') {
        if (openQty <= 0) {
          // 新开仓周期
          openQty = qty;
          openCost = qty * price + fee;
          openDate = t.trade_date;
          openTradeId = t.id;
          openPrice = price;
          buyReason = t.buy_reason ?? t.trade_reason;
          emotionStatus = t.emotion_status;
          brokerCode = t.broker_code;
          originalOpenQty = qty;
        } else {
          // 加仓：合并入原开仓
          openCost += qty * price + fee;
          openQty += qty;
          originalOpenQty += qty;
          if (t.buy_reason) buyReason = t.buy_reason;
        }
        continue;
      }

      if (t.trade_type === 'bonus') {
        if (openQty > 0) {
          openQty += qty; // 摊薄均价，成本基不变
          originalOpenQty += qty;
        }
        continue;
      }

      if (t.trade_type === 'dividend') {
        continue; // 不影响数量/成本
      }

      // reduce / clear / (transfer 忽略)
      if (t.trade_type !== 'reduce' && t.trade_type !== 'clear') continue;
      if (openQty <= 0) continue; // 空仓卖出跳过

      const closeQty = Math.min(qty, openQty);
      const avgCost = openCost / openQty;
      const revenue = closeQty * price - fee;
      const realized = revenue - closeQty * avgCost;
      const remaining = openQty - closeQty;

      pairs.push({
        id: t.id,
        asset_code: asset,
        open_trade_id: openTradeId,
        close_trade_id: t.id,
        open_date: openDate,
        close_date: t.trade_date,
        open_price: openPrice,
        close_price: price,
        open_quantity: originalOpenQty,
        closed_quantity: closeQty,
        remaining_quantity: remaining,
        realized_pnl: parseFloat(realized.toFixed(2)),
        holding_days: daysBetween(openDate, t.trade_date),
        buy_reason: buyReason,
        sell_reason: t.sell_reason ?? t.trade_reason,
        emotion_status: t.emotion_status ?? emotionStatus,
        broker_code: brokerCode ?? t.broker_code,
        status: 'closed',
      });

      openQty = remaining;
      openCost = openQty * avgCost;
      if (openQty <= 0) {
        openQty = 0;
        openCost = 0;
        originalOpenQty = 0;
      }
    }

    // 末尾未平仓 → 单独成组
    if (openQty > 0) {
      pairs.push({
        id: openTradeId,
        asset_code: asset,
        open_trade_id: openTradeId,
        close_trade_id: null,
        open_date: openDate,
        close_date: null,
        open_price: openPrice,
        close_price: null,
        open_quantity: originalOpenQty,
        closed_quantity: 0,
        remaining_quantity: openQty,
        realized_pnl: null,
        holding_days: null,
        buy_reason: buyReason,
        sell_reason: null,
        emotion_status: emotionStatus,
        broker_code: brokerCode,
        status: 'open',
      });
    }
  }

  // 排序：按 open_date desc, asset asc（与复盘页一致）
  pairs.sort((a, b) => {
    if (a.open_date !== b.open_date) return a.open_date < b.open_date ? 1 : -1;
    return a.asset_code < b.asset_code ? -1 : a.asset_code > b.asset_code ? 1 : 0;
  });

  return pairs;
}
