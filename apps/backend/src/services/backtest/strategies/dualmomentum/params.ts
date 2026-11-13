/**
 * DualMomentum 可调参数（DAS-3.1 §2.2）。
 *
 * 约定：
 * - **默认值一律引用 `l1/params.ts` 的锁定常量**，不在这里另抄一份数（避免双真值源）。
 * - `initial_cash` 属运行层参数（回测 `--cash` / 纸面建户初始资金），不进策略 schema；
 *   `price_model` 由 `Strategy.priceMode = 'open'` 表达，也不进 schema。
 * - 均线价量比较固定用**第 3 条均线**（默认 20），即 DAS 的 `ma_for_price_check`；
 *   这是 L1 过滤链的既有结构（`evaluateL1Filters` 的 `ma20` 槽位），不单独暴露。
 */
import type { ParamField } from '../../../pluginEngine.js';
import {
  BENCHMARK_SYMBOL,
  DAILY_CHANGE_MAX,
  DAILY_CHANGE_MIN,
  MA_PERIODS,
  MAX_HOLDINGS,
  NDAY_RETURN_ANNUALIZE,
  NDAY_RETURN_PERIOD,
  RSRS_ENABLE_QUALITY_FILTER,
  RSRS_MAX,
  RSRS_MIN,
  RSRS_PERIOD,
  RSRS_STD_PERIOD,
  USE_WSM_V2,
  WSM_MAX,
  WSM_MIN,
  WSM_PERIOD,
} from './l1/params.js';
import type { MomentumCombo } from './l1/types.js';

/** 执行层（成交/费用）默认值，DAS-3.1 §2.2。 */
export const DEFAULT_COMMISSION_RATE = 0.00006;
export const DEFAULT_MIN_COMMISSION = 5.0;
export const DEFAULT_SLIPPAGE = 0.002;
export const DEFAULT_LOT_SIZE = 100;
export const DEFAULT_ETF_EXEMPT_TAX = true;

/** 组合层（L2）默认值 —— ⚠️ 除 minHoldDays 外均保留 DAS 锁定值；
 * minHoldDays 现由 DUALMOMENTUM_DEFAULTS 直接赋 20（ADR-022 跑赢档），本常量仅作文档锚点保留。 */
export const DEFAULT_SINGLE_POSITION_CAP = 0.33;
export const DEFAULT_OVERWEIGHT_THRESHOLD = 0.4;
export const DEFAULT_MIN_HOLD_DAYS = 5;
export const DEFAULT_TAKE_PROFIT_THRESHOLD = 0.3;
export const DEFAULT_TAKE_PROFIT_COOLDOWN = 5;
export const DEFAULT_STOP_LOSS_DRAWDOWN = 0.1;
export const DEFAULT_STOP_LOSS_HIGH = 0.12;
export const DEFAULT_STOP_LOSS_COOLDOWN = 3;

