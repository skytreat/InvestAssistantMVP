/**
 * 成交模拟器（M2）—— 依据 proposal §5.1「成交与摩擦」表
 *
 * 铁律（逐条对应设计稿行）：
 * - 成交价：决策 T-1 收盘 → **T 开盘价成交**（也支持 T 收盘价口径，`priceMode='close'`）
 * - 滑点：买 +1bp / 卖 -1bp
 * - 佣金：成交额 × 0.01%，**最低 5 元**；ETF **免印花税**
 * - 整手：100 份，向下取整；不足 100 份但现金够则按 100 份（v5.2 行为）
 * - 最小成交额：< 10 元不下单（避免 1 股噪声成交）
 * - T+1：当日买入不可卖，卖出量按**可用持仓**封顶
 * - 涨跌停（ETF ±10%，可用参数覆盖）：开盘价 >= 涨停 → 买不进；<= 跌停 → 卖不出
 * - 停牌：缺 bar 或 volume=0（M1 两形态）→ 当日该标的跳过
 * - 顺序：**先卖后买**（卖出释放现金后再买，避免「差一分钱买不进」）
 *
 * ⚠️ 本模块**不持有持仓状态**：`positionOf` 由账户层提供（引擎在应用成交前调用一次）。
 * 这样同一份模拟器既能单测（传入假持仓），也能在引擎里逐日复用。
 */
import type { SuspensionVerdict } from '../types.js';
import type { TargetPosition } from '../strategy/types.js';

/** 交易规则（费用/滑点/整手/涨跌停） */
export interface TradeRules {
  /** 佣金费率（双边） */
  commissionRate: number;
  /** 单笔最低佣金（元） */
  minCommission: number;
  /** 滑点比例（买 +、卖 -） */
  slippageRate: number;
  /** 整手份数 */
  lotSize: number;
  /** 最小成交额（元），低于此值跳过 */
  minNotional: number;
  /** 涨跌停幅度（0.10 = ±10%） */
  priceLimit: number;
}

export const DEFAULT_TRADE_RULES: Readonly<TradeRules> = Object.freeze({
  commissionRate: 0.0001,
  minCommission: 5,
  slippageRate: 0.0001,
  lotSize: 100,
  minNotional: 10,
  priceLimit: 0.1,
});

/** 模拟器需要的 bar（成交轨 bfq，含 preclose 用于涨跌停判定） */
export interface ExecutionBar {
  open: number;
  close: number;
  preclose: number;
  volume: number;
}

/** 账户提供的持仓状态（T+1：`closeableQty` = 上一交易日及更早买入的部分） */
export interface PositionState {
  qty: number;
  closeableQty: number;
}

/** 跳过原因（落库/单测断言用） */
export type SkipReason =
  | 'suspended'
  | 'limit-up'
  | 'limit-down'
  | 't-plus-1'
  | 'no-position'
  | 'round-lot-zero'
  | 'below-min-notional'
  | 'insufficient-cash'
  | 'no-target-value'
  /** 换手上限把增仓额度裁到不足一手（引擎在调用前完成缩放） */
  | 'turnover-capped';

/** 一笔成交（price 为**含滑点后的实际成交价**） */
export interface Fill {
  date: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  /** 佣金（元，四舍五入到分） */
  fee: number;
  /** 滑点成本（元，仅报告用；已包含在 price 里） */
  slippageCost: number;
  reason: string;
}

/** 一笔被跳过的委托 */
export interface SkippedOrder {
  date: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  reason: SkipReason;
  /** 附加上下文（如停牌子原因 'missing-bar'） */
  detail?: string;
}

export interface ExecutionRequest {
  date: string;
  targets: readonly TargetPosition[];
  mode: 'replace' | 'incremental';
  /** replace 模式下需要清算的持仓（不在 targets 里） */
  heldSymbols: readonly string[];
  /** 决策时点（T-1 收盘）权益，用于 targetWeight → 金额 */
  equityAtCutoff: number;
  cash: number;
  priceMode?: 'open' | 'close';
  rules?: Partial<TradeRules>;
  positionOf(symbol: string): PositionState;
  barOf(symbol: string): ExecutionBar | undefined;
  suspensionOf(symbol: string): SuspensionVerdict;
  /**
   * `replace` 模式清仓的逐标的退出原因（M3 归因用）。
   * 缺省回退 `rebalance-replace`；减仓（未清仓）仍记 `rebalance-replace`。
   */
  exitReasons?: Readonly<Record<string, string>>;
}

