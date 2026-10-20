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
import { batchGetDaily } from './marketData.js';

/**
 * 查用户累计收到的除权福利（分红 + 送转 + 配股）
 * SDD §5.8：exDividendSync 17:03 往 user_trade_record 写 trade_type IN ('dividend','bonus','transfer')
 * positionCalculator.mapToCoreTrade 过滤了这些类型 → 不影响 price 口径 costBasis
 * 这里汇总它们 = actual 口径需要加回的分红金额
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
    // 2. 算持仓（positionCalculator 过滤了除权交易 → costBasis = 纯买入成本）
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