export interface DualMomentumParams {
  /** §2.3 动量组合（主槽/次槽/基准算法） */
  momentumCombo: MomentumCombo;
  wsmPeriod: number;
  useWsmV2: boolean;
  ndayReturnPeriod: number;
  ndayReturnAnnualize: boolean;
  rsrsPeriod: number;
  rsrsStdPeriod: number;
  rsrsQualityFilter: boolean;
  wsmMin: number;
  wsmMax: number;
  rsrsMin: number;
  rsrsMax: number;
  maPeriod1: number;
  maPeriod2: number;
  maPeriod3: number;
  maPeriod4: number;
  dailyChangeMin: number;
  dailyChangeMax: number;
  maxHoldings: number;
  singlePositionCap: number;
  overweightThreshold: number;
  minHoldDays: number;
  takeProfitThreshold: number;
  takeProfitCooldown: number;
  stopLossDrawdown: number;
  stopLossHigh: number;
  stopLossCooldown: number;
  commissionRate: number;
  minCommission: number;
  slippage: number;
  lotSize: number;
  etfExemptTax: boolean;
  benchmark: string;
  /** 闲置现金年化利率（÷250 日计提；ADR-022 后缺省 0.02 = 2%；DAS 锁定值为 0） */
  cashInterestRate: number;
  /** 档 2：暴露模式（缺省 `fixed` = DAS 基线「候选均分满仓 / 否则空仓」） */
  exposureMode: 'fixed' | 'scale' | 'vol';
  /** 档 2：`scale` 模式下目标暴露 = min(1, 通过数 / 该值) */
  exposureScaleDivisor: number;
  /** 档 2：`vol` 模式下目标年化波动率（如 0.12 = 12%） */
  targetVol: number;
  /** 档 2：`vol` 模式下实现波动率估计窗口（交易日） */
  volWindow: number;
  /** 档 2：候选数 < 该值时放开单标的 cap（0 = 不放开；缺省 0） */
  capRelaxBelow: number;
  /** 档 3：主槽上界研究值（缺省 = DAS `wsmMax`；传更大值才放宽） */
  wsmMaxResearch: number;
  /** 档 3：次槽上界研究值（缺省 = DAS `rsrsMax`；传更大值才放宽） */
  rsrsMaxResearch: number;
  /** 档 3：基准门槛模式（缺省 `hard` = DAS 基线；`soft` = 仅基准动量 > 0 时启用） */
  benchmarkGateMode: 'hard' | 'soft';
  /** 档 3：AND→评分制（缺省 `and` = DAS 基线；`scored` = 次槽降为打分不拦截） */
  scoreMode: 'and' | 'scored';
  /** 动量衰减退出（§12.5 第 5 条；缺省 false = DAS 基线，不新增退出路径） */
  momentumDecayExit: boolean;
  /** 衰减退出排名阈值：当日主槽排名（相对全池）> 该值即触发退出（缺省 = maxHoldings + 2） */
  decayRankThreshold: number;
  /**
   * 追踪止盈（§12.5 第 4 条；缺省 false = DAS 基线固定止盈 + 冷却，逐位不变）。
   * 开启后：当日 qfq 收盘距高水位回撤 ≥ `trailingTakeProfitDrawdown` 即清仓，
   * 替代固定 `takeProfitThreshold` 的「成本涨 30%」判定；且**止盈后不开 `takeProfitCooldown`**
   * （§12.5 原文「止盈后不冷却」），只开 `stopLossCooldown`（防同日反复）。
   */
  trailingTakeProfit: boolean;
  /** 追踪止盈回撤阈值：qfq 收盘距高水位 (hw − close)/hw ≥ 该值即清仓（缺省 0.15 = 15%） */
  trailingTakeProfitDrawdown: number;
  /** 追踪止盈是否仍需先满足固定止盈阈值（缺省 false = 纯追踪，不设 30% 前置门槛） */
  trailingTakeProfitRequiresThreshold: boolean;
  /**
   * 按标的权重（§13.15 A2；缺省 `'{}'` = 候选均分，基线逐位不变）。
   * 仅对「当前入选候选」生效：目标市值按权重归一后分配（`weight[s] / Σ weight[入选]`），
   * 未出现的标的视为权重 1。`'{"sh518880":2}'` = 黄金腿入选时占 2 倍于其他候选的份额。
   * 存储为 JSON 字符串（schema default 须过纸面建户 string 校验）；`index.ts` 消费时 JSON.parse。
   */
  symbolWeights: string;
  /**
   * 候选池扩展（§13.16 B1/B2；缺省 `'[]'` = 只用 DAS 锁定 7 只池，基线逐位不变）。
   * JSON 数组字符串，运行时**追加**到 `POOL_ORDER` 之后（不改 `l1/params.ts` 的对齐契约常量）。
   * 用途：把债券/商品等**低相关**资产纳入候选（实测债券 ETF 与 A 股池相关 −0.12~−0.28）。
   * 注意：扩展标的仍走**同一套 L1 过滤链**（MA + 动量区间 + 日涨跌），能否入选由信号决定。
   */
  poolExtension: string;
  /**
   * 防御回退标的（§13.16 B1；缺省 `''` = 无候选时保持现金，基线逐位不变）。
   * 非空时：**候选为空**则全仓持有该标的（不再空仓），沿用框架既有 `defensive-fallback` 语义
   * （与 `wufuRotation` 的 `defensiveEtf` 同款）。
   */
  defensiveSymbol: string;
  /**
   * 基准趋势破位 → 切防御（§13.17 / ADR-024；缺省 `0` = 关闭，基线逐位不变）。
   *
   * 触发：**基准主槽动量（WSM）< 该阈值** ⇒ 强制清掉非防御持仓，全仓持有 `defensiveSymbol`。
   * ⚠️ 阈值取**负数**（WSM < 0 表示基准趋势向下）；`0` = 不启用
   * （实测 `sh000300` WSM < 0 占 52.1% 的天，阈值必须为负才有区分度）。
   *
   * 与 §13.8 否决的「基准软化」**机制不同**：软化只改**选股门槛**（不产生买卖动作），
   * 本规则改的是**仓位**（切防御标的）。
   */
  benchmarkBreakoutThreshold: number;
  /**
   * 基准破位切换的**迟滞**（§13.17；缺省 0.3）。
   * 切到防御后，需基准动量回升到 `threshold + hysteresis` 以上才切回股票，
   * 避免阈值附近的信号抖动产生大量换手（§13.1 已证摩擦是主要成本）。
   */
  benchmarkBreakoutHysteresis: number;
}

