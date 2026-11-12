/**
 * DualMomentum 策略适配器（DAS-3.1 是唯一裁判）。
 *
 * 分工：
 * - **L1**（指标 / 过滤 / 排名）复用 `l1/` 的既有实现，不在这里重算公式；
 * - **L2**（§3.4 组合层：止损 / 止盈 / 再平衡 / 超配 / 买入预算）在本文件实现；
 * - **执行层**（成交价、涨跌停、停牌、费用）由回测引擎负责，本文件只给目标。
 *
 * 复权口径：`ctx` 提供的一切价格都是**前复权到最新**的 qfq 序列。DAS 用的是
 * 「前复权到当日」的 adj 序列，两者只差一个**窗口内恒定的比例因子**，因此
 * 指标（对数斜率 / 收益率 / RSRS / MA 比值）与「今收 vs 前收」的比较完全等价，
 * 无需在此做因子换算。涉及**金额**的量（市值 / 权益 / 目标金额）一律取 `ctx` 的
 * bfq 口径（`PositionView.marketValue` / `ctx.equity`），不混用 qfq 价格。
 *
 * ⚠️ 已知偏差（写入 `docs/audit/dualmomentum-l1-alignment.md`）：
 * 1. `unit_cost` 取引擎的移动加权成本（**含买入费用**），DAS 的 `unit_cost` 不含费用
 *    （约 6bp 差异），影响止损/止盈判定的边界；
 * 2. 手数取整由引擎按 T+1 实际开盘价完成（DAS 按 T 日 plan_price 取整），
 *    并带引擎既有的「不足一手但 ≥1 股时补 1 手」兜底；
 * 3. 高水位在 qfq 空间维护（除权连续），与 DAS「raw 价 + 除权调整」等价，
 *    但建仓首日的水位由「成交价 × 当日 qfq/raw 比」换算得到。
 */
import {
  defineStrategy,
  type BarView,
  type ExitReason,
  type FillNotice,
  type PositionView,
  type StrategyContext,
  type TargetPosition,
  type TargetSet,
} from '../../strategy/types.js';
import { calcMa, calcNdayReturnMomentum, calcRsrsZ, calcWeightedSlopeMomentum } from './l1/indicators.js';
import { evaluateL1Filters } from './l1/decisions.js';
import { COMBO_SLOTS, DEFAULT_LIMIT_RATIO, POOL_ORDER } from './l1/params.js';
import {
  DUALMOMENTUM_PARAM_SCHEMA,
  dualMomentumLookback,
  resolveDualMomentumParams,
  type DualMomentumParams,
} from './params.js';

const DAY_MS = 86_400_000;

/** 冷却表项：`pending` = 成交当日（DAS 的 `sell_date < T` ⇒ 当日不冷却）。 */
interface CooldownEntry {
  remaining: number;
  pending: boolean;
}

interface DualMomentumState {
  params: DualMomentumParams;
  /** 建仓日（= 成交日 T+1） */
  entryDate: Map<string, string>;
  /** 建仓成交价（raw，用于把高水位换算到 qfq 空间） */
  entryFillPrice: Map<string, number>;
  /** 高水位（qfq 空间，除权连续） */
  highWater: Map<string, number>;
  /** 冷却（交易日计数） */
  cooldown: Map<string, CooldownEntry>;
  warnedNoBenchmark: boolean;
}

/**
 * 波动率目标暴露（`exposureMode='vol'`；缺省路径不调用，基线不变）。
 *
 * `exposure = clip(targetVol / realizedVol, 0, 1)`，其中 `realizedVol` = 组合
 * （现金 + 全部持仓市值）逐日权益的 `volWindow` 日滚动标准差 × √250（年化）。
 * 数据不足（< volWindow 根）或无波动时返回 1（满仓，退化为基线行为）。
 */
