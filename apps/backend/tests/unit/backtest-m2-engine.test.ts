/**
 * M2 引擎单测（**纯合成数据，不读 DuckDB**）—— 对应验收锚点 ② / ④
 *
 * 锚点 ②：前视探针 —— 篡改 T 及之后行情，T 及之前的决策/成交**逐字节相同**
 * 锚点 ④：现金恒等式 —— 每日 `equity = cash + riskMv + cashMv` 且现金不为负
 *
 * 之所以能用合成数据：引擎是纯函数（`runBacktest(data, request)` 不读库），
 * 所以 CI 在没有真实行情库（`data/quotes.duckdb` 是 12KB 空壳）时也能跑这两个锚点。
 */
import { describe, it, expect } from 'vitest';
import { TradingCalendar } from '../../src/services/backtest/calendar.js';
import {
  runBacktest,
  BacktestInvariantError,
  type BacktestData,
} from '../../src/services/backtest/engine.js';
import { buyAndHoldStrategy } from '../../src/services/backtest/strategies/buyAndHold.js';
import { defineStrategy, type StrategyContext } from '../../src/services/backtest/strategy/types.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import type { Bar } from '../../src/services/backtest/types.js';

/** 6 个交易日（跨周末，用于验证 `prev()` 对齐） */
const DATES = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09'];

/** 基础价格序列（sh510300）：01-08 收盘 12 ≥ 探针阈值 11 */
const BASE_PRICES = [10, 10, 10.2, 10.5, 12, 13];
/** 探针用：把 01-08 / 01-09（最后两根）改成下跌（决策会因此改变） */
const MUTATED_PRICES = [10, 10, 10.2, 10.5, 9, 9];

function makeBars(
  dates: readonly string[] = DATES,
  prices: readonly number[] = BASE_PRICES,
  volumes?: readonly number[],
): Bar[] {
  return dates.map((date, i) => ({
    date,
    open: prices[i],
    high: prices[i],
    low: prices[i],
    close: prices[i],
    preclose: i > 0 ? prices[i - 1] : prices[i],
    volume: volumes?.[i] ?? 1_000_000,
    amount: prices[i] * (volumes?.[i] ?? 1_000_000),
  }));
}

/** 最小 UniverseSnapshot（引擎只读 asOf / fixed / dynamic / weak / 阈值） */
function snapshot(asOf: string): UniverseSnapshot {
  return {
    requestedAsOf: asOf,
    asOf,
    liquidityDates: [asOf],
    liquidity: { dates: [asOf], totalByDate: [1e9], avgTotal: 1e9, threshold: 10_000_000, fallback: false },
    marketSymbolCount: 2,
    universeCount: 2,
    marketLiquidityPassCount: 2,
    fixedPoolSize: 2,
    fixedTradableCount: 2,
    fixedCoverageCount: 2,
    fixed: [
      {
        symbol: 'sh510300',
        name: '沪深300ETF',
        firstBar: DATES[0],
        lastBar: DATES[DATES.length - 1],
        avgAmount: 1e9,
      },
    ],
    weak: [],
    dynamic: { groups: [], pool: [], excludedCount: 0, skippedCount: 0, specialCount: 0, normalCount: 0 },
  };
}

function makeData(prices: readonly number[], volumes?: readonly number[]): BacktestData {
  const bars = makeBars(DATES, prices, volumes);
  return {
    calendar: new TradingCalendar(DATES),
    signalBars: new Map([['sh510300', bars]]),
    execBars: new Map([['sh510300', bars]]),
    benchmarkBars: bars,
    universe: (asOf) => snapshot(asOf),
  };
}

/** 探针策略：按「决策时点可见的收盘价」决定目标金额，并留痕 `seen` */
const probeStrategy = defineStrategy({
  id: 'test-probe',
  version: '0.0.1',
  name: '前视探针策略',
  paramSchema: [],
  warmupDays: 0,
  priceMode: 'open',
  decide(ctx: StrategyContext) {
    const close = ctx.latest('sh510300');
    if (close === null) return null;
    ctx.tag('seenClose', close);
    ctx.tag('asOf', ctx.asOf);
    return {
      targets: [{ symbol: 'sh510300', targetNotional: close >= 11 ? 50_000 : 20_000, reason: 'rebalance' }],
      mode: 'replace' as const,
    };
  },
});

const baseRequest = {
  strategy: probeStrategy,
  start: DATES[0],
  end: DATES[DATES.length - 1],
  initialCash: 100_000,
  benchmarkSymbol: 'sh510300',
};