export const DUALMOMENTUM_DEFAULTS: Readonly<DualMomentumParams> = {
  momentumCombo: 'wsm_v2_rsrs',
  wsmPeriod: WSM_PERIOD,
  useWsmV2: USE_WSM_V2,
  ndayReturnPeriod: NDAY_RETURN_PERIOD,
  ndayReturnAnnualize: NDAY_RETURN_ANNUALIZE,
  rsrsPeriod: RSRS_PERIOD,
  rsrsStdPeriod: RSRS_STD_PERIOD,
  rsrsQualityFilter: RSRS_ENABLE_QUALITY_FILTER,
  wsmMin: WSM_MIN,
  wsmMax: WSM_MAX,
  rsrsMin: RSRS_MIN,
  rsrsMax: RSRS_MAX,
  maPeriod1: MA_PERIODS[0],
  maPeriod2: MA_PERIODS[1],
  maPeriod3: MA_PERIODS[2],
  maPeriod4: MA_PERIODS[3],
  dailyChangeMin: DAILY_CHANGE_MIN,
  dailyChangeMax: DAILY_CHANGE_MAX,
  maxHoldings: MAX_HOLDINGS,
  singlePositionCap: DEFAULT_SINGLE_POSITION_CAP,
  overweightThreshold: DEFAULT_OVERWEIGHT_THRESHOLD,
  minHoldDays: 20,
  takeProfitThreshold: DEFAULT_TAKE_PROFIT_THRESHOLD,
  takeProfitCooldown: DEFAULT_TAKE_PROFIT_COOLDOWN,
  stopLossDrawdown: DEFAULT_STOP_LOSS_DRAWDOWN,
  stopLossHigh: DEFAULT_STOP_LOSS_HIGH,
  stopLossCooldown: DEFAULT_STOP_LOSS_COOLDOWN,
  commissionRate: DEFAULT_COMMISSION_RATE,
  minCommission: DEFAULT_MIN_COMMISSION,
  slippage: DEFAULT_SLIPPAGE,
  lotSize: DEFAULT_LOT_SIZE,
  etfExemptTax: DEFAULT_ETF_EXEMPT_TAX,
  benchmark: BENCHMARK_SYMBOL,
  // ── §13.10 跑赢档 + §13.13 vol(0.12)（ADR-022：目标函数 = 跑赢 sh510300；2026-11-12 owner 签字）──
  // 代价：MDD 13.11% → 26.46%（翻倍）；收益：CAGR 2.25% → 11.65% / 超额 +5.63pp / Calmar 0.44
  // 回退：`git revert` 本 ADR 对应 commit 即恢复 DAS 锁定基线（final=1,189,224.15 / 1780 笔）
  cashInterestRate: 0.02,
  exposureMode: 'vol',
  exposureScaleDivisor: 3,
  targetVol: 0.12,
  // §13.15 A3：volWindow=10 虽 CAGR +0.21pp / 超额 +5.84pp 最高，但 Calmar 与 20 持平（0.44），
  // 优势不显著（统计上不足以单独推翻），故维持 20（§13.13 已判定的跑赢档基准）
  volWindow: 20,
  capRelaxBelow: 0,
  wsmMaxResearch: 100,
  rsrsMaxResearch: 100,
  benchmarkGateMode: 'soft',
  scoreMode: 'scored',
  momentumDecayExit: false,
  /** 缺省 = maxHoldings + 2；显式传小值（如 3）可收紧排名触发 */
  decayRankThreshold: 8,
  trailingTakeProfit: false,
  trailingTakeProfitDrawdown: 0.15,
  trailingTakeProfitRequiresThreshold: false,
  /** 缺省 '{}' = 候选均分，基线不变；显式传 '{"sh518880":2}' 等才激活加权分配 */
  symbolWeights: '{}',
  /** 缺省 '[]' = 只用 DAS 锁定 7 只池，基线不变 */
  poolExtension: '[]',
  // ── §13.17 / ADR-024：基准趋势破位 → 切防御（owner 2026-11-12 选 B 采纳）──
  // 防御腿 = 十年国债 ETF（与 A 股池相关 −0.28，实测 §13.16 对比优于货币 ETF）
  // 破位阈值 −0.5（样本期触发 69 天 / 切换 19 次）
  // 效果：CAGR 11.65%→10.57%（−1.08pp）/ MDD 26.46%→18.97%（−7.49pp）/ Calmar 0.44→0.56
  // 回退：显式传 defensiveSymbol='' + benchmarkBreakoutThreshold=0 即恢复 ADR-022 基线
  defensiveSymbol: 'sh511260',
  benchmarkBreakoutThreshold: -0.5,
  /** 缺省 0.3 = 切回股票需基准动量回升到 threshold+0.3 */
  benchmarkBreakoutHysteresis: 0.3,
};

