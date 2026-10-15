// src/services/assetStat.ts
// T26: user_asset_stat 双口径资产快照写入（SDD §5.1 17:02 信号生成最后一步）
// MVP 简化：actual = price（除权复权口径 V2 补）

import { ConfigStore } from '../config/configStore.js';
import { calcAllPositions } from './positionCalculator.js';
import { batchGetDaily } from './marketData.js';

/**
 * 双口径资产快照写入（SDD §5.1 信号生成最后一步）
 *
 * MVP 简化口径：
 *   - price 和 actual 数值相同（除权复权口径 V2 拉开）
 *   - 汇总用户所有持仓 → positionCalculator.calcAllPositions
 *   - 市价从 DuckDB v_stock_qfq 当日收盘价拿（1 次 IN 查询）
 *   - DuckDB 无数据时 close 用 0，不导致 NaN
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
    // 2. 算持仓
    const positions = calcAllPositions(user.id);

    if (positions.length === 0) {
      // 空持仓：写全零快照
      stmt.run(user.id, tradeDate, 0, 0, 0, 0);
      inserted++;
      continue;
    }

    // 3. 1 次 IN 查询拿所有标的当日收盘价（SDD §5.3 硬约束：禁止逐标的循环查 DuckDB）
    const symbols = positions.map(p => p.asset_code);
    const priceMap = await batchGetDaily(symbols, tradeDate);

    // 4. 汇总 marketValue / costBasis
    let totalMarketValue = 0;
    let totalCostBasis = 0;
    for (const pos of positions) {
      const kline = priceMap.get(pos.asset_code);
      const close = kline?.close ?? 0; // DuckDB 无数据（tdx2db 未 init）→ 用 0
      totalMarketValue += pos.totalQuantity * close;
      totalCostBasis += pos.totalCostBasis;
    }

    // 5. 算利润和收益率
    const totalProfit = totalMarketValue - totalCostBasis;
    const yieldPct = totalCostBasis > 0 ? totalProfit / totalCostBasis : 0;

    // 6. MVP 简化：actual = price
    stmt.run(
      user.id, tradeDate,
      yieldPct, yieldPct,            // total_assets_price_yield, total_assets_actual_yield
      totalProfit, totalProfit,      // total_profit_price, total_profit_actual
    );
    inserted++;
  }

  return { inserted };
}
