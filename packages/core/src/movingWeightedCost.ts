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

/**
 * T84 超卖业务异常（P0-13）
 *
 * 抛出即代表「某笔卖出在它发生时点上超出了当时持仓」。
 * Requirements §5.2：减仓数量不得超过当时实际持仓 → 服务端拒绝保存。
 */
export class PositionOversellError extends Error {
  readonly date: string;
  readonly requested: number;
  readonly available: number;
  readonly shortfall: number;

  constructor(date: string, requested: number, available: number) {
    super(
      `HOLDING_INSUFFICIENT: ${date} 卖出 ${requested} 股，但当时持仓仅 ${available} 股（缺口 ${requested - available}）`,
    );
    this.name = 'PositionOversellError';
    this.date = date;
    this.requested = requested;
    this.available = available;
    this.shortfall = requested - available;
  }
}

export interface OversellDetail {
  date: string;
  requested: number;
  available: number;
  shortfall: number;
}

export interface PositionResult {
  totalQuantity: number;        // 当前持仓数量
  avgCost: number;              // 移动加权平均成本（含手续费）
  totalCostBasis: number;       // 总持仓成本
  realizedPnL: number;          // 已实现盈亏
  totalFee: number;             // 累计手续费
  /** T84：是否检出超卖。strictOversell=false 时用于「显示但暴露」，不得静默吞掉 */
  hasOversell?: boolean;
  oversellDetail?: OversellDetail | null;
}

export interface CalcOptions {
  /**
   * 超卖时的行为：
   * - `true`（默认）→ 抛 `PositionOversellError`，让脏状态无法被吞掉
   * - `false` → 不抛，但置 `hasOversell=true` 并把数量夹到 0（**不得产生负持仓**）
   *
   * 显示类调用方（持仓卡 / 复盘）应传 `false` 以免存量脏数据导致整页 500，
   * 但脏状态会通过 `hasOversell` 暴露出来，可上报告警。
   */
  strictOversell?: boolean;
}

export function calculateMovingWeightedCost(
  trades: TradeRecord[],
  opts: CalcOptions = {},
): PositionResult {
  const strict = opts.strictOversell ?? true;
  let totalQuantity = 0;
  let totalCostBasis = 0;
  let realizedPnL = 0;
  let totalFee = 0;
  let oversellDetail: OversellDetail | null = null;

  for (const trade of trades) {
    const fee = trade.fee ?? 0;
    totalFee += fee;

    if (trade.direction === 'buy') {
      const totalCost = trade.quantity * trade.price + fee;
      totalCostBasis += totalCost;
      totalQuantity += trade.quantity;
    } else if (trade.direction === 'sell') {
      // T84：卖出必须以「卖出发生时点」的持仓为准，且不得被静默跳过
      if (trade.quantity > totalQuantity) {
        const detail: OversellDetail = {
          date: trade.date,
          requested: trade.quantity,
          available: totalQuantity,
          shortfall: trade.quantity - totalQuantity,
        };
        if (strict) {
          throw new PositionOversellError(trade.date, trade.quantity, totalQuantity);
        }
        oversellDetail ??= detail;
        // 容错路径：按实际可卖数量结算，绝不允许出现负持仓
        if (totalQuantity <= 0) continue;
        const avgCost = totalCostBasis / totalQuantity;
        const sellQty = totalQuantity;
        const revenue = sellQty * trade.price - fee;
        realizedPnL += revenue - sellQty * avgCost;
        totalQuantity = 0;
        totalCostBasis = 0;
        continue;
      }
      if (totalQuantity <= 0) continue;  // 卖出 0 股，no-op
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
    hasOversell: oversellDetail !== null,
    oversellDetail,
  };
}