function computeVolTargetExposure(ctx: StrategyContext, p: DualMomentumParams): number {
  // 用 ctx.series 拿不到权益，改从持仓 + 现金重建「截至 asOf 的权益序列」
  // 简化：只取当前时刻权益，按「实现波动率 = 目标组合历史日收益 std」近似为
  // 持仓标的混合收益的滚动 std（各持仓按当前市值加权）
  const positions = ctx.positions().filter((v) => v.qty > 0);
  const totalMv = positions.reduce((a, v) => a + v.marketValue, 0);
  if (totalMv <= 0) return 1; // 无风险敞口时不缩放（避免空仓日反复拉低暴露）

  const w = p.volWindow;
  let retSum = 0;
  let retSqSum = 0;
  let n = 0;
  for (const pos of positions) {
    const weight = pos.marketValue / totalMv;
    if (weight <= 0) continue;
    // 该标的截至 asOf 的最近 w 根日收益（qfq 轨，ctx.series 提供）
    const closes = ctx.series(pos.symbol, w + 1);
    if (closes.length < 2) continue;
    for (let i = 1; i < closes.length; i++) {
      const r = closes[i] / closes[i - 1] - 1;
      retSum += weight * r;
      retSqSum += weight * r * r;
      n++;
    }
  }
  if (n < 2) return 1;
  const mean = retSum / n;
  const varAll = retSqSum / n - mean * mean;
  const dailyVol = Math.sqrt(Math.max(0, varAll));
  const realizedVol = dailyVol * Math.sqrt(250);
  if (realizedVol <= 0) return 1;
  return Math.max(0, Math.min(1, p.targetVol / realizedVol));
}

function createState(): DualMomentumState {
  return {
    params: resolveDualMomentumParams(undefined),
    entryDate: new Map(),
    entryFillPrice: new Map(),
    highWater: new Map(),
    cooldown: new Map(),
    warnedNoBenchmark: false,
  };
}

function isUsable(bar: BarView): boolean {
  if (!Number.isFinite(bar.volume) || bar.volume <= 0) return false;
  return [bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0);
}

function lastUsableClose(bars: readonly BarView[]): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (isUsable(bars[i])) return bars[i].close;
  }
  return null;
}

interface IndicatorSet {
  wsm: number;
  nday: number;
  rsrs: number;
  ma: Partial<Record<number, number>>;
}

/** 与 `precalcIndicators` 同构，但周期来自可调参数（默认值 ⇒ 与锁定常量逐位一致）。 */
function calcIndicators(bars: readonly BarView[], p: DualMomentumParams): IndicatorSet {
  const need = dualMomentumLookback(p);
  if (bars.length < need) return { wsm: 0, nday: 0, rsrs: 0, ma: {} };

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const rsrsWindow = p.rsrsPeriod + p.rsrsStdPeriod;

  const wsm = calcWeightedSlopeMomentum(closes.slice(-p.wsmPeriod), p.useWsmV2);
  const nday = calcNdayReturnMomentum(closes, p.ndayReturnPeriod, p.ndayReturnAnnualize);
  const rsrs = calcRsrsZ(
    highs.slice(-rsrsWindow),
    lows.slice(-rsrsWindow),
    p.rsrsPeriod,
    p.rsrsStdPeriod,
    p.rsrsQualityFilter,
  );

  const ma: Partial<Record<number, number>> = {};
  for (const period of [p.maPeriod1, p.maPeriod2, p.maPeriod3, p.maPeriod4]) {
    ma[period] = calcMa(closes, period);
  }
  return { wsm, nday, rsrs, ma };
}

function maOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/** 冷却推进：返回「本次决策日仍处于冷却」的标的集合。 */
function advanceCooldown(state: DualMomentumState): Set<string> {
  const cooling = new Set<string>();
  for (const [symbol, entry] of [...state.cooldown]) {
    if (entry.pending) {
      // 成交当日：DAS 只判 `sell_date < T`，当日不冷却
      entry.pending = false;
      continue;
    }
    if (entry.remaining > 0) cooling.add(symbol);
    entry.remaining -= 1;
    if (entry.remaining <= 0) state.cooldown.delete(symbol);
  }
  return cooling;
}