describe('M2 引擎 · 决策时点（T-1 无前视）', () => {
  it('每个决策的 asOf = T-1 交易日，策略只能看到 ≤ asOf 的行情', () => {
    const res = runBacktest(makeData(BASE_PRICES), baseRequest);

    // dates[0] 没有 T-1，不产生决策
    expect(res.decisions).toHaveLength(DATES.length - 1);
    expect(res.decisions.map((d) => d.execDate)).toEqual(DATES.slice(1));
    expect(res.decisions.map((d) => d.asOf)).toEqual(DATES.slice(0, -1));

    // 01-05 的决策看到的是 01-04 收盘 10.2，**不是** 01-05 自己的 10.5
    const idx = res.decisions.findIndex((d) => d.execDate === '2024-01-05');
    expect(res.decisions[idx].tags.seenClose).toBe(10.2);
  });

  it('时点池 asOf 与请求不一致 → 抛 BacktestInvariantError（前视硬拦截）', () => {
    const data = { ...makeData(BASE_PRICES), universe: () => snapshot('2024-01-01') };
    expect(() => runBacktest(data, baseRequest)).toThrow(BacktestInvariantError);
  });

  it('maxTurnoverRatio：买入按剩余额度等比缩放（Σ|Δ| ≤ ratio×equity）', () => {
    const capped = defineStrategy({
      id: 'test-turnover-scale',
      version: '0.0.1',
      name: '带换手上限',
      paramSchema: [],
      warmupDays: 0,
      priceMode: 'open',
      decide: () => ({
        targets: [{ symbol: 'sh510300', targetWeight: 1, reason: 'candidate-top' }],
        mode: 'replace',
        maxTurnoverRatio: 0.5,
      }),
    });
    const res = runBacktest(makeData(BASE_PRICES), { ...baseRequest, strategy: capped });

    // 权益 10 万、上限 0.5 → 首日最多买入 5 万（后续日按当日权益重新算上限）
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.trades[0].qty * res.trades[0].price).toBeLessThanOrEqual(50_000 + 1e-6);
    expect(res.trades[0].qty * res.trades[0].price).toBeGreaterThan(49_000);
    // 缩放后仍可成交，不记 turnover-capped
    expect(res.skipped.some((s) => s.reason === 'turnover-capped')).toBe(false);
  });

  it('maxTurnoverRatio 把增仓裁到不足 1 元 → 记 turnover-capped（不静默丢弃）', () => {
    const starved = defineStrategy({
      id: 'test-turnover-starved',
      version: '0.0.1',
      name: '换手上限几乎为零',
      paramSchema: [],
      warmupDays: 0,
      priceMode: 'open',
      decide: () => ({
        targets: [{ symbol: 'sh510300', targetWeight: 1, reason: 'candidate-top' }],
        mode: 'replace',
        maxTurnoverRatio: 1e-9,
      }),
    });
    const res = runBacktest(makeData(BASE_PRICES), { ...baseRequest, strategy: starved });

    expect(res.trades).toHaveLength(0);
    expect(res.skipped.some((s) => s.reason === 'turnover-capped')).toBe(true);
  });
});

describe('M2 引擎 · 前视探针（锚点 ②）', () => {
  it('篡改 T 及之后行情：T 及之前的决策与净值逐值不变', () => {
    const clean = runBacktest(makeData(BASE_PRICES), baseRequest);
    const mutated = runBacktest(makeData(MUTATED_PRICES), baseRequest);

    // 01-08 与 01-09 被篡改；asOf ≤ 01-04 的决策（execDate 01-03/01-04/01-05）必须完全相同
    expect(mutated.decisions.slice(0, 3)).toEqual(clean.decisions.slice(0, 3));
    expect(mutated.equity.slice(0, 3)).toEqual(clean.equity.slice(0, 3));

    // 探针不能是「空过」：被篡改区间的决策必须真的不同
    expect(mutated.decisions.at(-1)!.targets).not.toEqual(clean.decisions.at(-1)!.targets);
  });
});

describe('M2 引擎 · 现金恒等式（锚点 ④）', () => {
  it('每日 equity = cash + riskMv + cashMv，且现金不为负', () => {
    const res = runBacktest(makeData(BASE_PRICES), baseRequest);
    expect(res.equity.length).toBe(DATES.length - 1);

    for (const p of res.equity) {
      expect(p.cash).toBeGreaterThanOrEqual(0);
      expect(p.equity).toBeCloseTo(p.cash + p.riskMv + p.cashMv, 8);
    }
  });

  it('成交现金流与账户现金一致（买入减少、卖出增加）', () => {
    const res = runBacktest(makeData(BASE_PRICES), baseRequest);
    const first = res.trades[0];
    expect(first.side).toBe('buy');

    // 期初 10 万 → 首笔买入后现金 = 10 万 - (份数 × 价 + 佣金)
    const after = res.equity.find((p) => p.date === first.date)!;
    expect(after.cash).toBeCloseTo(100_000 - first.qty * first.price - first.fee, 8);
  });

  it('成交价口径：priceMode=close 时按 T 收盘价 + 1bp 滑点', () => {
    const bars: Bar[] = [
      {
        date: DATES[0],
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        preclose: 10,
        volume: 1_000_000,
        amount: 1e7,
      },
      {
        date: DATES[1],
        open: 10,
        high: 10.6,
        low: 9.9,
        close: 10.5,
        preclose: 10,
        volume: 1_000_000,
        amount: 1e7,
      },
    ];
    const data: BacktestData = {
      calendar: new TradingCalendar([DATES[0], DATES[1]]),
      signalBars: new Map([['sh510300', bars]]),
      execBars: new Map([['sh510300', bars]]),
      benchmarkBars: bars,
      universe: (asOf) => snapshot(asOf),
    };
    const res = runBacktest(data, {
      ...baseRequest,
      strategy: buyAndHoldStrategy,
      start: DATES[0],
      end: DATES[1],
      params: { symbol: 'sh510300', weight: 1, rebalance: false },
      priceMode: 'close',
    });

    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].price).toBeCloseTo(10.5 * 1.0001, 8);
  });
});

