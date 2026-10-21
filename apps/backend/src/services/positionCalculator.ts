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
 *
 * 🔴 **T60（Wave 8）N+1 消除** —— 此前实现是
 *   `codes.map((c) => calcPosition(userId, c.asset_code))`
 * ⇒ **每个标的一次 SQLite 查询**（30 只持仓 = 1 次 DISTINCT + 30 次单标的查询 = 31 次），
 *   查询次数随标的数**线性增长**（AGENTS.md「批量查询必须一次拿 100+ 标的」的同款反模式，
 *   只是发生在 SQLite 侧而不是 DuckDB 侧）。
 *
 * ⇒ 改为：**1 次查询**取回该用户的全部交易记录 → 内存里按 `asset_code` 分组
 *   → 每组喂给 core 的 `calculateMovingWeightedCost`（**纯函数，不碰 DB**）。
 * ⇒ 查询次数恒为 **1**，与标的数无关（30 只持仓 = 1 次查询）。
 *
 * ── 口径等价性（必须逐位相同）──
 * ① 分组用的 WHERE / ORDER BY 与 `calcPosition` 的单标的查询**逐字一致**
 *    （`user_id = ? AND is_deleted = 0` + `ORDER BY trade_date ASC, trade_time ASC, id ASC`）；
 *    `calcAllPositions` 从不传 `asOfDate`，故单标的查询里的 `(? IS NULL OR …)` 恒为真
 *    ⇒ 两者取到的行集合与行序**完全相同**。
 * ② **输出的标的集合不变**：旧实现先取 `DISTINCT asset_code`（含只有
 *    dividend/bonus/transfer 的标的），再逐个算；新实现按「全部行」分组
 *    ⇒ 只有分红记录的标的**仍会出现在结果里**（持仓量为 0），
 *    若按「有买卖记录才建组」实现就会**悄悄丢掉这些标的**（返回数组变短）。
 * ③ 计算口径不变：仍是 `calculateMovingWeightedCost(..., { strictOversell: false })`。
 */
export function calcAllPositions(userId: number): Array<{ asset_code: string } & PositionResult> {
  const db = ConfigStore.getInstance().db;

  // 🔴 **1 次查询**（不再是 1 + N 次）
  const rows = db
    .prepare(
      `SELECT id, user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted
       FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0
       ORDER BY trade_date ASC, trade_time ASC, id ASC`,
    )
    .all(userId) as DbTradeRow[];

  // 按 asset_code 分组（**保留只有分红类记录的标的**，见上方口径等价性 ②）
  const grouped = new Map<string, DbTradeRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.asset_code);
    if (list) list.push(row);
    else grouped.set(row.asset_code, [row]);
  }

  const result: Array<{ asset_code: string } & PositionResult> = [];
  for (const [assetCode, codeRows] of grouped) {
    const coreTrades = codeRows.map(mapToCoreTrade).filter((t): t is CoreTrade => t !== null);
    result.push({
      asset_code: assetCode,
      ...calculateMovingWeightedCost(coreTrades, { strictOversell: false }),
    });
  }

  // 排序口径 = **asset_code 升序**（与重写前的 `SELECT DISTINCT asset_code` 的返回序一致：
  // SQLite 的 DISTINCT 走 `idx_trade_asset (user_id, asset_code)` 索引 / 临时 B-tree，
  // 两种路径都是**字节序升序**）⇒ 重写前后响应数组的**顺序逐项相同**。
  // ⚠️ 用 `<` / `>` 而不是 `localeCompare` —— 后者是语言环境相关的排序，
  //    与 SQLite 默认的 BINARY  collation 不等价。
  result.sort((a, b) => (a.asset_code < b.asset_code ? -1 : a.asset_code > b.asset_code ? 1 : 0));

  return result;
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

    // 🔴 `add`（加仓）**必须**与 `buy` 同分支 —— 它是买入，不是卖出。
    //   误落 else 分支 → 加仓被记成一笔「平仓」（凭空多出已实现盈亏、持仓被扣减），
    //   复盘页胜率 / 盈亏比全部失真，且后续真实减仓因持仓被提前扣光而**整笔被跳过**。
    //   与上方 `mapToCoreTrade` 的 `case 'buy': case 'add':` 共用分支保持同口径。
    if (row.trade_type === 'buy' || row.trade_type === 'add') {
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
