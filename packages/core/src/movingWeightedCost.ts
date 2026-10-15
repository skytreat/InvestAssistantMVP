/**
 * 移动加权平均成本（MVP Phase 1 初版，不含除权除息调整）
 *
 * 公式：avg_cost = 总持仓成本 / 总持仓数量
 * 每次买入/分红转增后重算
 * 卖出不改变 avg_cost（FIFO/平均法均如此，MVP 用平均法）
 *
 * 除权除息调整（后续补）：
 * - 送转后 avg_cost_old / (1 + transfer_ratio)
 * - 分红后 avg_cost_old - cash_per_share
 */

export interface TradeRecord {
  date: string;
  direction: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee?: number;
}

export interface PositionResult {
  totalQuantity: number;        // 当前持仓数量
  avgCost: number;              // 移动加权平均成本（含手续费）
  totalCostBasis: number;       // 总持仓成本
  realizedPnL: number;          // 已实现盈亏
  totalFee: number;             // 累计手续费
}

export function calculateMovingWeightedCost(trades: TradeRecord[]): PositionResult {
  let totalQuantity = 0;
  let totalCostBasis = 0;
  let realizedPnL = 0;
  let totalFee = 0;

  for (const trade of trades) {
    const fee = trade.fee ?? 0;
    totalFee += fee;

    if (trade.direction === 'buy') {
      const totalCost = trade.quantity * trade.price + fee;
      totalCostBasis += totalCost;
      totalQuantity += trade.quantity;
    } else if (trade.direction === 'sell') {
      if (totalQuantity <= 0) continue;  // 空仓卖出跳过
      const avgCost = totalCostBasis / totalQuantity;
      const revenue = trade.quantity * trade.price - fee;
      realizedPnL += revenue - trade.quantity * avgCost;
      totalQuantity -= trade.quantity;
      totalCostBasis = totalQuantity * avgCost;  // 卖出后成本基按剩余数量等比减少
    }
  }

  return {
    totalQuantity,
    avgCost: totalQuantity > 0 ? totalCostBasis / totalQuantity : 0,
    totalCostBasis,
    realizedPnL,
    totalFee,
  };
}
