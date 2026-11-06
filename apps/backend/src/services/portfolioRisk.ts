/**
 * T137（V3.6）组合风控体检 —— SDD_v3 §9.8 / Requirements §7
 *
 * 只呈现、不阻断。集中度分母排除现金类资产。
 *
 * 2026-11-06（J3 修复，三项）：
 * ① `maxDrawdown` 旧实现把「利润峰值」当分母（峰值利润可小到几千元），
 *    实测输出 12,710.04% —— 数值是比率但分母无意义。改为
 *    「累计盈亏峰值回落 ÷ 峰值持仓成本」（见 computeMaxDrawdown 注释）。
 * ② `industryDistribution` 旧实现直接取 `asset_code.slice(0,2)`、且**逐持仓一行不聚合**，
 *    实测返回 39 行 `sh`/`sz` 重复项、其中 27 行为零权重。改为
 *    行业维度（通达信板块成分）优先、缺数据时降级为交易所维度并聚合。
 * ③ 新增 `distributionBasis` / `distributionNote` / `maxDrawdownNote`，均为**追加字段**，
 *    既有调用方读旧字段不受影响（API 契约向后兼容）。
 */
import { ConfigStore } from '../config/configStore.js';
import { calcAllPositions, calcClosedTradePnLs } from './positionCalculator.js';
import { getAssetClass } from './assetClass.js';
import { batchGetLatestClose } from './marketData.js';
import { queryDuckDB } from '../db/duckdb.js';

/** 分布口径：行业维度（板块成分）或交易所维度（降级） */
export type DistributionBasis = 'industry' | 'exchange';

export interface DistributionItem {
  /**
   * 分布项名称。
   * - `distributionBasis='industry'` 时是板块名称（如「半导体」）；无归属为「未分类」。
   * - `distributionBasis='exchange'` 时是交易所前缀（sh/sz/bj/其他）。
   *
   * ⚠️ 字段名沿用 `industry` 仅为**契约兼容**（外部调用方按此名读取），
   * 其语义由 `distributionBasis` 决定 —— 降级时它不是行业。
   */
  industry: string;
  /** 占比（%），对该维度下全部风险持仓市值归一 */
  weight: number;
}

export interface RiskCheckResult {
  singleStockMaxWeight: number; // 单票最大占比（%），分母排除现金类
  top10Concentration: number; // 前十大集中度（%）
  availableCashRatio: number; // 可用现金比例（%）
  /**
   * 最大回撤（%）。
   * 口径：累计盈亏曲线（已实现累计 + 当期浮动盈亏 + 分红累计）自峰值回落的最大值，
   * 分母 = 全期峰值持仓成本。详见 `maxDrawdownNote`。
   */
  maxDrawdown: number;
  /** 分布明细；语义见 `distributionBasis`（`industry` 字段名沿用但含义随口径变化） */
  industryDistribution: DistributionItem[];
  cashExcluded: boolean;
  /** 本次分布的维度：`industry`=板块行业，`exchange`=交易所（行业数据不可用时降级） */
  distributionBasis: DistributionBasis;
  /** 分布口径说明（含降级原因 / ETF 无行业归属提示） */
  distributionNote: string;
  /** 最大回撤口径说明（含峰谷金额与分母） */
  maxDrawdownNote: string;
}

/**
 * 计算最大回撤（%）。
 *
 * ── 为什么不用 `user_asset_stat.total_profit_actual` 的峰值做分母 ──
 * 旧实现 `dd = (利润峰值 − 当期利润) / 利润峰值`：
 * 利润峰值可以只有几千元（实测 2026-05-13 峰值 8,951.54），而后期浮亏到 −2.4 万，
 * 于是得到 **12,710.04%** —— 单位写着 %，分母与投入规模无关，纯噪声。
 *
 * ── 新口径 ──
 * 1. 累计盈亏曲线 `pnl(t) = 已实现累计 + 当期浮动盈亏（total_profit_price）+ 分红累计`
 *    （三项都按**风险资产**过滤；分红与已实现一旦发生就不会回吐，故为累计值）。
 * 2. 持仓成本 `cost(t)` 由 `priceYield = priceProfit / costBasis` 反推
 *    （`user_asset_stat` 只存利润与收益率两列；|y| < 1e-6 的行成本视为 0，即空仓行）。
 * 3. 分母 = **全期最大持仓成本**（单一固定分母，避免「拿峰值利润比早期小仓位」的放大）。
 * 4. `dd(t) = (peakPnl − pnl(t)) / maxCostBasis × 100`，取最大值。
 *
 * 意义：利润从峰值回吐了多少「相对于最大投入规模」—— 实测 24.18 万回吐 ÷ 157.67 万成本 ≈ 15.3%，
 * 与旧值 12,710.04 相比是同一量级维度的正确表达（百分比、分母是资金规模）。
 *
 * 纯函数（不碰 DB），便于单测覆盖「空仓行 / 单调上升 / 有回撤」。
 */
