/**
 * M2 成交模拟器单测 —— 对应验收锚点 ① / ⑤
 *
 * 锚点 ①：3 个手工算例**逐分对账**（最低佣金 5 元、整手 100 份、T+1 拒卖）
 * 锚点 ⑤：手续费 / 整手 / T+1 / 停牌 / 涨跌停 五类分支各 ≥ 2 用例
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRADE_RULES,
  commissionOf,
  executeTargets,
  type ExecutionRequest,
  type ExecutionBar,
  type PositionState,
} from '../../src/services/backtest/execution/simulator.js';
import type { TargetPosition } from '../../src/services/backtest/strategy/types.js';

const OK = { suspended: false, reason: null } as const;

function makeBar(open: number, preclose = open, volume = 1000): ExecutionBar {
  return { open, close: open, preclose, volume };
}

interface CaseOptions {
  targets?: TargetPosition[];
  mode?: 'replace' | 'incremental';
  heldSymbols?: string[];
  cash?: number;
  equityAtCutoff?: number;
  positions?: Record<string, PositionState>;
  bars?: Record<string, ExecutionBar | undefined>;
  suspended?: Record<string, { suspended: boolean; reason: 'missing-bar' | 'zero-volume' | null }>;
  barMissing?: string[];
  rules?: Partial<typeof DEFAULT_TRADE_RULES>;
}

function runCase(opts: CaseOptions) {
  const bars = opts.bars ?? { sh510300: makeBar(10) };
  const missing = new Set(opts.barMissing ?? []);
  const req: ExecutionRequest = {
    date: '2024-01-03',
    targets: opts.targets ?? [],
    mode: opts.mode ?? 'replace',
    heldSymbols: opts.heldSymbols ?? [],
    equityAtCutoff: opts.equityAtCutoff ?? 100_000,
    cash: opts.cash ?? 100_000,
    positionOf: (symbol) => opts.positions?.[symbol] ?? { qty: 0, closeableQty: 0 },
    barOf: (symbol) => (missing.has(symbol) ? undefined : bars[symbol]),
    suspensionOf: (symbol) => opts.suspended?.[symbol] ?? OK,
    rules: opts.rules,
  };
  return executeTargets(req);
}

const buyTarget = (notional: number): TargetPosition => ({
  symbol: 'sh510300',
  targetNotional: notional,
  reason: 'rebalance',
});

describe('M2 成交模拟器 · 佣金（含最低 5 元）', () => {
  it('佣金口径：小额按最低 5 元，大额按成交额 × 0.01%（四舍五入到分）', () => {
    expect(commissionOf(1000, DEFAULT_TRADE_RULES)).toBe(5);
    expect(commissionOf(10_000, DEFAULT_TRADE_RULES)).toBe(5);
    expect(commissionOf(100_000, DEFAULT_TRADE_RULES)).toBe(10);
    expect(commissionOf(123_456, DEFAULT_TRADE_RULES)).toBe(12.35);
  });

  it('手工算例 1（买入逐分对账）：10 万现金 / 目标 3 万 / 开盘 10.00', () => {
    const r = runCase({ targets: [buyTarget(30_000)] });
    expect(r.fills).toHaveLength(1);
    const f = r.fills[0];
    // 10 → 含 1bp 滑点 = 10.001；30000/10.001 = 2999.7 → 整手 2900 份
    expect(f.qty).toBe(2900);
    expect(f.price).toBeCloseTo(10.001, 8);
    expect(f.fee).toBe(5);
    // 2900 × 10.001 = 29002.9；+5 手续费
    expect(r.cashDelta).toBeCloseTo(-29_007.9, 6);
    expect(r.skipped).toHaveLength(0);
  });
});

describe('M2 成交模拟器 · 整手与最小成交额', () => {
  it('目标 1 万 / 开盘 10.00 → 900 份（向下取整到 100）', () => {
    const r = runCase({ targets: [buyTarget(10_000)] });
    expect(r.fills[0].qty).toBe(900);
    expect(r.fills[0].qty % 100).toBe(0);
  });

  it('不足 100 份但现金够 → 按 100 份（v5.2 行为）', () => {
    const r = runCase({ targets: [buyTarget(1000)] });
    expect(r.fills[0].qty).toBe(100);
  });

  it('目标金额不足 1 份 → round-lot-zero 跳过', () => {
    const r = runCase({ targets: [buyTarget(5)] });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('round-lot-zero');
  });

  it('成交额 < 10 元 → below-min-notional 跳过（lotSize=1 才能命中该分支）', () => {
    const r = runCase({
      targets: [buyTarget(9)],
      bars: { sh510300: makeBar(3) },
      rules: { lotSize: 1 },
    });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('below-min-notional');
  });
});

describe('M2 成交模拟器 · T+1', () => {
  it('当日买入（可用 0）→ 卖单被 t-plus-1 拒掉', () => {
    const r = runCase({
      targets: [],
      heldSymbols: ['sh510300'],
      positions: { sh510300: { qty: 100, closeableQty: 0 } },
    });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ symbol: 'sh510300', side: 'sell', reason: 't-plus-1' });
  });

  it('手工算例 2（卖出逐分对账）：100 份 / 开盘 10.00 / 可用 100', () => {
    const r = runCase({
      targets: [],
      heldSymbols: ['sh510300'],
      positions: { sh510300: { qty: 100, closeableQty: 100 } },
    });
    const f = r.fills[0];
    expect(f.side).toBe('sell');
    expect(f.price).toBeCloseTo(9.999, 8);
    expect(f.fee).toBe(5);
    // 100 × 9.999 = 999.9；-5 手续费
    expect(r.cashDelta).toBeCloseTo(994.9, 6);
  });
});

describe('M2 成交模拟器 · 停牌两形态', () => {
  it('缺 bar → suspended（detail=missing-bar），不成交', () => {
    const r = runCase({ targets: [buyTarget(10_000)], barMissing: ['sh510300'] });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ side: 'buy', reason: 'suspended', detail: 'missing-bar' });
  });

  it('volume=0 → suspended（detail=zero-volume），不成交', () => {
    const r = runCase({
      targets: [buyTarget(10_000)],
      bars: { sh510300: makeBar(10, 10, 0) },
      suspended: { sh510300: { suspended: true, reason: 'zero-volume' } },
    });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ reason: 'suspended', detail: 'zero-volume' });
  });
});

describe('M2 成交模拟器 · 涨跌停', () => {
  it('开盘价 = 涨停（+10%）→ 买不进', () => {
    const r = runCase({ targets: [buyTarget(10_000)], bars: { sh510300: makeBar(11, 10) } });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('limit-up');
  });

  it('开盘价 = 跌停（-10%）→ 卖不出', () => {
    const r = runCase({
      targets: [],
      heldSymbols: ['sh510300'],
      bars: { sh510300: makeBar(9, 10) },
      positions: { sh510300: { qty: 100, closeableQty: 100 } },
    });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('limit-down');
  });
});

describe('M2 成交模拟器 · preclose 缺失（只记录，不拦截）', () => {
  /**
   * `preclose` 运行时来自 LEFT JOIN，可能为 NULL（类型声明是 number，实际列存不归一）。
   * 这里用 `null` 直接构造运行时形态。
   */
  const barWithPreclose = (preclose: number | null): ExecutionBar => ({
    open: 10,
    close: 10,
    preclose: preclose as unknown as number,
    volume: 1000,
  });

  const baseline = runCase({ targets: [buyTarget(10_000)] });

  const cases: { name: string; preclose: number | null }[] = [
    { name: 'null', preclose: null },
    { name: 'NaN', preclose: Number.NaN },
    { name: '0（<= 0）', preclose: 0 },
    { name: '-1（<= 0）', preclose: -1 },
  ];

  for (const c of cases) {
    it(`preclose=${c.name}：仍放行（成交与正常数据逐值一致），并记录 PRECLOSE_MISSING`, () => {
      const r = runCase({
        targets: [buyTarget(10_000)],
        bars: { sh510300: barWithPreclose(c.preclose) },
      });

      // 行为一致：不被判成 limit-up / limit-down，成交逐值等于基准
      expect(r.skipped).toHaveLength(0);
      expect(r.fills).toHaveLength(1);
      expect(r.fills[0]).toEqual(baseline.fills[0]);
      expect(r.cashDelta).toBeCloseTo(baseline.cashDelta, 8);

      // 事件可见：代码 / 日期 / 标的 / 原始值（非有限数记 null）
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatchObject({
        code: 'PRECLOSE_MISSING',
        date: '2024-01-03',
        symbol: 'sh510300',
      });
      expect(r.warnings[0].preclose).toBe(Number.isFinite(c.preclose) ? c.preclose : null);
    });
  }

  it('preclose 有效 → 不产生 PRECLOSE_MISSING', () => {
    expect(baseline.warnings).toHaveLength(0);
  });
});

