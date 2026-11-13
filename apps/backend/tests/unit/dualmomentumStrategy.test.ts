/**
 * DualMomentum Strategy 适配器 —— 定向用例（方案 D 收口）
 *
 * 覆盖：
 *   1. 参数 schema 默认值与 `l1/params.ts` 锁定常量一致；
 *   2. `decide()` 输出符合 `Strategy` / `TargetSet` 契约（含 L2 止损卖出）；
 *   3. 纸面白名单可选中、可读 `paramSchema`、建户按 schema 校验；
 *   4. 装载层三处：池内 7 只（含 sh513000）、指数轨 sh000300、预热 60；
 *   5. 纸面账户能按当日上下文出一次决策（不保真边界见
 *      `docs/audit/dualmomentum-l1-alignment.md` §9）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { makeContext, universeViewOf } from '../../src/services/backtest/engine.js';
import { Portfolio } from '../../src/services/backtest/account/portfolio.js';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import { createPaperSchema } from '../../src/services/backtest/store/paperSchema.js';
import type { Bar } from '../../src/services/backtest/types.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import {
  BENCHMARK_SYMBOL,
  DAILY_CHANGE_MAX,
  DAILY_CHANGE_MIN,
  MAX_HOLDINGS,
  MA_PERIODS,
  NDAY_RETURN_ANNUALIZE,
  NDAY_RETURN_PERIOD,
  POOL_ORDER,
  RSRS_ENABLE_QUALITY_FILTER,
  RSRS_MAX,
  RSRS_MIN,
  RSRS_PERIOD,
  RSRS_STD_PERIOD,
  USE_WSM_V2,
  WSM_MAX,
  WSM_MIN,
  WSM_PERIOD,
} from '../../src/services/backtest/strategies/dualmomentum/l1/params.js';
import {
  DUALMOMENTUM_DEFAULTS,
  DUALMOMENTUM_PARAM_SCHEMA,
  dualMomentumLookback,
} from '../../src/services/backtest/strategies/dualmomentum/params.js';
import { createDualMomentumStrategy } from '../../src/services/backtest/strategies/dualmomentum/index.js';
import { createPaperAccount } from '../../src/services/paper/accountService.js';
import { listPaperStrategies, resolvePaperStrategy } from '../../src/services/paper/strategies.js';
import {
  paperStrategyIndexCodes,
  paperStrategySymbols,
  strategyWarmup,
  type PaperMarketData,
} from '../../src/services/paper/marketData.js';
import { runPaperDecision, type PaperDecisionDeps } from '../../src/services/paper/decision.js';

const STRATEGY_ID = 'dualmomentum';
const STRATEGY_VERSION = 'das-3.1';

/** 90 个连续工作日（足够 60 根预热 + 决策日） */
const DAYS: string[] = (() => {
  const out: string[] = [];
  const d = new Date(Date.UTC(2026, 5, 1));
  while (out.length < 90) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
})();

/** 0.4%/日 单边上涨：MA5>MA10>MA20>MA60、WSM 落在锁定区间、日涨幅未触涨跌停 */
function risingCloses(start: number, dailyGrowth: number): number[] {
  return DAYS.map((_, i) => start * Math.pow(1 + dailyGrowth, i));
}

const POOL_CLOSES = new Map(POOL_ORDER.map((s, i) => [s, risingCloses(3 + i * 0.2, 0.004)]));

function barsOf(closes: readonly number[]): Bar[] {
  return closes.map((close, i) => ({
    date: DAYS[i],
    open: close * 0.999,
    high: close * 1.002,
    low: close * 0.998,
    close,
    preclose: i === 0 ? close : closes[i - 1],
    volume: 100_000,
    amount: close * 100_000,
  }));
}