export interface ExecutionResult {
  fills: Fill[];
  skipped: SkippedOrder[];
  /** 现金变动（= 卖出净额 - 买入总额 - 费用；引擎据此核对恒等式） */
  cashDelta: number;
}

/** 金额四舍五入到分（佣金最小 5 元，必须落到分） */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function commissionOf(notional: number, rules: TradeRules): number {
  return round2(Math.max(rules.minCommission, notional * rules.commissionRate));
}

/** 目标仓位 → 目标金额（targetNotional 优先） */
function targetNotionalOf(t: TargetPosition, equityAtCutoff: number): number | null {
  if (t.targetNotional !== undefined) return t.targetNotional;
  if (t.targetWeight !== undefined) return t.targetWeight * equityAtCutoff;
  return null;
}

/** 成交价（含滑点） */
function execPriceOf(
  bar: ExecutionBar,
  priceMode: 'open' | 'close',
  side: 'buy' | 'sell',
  rules: TradeRules,
): number {
  const base = priceMode === 'close' ? bar.close : bar.open;
  return side === 'buy' ? base * (1 + rules.slippageRate) : base * (1 - rules.slippageRate);
}

/**
 * 按目标仓位生成成交。
 *
 * @returns fills（按「先卖后买」的实际执行顺序）+ skipped + cashDelta
 */