export function computeMaxDrawdown(
  stats: Array<{ trade_date: string; priceProfit: number; priceYield: number }>,
  realizedByDate: Map<string, number>,
  dividendByDate: Map<string, number>,
): { value: number; peakPnl: number; peakCostBasis: number; troughPnl: number; worstDate: string } {
  if (stats.length === 0) return { value: 0, peakPnl: 0, peakCostBasis: 0, troughPnl: 0, worstDate: '' };

  const sorted = [...stats].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0,
  );
  const realizedDates = [...realizedByDate.keys()].sort();
  const dividendDates = [...dividendByDate.keys()].sort();

  const cumAt = (dates: string[], map: Map<string, number>, day: string): number => {
    let s = 0;
    for (const d of dates) {
      if (d > day) break;
      s += map.get(d) ?? 0;
    }
    return s;
  };

  let peakPnl = -Infinity;
  const points: Array<{ date: string; pnl: number; cost: number }> = [];

  for (const row of sorted) {
    // 成本反推：收益率接近 0 时除法不稳定（空仓行 y=p=0），置 0
    const p = Number(row.priceProfit) || 0;
    const y = Number(row.priceYield) || 0;
    const cost = Math.abs(y) > 1e-6 ? Math.abs(p / y) : 0;
    const pnl =
      cumAt(realizedDates, realizedByDate, row.trade_date) +
      p +
      cumAt(dividendDates, dividendByDate, row.trade_date);
    if (pnl > peakPnl) peakPnl = pnl;
    points.push({ date: row.trade_date, pnl, cost });
  }

  // 峰值成本用**全期最大值**（固定分母）：避免「后面的峰值利润 ÷ 前面的小成本」把比率放大成噪声
  const peakCostBasis = points.reduce((m, p) => Math.max(m, p.cost), 0);
  let maxDd = 0;
  let troughPnl = 0;
  let worstDate = '';
  if (peakCostBasis > 0) {
    // 回撤必须是「先峰后谷」：用**滚动峰值**，不能拿全期峰值去比早期点（那会把上涨算成回撤）
    let runPeak = -Infinity;
    let ddPeak = -Infinity;
    for (const p of points) {
      if (p.pnl > runPeak) runPeak = p.pnl;
      const dd = ((runPeak - p.pnl) / peakCostBasis) * 100;
      if (dd > maxDd) {
        maxDd = dd;
        troughPnl = p.pnl;
        worstDate = p.date;
        ddPeak = runPeak;
      }
    }
    peakPnl = Number.isFinite(ddPeak) ? ddPeak : peakPnl;
  }

  return {
    value: maxDd,
    peakPnl: Number.isFinite(peakPnl) ? peakPnl : 0,
    peakCostBasis,
    troughPnl,
    worstDate,
  };
}

/**
 * 交易所维度聚合（行业数据不可用时的降级口径）。
 *
 * 与旧实现的区别：**按前缀聚合**（旧实现逐持仓输出，39 行里 sh/sz 重复出现、含 27 行零权重）。
 * 未知前缀归入「其他」。
 */
export function aggregateByExchange(
  rows: Array<{ assetCode: string; marketValue: number }>,
): DistributionItem[] {
  return aggregate(rows, (r) => {
    const prefix = r.assetCode.slice(0, 2).toLowerCase();
    return ['sh', 'sz', 'bj'].includes(prefix) ? prefix : '其他';
  });
}

/**
 * 行业维度聚合：按板块名称分组；`industry` 为空的标的（多为 ETF / 指数基金，
 * 通达信行业板块成分基本只覆盖 A 股个股）统一计入「未分类」。
 */
export function aggregateByIndustry(
  rows: Array<{ assetCode: string; marketValue: number; industry?: string | null }>,
): DistributionItem[] {
  return aggregate(rows, (r) => (r.industry && r.industry.trim() ? r.industry.trim() : '未分类'));
}

