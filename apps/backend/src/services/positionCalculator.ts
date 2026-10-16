import { ConfigStore } from '../config/configStore.js';
import { calculateMovingWeightedCost, type TradeRecord as CoreTrade, type PositionResult } from '@invest/core';

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
  quantity: number;
  price: number;
  fee: number;
  is_deleted: number;
}

function mapToCoreTrade(row: DbTradeRow): CoreTrade | null {
  switch (row.trade_type) {
    case 'buy':
      return { date: row.trade_date, direction: 'buy', quantity: row.quantity, price: row.price, fee: row.fee };
    case 'sell':
    case 'reduce':
    case 'clear':
      return { date: row.trade_date, direction: 'sell', quantity: row.quantity, price: row.price, fee: row.fee };
    default:
      return null;  // dividend/bonus/transfer 不参与移动加权（MVP 初版）
  }
}

/**
 * 算单个标的当前持仓（含已实现盈亏）
 */
export function calcPosition(userId: number, assetCode: string): PositionResult {
  const db = ConfigStore.getInstance().db;
  const rows = db.prepare(
    `SELECT id, user_id, asset_code, trade_type, trade_date, quantity, price, fee, is_deleted
     FROM user_trade_record
     WHERE user_id = ? AND asset_code = ? AND is_deleted = 0
     ORDER BY trade_date ASC, id ASC`
  ).all(userId, assetCode) as DbTradeRow[];

  const coreTrades = rows
    .map(mapToCoreTrade)
    .filter((t): t is CoreTrade => t !== null);

  return calculateMovingWeightedCost(coreTrades);
}

/**
 * 查所有有交易记录的标的 + 聚合持仓
 * 给 GET /api/positions 用
 */
export function calcAllPositions(userId: number): Array<{ asset_code: string } & PositionResult> {
  const db = ConfigStore.getInstance().db;
  const codes = db.prepare(
    'SELECT DISTINCT asset_code FROM user_trade_record WHERE user_id = ? AND is_deleted = 0'
  ).all(userId) as { asset_code: string }[];

  return codes.map((c) => ({ asset_code: c.asset_code, ...calcPosition(userId, c.asset_code) }));
}

/**
 * sell 前校验持仓充足（T25 核心，AGENTS.md 硬约束）
 * 返回 true = 可卖；false = 持仓不足
 */
export function validateSufficientHolding(userId: number, assetCode: string, sellQty: number): boolean {
  if (sellQty <= 0) return false;
  const pos = calcPosition(userId, assetCode);
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
  const rows = db.prepare(
    `SELECT id, asset_code, trade_type, trade_date, quantity, price, fee
     FROM user_trade_record
     WHERE user_id = ? AND is_deleted = 0
       AND trade_type IN ('buy','sell','reduce','clear')
     ORDER BY trade_date ASC, id ASC`
  ).all(userId) as Array<Omit<ClosedTradePnl, 'realized_pnl'> & { fee: number }>;

  // 每个标的独立维护持仓量与成本基
  const state = new Map<string, { qty: number; costBasis: number }>();
  const result: ClosedTradePnl[] = [];

  for (const row of rows) {
    const st = state.get(row.asset_code) ?? { qty: 0, costBasis: 0 };

    if (row.trade_type === 'buy') {
      st.costBasis += row.quantity * row.price + row.fee;
      st.qty += row.quantity;
    } else {
      if (st.qty <= 0) continue;  // 空仓卖出跳过（脏数据，POS 校验理论上已拦）
      const avgCost = st.costBasis / st.qty;
      const revenue = row.quantity * row.price - row.fee;
      result.push({ ...row, realized_pnl: revenue - row.quantity * avgCost });
      st.qty -= row.quantity;
      st.costBasis = st.qty * avgCost;  // 卖出后成本基按剩余数量等比减少
      if (st.qty <= 0) { st.qty = 0; st.costBasis = 0; }
    }

    state.set(row.asset_code, st);
  }

  return result;
}