function startCooldown(state: DualMomentumState, symbol: string, days: number): void {
  if (days <= 0) {
    state.cooldown.delete(symbol);
    return;
  }
  state.cooldown.set(symbol, { remaining: days, pending: true });
}

/** 单标的的当日行情切片（L1 输入 + 高水位更新共用，避免重复取数）。 */
interface SymbolDay {
  bars: BarView[];
  hasBar: boolean;
  usable: boolean;
  snapshotPrice: number | null;
  prevCloseAdj: number;
  qfqClose: number | null;
}

function readSymbolDay(ctx: StrategyContext, symbol: string, lookback: number, asOf: string): SymbolDay {
  const bars = ctx.bars(symbol, lookback);
  if (bars.length === 0) {
    return { bars, hasBar: false, usable: false, snapshotPrice: null, prevCloseAdj: 0, qfqClose: null };
  }
  const last = bars[bars.length - 1];
  const hasBar = last.date === asOf;
  const usable = hasBar && isUsable(last);
  // DAS `last_valid_close`：当日不可成交则顺延最近有效收盘（qfq 空间同比例）
  const snapshotPrice = usable ? last.close : lastUsableClose(bars);
  // 前收（除权调整后）= 前一根 qfq 收盘；首根退化为自身
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;
  const prevCloseAdj = prevBar !== null && prevBar.close > 0 ? prevBar.close : last.close;
  const qfqClose = lastUsableClose(bars);
  return { bars, hasBar, usable, snapshotPrice, prevCloseAdj, qfqClose };
}

