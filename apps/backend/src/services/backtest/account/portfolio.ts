/**
 * 回测账户（M2）—— 持仓/现金/成本基/除权/回合交易
 *
 * 🔴 **口径唯一来源 = `@invest/core` 的 `calculateMovingWeightedCost`**
 *   （Requirements §5.2 / SDD §5.4；主服务与服务端同一套实现）。
 *   本文件**不自己写**成本算法：每次成交/除权后，把该标的的完整交易记录喂给 core，
 *   取回 `totalQuantity / avgCost / totalCostBasis / realizedPnL / cashReceived`。
 *
 * 这样做的代价是每笔成交要重算该标的的记录（O(该标的成交笔数)），
 * 收益是「不会和主服务漂移」—— 对回测（每标的成交笔数最多几百）完全可接受。
 *
 * 铁律：
 * - `transfer/bonus` **成本基不变**（core 的 bonus 分支只加数量，不碰 totalCostBasis）
 * - 卖出量按**可用持仓**封顶（T+1）由执行模拟器负责；本层再用 core 的 strictOversell 兜底
 * - 现金分红计入现金（不动成本基），`cashReceived` 是 core 的分量，**不含在 realizedPnL 里**
 */
import { calculateMovingWeightedCost, type TradeRecord } from '@invest/core';
import type { Fill } from '../execution/simulator.js';

/** 除权事件（由 `raw_gbbq` category=1 解析，口径对齐既有 `exDividendSync`） */
export interface CorporateAction {
  date: string;
  symbol: string;
  kind: 'dividend' | 'bonus';
  /** 每股派现额（元/份），= `c1 / 10` */
  cashPerShare?: number;
  /** 送转比例（每 1 份送转多少份），= `c3 / 10`；份数在除权日按当时持仓计算 */
  bonusRatio?: number;
}

/** 一笔平仓（部分卖出也记一笔，`exitReason` 供 M3 归因） */
export interface RoundTrip {
  symbol: string;
  openDate: string;
  closeDate: string;
  qty: number;
  /** 已实现盈亏（价差口径，成本含买入费用；不含分红 —— 与 core 一致） */
  pnl: number;
  /** pnl / 卖出部分成本基 */
  returnPct: number;
  exitReason: string;
  /** 卖出成交额 */
  proceeds: number;
}

/** 一笔已派现（M3 归因要把分红记到持有它的回合，不能让它在 `total.pnl` 里消失） */
export interface DividendRecord {
  date: string;
  symbol: string;
  /** 现金分红总额（元） */
  amount: number;
}

export interface PortfolioPosition {
  symbol: string;
  qty: number;
  avgCost: number;
  costBasis: number;
  closeableQty: number;
}

/** `Portfolio.restore()` 的输入：来自检查点（`paper_position` + 账户现金） */
export interface PortfolioRestorePosition {
  symbol: string;
  qty: number;
  /** 已在检查点算定的均价（含买入费用分摊）；合成成交价 = 该值 */
  avgCost: number;
  /** T+1 只剩「上一交易日及更早买入」的部分 */
  closeableQty: number;
}

export class Portfolio {
  private cashAmount: number;
  /** 逐标的交易记录（喂给 core 的唯一输入） */
  private readonly tradesBySymbol = new Map<string, TradeRecord[]>();
  /** 当日买入量（T+1 不可卖） */
  private readonly boughtToday = new Map<string, number>();
  /** 当前持仓的建仓日（用于回合交易） */
  private readonly openDateBySymbol = new Map<string, string>();
  readonly roundTrips: RoundTrip[] = [];
  /** 现金分红流水（M3 归因用；`RoundTrip.pnl` 不含分红，与 core 口径一致） */
  readonly dividends: DividendRecord[] = [];

  constructor(initialCash: number) {
    if (!(initialCash > 0)) throw new Error(`Portfolio: 初始现金必须 > 0（收到 ${initialCash}）`);
    this.cashAmount = initialCash;
  }