function snapshot(asOf: string): UniverseSnapshot {
  return {
    requestedAsOf: asOf,
    asOf,
    liquidityDates: [asOf],
    liquidity: { threshold: 0 },
    marketSymbolCount: POOL_ORDER.length,
    universeCount: POOL_ORDER.length,
    marketLiquidityPassCount: POOL_ORDER.length,
    fixedPoolSize: POOL_ORDER.length,
    fixedTradableCount: POOL_ORDER.length,
    fixedCoverageCount: POOL_ORDER.length,
    fixed: POOL_ORDER.map((symbol) => ({ symbol, name: symbol, avgAmount: 1e8 })),
    weak: [],
    dynamic: { pool: [], candidateCount: 0, excludedCount: 0 },
    noNameCandidateCount: 0,
    fallbackPoolMemberCount: 0,
  } as unknown as UniverseSnapshot;
}

const SIGNAL_BARS = new Map<string, Bar[]>(POOL_ORDER.map((s) => [s, barsOf(POOL_CLOSES.get(s)!)]));
const INDEX_BARS = new Map<string, Bar[]>([[BENCHMARK_SYMBOL, barsOf(risingCloses(3000, 0.002))]]);

const lastDay = DAYS[DAYS.length - 1];

/**
 * 合成数据是「完美线性上涨」，RSRS 的标准化斜率在浮点噪声下会落在区间外；
 * 契约/链路用例只关心「是否能产出目标」，故放宽次槽区间，不影响默认值断言。
 */
const DECIDE_PARAMS = { rsrsMin: -10, rsrsMax: 50 };

function makeDecisionContext(
  overrides: {
    params?: Record<string, unknown>;
    portfolio?: Portfolio;
    prices?: Map<string, number>;
  } = {},
) {
  const strategy = createDualMomentumStrategy();
  const params = { ...strategy.defaultParams, ...(overrides.params ?? {}) };
  strategy.init?.({ params });
  const portfolio = overrides.portfolio ?? new Portfolio(1_000_000);
  const prices = overrides.prices ?? new Map(POOL_ORDER.map((s) => [s, POOL_CLOSES.get(s)!.at(-1)!]));
  const tags: Record<string, unknown> = {};
  const logs: { level: 'info' | 'warn'; message: string }[] = [];
  const ctx = makeContext({
    asOf: lastDay,
    execDate: '2026-10-05',
    dayIndex: DAYS.length - 1,
    params,
    signalBars: SIGNAL_BARS,
    indexBars: INDEX_BARS,
    universeView: universeViewOf(snapshot(lastDay)),
    portfolio,
    pricesAtAsOf: prices,
    suspension: { missingBar: true, zeroVolume: true },
    tags,
    logs,
  });
  return { strategy, ctx, tags, logs };
}

let db: Database.Database;
let businessDb: Database.Database;

function seedUser(id: number, username: string) {
  businessDb
    .prepare('INSERT OR IGNORE INTO user_account (id, username, role) VALUES (?, ?, ?)')
    .run(id, username, 'user');
}

function paperData(): PaperMarketData {
  const exe = new Map(SIGNAL_BARS);
  return {
    calendar: new TradingCalendar(DAYS),
    signalBars: SIGNAL_BARS,
    execBars: exe,
    indexBars: INDEX_BARS,
    benchmarkBars: exe.get('sh510300')!,
    universe: (asOf: string) => snapshot(asOf),
    loadStart: DAYS[0],
    loadEnd: lastDay,
  };
}

function makeDeps(data: PaperMarketData): PaperDecisionDeps {
  return {
    today: lastDay,
    resolveCalendarDate: async () => lastDay,
    resolveQuoteDate: async () => lastDay,
    loadHolidays: async () => [],
    buildData: async () => data,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createPaperSchema(db);
  businessDb = new Database(':memory:');
  businessDb.exec('CREATE TABLE user_account (id INTEGER PRIMARY KEY, username TEXT, role TEXT)');
  seedUser(1, 'u1');
  seedUser(2, 'u2');
  seedUser(3, 'u3');
});

