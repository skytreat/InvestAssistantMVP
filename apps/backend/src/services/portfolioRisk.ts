/**
 * T137（V3.6）组合风控体检 —— SDD_v3 §9.8 / Requirements §7
 *
 * 只呈现、不阻断。集中度分母排除现金类资产。
 */
import { ConfigStore } from '../config/configStore.js';
import { calcAllPositions } from './positionCalculator.js';
import { getAssetClass } from './assetClass.js';
import { batchGetLatestClose } from './marketData.js';

export interface RiskCheckResult {
  singleStockMaxWeight: number; // 单票最大占比（%），分母排除现金类
  top10Concentration: number; // 前十大集中度（%）
  availableCashRatio: number; // 可用现金比例（%）
  maxDrawdown: number; // 最大回撤（%），基于含费用净值曲线
  industryDistribution: Array<{ industry: string; weight: number }>;
  cashExcluded: boolean;
}

export async function computeRiskCheck(userId: number): Promise<RiskCheckResult> {
  const db = ConfigStore.getInstance().db;
  const positions = calcAllPositions(userId);
  const riskPositions = positions.filter((p) => getAssetClass(db, p.asset_code) === 'risk');

  const symbols = riskPositions.map((p) => p.asset_code);
  let priceMap = new Map<string, { date: string; close: number }>();
  try {
    priceMap = await batchGetLatestClose(symbols);
  } catch {
    priceMap = new Map();
  }

  const mvByAsset = new Map<string, number>();
  let totalRiskMV = 0;
  for (const p of riskPositions) {
    const px = priceMap.get(p.asset_code)?.close ?? 0;
    const mv = p.totalQuantity * px;
    mvByAsset.set(p.asset_code, mv);
    totalRiskMV += mv;
  }

  // 单票最大占比
  let singleMax = 0;
  for (const mv of mvByAsset.values()) {
    if (totalRiskMV > 0) {
      singleMax = Math.max(singleMax, (mv / totalRiskMV) * 100);
    }
  }

  // 前十大集中度
  const sorted = [...mvByAsset.values()].sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10).reduce((s, v) => s + v, 0);
  const top10Conc = totalRiskMV > 0 ? (top10 / totalRiskMV) * 100 : 0;

  // 可用现金比例：cash MV / total MV
  const cashPositions = positions.filter((p) => getAssetClass(db, p.asset_code) === 'cash');
  const cashSymbols = cashPositions.map((p) => p.asset_code);
  let cashPriceMap = new Map<string, { date: string; close: number }>();
  try {
    cashPriceMap = await batchGetLatestClose(cashSymbols);
  } catch {
    cashPriceMap = new Map();
  }
  let totalCashMV = 0;
  for (const p of cashPositions) {
    const px = cashPriceMap.get(p.asset_code)?.close ?? 0;
    totalCashMV += p.totalQuantity * px;
  }
  const totalMV = totalRiskMV + totalCashMV;
  const cashRatio = totalMV > 0 ? (totalCashMV / totalMV) * 100 : 0;

  // 最大回撤：基于 user_asset_stat 历史利润曲线
  const rows = db
    .prepare(`SELECT total_profit_actual FROM user_asset_stat WHERE user_id = ? ORDER BY trade_date ASC`)
    .all(userId) as Array<{ total_profit_actual: number }>;
  let peak = 0;
  let maxDd = 0;
  let cum = 0;
  for (const r of rows) {
    cum = r.total_profit_actual ?? 0;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  // 行业分布：近似，按标的前缀分组（板块映射待 T137 后续细化）
  const industryDistribution = riskPositions.map((p) => ({
    industry: p.asset_code.slice(0, 2),
    weight: totalRiskMV > 0 ? parseFloat(((mvByAsset.get(p.asset_code)! / totalRiskMV) * 100).toFixed(2)) : 0,
  }));

  return {
    singleStockMaxWeight: parseFloat(singleMax.toFixed(2)),
    top10Concentration: parseFloat(top10Conc.toFixed(2)),
    availableCashRatio: parseFloat(cashRatio.toFixed(2)),
    maxDrawdown: parseFloat(maxDd.toFixed(2)),
    industryDistribution,
    cashExcluded: true,
  };
}