export const DUALMOMENTUM_PARAM_SCHEMA: ParamField[] = [
  {
    key: 'momentumCombo',
    label: '动量组合',
    type: 'select',
    default: DUALMOMENTUM_DEFAULTS.momentumCombo,
    options: ['wsm_v2_rsrs', 'nday_return_rsrs', 'nday_return_wsm_v2'],
    description: 'DAS §2.3：主槽/次槽指标组合；默认 wsm_v2_rsrs',
  },
  {
    key: 'wsmPeriod',
    label: '加权斜率动量周期',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.wsmPeriod,
    min: 2,
    max: 250,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 wsm_period',
  },
  {
    key: 'useWsmV2',
    label: '启用 WSM V2（加权 R²）',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.useWsmV2,
    description: 'DAS §2.2 use_wsm_v2',
  },
  {
    key: 'ndayReturnPeriod',
    label: 'N 日涨幅周期',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.ndayReturnPeriod,
    min: 2,
    max: 250,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 nday_return_period',
  },
  {
    key: 'ndayReturnAnnualize',
    label: 'N 日涨幅年化',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.ndayReturnAnnualize,
    description: 'DAS §2.2 nday_return_annualize',
  },
  {
    key: 'rsrsPeriod',
    label: 'RSRS 回归窗口',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.rsrsPeriod,
    min: 2,
    max: 250,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 rsrs_period',
  },
  {
    key: 'rsrsStdPeriod',
    label: 'RSRS 标准化窗口',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.rsrsStdPeriod,
    min: 2,
    max: 500,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 rsrs_std_period',
  },
  {
    key: 'rsrsQualityFilter',
    label: 'RSRS 质量过滤',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.rsrsQualityFilter,
    description: 'DAS §2.2 rsrs_enable_quality_filter（锁定关闭）',
  },
  {
    key: 'wsmMin',
    label: '主槽动量下限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.wsmMin,
    min: -10,
    max: 10,
    step: 0.1,
    description: 'DAS §2.2 wsm_min（作用在动量槽位）',
  },
  {
    key: 'wsmMax',
    label: '主槽动量上限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.wsmMax,
    min: -10,
    max: 50,
    step: 0.1,
    description: 'DAS §2.2 wsm_max',
  },
  {
    key: 'rsrsMin',
    label: '次槽动量下限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.rsrsMin,
    min: -10,
    max: 10,
    step: 0.1,
    description: 'DAS §2.2 rsrs_min（作用在次槽，combo 3 下即 WSM 下限）',
  },
  {
    key: 'rsrsMax',
    label: '次槽动量上限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.rsrsMax,
    min: -10,
    max: 50,
    step: 0.1,
    description: 'DAS §2.2 rsrs_max',
  },
  {
    key: 'maPeriod1',
    label: '均线 1 周期',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.maPeriod1,
    min: 2,
    max: 250,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 ma_periods[0]（最短均线）',
  },
  {
    key: 'maPeriod2',
    label: '均线 2 周期',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.maPeriod2,
    min: 2,
    max: 250,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 ma_periods[1]',
  },
  {
    key: 'maPeriod3',
    label: '均线 3 周期（兼价格比较）',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.maPeriod3,
    min: 2,
    max: 250,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 ma_periods[2]；同时充当 ma_for_price_check',
  },
  {
    key: 'maPeriod4',
    label: '均线 4 周期',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.maPeriod4,
    min: 2,
    max: 500,
    step: 1,
    unit: '根',
    description: 'DAS §2.2 ma_periods[3]（最长均线）',
  },
  {
    key: 'dailyChangeMin',
    label: '当日涨跌幅下限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.dailyChangeMin,
    min: -0.5,
    max: 0.5,
    step: 0.005,
    description: 'DAS §2.2 daily_change_min（-0.05 = -5%）',
  },
  {
    key: 'dailyChangeMax',
    label: '当日涨跌幅上限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.dailyChangeMax,
    min: -0.5,
    max: 0.5,
    step: 0.005,
    description: 'DAS §2.2 daily_change_max（0.05 = +5%）',
  },
  {
    key: 'maxHoldings',
    label: '最大持仓只数',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.maxHoldings,
    min: 1,
    max: 20,
    step: 1,
    unit: '只',
    description: 'DAS §2.2 max_holdings（同时也是排名截断只数）',
  },
  {
    key: 'singlePositionCap',
    label: '单标的上限',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.singlePositionCap,
    min: 0.05,
    max: 1,
    step: 0.01,
    description: 'DAS §2.2 single_position_cap（0.33 = 33% 总权益）',
  },
  {
    key: 'overweightThreshold',
    label: '超配阈值',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.overweightThreshold,
    min: 0.1,
    max: 1,
    step: 0.01,
    description: 'DAS §2.2 overweight_threshold（0.40，分母不含现金）',
  },
  {
    key: 'minHoldDays',
    label: '最短持有天数',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.minHoldDays,
    min: 0,
    max: 250,
    step: 1,
    unit: '自然日',
    description:
      'DAS §2.2 min_hold_days（DAS §9.1：自然日差，不是交易日）；DAS 锁定 5，ADR-022 后缺省 20（降换手）',
  },
  {
    key: 'takeProfitThreshold',
    label: '止盈阈值',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.takeProfitThreshold,
    min: 0.01,
    max: 5,
    step: 0.01,
    description: 'DAS §2.2 take_profit_threshold（含费后收益率）',
  },
  {
    key: 'takeProfitCooldown',
    label: '止盈冷却',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.takeProfitCooldown,
    min: 0,
    max: 60,
    step: 1,
    unit: '交易日',
    description: 'DAS §2.2 take_profit_cooldown',
  },
  {
    key: 'stopLossDrawdown',
    label: '成本止损线',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.stopLossDrawdown,
    min: 0.01,
    max: 1,
    step: 0.01,
    description: 'DAS §2.2 stop_loss_drawdown（相对持仓成本）',
  },
  {
    key: 'stopLossHigh',
    label: '高水位止损线',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.stopLossHigh,
    min: 0.01,
    max: 1,
    step: 0.01,
    description: 'DAS §2.2 stop_loss_high（相对建仓后最高价）',
  },
  {
    key: 'stopLossCooldown',
    label: '止损冷却',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.stopLossCooldown,
    min: 0,
    max: 60,
    step: 1,
    unit: '交易日',
    description: 'DAS §2.2 stop_loss_cooldown',
  },
  {
    key: 'commissionRate',
    label: '佣金费率',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.commissionRate,
    min: 0,
    max: 0.01,
    step: 0.00001,
    description: 'DAS §2.2 commission_rate（回测执行层；纸面账户以账户费用快照为准）',
  },
  {
    key: 'minCommission',
    label: '最低佣金',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.minCommission,
    min: 0,
    max: 100,
    step: 0.5,
    unit: '元',
    description: 'DAS §2.2 min_commission（回测执行层）',
  },
  {
    key: 'slippage',
    label: '滑点',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.slippage,
    min: 0,
    max: 0.05,
    step: 0.0005,
    description: 'DAS §2.2 slippage（回测执行层；买卖各让价一次）',
  },
  {
    key: 'lotSize',
    label: '最小交易单位',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.lotSize,
    min: 1,
    max: 1000,
    step: 1,
    unit: '股',
    description: 'DAS §2.2 lot_size（回测执行层）',
  },
  {
    key: 'etfExemptTax',
    label: 'ETF 免印花税',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.etfExemptTax,
    description: 'DAS §2.2 etf_exempt_tax（回测执行层：true 时卖出不缴印花税）',
  },
  {
    key: 'benchmark',
    label: '基准指数',
    type: 'select',
    default: DUALMOMENTUM_DEFAULTS.benchmark,
    options: [BENCHMARK_SYMBOL],
    description: 'DAS §2.1/§2.2 benchmark；用于市场过滤与超额基准',
  },
  {
    key: 'cashInterestRate',
    label: '闲置现金年化利率（档 1；ADR-022 后缺省 2%）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.cashInterestRate,
    min: 0,
    max: 0.2,
    step: 0.001,
    description: '研究口径（§12.3 闲置现金收益）；不入 DAS 对齐基线',
  },
  {
    key: 'exposureMode',
    label: '暴露模式（档 2）',
    type: 'select',
    default: DUALMOMENTUM_DEFAULTS.exposureMode,
    options: ['fixed', 'scale', 'vol'],
    description:
      'fixed = DAS 基线（候选均分满仓/否则空仓）；scale = 目标暴露 = min(1, 通过数 / divisor)；vol = 波动率目标（targetVol / 实现波动率）；ADR-022 后缺省 vol',
  },
  {
    key: 'exposureScaleDivisor',
    label: '暴露缩放分母（档 2）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.exposureScaleDivisor,
    min: 1,
    max: 10,
    step: 0.5,
    description: 'scale 模式下目标暴露 = min(1, 通过数 / 该值)',
  },
  {
    key: 'targetVol',
    label: '目标年化波动率（档 2 vol 模式）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.targetVol,
    min: 0.01,
    max: 1,
    step: 0.01,
    description: 'vol 模式下目标暴露 = clip(targetVol / 实现波动率, 0, 1)',
  },
  {
    key: 'volWindow',
    label: '实现波动率估计窗口（档 2 vol 模式）',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.volWindow,
    min: 5,
    max: 120,
    step: 5,
    unit: '交易日',
    description: 'vol 模式下滚动实现波动率的窗口长度',
  },
  {
    key: 'capRelaxBelow',
    label: '放开单标的 cap 的候选数阈值（档 2；0 = 不放开）',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.capRelaxBelow,
    min: 0,
    max: 10,
    step: 1,
    description: '候选数 < 该值时单标的 cap 放开到 1.0；缺省 0 = DAS 基线 33%',
  },
  {
    key: 'wsmMaxResearch',
    label: '主槽上界研究值（档 3；ADR-022 后缺省 100，DAS 锁定 5）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.wsmMaxResearch,
    min: 0,
    max: 100,
    step: 1,
    description: '档 3 放宽（§12.5 第 1 条）；DAS 锁定 5，ADR-022 后缺省 100',
  },
  {
    key: 'rsrsMaxResearch',
    label: '次槽上界研究值（档 3；ADR-022 后缺省 100，DAS 锁定 2）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.rsrsMaxResearch,
    min: 0,
    max: 100,
    step: 0.5,
    description: '档 3 放宽（§12.5 第 1 条）；DAS 锁定 2，ADR-022 后缺省 100',
  },
  {
    key: 'benchmarkGateMode',
    label: '基准门槛模式（档 3）',
    type: 'select',
    default: DUALMOMENTUM_DEFAULTS.benchmarkGateMode,
    options: ['hard', 'soft'],
    description: 'hard = DAS 基线；soft = 仅基准动量 > 0 时启用第 9 步（§12.5 第 2 条）；ADR-022 后缺省 soft',
  },
  {
    key: 'scoreMode',
    label: 'AND → 评分制（档 3）',
    type: 'select',
    default: DUALMOMENTUM_DEFAULTS.scoreMode,
    options: ['and', 'scored'],
    description:
      'and = DAS 基线（次槽 + 基准 AND）；scored = 次槽降为打分不拦截（§12.5 第 3 条）；ADR-022 后缺省 scored',
  },
  {
    key: 'momentumDecayExit',
    label: '动量衰减退出（§12.5 第 5 条；缺省 false = DAS 基线）',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.momentumDecayExit,
    description:
      '开启后：主槽动量转负或全池排名 > decayRankThreshold 即清仓，可绕过 minHoldDays，触发后开 stopLoss 冷却',
  },
  {
    key: 'decayRankThreshold',
    label: '衰减退出排名阈值（§12.5 第 5 条）',
    type: 'integer',
    default: DUALMOMENTUM_DEFAULTS.decayRankThreshold,
    min: 1,
    max: 50,
    step: 1,
    description: '动量衰减退出：当日主槽全池排名 > 该值即触发退出（缺省 8 = 7 只池下几乎不触发）',
  },
  {
    key: 'trailingTakeProfit',
    label: '追踪止盈（§12.5 第 4 条；缺省 false = DAS 基线固定止盈 + 冷却）',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.trailingTakeProfit,
    description:
      '开启后：qfq 收盘距高水位回撤 ≥ trailingTakeProfitDrawdown 即清仓，替代固定 30% 止盈；止盈后不开 takeProfitCooldown',
  },
  {
    key: 'trailingTakeProfitDrawdown',
    label: '追踪止盈回撤阈值（§12.5 第 4 条）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.trailingTakeProfitDrawdown,
    min: 0.02,
    max: 1,
    step: 0.01,
    description: '(高水位 − 当日 qfq 收盘) / 高水位 ≥ 该值即清仓（缺省 0.15 = 15%）',
  },
  {
    key: 'trailingTakeProfitRequiresThreshold',
    label: '追踪止盈前置 30% 门槛（§12.5 第 4 条）',
    type: 'boolean',
    default: DUALMOMENTUM_DEFAULTS.trailingTakeProfitRequiresThreshold,
    description:
      'true = 仍需先满足固定 takeProfitThreshold 才启用追踪（双门槛）；false（缺省）= 纯追踪，不设 30% 前置',
  },
  {
    key: 'symbolWeights',
    label: '按标的权重（§13.15 A2；缺省全 1 = 候选均分）',
    type: 'string',
    default: DUALMOMENTUM_DEFAULTS.symbolWeights,
    description:
      'JSON 对象字符串，对入选候选的市值分配按权重归一（weight[s] / Σ 入选权重）；未出现标的视为 1；如 {"sh518880": 2} 黄金腿 2 倍份额',
  },
  {
    key: 'poolExtension',
    label: '候选池扩展（§13.16 B1/B2；缺省空 = 锁定 7 只池）',
    type: 'string',
    default: DUALMOMENTUM_DEFAULTS.poolExtension,
    description:
      'JSON 数组字符串，运行时追加到 POOL_ORDER 之后（不改对齐契约常量）；用于纳入债券/商品等低相关资产，如 ["sh511260","sh511010"]',
  },
  {
    key: 'defensiveSymbol',
    label: '防御回退标的（§13.16 B1；缺省空 = 无候选时保持现金）',
    type: 'string',
    default: DUALMOMENTUM_DEFAULTS.defensiveSymbol,
    description: '非空时，候选为空则全仓持有该标的（沿用框架 defensive-fallback 语义）；如 "sh511260"',
  },
  {
    key: 'benchmarkBreakoutThreshold',
    label: '基准趋势破位阈值（§13.17 / ADR-024；缺省 0 = 关闭）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.benchmarkBreakoutThreshold,
    min: -10,
    max: 10,
    step: 0.1,
    description: '基准主槽动量（WSM）< 该值时强制切防御标的；取负数（如 -0.5）才启用；0 = 关闭',
  },
  {
    key: 'benchmarkBreakoutHysteresis',
    label: '基准破位切换迟滞（§13.17）',
    type: 'number',
    default: DUALMOMENTUM_DEFAULTS.benchmarkBreakoutHysteresis,
    min: 0,
    max: 5,
    step: 0.1,
    description: '切到防御后，基准动量需回升到 threshold+hysteresis 以上才切回股票（抑制换手）',
  },
];

