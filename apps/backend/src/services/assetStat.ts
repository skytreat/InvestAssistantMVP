// src/services/assetStat.ts
// T26: user_asset_stat 双口径资产快照写入（SDD §5.1 17:02 信号生成最后一步）
//
// 双口径定义（SDD A6/A7）：
//   price 口径：纯价格收益率，不含除权分红 → yield = (MV - cost) / cost
//   actual 口径：总收益率，含除权分红福利 → yield = (MV - cost + dividends) / cost
//
// 实现层不动 core 包 calculateMovingWeightedCost（有 golden 数据集 24 测试），
// 在应用层查 user_trade_record 里除权交易汇总累计分红/送转金额。

import { ConfigStore } from '../config/configStore.js';
import { calcAllPositions } from './positionCalculator.js';
import { batchGetDaily, batchGetDailyRangeByView, fetchAssetClasses } from './marketData.js';

/**
 * 查用户累计收到的除权福利（分红 + 送转 + 配股）
 * SDD §5.8：exDividendSync 17:03 往 user_trade_record 写 trade_type IN ('dividend','bonus','transfer')
 * T119 起：positionCalculator.mapToCoreTrade 已把 dividend/bonus 映射进 core（bonus 摊薄均价、
 * dividend 进 cashReceived）→ totalCostBasis/totalQuantity 已含送股效应；
 * 这里仍单独汇总 price×quantity（bonus 行 price=0 天然不贡献）= actual 口径需要加回的分红金额
 */
