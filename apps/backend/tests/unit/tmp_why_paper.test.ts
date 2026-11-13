import { it } from 'vitest';
import { makeContext, universeViewOf } from '../../src/services/backtest/engine.js';
import { Portfolio } from '../../src/services/backtest/account/portfolio.js';
import type { Bar } from '../../src/services/backtest/types.js';
import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';
import { POOL_ORDER, BENCHMARK_SYMBOL } from '../../src/services/backtest/strategies/dualmomentum/l1/params.js';
import { createDualMomentumStrategy } from '../../src/services/backtest/strategies/dualmomentum/index.js';

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
const rising = (s: number, g: number) => DAYS.map((_, i) => s * Math.pow(1 + g, i));
const CLOSES = new Map(POOL_ORDER.map((s, i) => [s, rising(3 + i * 0.2, 0.004)]));
const barsOf = (cl: readonly number[]): Bar[] => cl.map((close, i) => ({
  date: DAYS[i], open: close * 0.999, high: close * 1.002, low: close * 0.998, close,
  preclose: i === 0 ? close : cl[i - 1], volume: 100_000, amount: close * 100_000 }));
const SIGNAL = new Map<string, Bar[]>(POOL_ORDER.map((s) => [s, barsOf(CLOSES.get(s)!)]));
const INDEX = new Map<string, Bar[]>([[BENCHMARK_SYMBOL, barsOf(rising(3000, 0.002))]]);
const snap = (asOf: string) => ({
  requestedAsOf: asOf, asOf, liquidityDates: [asOf], liquidity: { threshold: 0 },
  marketSymbolCount: 7, universeCount: 7, marketLiquidityPassCount: 7, fixedPoolSize: 7,
  fixedTradableCount: 7, fixedCoverageCount: 7,
  fixed: POOL_ORDER.map((symbol) => ({ symbol, name: symbol, avgAmount: 1e8 })),
  weak: [], dynamic: { pool: [], candidateCount: 0, excludedCount: 0 },
  noNameCandidateCount: 0, fallbackPoolMemberCount: 0,
} as unknown as UniverseSnapshot);
const lastDay = DAYS.at(-1)!;

it('why: paper vs backtest path for stateful L2 rules', () => {
  const SYM = 'sh518880';
  // 持仓：成本 6.0，当前 7.9 ⇒ 涨幅 31.7% ≥ 30% 固定止盈阈值
  const mkPortfolio = () => {
    const p = new Portfolio(1_000_000);
    p.restore([{ symbol: SYM, qty: 100_000, avgCost: 6, closeableQty: 100_000 }], 1_000_000, DAYS[0]);
    return p;
  };
  const mkCtx = (portfolio: Portfolio, prices: Map<string, number>, logs: any[]) =>
    makeContext({
      asOf: lastDay, execDate: '2026-10-05', dayIndex: DAYS.length - 1,
      params: { rsrsMin: -10, rsrsMax: 50 },
      signalBars: SIGNAL, indexBars: INDEX,
      universeView: universeViewOf(snap(lastDay)),
      portfolio, pricesAtAsOf: prices,
      suspension: { missingBar: true, zeroVolume: true },
      tags: {}, logs,
    });

  // ── Case A：纸面路径（不调 onFill；回放期空组合 → 最终日检查点组合）──
  const sA = createDualMomentumStrategy();
  sA.init?.({ params: { rsrsMin: -10, rsrsMax: 50 } });
  const logsA: any[] = [];
  const pA = mkPortfolio();
  const resA = sA.decide(mkCtx(pA, new Map([[SYM, 7.9]]), logsA));
  console.log('PAPER_PATH  exitReasons =', JSON.stringify(resA?.exitReasons));
  console.log('PAPER_PATH  warnings     =', JSON.stringify(logsA.map(l => l.message.slice(0, 60))));

  // ── Case B：回测路径（onFill 累积过建仓/成交事件）──
  const sB = createDualMomentumStrategy();
  sB.init?.({ params: { rsrsMin: -10, rsrsMax: 50 } });
  sB.onFill?.({ side: 'buy', symbol: SYM, date: DAYS[10], price: 6, qty: 100_000 } as any);
  const logsB: any[] = [];
  const pB = mkPortfolio();
  const resB = sB.decide(mkCtx(pB, new Map([[SYM, 7.9]]), logsB));
  console.log('BACKTEST_PATH exitReasons =', JSON.stringify(resB?.exitReasons));
  console.log('BACKTEST_PATH warnings     =', JSON.stringify(logsB.map(l => l.message.slice(0, 60))));
});