function num(raw: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = raw[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

function int(raw: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  return Math.round(num(raw, key, fallback));
}

function bool(raw: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const v = raw[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return fallback;
}

/** 归一 symbolWeights 为 JSON 字符串（接受 JSON 字符串 / 原生对象 / 缺省），非法值退化为 '{}'（全 1 均分）。 */
function normalizeSymbolWeightsJson(raw: Readonly<Record<string, unknown>>, fallback: string): string {
  const v = raw.symbolWeights;
  let candidate: Record<string, unknown> | null = null;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        candidate = parsed as Record<string, unknown>;
    } catch {
      candidate = null;
    }
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    candidate = v as Record<string, unknown>;
  }
  if (!candidate) return fallback; // 缺省 fallback='{}'
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(candidate)) {
    const n = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN;
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : fallback;
}

/** 归一 poolExtension 为 JSON 数组字符串（接受 JSON 字符串 / 原生数组 / 缺省），非法值退化为 '[]'。 */
function normalizePoolExtensionJson(raw: Readonly<Record<string, unknown>>, fallback: string): string {
  const v = raw.poolExtension;
  let candidate: unknown[] | null = null;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) candidate = parsed;
    } catch {
      candidate = null;
    }
  } else if (Array.isArray(v)) {
    candidate = v;
  }
  if (!candidate) return fallback; // 缺省 fallback='[]'
  const out = candidate.filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== x,
  );
  const dedup = [...new Set(out)];
  return dedup.length > 0 ? JSON.stringify(dedup) : fallback;
}

