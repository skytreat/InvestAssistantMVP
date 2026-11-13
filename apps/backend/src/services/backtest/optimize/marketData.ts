/**
 * M4 sweep 的行情基座 —— **只装载一次**，供数百次试次复用
 *
 * 为什么单独抽出来：单次 2023-2025 回测里，面板装载（全市场 ETF ~1300 只）占相当比例；
 * 若每个试次都重装，450 组的时间会翻倍，且反复打开 DuckDB 增加锁冲突风险。
 * 这里一次性装载 `BacktestData`（只读），试次只在内存里换 `params` 跑引擎。
 *
 * 🔴 面板装载用 `loadUniversePanel`（dynamic 模式），与 `cli.ts run --universe dynamic` 完全同口径。
 */
import { loadTradingCalendar } from '../calendar.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL, GLOBAL_ETF_POOL } from '../universe/fixedPool.js';
import {
  WEAK_PERIOD_INDEXES,
  DEFAULT_LIQUIDITY_DIVISOR,
  DEFAULT_DYNAMIC_TOP_N,
} from '../universe/pointInTime.js';
import { loadUniversePanel } from '../universe/dynamicPanel.js';
import { loadUniverseProvider } from '../universe/provider.js';
import { loadCorporateActions } from '../corporateActions.js';
import { createWufuRotationStrategy } from '../strategies/wufuRotation/index.js';
import { DUALMOMENTUM_DEFAULTS } from '../strategies/dualmomentum/params.js';
import type { BacktestData } from '../engine.js';
import type { UniverseResolver } from '../universe/provider.js';

export interface SweepDataBundle {
  data: BacktestData;
  universe: UniverseResolver;
  /** 面板装载起点（含 warmup） */
  loadStart: string;
  /** 面板标的数 / bar 数（报告用） */
  panelSymbols: number;
  panelBars: number;
  /** 预热天数（策略 warmupDays + 1） */
  warmup: number;
  /** 本次实际生效的池子口径（审计元数据，写入 `bt_run.universe_params_json`） */
  divisor: number;
  topN: number;
}

export interface LoadSweepDataOptions {
  start: string;
  end: string;
  divisor?: number;
  topN?: number;
  benchmark?: string;
  /**
   * 预热天数（日历 bar）；不传则用策略默认参数推导的 `warmupDays`。
   * 网格会扫到 `lookbackDays=40` ⇒ 调用方须按**网格最大值**传入（见 `runner.ts`），
   * 否则起点附近有效点不足，试次会成片「数据不足」。
   */
  warmupDays?: number;
}

/**
 * 装载 sweep 用行情基座（dynamic 模式）。
 *
 * @param options `start/end` 为评估区间（2023-01-01~2025-12-31）
 */
export async function loadSweepData(options: LoadSweepDataOptions): Promise<SweepDataBundle> {
  const divisor = options.divisor ?? DEFAULT_LIQUIDITY_DIVISOR;
  const topN = options.topN ?? DEFAULT_DYNAMIC_TOP_N;
  const benchmark = options.benchmark ?? 'sh510300';
  const strategy = createWufuRotationStrategy();

  const calendar = await loadTradingCalendar();
  const warmup = Math.max(5, (options.warmupDays ?? strategy.warmupDays) + 1);
  const loadStart = calendar.lastN(options.start, warmup)[0] ?? options.start;

  const extraSymbols = [...new Set([...FIXED_ETF_POOL, ...GLOBAL_ETF_POOL, DEFENSIVE_ETF, benchmark])];

  const [panel, provider] = await Promise.all([
    loadUniversePanel({
      start: loadStart,
      end: options.end,
      extraSymbols,
      indexCodes: [...WEAK_PERIOD_INDEXES],
    }),
    loadUniverseProvider(options.start, options.end, { calendar, divisor, topN }),
  ]);

  const corporateActions = await loadCorporateActions(panel.symbols, loadStart, options.end);

  const data: BacktestData = {
    calendar,
    signalBars: panel.signalBars,
    execBars: panel.execBars,
    benchmarkBars: panel.execBars.get(benchmark) ?? [],
    indexBars: panel.indexBars,
    universe: (asOf) => provider.snapshotAt(asOf),
    corporateActions,
  };

  return {
    data,
    universe: data.universe,
    loadStart,
    panelSymbols: panel.symbols.length,
    panelBars: panel.barCount,
    warmup,
    divisor,
    topN,
  };
}

/**
 * 收集「策略会下单、但不在固定池里」的标的（**装载面板必须包含它们**）。
 *
 * 🔴 **为什么必须自动收集**（2026-11-12 实测踩坑，ADR-024 §6）：
 *   `dmSweep.loadPanel()` / `dmDiagnose.loadPanel()` 原本只装
 *   `FIXED_ETF_POOL + GLOBAL_ETF_POOL + DEFENSIVE_ETF + BENCHMARK + POOL_ORDER`，
 *   **不含** 防御回退标的（如 `sh511260`）⇒ 防御态下单**成交不了**
 *   ⇒ 实际退化成**切现金**，指标照样算得出来、结论照样错
 *   （首轮实测报出虚高的 CAGR 11.73% / MDD 16.03%，真值是 10.57% / 18.97%）。
 *
 * ⇒ 凡实验/默认参数里会下单的标的，都必须进装载清单。
 *
 * @param extraSymbols 额外要装的标的（如 dmDiagnose 从实验组收集的）
 */
export function collectStrategyExtraSymbols(extraSymbols: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const s of extraSymbols) if (s.trim() !== '') out.add(s.trim());
  // 默认参数里的防御标的 + 池扩展标的（跟随 DUALMOMENTUM_DEFAULTS，改一处即生效）
  const def = DUALMOMENTUM_DEFAULTS.defensiveSymbol.trim();
  if (def !== '') out.add(def);
  try {
    const ext: unknown = JSON.parse(DUALMOMENTUM_DEFAULTS.poolExtension);
    if (Array.isArray(ext)) {
      for (const s of ext) if (typeof s === 'string' && s.trim() !== '') out.add(s.trim());
    }
  } catch {
    /* 非法 JSON 忽略 */
  }
  return [...out];
}