function createDualMomentumStrategy(): ReturnType<typeof defineStrategy> {
  const state = createState();

  return defineStrategy({
    id: 'dualmomentum',
    version: 'das-3.1',
    name: '双动量轮动（DAS-3.1）',
    paramSchema: DUALMOMENTUM_PARAM_SCHEMA,
    // 默认参数下 DAS 的指标预热是 60 根；参数放大时同步放大
    warmupDays: dualMomentumLookback(resolveDualMomentumParams(undefined)),
    // DAS §4：T 日收盘决策、T+1 开盘成交
    priceMode: 'open',

    init(ctx) {
      state.params = resolveDualMomentumParams(ctx.params);
      state.entryDate.clear();
      state.entryFillPrice.clear();
      state.highWater.clear();
      state.cooldown.clear();
      state.warnedNoBenchmark = false;
    },

    onFill(notice: FillNotice) {
      // 卖出成交 → 开冷却（止损 3 / 止盈 5 交易日）
      if (notice.side === 'sell') {
        const p = state.params;
        if (notice.reason === 'stop-loss') startCooldown(state, notice.symbol, p.stopLossCooldown);
        else if (notice.reason === 'take-profit') startCooldown(state, notice.symbol, p.takeProfitCooldown);
        // 追踪止盈（§12.5 第 4 条「止盈后不冷却」）：不开 takeProfitCooldown，只开 stopLossCooldown
        // 防同日反复；比固定止盈的 5 日冷却少 5 天空仓
        else if (notice.reason === 'take-profit-trailing')
          startCooldown(state, notice.symbol, p.stopLossCooldown);
        // 衰减退出开止损冷却（§12.5 第 4 条：止盈后不冷却，衰减是「动量转弱」而非止盈）
        else if (notice.reason === 'momentum-decay') startCooldown(state, notice.symbol, p.stopLossCooldown);
        return;
      }
      // 买入成交 → 新建仓（加仓不改建仓日与高水位）
      if (notice.side === 'buy' && !state.entryDate.has(notice.symbol)) {
        state.entryDate.set(notice.symbol, notice.date);
        state.entryFillPrice.set(notice.symbol, notice.price);
        state.highWater.delete(notice.symbol);
      }
    },

    decide(ctx: StrategyContext): TargetSet | null {
      const p = state.params;
      const slots = COMBO_SLOTS[p.momentumCombo];
      const asOf = ctx.asOf;
      const lookback = dualMomentumLookback(p);

      // ── 0) 状态对账：平仓清理 / 无建仓记录兜底 ──
      const positions = ctx.positions().filter((v) => v.qty > 0);
      const posBySymbol = new Map<string, PositionView>(positions.map((v) => [v.symbol, v]));
      for (const symbol of [...state.entryDate.keys()]) {
        if (!posBySymbol.has(symbol)) {
          state.entryDate.delete(symbol);
          state.entryFillPrice.delete(symbol);
          state.highWater.delete(symbol);
        }
      }
      for (const pos of positions) {
        if (!state.entryDate.has(pos.symbol)) {
          ctx.log(
            'warn',
            `DualMomentum：${pos.symbol} 有持仓但无建仓记录（回放/状态丢失），按 ${asOf} 兜底——最短持有与高水位从今日重算`,
          );
          state.entryDate.set(pos.symbol, asOf);
        }
      }

      const cooling = advanceCooldown(state);

      // ── 1) 基准动量（§3.3 第 9 步）──
      const benchCloses = ctx.indexSeries(p.benchmark, Math.max(p.wsmPeriod, p.ndayReturnPeriod, 2));
      let benchmarkPrimary = 0;
      if (benchCloses.length > 0) {
        benchmarkPrimary =
          slots.benchmark === 'wsm'
            ? calcWeightedSlopeMomentum(benchCloses.slice(-p.wsmPeriod), p.useWsmV2)
            : calcNdayReturnMomentum(benchCloses, p.ndayReturnPeriod, p.ndayReturnAnnualize);
      } else if (!state.warnedNoBenchmark) {
        state.warnedNoBenchmark = true;
        ctx.log(
          'warn',
          `DualMomentum：基准 ${p.benchmark} 无行情，市场过滤（第 9 步）退化为 benchmarkPrimary=0`,
        );
      }

      // ── 2) L1：逐标的指标 → 过滤 → 主槽降序排名 ──
      const dayBySymbol = new Map<string, SymbolDay>();
      const passed: { symbol: string; primary: number }[] = [];
      for (const symbol of POOL_ORDER) {
        const day = readSymbolDay(ctx, symbol, lookback, asOf);
        dayBySymbol.set(symbol, day);
        if (day.bars.length === 0) continue; // 池内从未有过 bar ⇒ POOL_ABSENT

        const ind = calcIndicators(day.bars, p);
        const primary = slots.primary === 'wsm' ? ind.wsm : ind.nday;
        const secondary = slots.secondary === 'rsrs' ? ind.rsrs : ind.wsm;
        const filter = evaluateL1Filters({
          inPool: true,
          hasBar: day.hasBar,
          snapshotPrice: day.snapshotPrice,
          prevCloseAdj: day.prevCloseAdj,
          ma5: maOrNull(ind.ma[p.maPeriod1]),
          ma10: maOrNull(ind.ma[p.maPeriod2]),
          ma20: maOrNull(ind.ma[p.maPeriod3]),
          ma60: maOrNull(ind.ma[p.maPeriod4]),
          primary,
          secondary,
          benchmarkPrimary,
          primaryRange: [p.wsmMin, p.wsmMax],
          secondaryRange: [p.rsrsMin, p.rsrsMax],
          cooling: cooling.has(symbol),
          limitRatio: DEFAULT_LIMIT_RATIO,
          dailyChangeMin: p.dailyChangeMin,
          dailyChangeMax: p.dailyChangeMax,
        });
        if (filter.pass) passed.push({ symbol, primary });
      }
      // 稳定降序：并列保持 POOL_ORDER（JS sort 自 ES2019 起稳定）
      passed.sort((a, b) => b.primary - a.primary);

      // ── 档 3：放宽上界 / 基准软化 / 评分制（全部缺省 = DAS 锁定语义，逐位不变）──
      // 触发条件：任一研究开关偏离缺省。缺省时走基线路径（`filtered = passed`）。
      const wsmRelaxed = p.wsmMaxResearch > p.wsmMax;
      const rsrsRelaxed = p.rsrsMaxResearch > p.rsrsMax;
      let filtered = passed;
      if (wsmRelaxed || rsrsRelaxed || p.benchmarkGateMode === 'soft' || p.scoreMode === 'scored') {
        filtered = [];
        for (const symbol of POOL_ORDER) {
          const day = dayBySymbol.get(symbol);
          if (!day || day.bars.length === 0) continue;
          const ind = calcIndicators(day.bars, p);
          const primary = slots.primary === 'wsm' ? ind.wsm : ind.nday;
          const secondary = slots.secondary === 'rsrs' ? ind.rsrs : ind.wsm;
          const primaryInRange = primary >= p.wsmMin && primary <= p.wsmMaxResearch;
          // 评分制：次槽不再拦截（`scored` 时 `secondaryInRange` 恒 true）
          const secondaryInRange =
            p.scoreMode === 'scored' ? true : secondary >= p.rsrsMin && secondary <= p.rsrsMaxResearch;
          // 基准软化：`soft` 时仅当基准动量 > 0 才启用第 9 步
          const benchGate =
            p.benchmarkGateMode === 'soft'
              ? benchmarkPrimary > 0
                ? primary >= benchmarkPrimary
                : true
              : primary >= benchmarkPrimary;
          if (primaryInRange && secondaryInRange && benchGate) filtered.push({ symbol, primary });
        }
        filtered.sort((a, b) => b.primary - a.primary);
      }

      // ── 档 2：连续仓位（缺省 `fixed` = DAS 基线「候选均分满仓/否则空仓」）──
      // `scale`：目标暴露 = min(1, 通过数 / divisor)；`vol`：波动率目标
      // （exposure = targetVol / 实现波动率，clip 到 [0,1]；实现波动率 = 组合 20 日日收益 std × √250，
      //  无持仓/数据不足时实现波动率取 0 ⇒ 暴露 = 1，退化为满仓）
      let exposureScale = 1.0;
      if (p.exposureMode === 'scale') {
        const passCount = filtered.length;
        exposureScale = Math.min(1, passCount / p.exposureScaleDivisor);
      } else if (p.exposureMode === 'vol') {
        exposureScale = computeVolTargetExposure(ctx, p);
      }

      const selected = filtered.slice(0, p.maxHoldings);
      const selectedSet = new Set(selected.map((s) => s.symbol));

      // 档 2 cap 条件化：候选数 < capRelaxBelow 时允许单只接近满仓（0 = 不放开）
      const capRelaxed =
        p.exposureMode === 'scale' && p.capRelaxBelow > 0 && filtered.length < p.capRelaxBelow;
      const effectiveCap = capRelaxed ? 1.0 : p.singlePositionCap;
      const selectedSetForCap = selectedSet; // 语义不变，别名仅供阅读
      void selectedSetForCap;

      // ── 3) L2 卖出：止损 > 止盈 > 再平衡 > 超配（§3.4）──
      const totalValue = ctx.equity;
      const sellAll = new Map<string, ExitReason>();
      const exitReasons: Record<string, ExitReason> = {};

      for (const pos of positions) {
        const price = pos.qty > 0 ? pos.marketValue / pos.qty : 0;
        if (!(price > 0)) continue;

        const day = dayBySymbol.get(pos.symbol) ?? readSymbolDay(ctx, pos.symbol, lookback, asOf);
        if (!dayBySymbol.has(pos.symbol)) dayBySymbol.set(pos.symbol, day);

        // 高水位（qfq）：首日按「成交价 × 当日 qfq/raw 比」换算，之后取收盘新高
        const qfqClose = day.qfqClose;
        if (qfqClose !== null && qfqClose > 0) {
          const prev = state.highWater.get(pos.symbol);
          if (prev === undefined) {
            const scale = qfqClose / price;
            const fill = state.entryFillPrice.get(pos.symbol) ?? price;
            state.highWater.set(pos.symbol, Math.max(fill * scale, qfqClose));
          } else {
            state.highWater.set(pos.symbol, Math.max(prev, qfqClose));
          }
        }

        // 持仓的主槽动量 + 排名（衰减退出用；缺省开关关闭时零开销——仍算了但不判定）
        const ind = calcIndicators(day.bars, p);
        const primaryNow = slots.primary === 'wsm' ? ind.wsm : ind.nday;

        const daysSinceEntry = calendarDaysBetween(state.entryDate.get(pos.symbol) ?? asOf, asOf);
        // 成本止损：(unit_cost − price)/unit_cost ≥ stopLossDrawdown
        const costDrawdown = pos.costBasis > 0 ? 1 - pos.marketValue / pos.costBasis : 0;
        // 高水位止损：(hw − price)/hw ≥ stopLossHigh
        const hw = state.highWater.get(pos.symbol);
        const highDrawdown = hw !== undefined && hw > 0 && qfqClose !== null ? (hw - qfqClose) / hw : 0;

        if (costDrawdown >= p.stopLossDrawdown || highDrawdown >= p.stopLossHigh) {
          sellAll.set(pos.symbol, 'stop-loss');
          continue;
        }
        const takeProfit = pos.costBasis > 0 ? pos.marketValue / pos.costBasis - 1 : 0;
        // 追踪止盈（§12.5 第 4 条；opt-in，缺省关闭 = 下方固定 30% 止盈逐位不变）：
        // qfq 收盘距高水位回撤 ≥ trailingTakeProfitDrawdown 即清仓；
        // RequiresThreshold=true 时仍需先满足固定 takeProfitThreshold（双门槛）
        const trailingHit =
          p.trailingTakeProfit &&
          highDrawdown >= 0 &&
          qfqClose !== null &&
          hw !== undefined &&
          hw > 0 &&
          highDrawdown >= p.trailingTakeProfitDrawdown &&
          (!p.trailingTakeProfitRequiresThreshold || takeProfit >= p.takeProfitThreshold);
        if (trailingHit) {
          sellAll.set(pos.symbol, 'take-profit-trailing');
          continue;
        }
        if (daysSinceEntry >= p.minHoldDays && takeProfit >= p.takeProfitThreshold) {
          sellAll.set(pos.symbol, 'take-profit');
          continue;
        }
        if (!selectedSet.has(pos.symbol) && daysSinceEntry >= p.minHoldDays) {
          sellAll.set(pos.symbol, 'out-of-candidate');
          continue;
        }
        // 动量衰减退出（§12.5 第 5 条；可绕过 minHoldDays，缺省关闭 = DAS 基线）：
        // 主槽动量转负 / 排名跌出 decayRankThreshold，两者任一触发即清仓
        if (p.momentumDecayExit && selectedSet.has(pos.symbol)) {
          const rankNow = filtered.filter((c) => c.primary > primaryNow).length + 1;
          const decayByMomentum = primaryNow < 0;
          const decayByRank = rankNow > p.decayRankThreshold;
          if (decayByMomentum || decayByRank) {
            sellAll.set(pos.symbol, 'momentum-decay');
          }
        }
      }
      for (const [symbol, reason] of sellAll) exitReasons[symbol] = reason;

      // ── 4) 超配减仓（对 1–3 执行后的剩余持仓；分母不含现金）──
      const remaining = positions.filter((v) => !sellAll.has(v.symbol) && v.marketValue > 0);
      const overweightTarget = new Map<string, number>();
      if (remaining.length >= 2) {
        const holdingsValue = remaining.reduce((sum, v) => sum + v.marketValue, 0);
        if (holdingsValue > 0) {
          for (const pos of remaining) {
            if (pos.marketValue / holdingsValue > p.overweightThreshold) {
              overweightTarget.set(pos.symbol, p.overweightThreshold * holdingsValue);
            }
          }
        }
      }

      // ── 5) 买入预算（§3.4：cash_after_sells_est / N，单只不超过权益 cap）──
      const sellProceeds = [...sellAll.keys()].reduce((sum, symbol) => {
        const pos = posBySymbol.get(symbol);
        if (!pos) return sum;
        const price = pos.marketValue / pos.qty;
        const gross = pos.qty * price;
        const fee = Math.max(gross * p.commissionRate, p.minCommission);
        return sum + gross * (1 - p.slippage) - fee;
      }, 0);
      const cashAfterSells = ctx.cash + sellProceeds;
      // 档 2：目标敞口 = 现金可用额度 × exposureScale（缺省 1.0 = 基线「候选均分满仓」）
      const deployBudget = cashAfterSells * exposureScale;
      const capAmount = totalValue * effectiveCap;
      const candidates = selected.filter((s) => !sellAll.has(s.symbol) && !overweightTarget.has(s.symbol));
      // §13.15 A2：按标的权重归一分配（缺省 '{}' = 均分，基线不变）；
      // p.symbolWeights 是 JSON 字符串，解析为对象后 weight[s] 未出现视为 1
      let weightMap: Readonly<Record<string, number>> = {};
      try {
        const parsed = JSON.parse(p.symbolWeights);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          weightMap = parsed as Readonly<Record<string, number>>;
      } catch {
        weightMap = {};
      }
      const hasWeights = Object.keys(weightMap).length > 0;
      const weightOf = (sym: string): number => weightMap[sym] ?? 1;
      const weightSum = hasWeights ? candidates.reduce((sum, c) => sum + weightOf(c.symbol), 0) : 0;

      const targets: TargetPosition[] = [];
      for (const cand of candidates) {
        const pos = posBySymbol.get(cand.symbol);
        const currentValue = pos ? pos.marketValue : 0;
        // 缺省 hasWeights=false ⇒ perTarget=deployBudget/候选数（基线逐位不变）
        const perTarget =
          hasWeights && weightSum > 0
            ? (deployBudget * weightOf(cand.symbol)) / weightSum
            : candidates.length > 0
              ? deployBudget / candidates.length
              : 0;
        const addValue = Math.min(perTarget, Math.max(0, capAmount - currentValue));
        if (pos !== undefined && addValue <= 0) {
          // 已持仓但本期不加仓：保持不动。不能用 `targetNotional = 市值` 表达，
          // 否则 T 收盘→T+1 开盘的价格漂移会被执行层误判成「减仓」。
          targets.push({ symbol: cand.symbol, hold: true, reason: 'holding-retained' });
          continue;
        }
        const notional = currentValue + Math.max(0, addValue);
        targets.push({
          symbol: cand.symbol,
          targetNotional: notional,
          targetWeight: totalValue > 0 ? notional / totalValue : 0,
          reason: pos ? 'holding-retained' : 'candidate-top',
          score: cand.primary,
        });
      }
      // 超配标的：只减仓不加仓
      for (const [symbol, notional] of overweightTarget) {
        targets.push({
          symbol,
          targetNotional: notional,
          targetWeight: totalValue > 0 ? notional / totalValue : 0,
          reason: 'rebalance',
        });
      }
      // 候选人之外、且未到最短持有期的持仓：保持不动（不参与换手与资金分配）
      for (const pos of positions) {
        if (selectedSet.has(pos.symbol) || sellAll.has(pos.symbol) || overweightTarget.has(pos.symbol))
          continue;
        targets.push({ symbol: pos.symbol, hold: true, reason: 'holding-retained' });
      }

      ctx.tag('dm.selected', selected.map((s) => s.symbol).join(','));
      if (sellAll.size > 0) ctx.tag('dm.sell', [...sellAll.keys()].join(','));

      if (targets.length === 0 && positions.length === 0) return null;
      return { targets, mode: 'replace', exitReasons };
    },
  });
}

export { createDualMomentumStrategy };
export const dualMomentumStrategy = createDualMomentumStrategy();
