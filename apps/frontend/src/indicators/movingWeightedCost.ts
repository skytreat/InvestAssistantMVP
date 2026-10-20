/**
 * 移动加权平均成本 —— **前端适配层**（T68）
 *
 * ## 为什么前端要有一份
 *
 * AGENTS.md 硬约束：「**apps/frontend 禁止直接 import packages/core**」——
 * 前后端通过 HTTP API 通信，算法口径一致性靠 **golden 数据集**在 CI 里验证。
 * ⇒ 本文件是 `packages/core/src/movingWeightedCost.ts` 的**逐位等价副本**，
 *   与 `src/indicators/kdj.ts` / `src/indicators/bollinger.ts` 同一套路。
 *
 * 🔒 **两份实现必须保持口径一致** —— 由
 *   `apps/frontend/tests/unit/trade-input.test.tsx` 对
 *   `packages/core/tests/fixtures/golden/movingWeightedCost.json`（5 个场景）逐条断言兜底。
 *   **改本文件必须同步改 core**（否则 G5「双端计算口径一致」门槛 FAIL）。
 *
 * ## 本文件放什么
 *
 * - `calculateMovingWeightedCost`：core 的**逐行等价**实现（交易序列 → 持仓结果）；
 * - `TRADE_TYPE_DIRECTION`：交易类型 → 移动加权方向（与后端 `positionCalculator.mapToCoreTrade` 同口径）；
 * - `estimateNewPosition`：**单笔交易对持仓的实时预估**（交易录入页的预估面板用）。
 *
 * ⚠️ 本文件是**纯计算**，不碰任何 UI / 网络 / 存储。
 *
 * ## 业务口径依据
 *
 * - `Requirements_simplified.md` §5.3：
 *   `新均价 = (原持仓数 × 原均价 + 买入数 × 买入价 + 买入手续费) / (原持仓数 + 买入数)`
 * - 卖出只减数量，**均价不变**；卖出手续费**不计入成本**（只抵扣本次盈亏）。
 */

export interface TradeRecord {
  date: string;
  direction: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee?: number;
}

/**
 * 超卖业务异常（core `PositionOversellError` 的等价副本）
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
  realizedPnL: number; // 已实现盈亏
  totalFee: number; // 累计手续费
  /** 是否检出超卖。strictOversell=false 时用于「显示但暴露」，不得静默吞掉 */
  hasOversell?: boolean;
  oversellDetail?: OversellDetail | null;
}

export interface CalcOptions {
  /**
   * 超卖时的行为：
   * - `true`（默认）→ 抛 `PositionOversellError`，让脏状态无法被吞掉
   * - `false` → 不抛，但置 `hasOversell=true` 并把数量夹到 0（**不得产生负持仓**）
   */
  strictOversell?: boolean;
}

/**
 * 移动加权平均成本（core `calculateMovingWeightedCost` 的逐行等价实现）
 *
 * ⚠️ 与 core 的差异**仅限**：`PositionOversellError` 的类声明位置与错误文案逐字一致。
 *    算法本身（买入加成本、卖出按均价结算、成本基等比减少）**逐行一致**。
 */
export function calculateMovingWeightedCost(trades: TradeRecord[], opts: CalcOptions = {}): PositionResult {
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
      // 卖出必须以「卖出发生时点」的持仓为准，且不得被静默跳过
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
    hasOversell: oversellDetail !== null,
    oversellDetail,
  };
}

/* ------------------------------------------------------------------ *
 * 交易类型 → 移动加权方向
 * ------------------------------------------------------------------ */

/**
 * 7 种交易类型在移动加权里的方向
 *
 * 🔒 **与后端 `apps/backend/src/services/positionCalculator.ts` 的 `mapToCoreTrade` 同口径**：
 * - `buy` / `add` → `'buy'`（**`add` 必须映射为 buy** —— 它是买入，仓位应增加；
 *   历史上把 add 落进 sell 分支导致「加仓后持仓直接归零」，见后端源码 §4-A 注释）；
 * - `reduce` / `clear` → `'sell'`；
 * - `dividend` / `bonus` / `transfer` → `null`（**不参与移动加权**）。
 *
 * ⚠️ 「送股 / 转增不计入持仓数量」是**后端当前实现**的口径
 *   （`mapToCoreTrade` 对这三类返回 `null`），与 `Requirements_simplified.md` §5.3
 *   「送转股只增加持仓数量」**不一致** —— 这是**后端已登记的待裁决项**
 *   （见 `apps/backend/src/routes/trade.ts` 文件头注释），前端**照后端口径**实现，
 *   避免预估面板显示的数字与成交后持仓对不上（G5 口径漂移）。
 */