/** 合并默认值 + 用户参数，并做最小合法性收敛（不抛错，避免回测因单个参数中断）。 */
export function resolveDualMomentumParams(
  raw: Readonly<Record<string, unknown>> | undefined,
): DualMomentumParams {
  const src = raw ?? {};
  const d = DUALMOMENTUM_DEFAULTS;
  const comboRaw = typeof src.momentumCombo === 'string' ? src.momentumCombo : d.momentumCombo;
  const combo: MomentumCombo =
    comboRaw === 'nday_return_rsrs' || comboRaw === 'nday_return_wsm_v2' ? comboRaw : 'wsm_v2_rsrs';

  return {
    momentumCombo: combo,
    wsmPeriod: Math.max(2, int(src, 'wsmPeriod', d.wsmPeriod)),
    useWsmV2: bool(src, 'useWsmV2', d.useWsmV2),
    ndayReturnPeriod: Math.max(2, int(src, 'ndayReturnPeriod', d.ndayReturnPeriod)),
    ndayReturnAnnualize: bool(src, 'ndayReturnAnnualize', d.ndayReturnAnnualize),
    rsrsPeriod: Math.max(2, int(src, 'rsrsPeriod', d.rsrsPeriod)),
    rsrsStdPeriod: Math.max(2, int(src, 'rsrsStdPeriod', d.rsrsStdPeriod)),
    rsrsQualityFilter: bool(src, 'rsrsQualityFilter', d.rsrsQualityFilter),
    wsmMin: num(src, 'wsmMin', d.wsmMin),
    wsmMax: num(src, 'wsmMax', d.wsmMax),
    rsrsMin: num(src, 'rsrsMin', d.rsrsMin),
    rsrsMax: num(src, 'rsrsMax', d.rsrsMax),
    maPeriod1: Math.max(2, int(src, 'maPeriod1', d.maPeriod1)),
    maPeriod2: Math.max(2, int(src, 'maPeriod2', d.maPeriod2)),
    maPeriod3: Math.max(2, int(src, 'maPeriod3', d.maPeriod3)),
    maPeriod4: Math.max(2, int(src, 'maPeriod4', d.maPeriod4)),
    dailyChangeMin: num(src, 'dailyChangeMin', d.dailyChangeMin),
    dailyChangeMax: num(src, 'dailyChangeMax', d.dailyChangeMax),
    maxHoldings: Math.max(1, int(src, 'maxHoldings', d.maxHoldings)),
    singlePositionCap: num(src, 'singlePositionCap', d.singlePositionCap),
    overweightThreshold: num(src, 'overweightThreshold', d.overweightThreshold),
    minHoldDays: Math.max(0, int(src, 'minHoldDays', d.minHoldDays)),
    takeProfitThreshold: num(src, 'takeProfitThreshold', d.takeProfitThreshold),
    takeProfitCooldown: Math.max(0, int(src, 'takeProfitCooldown', d.takeProfitCooldown)),
    stopLossDrawdown: num(src, 'stopLossDrawdown', d.stopLossDrawdown),
    stopLossHigh: num(src, 'stopLossHigh', d.stopLossHigh),
    stopLossCooldown: Math.max(0, int(src, 'stopLossCooldown', d.stopLossCooldown)),
    commissionRate: num(src, 'commissionRate', d.commissionRate),
    minCommission: num(src, 'minCommission', d.minCommission),
    slippage: num(src, 'slippage', d.slippage),
    lotSize: Math.max(1, int(src, 'lotSize', d.lotSize)),
    etfExemptTax: bool(src, 'etfExemptTax', d.etfExemptTax),
    benchmark: typeof src.benchmark === 'string' && src.benchmark !== '' ? src.benchmark : d.benchmark,
    // 档 1：ADR-022 后缺省 0.02 = 2%（DAS 锁定值为 0 = 引擎不计息）
    cashInterestRate: Math.max(0, num(src, 'cashInterestRate', d.cashInterestRate)),
    // 档 2：缺省回落到 d（DEFAULTS）——ADR-022 后缺省 = 'vol'
    exposureMode:
      src.exposureMode === 'scale' || src.exposureMode === 'vol' ? src.exposureMode : d.exposureMode,
    exposureScaleDivisor: Math.max(1, num(src, 'exposureScaleDivisor', d.exposureScaleDivisor)),
    targetVol: Math.max(0.01, num(src, 'targetVol', d.targetVol)),
    volWindow: Math.max(5, int(src, 'volWindow', d.volWindow)),
    capRelaxBelow: Math.max(0, int(src, 'capRelaxBelow', d.capRelaxBelow)),
    // 档 3：DAS 锁定值 wsmMax=5 / rsrsMax=2；ADR-022 后缺省 100，research 上界只放宽不收窄
    wsmMaxResearch: Math.max(d.wsmMax, num(src, 'wsmMaxResearch', d.wsmMaxResearch)),
    rsrsMaxResearch: Math.max(d.rsrsMax, num(src, 'rsrsMaxResearch', d.rsrsMaxResearch)),
    // 缺省回落到 d（DEFAULTS）——ADR-022 后缺省 = 'soft' / 'scored'
    benchmarkGateMode: src.benchmarkGateMode === 'soft' ? 'soft' : d.benchmarkGateMode,
    scoreMode: src.scoreMode === 'scored' ? 'scored' : d.scoreMode,
    momentumDecayExit: bool(src, 'momentumDecayExit', d.momentumDecayExit),
    decayRankThreshold: Math.max(1, int(src, 'decayRankThreshold', d.decayRankThreshold)),
    // 追踪止盈（§12.5 第 4 条；缺省 false = DAS 基线固定止盈 + 冷却，逐位不变）
    trailingTakeProfit: bool(src, 'trailingTakeProfit', d.trailingTakeProfit),
    trailingTakeProfitDrawdown: Math.max(
      0.01,
      num(src, 'trailingTakeProfitDrawdown', d.trailingTakeProfitDrawdown),
    ),
    trailingTakeProfitRequiresThreshold: bool(
      src,
      'trailingTakeProfitRequiresThreshold',
      d.trailingTakeProfitRequiresThreshold,
    ),
    // §13.15 A2：缺省 '{}' = 候选均分，基线不变；接受 JSON 字符串或对象两种形式，归一为 JSON 字符串
    symbolWeights: normalizeSymbolWeightsJson(src, d.symbolWeights),
    // §13.16 B1/B2：缺省 '[]' = 只用 DAS 锁定 7 只池；防御回退缺省 '' = 无候选时保持现金
    poolExtension: normalizePoolExtensionJson(src, d.poolExtension),
    // ⚠️ 「键存在即用之」：显式传 '' 表示**关闭防御回退**（否则空串会回落默认值，无法关闭）
    defensiveSymbol:
      src.defensiveSymbol !== undefined && src.defensiveSymbol !== null
        ? typeof src.defensiveSymbol === 'string'
          ? src.defensiveSymbol.trim()
          : d.defensiveSymbol
        : d.defensiveSymbol,
    // §13.17 / ADR-024：基准破位切防御；缺省 0 = 关闭（0 表示「不启用」而非「WSM<0 即切」）
    benchmarkBreakoutThreshold: num(src, 'benchmarkBreakoutThreshold', d.benchmarkBreakoutThreshold),
    benchmarkBreakoutHysteresis: Math.max(
      0,
      num(src, 'benchmarkBreakoutHysteresis', d.benchmarkBreakoutHysteresis),
    ),
  };
}

/**
 * 指标预热所需 bar 根数（不足则整体短路）。
 *
 * 默认参数下等于 `INDICATOR_LOOKBACK = 60`；参数放大时同步放大，避免「参数变了但预热没变」
 * 导致的隐性短窗口。
 */
export function dualMomentumLookback(p: DualMomentumParams): number {
  return Math.max(
    p.wsmPeriod,
    p.ndayReturnPeriod,
    p.rsrsPeriod + p.rsrsStdPeriod,
    p.maPeriod1,
    p.maPeriod2,
    p.maPeriod3,
    p.maPeriod4,
  );
}
