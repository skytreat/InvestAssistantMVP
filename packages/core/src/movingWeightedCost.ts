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

/**
 * V3.0（T119）：direction 扩为 4 值（SDD_v3 §8.2 CoreTradeDirection）。
 * - `bonus`：送股。price 语义 = 0；quantity = 送股数
 * - `dividend`：现金分红。price 语义 = 每股分红额；quantity = 分红股数基数
 * 既有调用方（只传 buy/sell）无需改动；新增 2 值对既有行为零影响。
 */
export interface TradeRecord {
  date: string;
  direction: 'buy' | 'sell' | 'bonus' | 'dividend';
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
  totalQuantity: number; // 当前持仓数量
  avgCost: number; // 移动加权平均成本（含手续费）
  totalCostBasis: number; // 总持仓成本
  realizedPnL: number; // 已实现盈亏（价差口径，**不含分红** —— T119）
  totalFee: number; // 累计手续费
  /**
   * T119：累计现金分红（Σ quantity × price，price = 每股分红额）。
   * 与 `realizedPnL` **分别呈现**：价差盈亏不含分红；「含分红净利」= realizedPnL + cashReceived（上层负责加总，core 只给两个分量）。
   * 新增必填字段：纯函数恒返回，既有调用方读旧字段不受影响。
   */
  cashReceived: number;
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

export function calculateMovingWeightedCost(trades: TradeRecord[], opts: CalcOptions = {}): PositionResult {
  const strict = opts.strictOversell ?? true;

  /**
   * T119 同日顺序规则（SDD_v3 §8.3 / Requirements §3.6 INV-S4-11~17）：
   * 同日**先送股后分红** —— 分红基数以送股后股数为准。
   * 规则落在 core（上层不得单独预处理）：按 date 分组做**稳定**重排，
   * 组内优先级 bonus(0) < dividend(1) < 其它(2)，同级保持输入相对顺序。
   * 输入若是除权模块产出（同日 bonus/dividend 同为 00:00:00，靠行 id 区分先后），
   * 重排后口径即正确，与记录插入顺序无关。
   */
  const orderOf: Record<TradeRecord['direction'], number> = { bonus: 0, dividend: 1, buy: 2, sell: 2 };
  const ordered = [...trades]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (a.t.date !== b.t.date) return a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : 0;
      const d = orderOf[a.t.direction] - orderOf[b.t.direction];
      if (d !== 0) return d;
      return a.i - b.i; // 稳定：同优先级保持原序
    })
    .map((x) => x.t);

  let totalQuantity = 0;
  let totalCostBasis = 0;
  let realizedPnL = 0;
  let totalFee = 0;
  let cashReceived = 0;
  let oversellDetail: OversellDetail | null = null;

  for (const trade of ordered) {
    const fee = trade.fee ?? 0;
    totalFee += fee;

    if (trade.direction === 'buy') {
      const totalCost = trade.quantity * trade.price + fee;
      totalCostBasis += totalCost;
      totalQuantity += trade.quantity;
    } else if (trade.direction === 'bonus') {
      // T119 送股：股数 +n，总成本不变，均价按 Q/(Q+n) 摊薄，不产生价差盈亏
      totalQuantity += trade.quantity;
    } else if (trade.direction === 'dividend') {
      // T119 现金分红：股数与成本不变，现金 += 股数 × 每股分红额，不产生价差盈亏
      cashReceived += trade.quantity * trade.price;
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
      if (totalQuantity <= 0) continue; // 卖出 0 股，no-op
      const avgCost = totalCostBasis / totalQuantity;
      const revenue = trade.quantity * trade.price - fee;
      realizedPnL += revenue - trade.quantity * avgCost;
      totalQuantity -= trade.quantity;
      totalCostBasis = totalQuantity * avgCost; // 卖出后成本基按剩余数量等比减少
    }
  }

  return {
    totalQuantity,
    avgCost: totalQuantity > 0 ? totalCostBasis / totalQuantity : 0,
    totalCostBasis,
    realizedPnL,
    totalFee,
    cashReceived,
    hasOversell: oversellDetail !== null,
    oversellDetail,
  };
}