export function executeTargets(req: ExecutionRequest): ExecutionResult {
  const rules: TradeRules = { ...DEFAULT_TRADE_RULES, ...(req.rules ?? {}) };
  const priceMode = req.priceMode ?? 'open';
  const fills: Fill[] = [];
  const skipped: SkippedOrder[] = [];
  let cash = req.cash;

  const targetBySymbol = new Map(req.targets.map((t) => [t.symbol, t]));

  /** 涨跌停判定：用**未含滑点**的开/收盘价与 preclose 比 */
  const isLimitUp = (bar: ExecutionBar): boolean => {
    const p = priceMode === 'close' ? bar.close : bar.open;
    return bar.preclose > 0 && p >= bar.preclose * (1 + rules.priceLimit);
  };
  const isLimitDown = (bar: ExecutionBar): boolean => {
    const p = priceMode === 'close' ? bar.close : bar.open;
    return bar.preclose > 0 && p <= bar.preclose * (1 - rules.priceLimit);
  };

  /** 卖出可执行性检查（返回 null 表示可卖，否则写 skipped） */
  const checkSell = (
    symbol: string,
    qtyWanted: number,
  ): { bar: ExecutionBar; price: number } | SkippedOrder => {
    const verdict = req.suspensionOf(symbol);
    const bar = req.barOf(symbol);
    const base = { date: req.date, symbol, side: 'sell' as const, qty: qtyWanted };
    if (verdict.suspended || !bar) {
      return { ...base, reason: 'suspended', detail: verdict.reason ?? 'missing-bar' };
    }
    if (isLimitDown(bar)) return { ...base, reason: 'limit-down' };
    const pos = req.positionOf(symbol);
    if (qtyWanted <= 0 || pos.qty <= 0) return { ...base, reason: 'no-position' };
    if (pos.closeableQty <= 0) return { ...base, reason: 't-plus-1' };
    return { bar, price: execPriceOf(bar, priceMode, 'sell', rules) };
  };

  const pushSell = (symbol: string, qtyWanted: number, reason: string): void => {
    const checked = checkSell(symbol, qtyWanted);
    if ('reason' in checked) {
      skipped.push(checked);
      return;
    }
    const pos = req.positionOf(symbol);
    // 卖出量按可用持仓封顶（T+1）—— 不静默放大，也不整手取整（清仓可以卖零股）
    const qty = Math.min(Math.floor(qtyWanted), Math.floor(pos.closeableQty));
    if (qty <= 0) {
      skipped.push({ date: req.date, symbol, side: 'sell', qty: qtyWanted, reason: 't-plus-1' });
      return;
    }
    const notional = qty * checked.price;
    const fee = commissionOf(notional, rules);
    cash += notional - fee;
    fills.push({
      date: req.date,
      symbol,
      side: 'sell',
      qty,
      price: checked.price,
      fee,
      slippageCost:
        qty * Math.abs(checked.price - (priceMode === 'close' ? checked.bar.close : checked.bar.open)),
      reason,
    });
  };

  // ── 1) 卖出：先处理 replace 模式下的清算，再处理 targets 的减仓 ──
  if (req.mode === 'replace') {
    for (const symbol of req.heldSymbols) {
      if (targetBySymbol.has(symbol)) continue;
      const pos = req.positionOf(symbol);
      if (pos.qty <= 0) continue;
      pushSell(symbol, pos.qty, req.exitReasons?.[symbol] ?? 'rebalance-replace');
    }
  }

  for (const t of req.targets) {
    const pos = req.positionOf(t.symbol);
    if (pos.qty <= 0) continue;
    const targetNotional = targetNotionalOf(t, req.equityAtCutoff);
    if (targetNotional === null) continue;
    const bar = req.barOf(t.symbol);
    if (!bar) {
      // 没有 T 日行情，无法判断目标份数；交由买入分支的停牌判定统一报 skipped
      continue;
    }
    const base = priceMode === 'close' ? bar.close : bar.open;
    if (base <= 0) continue;
    const targetQty = Math.floor(targetNotional / base);
    if (pos.qty <= targetQty) continue;
    pushSell(t.symbol, pos.qty - targetQty, 'rebalance-replace');
  }

  // ── 2) 买入 ──
  for (const t of req.targets) {
    const targetNotional = targetNotionalOf(t, req.equityAtCutoff);
    const baseOrder = { date: req.date, symbol: t.symbol, side: 'buy' as const, qty: 0 };
    if (targetNotional === null) {
      skipped.push({ ...baseOrder, reason: 'no-target-value' });
      continue;
    }
    const verdict = req.suspensionOf(t.symbol);
    const bar = req.barOf(t.symbol);
    if (verdict.suspended || !bar) {
      skipped.push({ ...baseOrder, reason: 'suspended', detail: verdict.reason ?? 'missing-bar' });
      continue;
    }
    if (isLimitUp(bar)) {
      skipped.push({ ...baseOrder, reason: 'limit-up' });
      continue;
    }

    const price = execPriceOf(bar, priceMode, 'buy', rules);
    if (price <= 0) continue;
    const pos = req.positionOf(t.symbol);
    const delta = targetNotional - pos.qty * price;
    if (delta <= 0) continue; // 已达到/超过目标，不加仓（超出部分由卖出分支处理）

    const rawQty = Math.floor(delta / price);
    let qty = Math.floor(rawQty / rules.lotSize) * rules.lotSize;
    if (qty === 0 && rawQty >= 1) {
      // v5.2 行为：不足 100 份但现金够 → 按 100 份
      qty = rules.lotSize;
    }
    if (qty <= 0) {
      skipped.push({ ...baseOrder, qty: 0, reason: 'round-lot-zero' });
      continue;
    }
    if (qty * price < rules.minNotional) {
      skipped.push({ ...baseOrder, qty, reason: 'below-min-notional' });
      continue;
    }

    // 现金约束：不够就按整手递减（费用随成交额变，需重算）
    let fee = commissionOf(qty * price, rules);
    while (qty > 0 && cash < qty * price + fee) {
      qty -= rules.lotSize;
      fee = qty > 0 ? commissionOf(qty * price, rules) : 0;
    }
    if (qty <= 0) {
      skipped.push({ ...baseOrder, qty: 0, reason: 'insufficient-cash' });
      continue;
    }

    const notional = qty * price;
    cash -= notional + fee;
    fills.push({
      date: req.date,
      symbol: t.symbol,
      side: 'buy',
      qty,
      price,
      fee,
      slippageCost: qty * Math.abs(price - (priceMode === 'close' ? bar.close : bar.open)),
      reason: t.reason,
    });
  }

  return { fills, skipped, cashDelta: cash - req.cash };
}

/** 佣金口径（单测直接断言） */
export { commissionOf };
