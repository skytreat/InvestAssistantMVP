/**
 * T132（V3.3）三口径收益率 —— SDD_v3 §7.3 / §9.5 / Requirements INV-S4-27~29
 *
 * ① 风险资产收益率 = (风险浮盈 + 已实现 + 现金分红) ÷ 风险投入
 * ② 现金类收益率   = (逆回购利息 + 货币 ETF 市值变动) ÷ 现金投入
 * ③ 总收益率       = (总资产 − 总投入 − 累计费用) ÷ 总投入
 * 可加性：total.pnl = risk.pnl + cash.pnl − fees（断言）
 *
 * 现金类判定走 asset_class 表（T120）；无记录默认 risk（安全侧）。
 * 券商维度：brokerCode 给定时只计该券商的流水 + 无券商维度的手工记录。
 */
import { ConfigStore } from '../config/configStore.js';
import { calcAllPositions } from './positionCalculator.js';
import { calcClosedTradePnLs } from './positionCalculator.js';
import { getAssetClass } from './assetClass.js';
import { batchGetLatestClose } from './marketData.js';
import { modelRepoCashFlow } from './broker/brokerCashModel.js';

export interface ReturnBreakdown {
  pnl: number;
  cost: number; // 投入（含费用）
  rate: number; // pnl / cost
  [key: string]: number;
}

export interface PortfolioReturn {
  risk: ReturnBreakdown & {
    realized: number;
    dividend: number;
    /**
     * 未平仓风险持仓成本内仍携带的买入手续费（明细披露，**不参与 pnl 计算**）。
     * `total.fees − risk.fees` = 已随平仓结转进已实现 / 落在现金类持仓成本内的部分。
     */
    fees: number;
    /**
     * 累计买入（buy + add 的成交金额 + 手续费，含已平仓部分）。
     *
     * ⚠️ 与 `cost` 是**两个不同口径**，不可混用：
     * - `cost` = 当前未平仓的移动加权成本（收益率的分母，语义不变）
     * - `cumulativeBuy` = 历史累计买入额（只增不减，用于让用户看到「一共投进去多少钱」）
     *
     * 2026-11-06：页面把 `cost` 标签写成「累计投入」造成误读（如兴森累计买入 16.9 万而
     * 页面显示的是剩余持仓成本），故新增本字段供另列一行。
     */
    cumulativeBuy: number;
  };
  cash: ReturnBreakdown & { repoInterest: number; cashEtfChange: number };
  total: ReturnBreakdown & {
    assets: number;
    invested: number;
    /** 全部交易费用合计（含已平仓）；`total.fees − risk.fees` 即已随平仓结转部分 */
    fees: number;
  };
  caliberNote: string;
}

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