function aggregate<T extends { assetCode: string; marketValue: number }>(
  rows: T[],
  keyOf: (row: T) => string,
): DistributionItem[] {
  const total = rows.reduce((s, r) => s + Math.max(0, r.marketValue), 0);
  const byKey = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    byKey.set(k, (byKey.get(k) ?? 0) + Math.max(0, r.marketValue));
  }
  return (
    [...byKey.entries()]
      // 有行情时剔除零市值桶（多为无行情的已清仓/停牌项）；全无行情时保留，交由 note 说明占比为 0
      .filter(([, mv]) => (total > 0 ? mv > 0 : true))
      .map(([industry, mv]) => ({
        industry,
        weight: total > 0 ? parseFloat(((mv / total) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.weight - a.weight || (a.industry < b.industry ? -1 : a.industry > b.industry ? 1 : 0))
  );
}

type IndustryLoad =
  | { ok: true; types: string[]; map: Map<string, string> }
  | { ok: false; reason: 'empty' | 'unrecognized' | 'error'; allTypes: string[]; types: string[] };

/**
 * 读取「通达信板块成分」→ 标的所属行业名。
 *
 * ⚠️ **不猜 `block_type` 取值**（本机副本该表 0 行，取值集合无法实测）：
 * 1. 先 `SELECT DISTINCT block_type`，若为空 ⇒ `empty`（数据不可用，降级）；
 * 2. 有 `INDUSTRY_BLOCK_TYPES` 环境变量则按它指定（逗号分隔）；
 * 3. 否则只在类型名**含「行业」或 industry** 时认定（其余情况一律 `unrecognized` 降级，
 *    并在 note 里列出可用类型，不硬编码猜测值）。
 *
 * 一个标的同时属于多个行业板块时取按名称排序的第一个（不做权重拆分）。
 */
async function loadIndustryMapping(symbols: string[]): Promise<IndustryLoad> {
  const empty: IndustryLoad = { ok: false, reason: 'empty', allTypes: [], types: [] };
  try {
    const typeRows = await queryDuckDB<{ block_type: string }>(
      `SELECT DISTINCT block_type FROM raw_tdx_blocks_info WHERE block_type IS NOT NULL`,
    );
    const allTypes = typeRows.map((r) => String(r.block_type)).filter((t) => t.length > 0);
    if (allTypes.length === 0) return empty;

    const override = (process.env.INDUSTRY_BLOCK_TYPES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const types = override.length
      ? override.filter((t) => allTypes.includes(t))
      : allTypes.filter((t) => /行业|industry/i.test(t));

    if (types.length === 0) return { ok: false, reason: 'unrecognized', allTypes, types: [] };
    if (symbols.length === 0) return { ok: true, types, map: new Map() };

    const memberRows = await queryDuckDB<{ stock_symbol: string; block_name: string }>(
      `SELECT DISTINCT m.stock_symbol AS stock_symbol, i.block_name AS block_name
         FROM raw_tdx_blocks_member m
         JOIN raw_tdx_blocks_info i ON i.block_code = m.block_code
        WHERE m.stock_symbol IN (${symbols.map(() => '?').join(',')})
          AND i.block_type IN (${types.map(() => '?').join(',')})`,
      [...symbols, ...types],
    );

    const map = new Map<string, string>();
    for (const r of memberRows) {
      const name = String(r.block_name ?? '').trim();
      if (!name) continue;
      const prev = map.get(r.stock_symbol);
      if (prev === undefined || name < prev) map.set(String(r.stock_symbol), name);
    }
    return { ok: true, types, map };
  } catch {
    return { ok: false, reason: 'error', allTypes: [], types: [] };
  }
}

export async function computeRiskCheck(userId: number): Promise<RiskCheckResult> {
  const db = ConfigStore.getInstance().db;
  const positions = calcAllPositions(userId);
  const riskPositions = positions.filter((p) => getAssetClass(db, p.asset_code) === 'risk');
  const heldRisk = riskPositions.filter((p) => p.totalQuantity > 0);

  const symbols = heldRisk.map((p) => p.asset_code);
  let priceMap = new Map<string, { date: string; close: number }>();
  try {
    priceMap = await batchGetLatestClose(symbols);
  } catch {
    priceMap = new Map();
  }

  const mvByAsset = new Map<string, number>();
  let totalRiskMV = 0;
  for (const p of heldRisk) {
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
  const cashHeld = cashPositions.filter((p) => p.totalQuantity > 0);
  const cashSymbols = cashHeld.map((p) => p.asset_code);
  let cashPriceMap = new Map<string, { date: string; close: number }>();
  try {
    cashPriceMap = await batchGetLatestClose(cashSymbols);
  } catch {
    cashPriceMap = new Map();
  }
  let totalCashMV = 0;
  for (const p of cashHeld) {
    const px = cashPriceMap.get(p.asset_code)?.close ?? 0;
    totalCashMV += p.totalQuantity * px;
  }
  const totalMV = totalRiskMV + totalCashMV;
  const cashRatio = totalMV > 0 ? (totalCashMV / totalMV) * 100 : 0;

  // ── 最大回撤：累计盈亏曲线（已实现 + 浮动 + 分红）÷ 峰值持仓成本 ──
  const statRows = db
    .prepare(
      `SELECT trade_date, total_profit_price AS priceProfit, total_assets_price_yield AS priceYield
         FROM user_asset_stat WHERE user_id = ? ORDER BY trade_date ASC`,
    )
    .all(userId) as Array<{ trade_date: string; priceProfit: number; priceYield: number }>;

  // 已实现累计（按日期，仅风险资产）
  const closed = calcClosedTradePnLs(userId);
  const realizedByDate = new Map<string, number>();
  for (const c of closed) {
    if (getAssetClass(db, c.asset_code) !== 'risk') continue;
    realizedByDate.set(c.trade_date, (realizedByDate.get(c.trade_date) ?? 0) + c.realized_pnl);
  }

  // 分红累计（按日期，仅风险资产；bonus/transfer 的 price 恒为 0，不计）
  const divRows = db
    .prepare(
      `SELECT asset_code, trade_date, COALESCE(SUM(price * quantity), 0) AS d
         FROM user_trade_record
        WHERE user_id = ? AND is_deleted = 0 AND trade_type = 'dividend'
        GROUP BY asset_code, trade_date`,
    )
    .all(userId) as Array<{ asset_code: string; trade_date: string; d: number }>;
  const dividendByDate = new Map<string, number>();
  for (const r of divRows) {
    if (getAssetClass(db, r.asset_code) !== 'risk') continue;
    dividendByDate.set(r.trade_date, (dividendByDate.get(r.trade_date) ?? 0) + r.d);
  }

  const dd = computeMaxDrawdown(statRows, realizedByDate, dividendByDate);

  // ── 分布：行业维度优先，不可用则降级交易所维度 ──
  const industryLoad = await loadIndustryMapping(symbols);
  let distribution: DistributionItem[];
  let basis: DistributionBasis;
  let note: string;

  if (industryLoad.ok) {
    basis = 'industry';
    distribution = aggregateByIndustry(
      heldRisk.map((p) => ({
        assetCode: p.asset_code,
        marketValue: mvByAsset.get(p.asset_code) ?? 0,
        industry: industryLoad.map.get(p.asset_code) ?? null,
      })),
    );
    note =
      `行业分布：按通达信板块成分聚合（block_type=${industryLoad.types.join('/')}）。` +
      '同一标的属多个行业板块时按板块名取首个，不做权重拆分。' +
      '无行业归属的标的计入「未分类」（通达信行业板块成分基本只覆盖 A 股个股，ETF 多数无行业归属，组合以 ETF 为主时行业分布可能大面积为空）。';
  } else {
    basis = 'exchange';
    distribution = aggregateByExchange(
      heldRisk.map((p) => ({ assetCode: p.asset_code, marketValue: mvByAsset.get(p.asset_code) ?? 0 })),
    );
    const reason =
      industryLoad.reason === 'empty'
        ? '本机行情副本的板块成分表为空（raw_tdx_blocks_info / raw_tdx_blocks_member 0 行，属副本陈旧）；生产库已回填板块成分（raw_tdx_blocks_member 89928 行）后会自动切换为行业维度'
        : industryLoad.reason === 'unrecognized'
          ? `板块类型（${industryLoad.allTypes.join('/')}）无法判定哪一类是行业（可通过 INDUSTRY_BLOCK_TYPES 指定）`
          : '行情库当前不可用或缺少板块表';
    note =
      `当前按交易所维度展示（sh=上交所 / sz=深交所 / bj=北交所）：${reason}。` +
      '另注意：通达信行业板块成分基本只覆盖 A 股个股，ETF 多数无行业归属，行业维度下组合以 ETF 为主时可能大面积为空。';
  }

  if (totalRiskMV <= 0 && distribution.length > 0) {
    note += '（行情价不可用，占比暂为 0）';
  }

  const ddAmount = Math.max(0, dd.peakPnl - dd.troughPnl);
  const maxDrawdownNote =
    `口径：累计盈亏（已实现累计 + 当期浮动 + 分红累计）自峰值回落 ÷ 全期峰值持仓成本。` +
    `本次：峰值利润 ${dd.peakPnl.toFixed(2)} 元、峰值持仓成本 ${dd.peakCostBasis.toFixed(2)} 元、最大回吐约 ${ddAmount.toFixed(2)} 元` +
    (dd.worstDate ? `（最低点 ${dd.worstDate}）` : '') +
    '；空仓行（收益率为 0）不计入峰值成本。';

  return {
    singleStockMaxWeight: parseFloat(singleMax.toFixed(2)),
    top10Concentration: parseFloat(top10Conc.toFixed(2)),
    availableCashRatio: parseFloat(cashRatio.toFixed(2)),
    maxDrawdown: parseFloat(dd.value.toFixed(2)),
    industryDistribution: distribution,
    cashExcluded: true,
    distributionBasis: basis,
    distributionNote: note,
    maxDrawdownNote,
  };
}