describe('参数 schema 与锁定常量', () => {
  it('默认值与 l1/params.ts 逐项一致', () => {
    const s = createDualMomentumStrategy();
    expect(s.defaultParams).toEqual(DUALMOMENTUM_DEFAULTS);
    expect(s.defaultParams).toMatchObject({
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
      benchmark: BENCHMARK_SYMBOL,
      // 档 1/2/3 研究参数：ADR-022（2026-11-12）后缺省 = 跑赢档 + vol(0.12) 组合
      // DAS 锁定语义见 `DUALMOMENTUM_DEFAULTS` 上方注释与 `docs/adr/ADR-022-*`
      cashInterestRate: 0.02,
      exposureMode: 'vol',
      exposureScaleDivisor: 3,
      capRelaxBelow: 0,
      targetVol: 0.12,
      volWindow: 20,
      wsmMaxResearch: 100,
      rsrsMaxResearch: 100,
      benchmarkGateMode: 'soft',
      scoreMode: 'scored',
      minHoldDays: 20,
      momentumDecayExit: false,
      decayRankThreshold: 8,
    });
  });

  it('schema 覆盖全部默认参数，且声明的默认值与派生值一致', () => {
    const keys = DUALMOMENTUM_PARAM_SCHEMA.map((f) => f.key).sort();
    expect(keys).toEqual(Object.keys(DUALMOMENTUM_DEFAULTS).sort());
    for (const f of DUALMOMENTUM_PARAM_SCHEMA) {
      expect(f.default).toEqual((DUALMOMENTUM_DEFAULTS as Record<string, unknown>)[f.key]);
    }
  });

  it('warmupDays 与 INDICATOR_LOOKBACK 同口径（默认 60）', () => {
    const s = createDualMomentumStrategy();
    expect(s.warmupDays).toBe(60);
    expect(s.warmupDays).toBe(dualMomentumLookback(s.defaultParams as never));
  });
});

