/**
 * 纸面账户行情装载（PA-08）
 *
 * 口径与回测 CLI（`runCommand`）**逐条对齐**，避免纸面账户与回测结果漂移：
 *   - 信号轨 `v_etf_qfq`、成交轨 `v_etf_bfq`（动态池走 `loadUniversePanel`，固定池走 `getBars`）；
 *   - 装载区间 = `[回放起点 − warmup, 决策日 T]`，warmup 按**账户参数**推导；
 *   - 时点名录 `loadUniverseProvider(replayStart, T)`（逐日 `snapshotAt`）。
 *
 * 回放（replay）是必须的：`wufu-rotation` 的走弱期状态跨日演进，而纸面日更每天是新进程，
 * **不持久化策略内部状态**（`paper_account` 无 state 列，方案 §5.3 的 DDL 已定稿）。
 * 故每个决策都把 `[start_date .. T]` 的策略决策重放一遍（影子期持仓恒为空），
 * 只保留最后一天的目标。
 *
 * ⚠️ 只读 DuckDB；本文件不写任何库。
 */
import { BacktestInvariantError } from '../backtest/engine.js';
import { loadTradingCalendar, type TradingCalendar } from '../backtest/calendar.js';
import { getBars } from '../backtest/marketPanel.js';
import { loadUniversePanel, loadIndexBars } from '../backtest/universe/dynamicPanel.js';
import {
  loadUniverseProvider,
  type InMemoryUniverseProvider,
  type UniverseResolver,
} from '../backtest/universe/provider.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL, GLOBAL_ETF_POOL } from '../backtest/universe/fixedPool.js';
import { WEAK_PERIOD_INDEXES } from '../backtest/universe/pointInTime.js';
import { resolveWufuRotationParams } from '../backtest/strategies/wufuRotation/index.js';
import { momentumRawWindow } from '../backtest/strategies/wufuRotation/filters.js';
import {
  BENCHMARK_SYMBOL as DM_BENCHMARK_SYMBOL,
  POOL_ORDER as DM_POOL_ORDER,
} from '../backtest/strategies/dualmomentum/l1/params.js';
import {
  dualMomentumLookback,
  resolveDualMomentumParams,
  DUALMOMENTUM_DEFAULTS,
} from '../backtest/strategies/dualmomentum/params.js';
import { DEFAULT_DYNAMIC_TOP_N, DEFAULT_LIQUIDITY_DIVISOR } from '../backtest/universe/pointInTime.js';
import type { Bar } from '../backtest/types.js';

/** 纸面账户可用的池口径：由策略 id 推导（见 `universeModeForStrategy`） */
export type PaperUniverseMode = 'fixed' | 'dynamic';

export interface PaperMarketData {
  calendar: TradingCalendar;
  signalBars: ReadonlyMap<string, readonly Bar[]>;
  execBars: ReadonlyMap<string, readonly Bar[]>;
  indexBars: ReadonlyMap<string, readonly Bar[]>;
  benchmarkBars: readonly Bar[];
  universe: UniverseResolver;
  /** 实际装载起点（诊断用） */
  loadStart: string;
  /** 实际装载终点（= 决策日 T） */
  loadEnd: string;
}

export interface BuildPaperMarketDataInput {
  strategyId: string;
  /** 建户时冻结的参数（`paper_account.params_json`） */
  params: Readonly<Record<string, unknown>>;
  /** 回放起点（含）：影子期 = `start_date`（无则用决策日） */
  replayStart: string;
  /** 决策日 T（含） */
  end: string;
  benchmark: string;
  /** 已持仓标的（落账期必须把它们的序列装进来） */
  heldSymbols?: readonly string[];
  /**
   * 额外需要行情的标的（PA-09：组合信号跟随的目标可能不在固定池里，
   * 不装载就没法定价）。只影响**装载范围**，不影响 `asOf` 时点判定。
   */
  extraSymbols?: readonly string[];
  /**
   * 是否装载时点名录；默认 `true`。
   * 落账期结算走 `targetsOverride`，**不会**调用 `universe` ⇒ 关掉可省掉一次全市场池查询。
   * 关闭后误调 `universe()` 会直接抛错（不允许静默返回空名录）。
   */
  withUniverse?: boolean;
  divisor?: number;
  topN?: number;
}

/**
 * 池口径推导。
 *
 * `wufu-rotation` 的候选来自全市场 ETF ⇒ 必须 dynamic；其余内置策略走固定池。
 * （`paper_account` 未持久化 universeMode，按策略 id 推导 —— 与 CLI 的硬约束一致：
 * wufu 配固定池会漏掉候选。）
 */
export function universeModeForStrategy(strategyId: string): PaperUniverseMode {
  return strategyId === 'wufu-rotation' ? 'dynamic' : 'fixed';
}

/**
 * 策略预热根数（与回测 CLI 的 `strategyWarmup` 同口径）。
 *
 * `dualmomentum` 默认需要 60 根（`INDICATOR_LOOKBACK`），不足时 L1 整体短路返回 0 ⇒
 * 不装载预热段会让账户前 ~60 个交易日恒为空集。参数放大时按公式同步放大。
 */