export const TRADE_TYPE_DIRECTION = {
  buy: 'buy',
  add: 'buy',
  reduce: 'sell',
  clear: 'sell',
  dividend: null,
  bonus: null,
  transfer: null,
} as const;

/** 移动加权方向（`'buy'` / `'sell'`）*/
export type TradeDirection = 'buy' | 'sell';

/* ------------------------------------------------------------------ *
 * 实时预估（交易录入页的预估面板）
 * ------------------------------------------------------------------ */

/** 当前持仓（来自 `GET /api/holding/:asset_code`）*/
export interface HoldingInfo {
  /** 当前持仓数量 */
  quantity: number;
  /** 当前移动加权均价 */
  avgCost: number;
}

/** 单笔交易的实时预估入参 */
export interface EstimateInput {
  /** 交易前的持仓数量 */
  currentQuantity: number;
  /** 交易前的移动加权均价 */
  currentAvgCost: number;
  /** 本笔方向（买 / 卖）*/
  direction: TradeDirection;
  /** 本笔数量 */
  quantity: number;
  /** 本笔价格 */
  price: number;
  /** 本笔手续费 */
  fee: number;
}

/** 单笔交易的实时预估结果 */
export interface EstimateResult {
  /** 本次金额 = 数量 × 价格 */
  totalAmount: number;
  /** 本次手续费 */
  totalFee: number;
  /** 交易后的持仓数量 */
  newQuantity: number;
  /** 交易后的移动加权均价（持仓清零时为 0 —— 与后端 `calcPosition` 同口径）*/
  newAvgCost: number;
  /** 交易后的总成本基 */
  newCostBasis: number;
  /** 是否超出持仓（卖出数量 > 当前持仓）*/
  oversold: boolean;
  /** 可卖上限（= 当前持仓数量）*/
  available: number;
}

/**
 * 单笔交易对持仓的**实时预估**
 *
 * ## 为什么用「合成前序买入」而不是直接写公式
 *
 * 直接写 `(q0*p0 + q*p + fee) / (q0 + q)` 是**第二份公式** —— 一旦 core 改了算法，
 * 前端预估就会静默漂移（G5 门槛 FAIL）。
 * ⇒ 本函数把「当前持仓」合成成一笔前序买入（数量 = 当前持仓、价格 = 当前均价、手续费 = 0），
 *   再与本笔一起交给 **同一个** `calculateMovingWeightedCost` 计算 ——
 *   **公式只有一份**（core 的实现），预估只是它的另一个入口。
 *
 * 由此得到的口径与 Requirements §5.3 的公式**逐字等价**：
 * `新均价 = (原持仓数 × 原均价 + 买入数 × 买入价 + 买入手续费) / (原持仓数 + 买入数)`。
 *
 * 边界：
 * - 持仓为 0 时买入 → 等同首次建仓（均价 = 买入价 + 手续费摊薄）；
 * - 卖出 → 均价不变（成本基按剩余数量等比减少），与 core 一致；
 * - 卖出数量 > 持仓 → `oversold = true`，且 `newQuantity` 被夹到 0（**不产生负持仓**）。
 */
export function estimateNewPosition(input: EstimateInput): EstimateResult {
  const { currentQuantity, currentAvgCost, direction, quantity, price, fee } = input;

  const trades: TradeRecord[] = [];
  if (currentQuantity > 0) {
    // 合成「当前持仓」：数量 × 均价 = 当前成本基（手续费已含在均价里，不重复计入）
    trades.push({
      date: '1970-01-01',
      direction: 'buy',
      quantity: currentQuantity,
      price: currentAvgCost,
      fee: 0,
    });
  }
  trades.push({ date: '1970-01-01', direction, quantity, price, fee });

  const result = calculateMovingWeightedCost(trades, { strictOversell: false });

  return {
    totalAmount: quantity * price,
    totalFee: fee,
    newQuantity: result.totalQuantity,
    newAvgCost: result.avgCost,
    newCostBasis: result.totalCostBasis,
    oversold: direction === 'sell' && quantity > currentQuantity,
    available: currentQuantity,
  };
}