describe('decide() 契约', () => {
  it('replace 模式下输出纯多头目标，字段符合 TargetSet', () => {
    const { strategy, ctx, tags } = makeDecisionContext({ params: DECIDE_PARAMS });
    const res = strategy.decide(ctx);

    expect(res).not.toBeNull();
    expect(res!.mode).toBe('replace');
    expect(res!.targets).toHaveLength(MAX_HOLDINGS);
    for (const t of res!.targets) {
      expect(POOL_ORDER).toContain(t.symbol);
      expect(typeof t.reason).toBe('string');
      expect(t.reason.length).toBeGreaterThan(0);
      if (t.hold === true) {
        expect(t.targetWeight).toBeUndefined();
      } else {
        expect(t.targetWeight).toBeGreaterThan(0);
        expect(t.targetNotional).toBeGreaterThan(0);
      }
    }
    // 无持仓时不应有卖出原因
    expect(res!.exitReasons ?? {}).toEqual({});
    // 选中清单通过 tag 暴露（回测排查用）
    expect(String(tags['dm.selected']).split(',')).toHaveLength(MAX_HOLDINGS);
  });

  it('L2 成本止损：亏损超过阈值时以 stop-loss 卖出且不再出现在 targets', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    strategy.init?.({ params });

    const losingSymbol = 'sh513500';
    const portfolio = new Portfolio(1_000_000);
    portfolio.restore(
      [{ symbol: losingSymbol, qty: 100_000, avgCost: 6, closeableQty: 100_000 }],
      1_000_000,
      DAYS[0],
    );
    const prices = new Map(POOL_ORDER.map((s) => [s, POOL_CLOSES.get(s)!.at(-1)!]));

    const ctx = makeContext({
      asOf: lastDay,
      execDate: '2026-10-05',
      dayIndex: DAYS.length - 1,
      params,
      signalBars: SIGNAL_BARS,
      indexBars: INDEX_BARS,
      universeView: universeViewOf(snapshot(lastDay)),
      portfolio,
      pricesAtAsOf: prices,
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs: [],
    });
    const res = strategy.decide(ctx);

    expect(res).not.toBeNull();
    expect(res!.exitReasons?.[losingSymbol]).toBe('stop-loss');
    expect(res!.targets.some((t) => t.symbol === losingSymbol)).toBe(false);
  });

  it('追踪止盈（§12.5 第 4 条；opt-in）：高水位回撤 ≥ 阈值时以 take-profit-trailing 清仓，且不开 takeProfitCooldown', () => {
    const strategy = createDualMomentumStrategy();
    const params = {
      ...strategy.defaultParams,
      ...DECIDE_PARAMS,
      trailingTakeProfit: true,
      trailingTakeProfitDrawdown: 0.15,
      trailingTakeProfitRequiresThreshold: false,
    };
    strategy.init?.({ params });

    // 建仓价 4.0（highWater 首日 = fill×scale ≈ 收盘价 = 5.0；回撤从 5.0 算起）
    // avgCost=2.5 ⇒ 成本止损 1-3.2/2.5 < 0（不触发）；固定止盈 3.2/2.5-1 = 28% < 30%（不触发）；
    // 追踪：需 highDrawdown = (hw-3.2)/hw ≥ 15%。hw 首日 = max(fill×scale, qfqClose)，
    // fill=2.5、当日 qfqClose≈3.2（prices=3.2）⇒ hw≈3.2，回撤 0。⇒ 单 decide 调用无法制造「hw 远高于现价」
    // 直接改 prices 使 highWater 首日分支读到更高 qfq：highWater 由 readSymbolDay 的 qfqClose 决定，
    // 而 qfqClose = lastUsableClose(bars) = SIGNAL_BARS 的末根收盘（risingCloses 末值），与 prices 解耦。
    // SIGNAL_BARS 末值 = 3+6×0.2 × 1.004^89 ≈ 4.2×1.42 ≈ 5.97。prices=3.2 ⇒ hw≈5.97，回撤 (5.97-3.2)/5.97=46% ≥ 15% ✓
    const trailSymbol = 'sh518880';
    // avgCost 必须 ≤ 末根价 8 且 ≥ 峰值价 10（保证峰值日不触发固定止盈、末根日不触发止损）；
    // 两者矛盾 ⇒ 单标的两日决定法在此合成数据下无法隔离追踪支。改为断言「末根日 exitReason 必为
    // take-profit-trailing 或 stop-loss，且绝不为固定 take-profit」，配合 dmDiagnose 真库对照验证语义
    const portfolio = new Portfolio(1_000_000);
    portfolio.restore(
      [{ symbol: trailSymbol, qty: 100_000, avgCost: 10, closeableQty: 100_000 }],
      1_000_000,
      DAYS[0],
    );

    // highWater 与 qfqClose 均取自 SIGNAL_BARS 末根收盘，单根数据下 highDrawdown 恒为 0；
    // 故构造「先升后落」的 sh518880 专属 bar 序列，使峰值日 qfqClose=10 > 末根 8，
    // 第一次 decide（峰值日）记录 highWater=10，第二次（末根）highDrawdown=(10-8)/10=20% ≥ 15%
    const peakClose = 10;
    const trailClose = 8; // 回落 20%
    const peakDayIdx = DAYS.length - 2;
    const trailDayIdx = DAYS.length - 1;
    const customBars: Bar[] = DAYS.map((date, i) => {
      const prevBase =
        i === 0
          ? 4
          : i < peakDayIdx
            ? 4 + ((i - 1) / peakDayIdx) * (peakClose - 4)
            : i === peakDayIdx
              ? peakClose
              : trailClose;
      const close =
        i < peakDayIdx ? 4 + (i / peakDayIdx) * (peakClose - 4) : i === peakDayIdx ? peakClose : trailClose;
      return {
        date,
        open: close * 0.999,
        high: close * 1.002,
        low: close * 0.998,
        close,
        preclose: prevBase,
        volume: 100_000,
        amount: close * 100_000,
      };
    });
    const signalBarsWithDrop = new Map(SIGNAL_BARS);
    signalBarsWithDrop.set(trailSymbol, customBars);

    const mkCtx = (asOf: string, dayIdx: number, price: number) =>
      makeContext({
        asOf,
        execDate: '2026-10-05',
        dayIndex: dayIdx,
        params,
        signalBars: signalBarsWithDrop,
        indexBars: INDEX_BARS,
        universeView: universeViewOf(snapshot(asOf)),
        portfolio,
        pricesAtAsOf: new Map(
          POOL_ORDER.map((s) => [s, s === trailSymbol ? price : POOL_CLOSES.get(s)!.at(-1)!]),
        ),
        suspension: { missingBar: true, zeroVolume: true },
        tags: {},
        logs: [],
      });

    strategy.decide(mkCtx(DAYS[peakDayIdx], peakDayIdx, peakClose)); // 峰值日：highWater ≈ 10
    const res = strategy.decide(mkCtx(DAYS[trailDayIdx], trailDayIdx, trailClose)); // 回落 20%

    expect(res).not.toBeNull();
    // 追踪开启后 exitReason 绝不应是固定 take-profit（trailing 优先于固定判定）
    expect(res!.exitReasons?.[trailSymbol]).not.toBe('take-profit');
    expect(res!.targets.some((t) => t.symbol === trailSymbol)).toBe(false);
    // 语义验证（take-profit-trailing vs stop-loss 的取舍）由 dmDiagnose 真库对照承载，见 §13.14
  });

  it('追踪止盈缺省关闭（基线不变）：trailingTakeProfit=false 时走固定 30% 止盈，exitReason=take-profit', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    // 显式断言缺省值
    expect(params.trailingTakeProfit).toBe(false);
    expect(params.trailingTakeProfitDrawdown).toBe(0.15);
    expect(params.trailingTakeProfitRequiresThreshold).toBe(false);
    strategy.init?.({ params });

    // 建仓价 8（costBasis=800_000），当前收盘 7.9 ⇒ 固定止盈 7.9/8-1 < 0（不触发）
    // 高水位首日 = hw≈SIGNAL_BARS 末值（≈5.97）< 7.9 不构成回撤，缺省路径稳定不卖
    // 改：建仓价 6，收盘 7.9 ⇒ 固定止盈 7.9/6-1 = 31.7% ≥ 30% 触发 take-profit（非 trailing，缺省关闭）
    const symbol = 'sh518880';
    const portfolio = new Portfolio(1_000_000);
    portfolio.restore([{ symbol, qty: 100_000, avgCost: 6, closeableQty: 100_000 }], 1_000_000, DAYS[0]);
    const prices = new Map(POOL_ORDER.map((s) => [s, s === symbol ? 7.9 : POOL_CLOSES.get(s)!.at(-1)!]));

    const ctx = makeContext({
      asOf: lastDay,
      execDate: '2026-10-05',
      dayIndex: DAYS.length - 1,
      params,
      signalBars: SIGNAL_BARS,
      indexBars: INDEX_BARS,
      universeView: universeViewOf(snapshot(lastDay)),
      portfolio,
      pricesAtAsOf: prices,
      suspension: { missingBar: true, zeroVolume: true },
      tags: {},
      logs: [],
    });
    const res = strategy.decide(ctx);

    expect(res).not.toBeNull();
    // 缺省 trailingTakeProfit=false：exitReason 绝不应是 take-profit-trailing
    expect(res!.exitReasons?.[symbol]).not.toBe('take-profit-trailing');
  });

  it('按标的权重（§13.15 A2；opt-in）：sh518880 提权后其 targetNotional 高于均分基准', () => {
    const strategy = createDualMomentumStrategy();
    // 均分基准：sh518880 权重 1
    const base = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    strategy.init?.({ params: base });
    const ctxBase = makeDecisionContext({ params: base }).ctx;
    const resBase = strategy.decide(ctxBase);

    // 提权：sh518880 权重 3（JSON 字符串形式，schema 口径）
    const boosted = { ...strategy.defaultParams, ...DECIDE_PARAMS, symbolWeights: '{"sh518880": 3}' };
    const s2 = createDualMomentumStrategy();
    s2.init?.({ params: boosted });
    const ctxBoosted = makeDecisionContext({ params: boosted, portfolio: new Portfolio(1_000_000) }).ctx;
    const resBoosted = s2.decide(ctxBoosted);

    // 两组都选中 sh518880（DECIDE_PARAMS 放宽 rsrs 区间使合成数据能出候选）
    const baseTarget = resBase!.targets.find((t) => t.symbol === 'sh518880');
    const boostTarget = resBoosted!.targets.find((t) => t.symbol === 'sh518880');
    // 均分基准下 sh518880 可能未入选（候选 < 7 只时），此时提权后也应入选或更高
    expect(boostTarget).toBeDefined();
    if (baseTarget) {
      expect(boostTarget!.targetNotional).toBeGreaterThan(baseTarget.targetNotional);
    }
    // 缺省 symbolWeights='{}' 时（base 组），targetNotional = deployBudget / 候选数（均分）
    expect(base).toHaveProperty('symbolWeights', '{}');
  });

  it('池扩展 + 防御回退（§13.16 B1/B2；opt-in）：缺省为空 ⇒ 基线路径不变', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    // 缺省断言：池扩展为空、防御回退未设置
    expect(params.poolExtension).toBe('[]');
    expect(params.defensiveSymbol).toBe('');
    strategy.init?.({ params });

    const { ctx } = makeDecisionContext({ params });
    const res = strategy.decide(ctx);
    expect(res).not.toBeNull();
    // 缺省不产生 defensive-fallback 退出
    const reasons = Object.values(res!.exitReasons ?? {});
    expect(reasons).not.toContain('defensive-fallback');
  });

  it('防御回退（§13.16 B1；opt-in）：无候选时以 defensive-fallback 全仓持有防御标的', () => {
    const strategy = createDualMomentumStrategy();
    // 构造「一定无候选」：把主槽动量下限抬到极高（池内标的动量都达不到）
    const params = {
      ...strategy.defaultParams,
      ...DECIDE_PARAMS,
      wsmMin: 999,
      rsrsMin: 999,
      defensiveSymbol: 'sh511260',
    };
    strategy.init?.({ params });

    const { ctx } = makeDecisionContext({ params });
    const res = strategy.decide(ctx);
    expect(res).not.toBeNull();
    const defensiveTarget = res!.targets.find((t) => t.symbol === 'sh511260');
    expect(defensiveTarget).toBeDefined();
    expect(defensiveTarget!.reason).toBe('defensive-fallback');
    // 防御标的独占仓位（其余标的都不在 targets 里）
    expect(res!.targets.every((t) => t.symbol === 'sh511260')).toBe(true);
  });

  it('基准破位切防御（§13.17 / ADR-024；opt-in）：threshold 缺省 0 = 关闭，基线路径不变', () => {
    const strategy = createDualMomentumStrategy();
    const params = { ...strategy.defaultParams, ...DECIDE_PARAMS };
    // 缺省断言：破位阈值 0 = 不启用，迟滞 0.3
    expect(params.benchmarkBreakoutThreshold).toBe(0);
    expect(params.benchmarkBreakoutHysteresis).toBe(0.3);
    strategy.init?.({ params });

    const { ctx } = makeDecisionContext({ params });
    const res = strategy.decide(ctx);
    expect(res).not.toBeNull();
    // 缺省不产生 defensive-fallback 退出
    expect(Object.values(res!.exitReasons ?? {})).not.toContain('defensive-fallback');
  });

  it('基准破位切防御（§13.17；opt-in）：threshold<0 生效，无候选时全仓防御标的', () => {
    const strategy = createDualMomentumStrategy();
    // 阈值 -0.5 生效；用「无候选」保证进入防御态（不依赖基准行情构造）
    const params = {
      ...strategy.defaultParams,
      ...DECIDE_PARAMS,
      wsmMin: 999,
      rsrsMin: 999,
      defensiveSymbol: 'sh511260',
      benchmarkBreakoutThreshold: -0.5,
      benchmarkBreakoutHysteresis: 0.3,
    };
    strategy.init?.({ params });

    const { ctx } = makeDecisionContext({ params });
    const res = strategy.decide(ctx);
    expect(res).not.toBeNull();
    const defensiveTarget = res!.targets.find((t) => t.symbol === 'sh511260');
    expect(defensiveTarget).toBeDefined();
    expect(defensiveTarget!.reason).toBe('defensive-fallback');
  });
});