export function strategyWarmup(strategyId: string, params: Readonly<Record<string, unknown>>): number {
  if (strategyId === 'wufu-rotation') {
    return momentumRawWindow(resolveWufuRotationParams({ ...params }));
  }
  if (strategyId === 'dualmomentum') {
    return dualMomentumLookback(resolveDualMomentumParams({ ...params }));
  }
  return 1;
}

/**
 * 策略自带的固定标的（只影响装载范围，不影响 `asOf` 时点判定）。
 *
 * `FIXED_ETF_POOL` 是 v5.2 的 114 只名单，**不含 `sh513000`**；dualmomentum 的 7 只池
 * 必须显式补上，否则该标的永远没有 bar（L1 会判 `POOL_ABSENT`）。
 */
export function paperStrategySymbols(strategyId: string): readonly string[] {
  if (strategyId !== 'dualmomentum') return [];
  // 🔴 **防御回退标的必须一起装载**（ADR-024）：`benchmarkBreakoutThreshold=-0.5` 触发时
  //   `decide()` 会把防御标的设为**排他目标**，若该标的无 bar ⇒ 目标指向不存在的行情
  //   ⇒ 纸面决策产出坏订单/抛错。
  //   （同 §13.17.4 / §13.18 的装载层缺陷同源：会下单的标的必须进装载清单。）
  const defensive = DUALMOMENTUM_DEFAULTS.defensiveSymbol.trim();
  return defensive === '' ? DM_POOL_ORDER : [...DM_POOL_ORDER, defensive];
}

/** 策略需要的**指数**轨（`v_etf_*` 不含指数，必须走 `raw_kline_daily` 的 index 行） */
export function paperStrategyIndexCodes(strategyId: string): readonly string[] {
  return strategyId === 'dualmomentum' ? [DM_BENCHMARK_SYMBOL] : [];
}

/** 装载纸面决策所需的全部行情（一次区间批量取数，禁止逐标的循环） */
export async function buildPaperMarketData(input: BuildPaperMarketDataInput): Promise<PaperMarketData> {
  const calendar = await loadTradingCalendar();
  const warmup = Math.max(5, strategyWarmup(input.strategyId, input.params) + 1);
  const loadStart = calendar.lastN(input.replayStart, warmup)[0] ?? input.replayStart;
  const end = input.end;

  const mode = universeModeForStrategy(input.strategyId);
  const userSymbol = typeof input.params.symbol === 'string' ? input.params.symbol : null;
  // 🔴 建户参数里显式指定的防御标的也要装载（ADR-024 破位切防御会把它设为排他目标）
  const paramDefensive =
    typeof input.params.defensiveSymbol === 'string' && input.params.defensiveSymbol.trim() !== ''
      ? input.params.defensiveSymbol.trim()
      : null;
  const extraSymbols = [
    ...new Set([
      ...FIXED_ETF_POOL,
      ...GLOBAL_ETF_POOL,
      DEFENSIVE_ETF,
      input.benchmark,
      ...paperStrategySymbols(input.strategyId),
      ...(paramDefensive ? [paramDefensive] : []),
      ...(userSymbol ? [userSymbol] : []),
      ...(input.heldSymbols ?? []),
      ...(input.extraSymbols ?? []),
    ]),
  ];
  const symbols = [...new Set([...extraSymbols, ...WEAK_PERIOD_INDEXES])];

  const providerPromise =
    input.withUniverse === false
      ? null
      : loadUniverseProvider(input.replayStart, end, {
          calendar,
          divisor: input.divisor ?? DEFAULT_LIQUIDITY_DIVISOR,
          topN: input.topN ?? DEFAULT_DYNAMIC_TOP_N,
        });
  const universeOf = (provider: InMemoryUniverseProvider | null): UniverseResolver =>
    provider
      ? (asOf) => provider.snapshotAt(asOf)
      : () => {
          throw new BacktestInvariantError(
            'buildPaperMarketData: 本次装载未启用时点名录（withUniverse=false），不能调用 universe()',
          );
        };

  if (mode === 'dynamic') {
    const [panel, provider] = await Promise.all([
      loadUniversePanel({ start: loadStart, end, extraSymbols, indexCodes: [...WEAK_PERIOD_INDEXES] }),
      providerPromise,
    ]);
    return {
      calendar,
      signalBars: panel.signalBars,
      execBars: panel.execBars,
      indexBars: panel.indexBars,
      benchmarkBars: panel.execBars.get(input.benchmark) ?? [],
      universe: universeOf(provider),
      loadStart,
      loadEnd: end,
    };
  }

  const indexCodes = paperStrategyIndexCodes(input.strategyId);
  const [sig, exe, provider, realIndex] = await Promise.all([
    getBars(symbols, loadStart, end, { adjust: 'qfq' }),
    getBars(symbols, loadStart, end, { adjust: 'bfq' }),
    providerPromise,
    indexCodes.length > 0 ? loadIndexBars([...indexCodes], loadStart, end) : Promise.resolve(null),
  ]);
  const indexBars = new Map(WEAK_PERIOD_INDEXES.map((code) => [code, sig.get(code) ?? []]));
  if (realIndex) {
    for (const [code, bars] of realIndex) indexBars.set(code, bars);
  }
  return {
    calendar,
    signalBars: sig,
    execBars: exe,
    indexBars,
    benchmarkBars: exe.get(input.benchmark) ?? [],
    universe: universeOf(provider),
    loadStart,
    loadEnd: end,
  };
}