  /**
   * 从检查点恢复账户（纸面账户 §5.6）。
   *
   * 口径：每个持仓压**一笔合成 `buy`**（`price = avgCost`、`fee = 0`），喂给 core 重算出
   * 同样的 `costBasis / avgCost`；`boughtToday = qty − closeableQty` 复现决策视图的 T+1 冻结。
   * 结算阶段随后调用 `startDay()` 即全部可卖；决策阶段**不调用** `startDay()`。
   *
   * ⚠️ 恢复出来的 `roundTrips` 从空开始，`openDate` 会是恢复日 —— 回合报告必须走全量回放，
   * 不能用本实例的 `roundTrips`（§5.6）。
   */
  restore(positions: readonly PortfolioRestorePosition[], cash: number, date: string): void {
    if (this.tradesBySymbol.size > 0) {
      throw new Error('Portfolio.restore: 只能恢复到空账户（已有交易记录）');
    }
    if (!Number.isFinite(cash) || cash < 0) {
      throw new Error(`Portfolio.restore: 现金必须 ≥ 0 且有限（收到 ${cash}）`);
    }
    if (!date) throw new Error('Portfolio.restore: 恢复日不能为空');

    for (const p of positions) {
      if (!p.symbol) throw new Error('Portfolio.restore: symbol 不能为空');
      if (this.tradesBySymbol.has(p.symbol)) {
        throw new Error(`Portfolio.restore: 重复持仓 ${p.symbol}`);
      }
      if (!(p.qty > 0) || !Number.isFinite(p.qty)) {
        throw new Error(`Portfolio.restore: ${p.symbol} 持仓份数必须 > 0（收到 ${p.qty}）`);
      }
      if (!(p.avgCost >= 0) || !Number.isFinite(p.avgCost)) {
        throw new Error(`Portfolio.restore: ${p.symbol} 均价必须 ≥ 0（收到 ${p.avgCost}）`);
      }
      if (!(p.closeableQty >= 0) || p.closeableQty > p.qty) {
        throw new Error(
          `Portfolio.restore: ${p.symbol} 可用份数必须在 [0, ${p.qty}]（收到 ${p.closeableQty}）`,
        );
      }

      this.tradesBySymbol.set(p.symbol, [
        { date, direction: 'buy', quantity: p.qty, price: p.avgCost, fee: 0 },
      ]);
      const frozen = p.qty - p.closeableQty;
      if (frozen > 0) this.boughtToday.set(p.symbol, frozen);

      const st = this.stateOf(p.symbol);
      if (
        Math.abs(st.totalQuantity - p.qty) > 1e-9 ||
        Math.abs(st.avgCost - p.avgCost) > 1e-9 * Math.max(1, p.avgCost)
      ) {
        throw new Error(
          `Portfolio.restore: ${p.symbol} 重建结果与检查点不一致（qty ${st.totalQuantity} vs ${p.qty}，avgCost ${st.avgCost} vs ${p.avgCost}）`,
        );
      }
    }

    this.cashAmount = cash;
  }

  /** 新交易日开始：清空「当日买入」标记（T+1 每日重置） */
  startDay(): void {
    this.boughtToday.clear();
  }

  get cash(): number {
    return this.cashAmount;
  }

  /**
   * 现金直接入账（闲置现金计息用；**不产生成交记录、不进回合统计**）。
   * 与 `applyFill` 卖出分支不同：无手续费、不影响 `tradesBySymbol`。
   */
  creditCash(amount: number): void {
    if (amount > 0 && Number.isFinite(amount)) this.cashAmount += amount;
  }

  /** 某个标的的 core 状态（qty/avgCost/costBasis/realizedPnL） */
  private stateOf(symbol: string) {
    const trades = this.tradesBySymbol.get(symbol) ?? [];
    return calculateMovingWeightedCost(trades);
  }

  position(symbol: string): PortfolioPosition {
    const st = this.stateOf(symbol);
    const bought = this.boughtToday.get(symbol) ?? 0;
    return {
      symbol,
      qty: st.totalQuantity,
      avgCost: st.avgCost,
      costBasis: st.totalCostBasis,
      closeableQty: Math.max(0, st.totalQuantity - bought),
    };
  }