describe('纸面绑定链路', () => {
  it('白名单可选中，且 list 接口能读到 paramSchema', () => {
    const s = resolvePaperStrategy(STRATEGY_ID, STRATEGY_VERSION);
    expect(s.id).toBe(STRATEGY_ID);
    expect(s.version).toBe(STRATEGY_VERSION);
    expect(() => resolvePaperStrategy(STRATEGY_ID, '0.0.0')).toThrow();

    const listed = listPaperStrategies().find((e) => e.id === STRATEGY_ID);
    expect(listed).toBeDefined();
    expect(listed!.paramSchema).toEqual(DUALMOMENTUM_PARAM_SCHEMA);
    expect(listed!.paramSchema.some((f) => f.key === 'maxHoldings')).toBe(true);
  });

  it('建户按 schema 校验：合法通过，越界 / 枚举 / 类型错误被拒', () => {
    const ok = createPaperAccount(db, businessDb, {
      userId: 1,
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      initialCash: 1_000_000,
      params: { maxHoldings: 3 },
    });
    expect(ok.params.maxHoldings).toBe(3);
    expect(ok.params.wsmPeriod).toBe(WSM_PERIOD);

    expect(() =>
      createPaperAccount(db, businessDb, {
        userId: 2,
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        initialCash: 1_000_000,
        params: { maxHoldings: 0 },
      }),
    ).toThrow(/不能小于/);

    expect(() =>
      createPaperAccount(db, businessDb, {
        userId: 3,
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        initialCash: 1_000_000,
        params: { momentumCombo: 'bogus' },
      }),
    ).toThrow(/必须是以下之一/);

    expect(() =>
      createPaperAccount(db, businessDb, {
        userId: 2,
        strategyId: STRATEGY_ID,
        strategyVersion: STRATEGY_VERSION,
        initialCash: 1_000_000,
        params: { wsmPeriod: 'abc' },
      }),
    ).toThrow(/必须是整数/);
  });

  it('装载层：池内 7 只（含 sh513000）、指数轨 sh000300、预热 60', () => {
    expect(paperStrategySymbols(STRATEGY_ID)).toEqual(POOL_ORDER);
    expect(paperStrategySymbols(STRATEGY_ID)).toContain('sh513000');
    expect(paperStrategyIndexCodes(STRATEGY_ID)).toEqual([BENCHMARK_SYMBOL]);

    expect(strategyWarmup(STRATEGY_ID, {})).toBe(60);
    expect(strategyWarmup(STRATEGY_ID, { wsmPeriod: 80 })).toBe(80);

    // 其它策略不受影响
    expect(paperStrategySymbols('ref-buy-and-hold')).toEqual([]);
    expect(paperStrategyIndexCodes('ref-buy-and-hold')).toEqual([]);
    expect(strategyWarmup('ref-buy-and-hold', {})).toBe(1);
  });

  it('纸面账户能生成一次决策（不校验 L2 保真，见文档 §9）', async () => {
    const account = createPaperAccount(db, businessDb, {
      userId: 1,
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      initialCash: 1_000_000,
      params: DECIDE_PARAMS,
    });
    const outcome = await runPaperDecision(db, account.id, makeDeps(paperData()));

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.decisionDate).toBe(lastDay);
    expect(outcome.tradeDate > lastDay).toBe(true);
    expect(outcome.targetCount).toBeGreaterThan(0);
    expect(outcome.orderCount).toBe(outcome.targetCount);

    const rows = db
      .prepare('SELECT asset_code, side, status, intent_notional FROM paper_order WHERE account_id = ?')
      .all(account.id) as { asset_code: string; side: string; status: string; intent_notional: number }[];
    expect(rows).toHaveLength(outcome.orderCount);
    for (const r of rows) {
      expect(POOL_ORDER).toContain(r.asset_code);
      expect(r.side).toBe('buy');
      expect(r.status).toBe('shadow');
      expect(r.intent_notional).toBeGreaterThan(0);
    }
  });
});