export async function computePortfolioReturn(userId: number, brokerCode?: string): Promise<PortfolioReturn> {
  const db = ConfigStore.getInstance().db;

  // 券商维度过滤：brokerCode 给定时，只计该券商 + 手工（broker_code IS NULL）记录
  const brokerFilter = brokerCode ? `AND (broker_code = ? OR broker_code IS NULL)` : '';
  const brokerParams = brokerCode ? [brokerCode] : [];

  // 1. 全部持仓（移动加权成本，含送股摊薄）
  const positions = calcAllPositions(userId);
  const riskPositions = positions.filter((p) => getAssetClass(db, p.asset_code) === 'risk');
  const cashPositions = positions.filter((p) => getAssetClass(db, p.asset_code) === 'cash');

  // 2. 当前行情价（risk + cash ETF）
  const allSymbols = [...riskPositions, ...cashPositions].map((p) => p.asset_code);
  let priceMap = new Map<string, { date: string; close: number }>();
  try {
    priceMap = await batchGetLatestClose(allSymbols);
  } catch {
    priceMap = new Map();
  }

  // 3. 风险 invested（含费用）+ MV + dividend
  let riskInvested = 0;
  let riskMV = 0;
  let riskDividend = 0;
  for (const p of riskPositions) {
    riskInvested += p.totalCostBasis;
    const px = priceMap.get(p.asset_code)?.close ?? 0;
    riskMV += p.totalQuantity * px;
  }
  // dividend 汇总（风险标的的现金分红）
  const divRows = db
    .prepare(
      `SELECT asset_code, COALESCE(SUM(price * quantity), 0) AS d
         FROM user_trade_record
        WHERE user_id = ? AND trade_type = 'dividend' AND is_deleted = 0 ${brokerFilter}
        GROUP BY asset_code`,
    )
    .all(userId, ...brokerParams) as Array<{ asset_code: string; d: number }>;
  const divByAsset = new Map(divRows.map((r) => [r.asset_code, r.d]));
  for (const p of riskPositions) riskDividend += divByAsset.get(p.asset_code) ?? 0;

  // 累计买入（buy + add 的成交额 + fee，**含已平仓标的**）—— 与「当前持仓成本」分列展示。
  // ⚠️ 用 user_trade_record 独立聚合，不能从 positions 里推：已清仓标的的 totalCostBasis 为 0。
  const buyRows = db
    .prepare(
      `SELECT asset_code, COALESCE(SUM(quantity * price + fee), 0) AS g
         FROM user_trade_record
        WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ('buy','add') ${brokerFilter}
        GROUP BY asset_code`,
    )
    .all(userId, ...brokerParams) as Array<{ asset_code: string; g: number }>;
  let riskCumulativeBuy = 0;
  for (const r of buyRows) {
    if (getAssetClass(db, r.asset_code) === 'risk') riskCumulativeBuy += r.g;
  }

  // realized pnl（风险标的）
  const closed = calcClosedTradePnLs(userId);
  const closedRisk = closed.filter((c) => getAssetClass(db, c.asset_code) === 'risk');
  const riskRealized = closedRisk.reduce((s, c) => s + c.realized_pnl, 0);

  const riskPnl = riskMV + riskRealized + riskDividend - riskInvested;
  /**
   * risk.fees（2026-11-06 J3 修复）—— **只披露、不二次扣减**。
   *
   * 口径：未平仓风险持仓的移动加权成本里**仍然携带的买入手续费**
   * （`PositionResult.feeInCostBasis`，已随卖出按比例释放）。
   * - 买入费用已嵌入 `totalCostBasis`，故 `riskPnl` 公式里**不再单独减一次**，
   *   本字段仅用于把「费用落在哪里」讲清楚，不参与 pnl 计算。
   * - 与 `total.fees`（全部交易费用）的关系：
   *   `total.fees = risk.fees + 已随平仓结转/现金类持仓的成本内费用`。
   *   例：total.fees=1757.33、risk.fees=5.16 ⇒ 1752.17 已随平仓结转进已实现（或落在现金类）。
   * - 现金流类（逆回购）无手续费，恒为 0，故不单列。
   */
  const riskFees = riskPositions.reduce((s, p) => s + (p.feeInCostBasis ?? 0), 0);

  // 4. 现金：cash ETF MV/cost + repo interest
  let cashEtfCost = 0;
  let cashEtfMV = 0;
  for (const p of cashPositions) {
    if (getAssetClass(db, p.asset_code) !== 'cash') continue;
    // 区分 repo vs cash ETF：repo codes
    if (isRepoCode(p.asset_code)) continue; // repo 走 modelRepoCashFlow
    cashEtfCost += p.totalCostBasis;
    const px = priceMap.get(p.asset_code)?.close ?? 0;
    cashEtfMV += p.totalQuantity * px;
  }
  const cashEtfChange = cashEtfMV - cashEtfCost;

  // repo interest：需要 brokerCode；若未给，取所有券商分别汇总
  let repoInterest = 0;
  const brokers = brokerCode
    ? [brokerCode]
    : (
        db
          .prepare(
            `SELECT DISTINCT broker_code FROM broker_trade_record WHERE user_id = ? AND is_deleted = 0 AND broker_code IS NOT NULL`,
          )
          .all(userId) as Array<{
          broker_code: string;
        }>
      ).map((r) => r.broker_code);
  for (const bc of brokers) {
    try {
      const r = modelRepoCashFlow(db, userId, bc);
      repoInterest += r.totalInterest;
    } catch {
      /* ignore */
    }
  }
  const cashInvested = cashEtfCost; // repo 投入无法从 user_trade_record 精确还原，暂以 cash ETF 为主
  const cashPnl = cashEtfChange + repoInterest;
  const cashMV = cashEtfMV; // repo 在途不并入 MV（避免编造）

  // 5. 费用汇总（全部交易）
  const feeRow = db
    .prepare(
      `SELECT COALESCE(SUM(fee),0) AS f FROM user_trade_record WHERE user_id = ? AND is_deleted = 0 ${brokerFilter}`,
    )
    .get(userId, ...brokerParams) as { f: number };
  const totalFees = feeRow.f;

  // 6. 总
  const totalMV = riskMV + cashMV;
  const totalInvested = riskInvested + cashInvested;
  const totalPnlAdditive = riskPnl + cashPnl - totalFees;

  return {
    risk: {
      pnl: round2(riskPnl),
      cost: round2(riskInvested),
      rate: riskInvested > 0 ? round2((riskPnl / riskInvested) * 100) : 0,
      realized: round2(riskRealized),
      dividend: round2(riskDividend),
      fees: round2(riskFees),
      cumulativeBuy: round2(riskCumulativeBuy),
    },
    cash: {
      pnl: round2(cashPnl),
      cost: round2(cashInvested),
      rate: cashInvested > 0 ? round2((cashPnl / cashInvested) * 100) : 0,
      repoInterest: round2(repoInterest),
      cashEtfChange: round2(cashEtfChange),
    },
    total: {
      pnl: round2(totalPnlAdditive),
      cost: round2(totalInvested),
      rate: totalInvested > 0 ? round2((totalPnlAdditive / totalInvested) * 100) : 0,
      assets: round2(totalMV),
      invested: round2(totalInvested),
      fees: round2(totalFees),
    },
    caliberNote:
      '口径：风险资产按移动加权成本（含分红/送股）；现金类按市值变动 + 逆回购配对利息；费用含最低佣金。' +
      '费用拆分：total.fees 为全部交易费用；risk.fees 只统计未平仓风险持仓成本内仍携带的买入手续费' +
      '（买入费用已计入成本、卖出时按比例释放），因此 total.fees = risk.fees + 已随平仓结转进已实现的部分。' +
      '「当前持仓成本」= 未平仓部分的成本（收益率分母）；「累计买入」= 历史 buy/add 成交额合计（含已平仓，只增不减），两者不可混读。' +
      '与券商口径差异：券商按资金流水口径，本系统按持仓成本口径；逆回购利息按配对结果，未配对在途头寸不计入收益。',
  };
}

function isRepoCode(code: string): boolean {
  return code.startsWith('sh204') || code.startsWith('sz1318');
}