describe('M2 成交模拟器 · 现金与顺序', () => {
  it('手工算例 3：现金不足 → insufficient-cash，且现金不会变负', () => {
    const r = runCase({ targets: [buyTarget(100_000)], cash: 500 });
    expect(r.fills).toHaveLength(0);
    expect(r.skipped.some((s) => s.reason === 'insufficient-cash')).toBe(true);
    expect(r.cashDelta).toBe(0);
  });

  it('先卖后买：清仓 A 释放的现金可用于买 B', () => {
    const r = runCase({
      targets: [{ symbol: 'sh510500', targetWeight: 1, reason: 'rebalance' }],
      heldSymbols: ['sh510300'],
      cash: 100,
      positions: {
        sh510300: { qty: 100, closeableQty: 100 },
        sh510500: { qty: 0, closeableQty: 0 },
      },
      bars: { sh510300: makeBar(10), sh510500: makeBar(10) },
    });
    expect(r.fills.map((f) => `${f.side}:${f.symbol}`)).toEqual(['sell:sh510300', 'buy:sh510500']);
  });

  it('滑点方向：买 +1bp / 卖 -1bp，且 slippageCost 与价差一致', () => {
    const buy = runCase({ targets: [buyTarget(10_000)] });
    expect(buy.fills[0].price).toBeCloseTo(10.001, 8);
    expect(buy.fills[0].slippageCost).toBeCloseTo(buy.fills[0].qty * 0.001, 8);

    const sell = runCase({
      targets: [],
      heldSymbols: ['sh510300'],
      positions: { sh510300: { qty: 100, closeableQty: 100 } },
    });
    expect(sell.fills[0].price).toBeCloseTo(9.999, 8);
    expect(sell.fills[0].slippageCost).toBeCloseTo(100 * 0.001, 8);
  });
});