  /** 所有非零持仓（按 core 结果过滤） */
  positions(): PortfolioPosition[] {
    const out: PortfolioPosition[] = [];
    for (const symbol of this.tradesBySymbol.keys()) {
      const pos = this.position(symbol);
      if (pos.qty > 0) out.push(pos);
    }
    return out;
  }

  /** 应用一笔成交（调用方保证「先卖后买」的顺序） */
  applyFill(fill: Fill): void {
    const before = this.stateOf(fill.symbol);
    const trades = this.tradesBySymbol.get(fill.symbol) ?? [];

    if (fill.side === 'buy') {
      this.cashAmount -= fill.qty * fill.price + fill.fee;
      trades.push({
        date: fill.date,
        direction: 'buy',
        quantity: fill.qty,
        price: fill.price,
        fee: fill.fee,
      });
      this.tradesBySymbol.set(fill.symbol, trades);
      this.boughtToday.set(fill.symbol, (this.boughtToday.get(fill.symbol) ?? 0) + fill.qty);
      if (before.totalQuantity === 0) this.openDateBySymbol.set(fill.symbol, fill.date);
      return;
    }

    this.cashAmount += fill.qty * fill.price - fill.fee;
    trades.push({ date: fill.date, direction: 'sell', quantity: fill.qty, price: fill.price, fee: fill.fee });
    this.tradesBySymbol.set(fill.symbol, trades);

    const after = this.stateOf(fill.symbol);
    const pnl = after.realizedPnL - before.realizedPnL;
    // 卖出前均价（core 在卖出分支不改均价，用卖出前快照更直观且避免读到 after 的歧义）
    const costOfSold = fill.qty * before.avgCost;
    const openDate = this.openDateBySymbol.get(fill.symbol) ?? fill.date;
    this.roundTrips.push({
      symbol: fill.symbol,
      openDate,
      closeDate: fill.date,
      qty: fill.qty,
      pnl,
      returnPct: costOfSold > 0 ? pnl / costOfSold : 0,
      exitReason: fill.reason,
      proceeds: fill.qty * fill.price,
    });
    if (after.totalQuantity <= 0) this.openDateBySymbol.delete(fill.symbol);
  }

  /**
   * 应用除权事件（在成交日开盘前调用）
   *
   * - `dividend`：现金 += 持仓 × 每股派现；core 记一笔 `dividend`（quantity=持仓, price=每股派现）
   * - `bonus`：持仓 += 送转份数；core 记一笔 `bonus`（quantity=送转, price=0），**成本基不变**
   */
  applyCorporateActions(actions: readonly CorporateAction[]): void {
    // core 口径（SDD_v3 §8.3）：同日**先送股后分红**，分红基数以送股后股数为准。
    // `Array.prototype.sort` 稳定 ⇒ 同类型事件保持输入顺序。
    const ordered = [...actions].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'bonus' ? -1 : 1));
    for (const a of ordered) {
      const qty = this.stateOf(a.symbol).totalQuantity;
      if (qty <= 0) continue;
      const trades = this.tradesBySymbol.get(a.symbol) ?? [];
      if (a.kind === 'dividend') {
        const perShare = a.cashPerShare ?? 0;
        if (perShare <= 0) continue;
        const amount = qty * perShare;
        this.cashAmount += amount;
        this.dividends.push({ date: a.date, symbol: a.symbol, amount });
        trades.push({ date: a.date, direction: 'dividend', quantity: qty, price: perShare });
      } else {
        const ratio = a.bonusRatio ?? 0;
        if (ratio <= 0) continue;
        const add = qty * ratio;
        trades.push({ date: a.date, direction: 'bonus', quantity: add, price: 0 });
      }
      this.tradesBySymbol.set(a.symbol, trades);
    }
  }

  /** 持仓市值（价格缺失时按 0 计；引擎负责「停牌沿用最近有效价」） */
  marketValue(prices: ReadonlyMap<string, number>): number {
    let mv = 0;
    for (const pos of this.positions()) {
      mv += pos.qty * (prices.get(pos.symbol) ?? 0);
    }
    return mv;
  }

  /** 权益 = 现金 + 全部持仓市值 */
  equity(prices: ReadonlyMap<string, number>): number {
    return this.cashAmount + this.marketValue(prices);
  }
}