describe('M2 引擎 · 停牌标的跳过', () => {
  it('T 日 volume=0 → 当日不下单，且 skipped 记录 zero-volume', () => {
    // 01-04（下标 2）零成交
    const volumes = [1_000_000, 1_000_000, 0, 1_000_000, 1_000_000, 1_000_000];
    const res = runBacktest(makeData(BASE_PRICES, volumes), baseRequest);

    const suspended = res.skipped.filter((s) => s.reason === 'suspended');
    expect(suspended.length).toBeGreaterThan(0);
    expect(suspended.every((s) => s.detail === 'zero-volume')).toBe(true);
    expect(res.trades.some((t) => t.date === '2024-01-04')).toBe(false);

    // 停牌日估值沿用最近有效收盘（不会把市值打成 0）
    const p = res.equity.find((e) => e.date === '2024-01-04')!;
    expect(p.equity).toBeCloseTo(p.cash + p.riskMv + p.cashMv, 8);
  });

  it('T 日缺 bar → skipped 记录 missing-bar', () => {
    const bars = makeBars().filter((b) => b.date !== '2024-01-04');
    const data: BacktestData = {
      calendar: new TradingCalendar(DATES),
      signalBars: new Map([['sh510300', bars]]),
      execBars: new Map([['sh510300', bars]]),
      benchmarkBars: bars,
      universe: (asOf) => snapshot(asOf),
    };
    const res = runBacktest(data, baseRequest);
    expect(res.skipped.some((s) => s.detail === 'missing-bar')).toBe(true);
    expect(res.trades.some((t) => t.date === '2024-01-04')).toBe(false);
  });
});

describe('M2 引擎 · preclose 缺失事件透出', () => {
  it('缺失只记录事件：成交与净值逐值不变，warnings 可按标的/日期查看', () => {
    const normal = runBacktest(makeData(BASE_PRICES), baseRequest);

    const data = makeData(BASE_PRICES);
    for (const bar of data.execBars.get('sh510300')!) {
      (bar as unknown as { preclose: number | null }).preclose = null;
    }
    const broken = runBacktest(data, baseRequest);

    // 成交结果不变（用户要求：不新增拦截）
    expect(broken.trades).toEqual(normal.trades);
    expect(broken.equity).toEqual(normal.equity);

    // 事件可见：顶层汇总 + 当日决策
    expect(broken.warnings.length).toBeGreaterThan(0);
    expect(broken.warnings.every((w) => w.code === 'PRECLOSE_MISSING' && w.symbol === 'sh510300')).toBe(true);
    const day = broken.decisions.find((d) => d.warnings.length > 0)!;
    expect(day.warnings[0]).toMatchObject({ code: 'PRECLOSE_MISSING', date: day.execDate });

    // 正常数据不产生事件
    expect(normal.warnings).toHaveLength(0);
  });
});

describe('M2 引擎 · 买入持有参考策略', () => {
  it('weight=1 / 不复平衡：只买一次，后续不再产生成交', () => {
    const res = runBacktest(makeData(BASE_PRICES), {
      ...baseRequest,
      strategy: buyAndHoldStrategy,
      params: { symbol: 'sh510300', weight: 1, rebalance: false },
    });

    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].date).toBe(DATES[1]);
    expect(res.decisions.filter((d) => d.targets !== null)).toHaveLength(1);
  });

  it('weight=0：空仓位基准，全程无成交且权益恒为初始现金', () => {
    const res = runBacktest(makeData(BASE_PRICES), {
      ...baseRequest,
      strategy: buyAndHoldStrategy,
      params: { symbol: 'sh510300', weight: 0, rebalance: false },
    });

    expect(res.trades).toHaveLength(0);
    for (const p of res.equity) {
      expect(p.equity).toBeCloseTo(100_000, 8);
      expect(p.exposure).toBe(0);
    }
  });

  it('基准净值注入即所得：benchmarkClose 与注入 bar 逐日相等', () => {
    const res = runBacktest(makeData(BASE_PRICES), baseRequest);
    const benchByDate = new Map(makeBars().map((b) => [b.date, b.close]));
    for (const p of res.equity) {
      expect(p.benchmarkClose).toBe(benchByDate.get(p.date));
    }
  });
});
