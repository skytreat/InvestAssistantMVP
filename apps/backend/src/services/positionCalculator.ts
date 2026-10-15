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
