import { ConfigStore } from '../config/configStore.js';
import {
  calculateMovingWeightedCost,
  type TradeRecord as CoreTrade,
  type PositionResult,
} from '@invest/core';

/**
 * 持仓聚合服务（T26）
 *
 * MVP 设计：不持久化持仓表，从 user_trade_record 实时算
 * 后续性能不够再加 user_holding 表做缓存
 */

interface DbTradeRow {
  id: number;
  user_id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  trade_time: string;
  quantity: number;
  price: number;
  fee: number;
  is_deleted: number;
}

function mapToCoreTrade(row: DbTradeRow): CoreTrade | null {
  switch (row.trade_type) {
    case 'buy':
    // 🔴 §4-A（P0）：`add`（加仓）**必须**映射为 buy —— 它是买入，仓位应增加。
    //   原实现把 add / reduce / clear 一起映射为 sell → **加仓后持仓直接归零**，
    //   且已实现盈亏被错记为卖出价差（实测：买 100@10 + 加仓 100@12 → 期望 200 股/均价 11，
    //   实得 0 股/已实现 200）。T49 落地了 `add` 类型但成本计算分支没跟上。
    case 'add':
      return {
        date: row.trade_date,
        direction: 'buy',
        quantity: row.quantity,
        price: row.price,
        fee: row.fee,
      };
    case 'reduce':
    case 'clear':
      return {
        date: row.trade_date,
        direction: 'sell',
        quantity: row.quantity,
        price: row.price,
        fee: row.fee,
      };
    default:
      return null; // dividend/bonus/transfer 不参与移动加权（MVP 初版）
  }
}

/**
 * 算单个标的当前持仓（含已实现盈亏）
 *
 * T84：`asOfDate` 指定「回放到哪个时点」，只回放 `trade_date <= asOfDate` 的记录。
 * 卖出校验必须用它 —— 否则**尚未发生的买入**会支撑**更早的卖出**（P0-13）。
 *
 * ⚠️ 显示路径传 `strictOversell: false`：存量脏数据不应让持仓卡整页 500，
 * 但脏状态通过 `hasOversell` / `oversellDetail` 暴露，不得静默吞掉。
 */
export function calcPosition(
  userId: number,
  assetCode: string,
  asOfDate?: string,
  asOfTime?: string,
): PositionResult {
  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT id, user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted
     FROM user_trade_record
     WHERE user_id = ? AND asset_code = ? AND is_deleted = 0
       AND (? IS NULL OR (trade_date < ? OR (trade_date = ? AND trade_time <= ?)))
     ORDER BY trade_date ASC, trade_time ASC, id ASC`,
    )
    .all(
      userId,
      assetCode,
      asOfDate ?? null,
      asOfDate ?? null,
      asOfDate ?? null,
      asOfTime ?? '23:59:59',
    ) as DbTradeRow[];

  const coreTrades = rows.map(mapToCoreTrade).filter((t): t is CoreTrade => t !== null);

  return calculateMovingWeightedCost(coreTrades, { strictOversell: false });
}

/**
 * 查所有有交易记录的标的 + 聚合持仓
 * 给 GET /api/positions 用
 */
export function calcAllPositions(userId: number): Array<{ asset_code: string } & PositionResult> {
  const db = ConfigStore.getInstance().db;
  const codes = db
    .prepare('SELECT DISTINCT asset_code FROM user_trade_record WHERE user_id = ? AND is_deleted = 0')
    .all(userId) as { asset_code: string }[];

  return codes.map((c) => ({ asset_code: c.asset_code, ...calcPosition(userId, c.asset_code) }));
}

/**
 * sell/reduce/clear 前校验持仓充足（T25 核心 + T84 P0-13）
 *
 * 🔴 `tradeDate` 是**必传**的正确性参数：以卖出发生时点回放，
 * 只计入 `trade_date <= tradeDate` 的记录，避免未来买入支撑过去的卖出。
 *
 * 返回 true = 可卖；false = 持仓不足。
 */
export function validateSufficientHolding(
  userId: number,
  assetCode: string,
  sellQty: number,
  tradeDate?: string,
  tradeTime?: string,
): boolean {
  if (sellQty <= 0) return false;
  const pos = calcPosition(userId, assetCode, tradeDate, tradeTime);
  return pos.totalQuantity >= sellQty;
}

/**
 * 单笔平仓交易的已实现盈亏（T38 胜率/盈亏比统计的数据源）
 *
 * 口径与 calculateMovingWeightedCost 完全一致：卖出净收入 = price*qty - fee，
 * 成本按卖出时的移动加权均价计。平仓 0 股（空仓卖出）不计入。
 */
export interface ClosedTradePnl {
  trade_id: number;
  asset_code: string;
  trade_date: string;
  trade_type: string;
  quantity: number;
  price: number;
  fee: number;
  realized_pnl: number;
}

/**
 * 按时间顺序回放所有标的的买卖，输出每笔平仓（sell/reduce/clear）的已实现盈亏
 *
 * 与 calcPosition 相同的映射口径：dividend/bonus/transfer 不参与成本回放
 */
export function calcClosedTradePnLs(userId: number): ClosedTradePnl[] {
  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT id, asset_code, trade_type, trade_date, quantity, price, fee
     FROM user_trade_record
     WHERE user_id = ? AND is_deleted = 0
       AND trade_type IN ('buy','add','reduce','clear')
     ORDER BY trade_date ASC, trade_time ASC, id ASC`,
    )
    .all(userId) as Array<Omit<ClosedTradePnl, 'realized_pnl'> & { fee: number }>;

  // 每个标的独立维护持仓量与成本基
  const state = new Map<string, { qty: number; costBasis: number }>();
  const result: ClosedTradePnl[] = [];

  for (const row of rows) {
    const st = state.get(row.asset_code) ?? { qty: 0, costBasis: 0 };

    if (row.trade_type === 'buy') {
      st.costBasis += row.quantity * row.price + row.fee;
      st.qty += row.quantity;
    } else {
      if (st.qty <= 0) continue; // 空仓卖出跳过（脏数据，POS 校验理论上已拦）
      const avgCost = st.costBasis / st.qty;
      const revenue = row.quantity * row.price - row.fee;
      result.push({ ...row, realized_pnl: revenue - row.quantity * avgCost });
      st.qty -= row.quantity;
      st.costBasis = st.qty * avgCost; // 卖出后成本基按剩余数量等比减少
      if (st.qty <= 0) {
        st.qty = 0;
        st.costBasis = 0;
      }
    }

    state.set(row.asset_code, st);
  }

  return result;
}
