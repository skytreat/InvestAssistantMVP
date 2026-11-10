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
      // 档 1/2/3 研究参数（缺省 = 基线语义，见 §13.6–13.9）
      cashInterestRate: 0,
      exposureMode: 'fixed',
      exposureScaleDivisor: 3,
      capRelaxBelow: 0,
      wsmMaxResearch: WSM_MAX,
      rsrsMaxResearch: RSRS_MAX,
      benchmarkGateMode: 'hard',
      scoreMode: 'and',
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