function getTotalDividends(userId: number): number {
  const db = ConfigStore.getInstance().db;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(price * quantity), 0) AS total
     FROM user_trade_record
     WHERE user_id = ? AND trade_type IN ('dividend','bonus','transfer') AND is_deleted = 0`,
    )
    .get(userId) as { total: number };
  return row.total;
}

/**
 * 双口径资产快照写入（SDD §5.1 信号生成最后一步）
 *
 * 空持仓用户也写快照（全零），保证 user_asset_stat 每天都有一条记录。
 *
 * @returns 实际写入的快照条数（= 活跃用户数，含空持仓）
 * @throws 任何 DB / DuckDB / 计算异常 → 由 scheduler 调用方捕获写 WARN 日志
 */
export async function insertAssetStatSnapshots(tradeDate: string): Promise<{ inserted: number }> {
  const db = ConfigStore.getInstance().db;

  // 1. 拿所有用户
  const users = db.prepare('SELECT id FROM user_account').all() as { id: number }[];
  if (users.length === 0) return { inserted: 0 };

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO user_asset_stat
      (user_id, trade_date, total_assets_price_yield, total_assets_actual_yield, total_profit_price, total_profit_actual)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;

  for (const user of users) {
    // 2. 算持仓（T119 起 costBasis 含送股摊薄效应；dividend 不进 costBasis，经 totalDividends 加回 actual 口径）
    const positions = calcAllPositions(user.id);
    // 3. 查累计除权福利
    const totalDividends = getTotalDividends(user.id);

    if (positions.length === 0 && totalDividends === 0) {
      // 空持仓 + 无分红：写全零快照
      stmt.run(user.id, tradeDate, 0, 0, 0, 0);
      inserted++;
      continue;
    }

    // 4. 1 次 IN 查询拿所有标的当日收盘价（SDD §5.3 硬约束：禁止逐标的循环查 DuckDB）
    let totalMarketValue = 0;
    let totalCostBasis = 0;

    if (positions.length > 0) {
      const symbols = positions.map((p) => p.asset_code);
      const priceMap = await batchGetDaily(symbols, tradeDate);
      for (const pos of positions) {
        const kline = priceMap.get(pos.asset_code);
        const close = kline?.close ?? 0; // DuckDB 无数据 → 用 0，不 NaN
        totalMarketValue += pos.totalQuantity * close;
        totalCostBasis += pos.totalCostBasis;
      }
    }

    // 5. 双口径利润 + 收益率
    const priceProfit = totalMarketValue - totalCostBasis; // 纯价格利润
    const actualProfit = priceProfit + totalDividends; // 含分红福利
    const priceYield = totalCostBasis > 0 ? priceProfit / totalCostBasis : 0;
    const actualYield = totalCostBasis > 0 ? actualProfit / totalCostBasis : 0;

    stmt.run(
      user.id,
      tradeDate,
      priceYield,
      actualYield, // total_assets_price_yield, total_assets_actual_yield
      priceProfit,
      actualProfit, // total_profit_price, total_profit_actual
    );
    inserted++;
  }

  return { inserted };
}

export interface MonthlyCashFlowPoint {
  /** 自然月 YYYY-MM */
  month: string;
  /** 现金流口径当月盈亏 = 卖出回款 − 买入支出 + 现金分红（送股/拆分/调账不计现金流）*/
  cashFlow: number;
  /** 当月买入支出（正数）*/
  buyOut: number;
  /** 当月卖出回款（含手续费扣减）*/
  sellIn: number;
  /** 当月现金分红（正数）*/
  dividend: number;
}

/**
 * 按月汇总「现金流口径」盈亏（交易复盘页月度柱状图数据源）
 *
 * 为什么要单独算：`user_asset_stat` 是**每日快照**，靠月末最后一条做差分只能得到
 * 持有口径的盈亏变化，且**必须每天有行情**才能写。行情库停止更新 / 当月尚无快照时
 * 就没有数据点（11 月缺失即此类）。本函数只依赖 `user_trade_record`，不依赖行情，
 * 故当月也能立即出数。
 *
 * 口径（与 owner 2026-11-06 的决策一致）：
 * - 买入 / 加仓 → 现金流出 `quantity * price + fee`
 * - 减仓 / 清仓 → 现金流入 `quantity * price - fee`
 * - 现金分红 → 现金流入 `price * quantity`（分红行 quantity 存 1、price 存金额）
 * - 送股 / 拆分 / 调账转入 → 0（不产生现金流）
 *
 * @param months 回溯的自然月数（含当月），默认 12
 */
export function computeMonthlyCashFlow(userId: number, months = 12): MonthlyCashFlowPoint[] {
  const db = ConfigStore.getInstance().db;
  const now = new Date();
  const startMonth = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const startDate = `${startMonth.getFullYear()}-${String(startMonth.getMonth() + 1).padStart(2, '0')}-01`;

  const rows = db
    .prepare(
      `SELECT substr(trade_date, 1, 7) AS month,
              COALESCE(SUM(CASE
                WHEN trade_type IN ('reduce','clear') THEN quantity * price - fee
                WHEN trade_type IN ('buy','add') THEN -(quantity * price + fee)
                WHEN trade_type = 'dividend' THEN price * quantity
                ELSE 0 END), 0) AS cashFlow,
              COALESCE(SUM(CASE WHEN trade_type IN ('buy','add') THEN quantity * price + fee ELSE 0 END), 0) AS buyOut,
              COALESCE(SUM(CASE WHEN trade_type IN ('reduce','clear') THEN quantity * price - fee ELSE 0 END), 0) AS sellIn,
              COALESCE(SUM(CASE WHEN trade_type = 'dividend' THEN price * quantity ELSE 0 END), 0) AS dividend
         FROM user_trade_record
        WHERE user_id = ? AND is_deleted = 0 AND trade_date >= ?
        GROUP BY month
        ORDER BY month ASC`,
    )
    .all(userId, startDate) as Array<{
    month: string;
    cashFlow: number;
    buyOut: number;
    sellIn: number;
    dividend: number;
  }>;

  return rows.map((r) => ({
    month: r.month,
    cashFlow: Number(r.cashFlow.toFixed(2)),
    buyOut: Number(r.buyOut.toFixed(2)),
    sellIn: Number(r.sellIn.toFixed(2)),
    dividend: Number(r.dividend.toFixed(2)),
  }));
}

export interface AssetStatBackfillResult {
  /** 实际补写的快照条数（已存在的日期跳过） */
  filled: number;
  /** 实际覆盖的首个交易日（YYYY-MM-DD；窗口内无行情时回落为请求窗口起点） */
  from: string;
  /** 实际覆盖的最后一个交易日（窗口内无行情时回落为请求窗口终点） */
  to: string;
  /** 窗口内有行情数据的交易日数 */
  marketDays: number;
  /** 窗口内已有快照、被跳过的日期数 */
  skippedExisting: number;
}

/**
 * 回补缺失的双口径资产快照（近 N 天，只补没有的日期）
 *
 * 背景：快照平时由 cron 每天 17:02 写入（{@link insertAssetStatSnapshots}）。
 * 后端没在跑的日子（开发机 / 服务重启 / 部署初期）`user_asset_stat` 就没有数据，
 * 交易复盘页的「收益曲线」因此整段空白。本函数按「as-of 当日」口径重算缺失日：
 *
 * - **持仓/成本**：`user_trade_record` 按日回放（同 {@link calcAllPositions} 的移动加权
 *   成本口径，含 T119 送股摊薄；同日顺序 bonus < dividend < 买卖，与 core 一致）；
 * - **收盘价**：取「≤ 当日」的 qfq 收盘（前向填充；窗口内无行情 → 0，与 cron 的
 *   `kline?.close ?? 0` 兜底同向）。按 stock / etf 两组各 1 条基表区间查询
 *   （`batchGetDailyRangeByView`，**禁止逐标的循环查 DuckDB**）；
 * - **actual 口径**：price 口径 + 截至当日的累计除权福利（`getTotalDividends` 同公式，
 *   dividend / bonus / transfer 的 price × quantity 累计）。
 *
 * ⚠️ 写库用 `ON CONFLICT(user_id, trade_date) DO NOTHING` —— **绝不覆盖 cron 写过的
 * 真实快照**（补跑是「补洞」，不是「重写历史」）。
 *
 * @throws DuckDB 不可用 / 行情表缺失时抛错（调用方应转 503，不静默假绿）。
 */
export async function backfillAssetStatSnapshots(
  userId: number,
  days: number,
): Promise<AssetStatBackfillResult> {
  const db = ConfigStore.getInstance().db;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  const empty: AssetStatBackfillResult = { filled: 0, from, to, marketDays: 0, skippedExisting: 0 };

  const trades = db
    .prepare(
      `SELECT asset_code, trade_type, trade_date, quantity, price, fee
       FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0
       ORDER BY trade_date ASC, trade_time ASC, id ASC`,
    )
    .all(userId) as Array<{
    asset_code: string;
    trade_type: string;
    trade_date: string;
    quantity: number;
    price: number;
    fee: number;
  }>;

  if (trades.length === 0) return empty;

  // ── 1. 一次拿全窗口 qfq 日线（stock / etf 两组各 1 条查询）──
  const assets = [...new Set(trades.map((t) => t.asset_code))];
  let classes: Map<string, string>;
  try {
    classes = await fetchAssetClasses(assets);
  } catch (err) {
    throw new Error(`行情库不可用，无法回补资产快照：${String(err)}`);
  }
  const etfSyms = assets.filter((s) => classes.get(s) === 'etf');
  const stockSyms = assets.filter((s) => classes.get(s) !== 'etf');
  const klines = await batchGetDailyRangeByView(
    new Map<string, string[]>([
      ['v_stock_qfq', stockSyms],
      ['v_etf_qfq', etfSyms],
    ]),
    from,
    to,
  );

  // 窗口内「有行情」的交易日 = 全部标的 K 线日期的并集（升序）
  const daySet = new Set<string>();
  for (const list of klines.values()) for (const k of list) daySet.add(k.date);
  const marketDays = [...daySet].sort();
  if (marketDays.length === 0) return empty;

  const existing = new Set(
    (
      db
        .prepare(
          'SELECT trade_date FROM user_asset_stat WHERE user_id = ? AND trade_date >= ? AND trade_date <= ?',
        )
        .all(userId, from, to) as Array<{ trade_date: string }>
    ).map((r) => r.trade_date),
  );
  const skippedExisting = marketDays.filter((d) => existing.has(d)).length;

  // ── 2. 每标的持仓检查点（回放口径与 core `calculateMovingWeightedCost` 一致）──
  //    同日顺序 bonus/transfer(0) < dividend(1) < 其它(2)，同级保持输入顺序（time/id）。
  const orderOf: Record<string, number> = { bonus: 0, transfer: 0, dividend: 1 };
  const byAsset = new Map<string, Array<{ date: string; qty: number; cost: number }>>();
  for (const asset of assets) {
    const rows = trades
      .filter((t) => t.asset_code === asset)
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        if (a.t.trade_date !== b.t.trade_date) return a.t.trade_date < b.t.trade_date ? -1 : 1;
        const d = (orderOf[a.t.trade_type] ?? 2) - (orderOf[b.t.trade_type] ?? 2);
        if (d !== 0) return d;
        return a.i - b.i;
      })
      .map((x) => x.t);

    let qty = 0;
    let cost = 0;
    const cps: Array<{ date: string; qty: number; cost: number }> = [];
    for (const t of rows) {
      switch (t.trade_type) {
        case 'buy':
        case 'add':
          cost += t.quantity * t.price + t.fee;
          qty += t.quantity;
          break;
        case 'bonus':
        case 'transfer': // 转增/调帐转入：股数 +n，成本基不变（与 core bonus 分支同口径）
          qty += t.quantity;
          break;
        case 'reduce':
        case 'clear':
          if (qty > 0) {
            const sellQty = Math.min(t.quantity, qty); // 超卖容错：按实际持仓结算，不出负数
            const avg = cost / qty;
            qty -= sellQty;
            cost = qty * avg;
          }
          break;
        default:
          break; // dividend 不改持仓与成本
      }
      cps.push({ date: t.trade_date, qty, cost });
    }
    byAsset.set(asset, cps);
  }

  // ── 3. 累计除权福利检查点（dividend / bonus / transfer 的 price×qty，同 getTotalDividends）──
  const divEvents = trades
    .filter((t) => t.trade_type === 'dividend' || t.trade_type === 'bonus' || t.trade_type === 'transfer')
    .map((t) => ({ date: t.trade_date, amount: t.price * t.quantity }));

  // ── 4. 逐交易日计算 + 写库（指针单调推进，总复杂度 O(交易日 × 标的)）──
  const insertStmt = db.prepare(
    `INSERT INTO user_asset_stat
       (user_id, trade_date, total_assets_price_yield, total_assets_actual_yield,
        total_profit_price, total_profit_actual)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, trade_date) DO NOTHING`,
  );

  let filled = 0;
  const cpPtr = new Map<string, number>(); // 每标的检查点指针（-1 = 尚无事件）
  const kPtr = new Map<string, number>(); // 每标的 K 线指针（-1 = 窗口内首根还没到）
  let divPtr = -1;
  let divCum = 0;

  for (const day of marketDays) {
    if (existing.has(day)) continue; // cron 写过的日子不动

    // 累计除权福利（≤ 当日）
    while (divPtr + 1 < divEvents.length && divEvents[divPtr + 1].date <= day) {
      divPtr++;
      divCum += divEvents[divPtr].amount;
    }

    let mv = 0;
    let costBasis = 0;
    for (const asset of assets) {
      // 持仓检查点（≤ 当日）
      const cps = byAsset.get(asset)!;
      let p = cpPtr.get(asset) ?? -1;
      while (p + 1 < cps.length && cps[p + 1].date <= day) p++;
      cpPtr.set(asset, p);
      const qty = p >= 0 ? cps[p].qty : 0;
      const cost = p >= 0 ? cps[p].cost : 0;
      costBasis += cost;

      // 收盘价前向填充（≤ 当日的最后一根；窗口内没有行情 → 0）
      const arr = klines.get(asset);
      let kp = kPtr.get(asset) ?? -1;
      if (arr) {
        while (kp + 1 < arr.length && arr[kp + 1].date <= day) kp++;
      }
      kPtr.set(asset, kp);
      const close = arr && kp >= 0 ? arr[kp].close : 0;
      mv += qty * close;
    }

    const priceProfit = mv - costBasis;
    const actualProfit = priceProfit + divCum;
    const priceYield = costBasis > 0 ? priceProfit / costBasis : 0;
    const actualYield = costBasis > 0 ? actualProfit / costBasis : 0;

    const info = insertStmt.run(userId, day, priceYield, actualYield, priceProfit, actualProfit);
    filled += info.changes;
  }

  // 返回**实际覆盖**的交易日区间（行情库可能落后于今天，别把请求窗口当成已覆盖区间）
  return {
    filled,
    from: marketDays[0] ?? from,
    to: marketDays[marketDays.length - 1] ?? to,
    marketDays: marketDays.length,
    skippedExisting,
  };
}
