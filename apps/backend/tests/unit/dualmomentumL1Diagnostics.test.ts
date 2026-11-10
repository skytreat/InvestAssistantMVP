import { describe, expect, it } from 'vitest';
import {
  ABLATION_VARIANTS,
  ablationByKey,
  correlationMatrix,
  evaluateL1FiltersAttributed,
  layerEliminationCounts,
  momentumIcSeries,
  spearmanRankCorrelation,
  type AttributedFilterResult,
  type L1FilterInput,
} from '../../src/services/backtest/strategies/dualmomentum/l1/diagnostics.js';

const BASE: L1FilterInput = {
  inPool: true,
  hasBar: true,
  snapshotPrice: 3.15,
  prevCloseAdj: 3,
  ma5: 3.2,
  ma10: 3.1,
  ma20: 3.05,
  ma60: 2.9,
  primary: 0.5,
  secondary: 0.5,
  benchmarkPrimary: 0.2,
  primaryRange: [0, 5],
  secondaryRange: [0, 2],
  cooling: false,
  limitRatio: 0.1,
};

/** 变体全开（null）时，槽位拆分归因必须与既有 `evaluateL1Filters` 的结论一致 */
function attributed(
  input: L1FilterInput,
  config?: Parameters<typeof evaluateL1FiltersAttributed>[1],
): AttributedFilterResult {
  return evaluateL1FiltersAttributed(input, config ?? null);
}

describe('evaluateL1FiltersAttributed', () => {
  it('基线全开时：全部层通过 → pass', () => {
    const r = attributed(BASE);
    expect(r.pass).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.primaryInRange).toBe(true);
    expect(r.secondaryInRange).toBe(true);
  });

  it('主槽越界 → PRIMARY_OUT_OF_RANGE（不是 MOMENTUM_OUT_OF_RANGE）', () => {
    const r = attributed({ ...BASE, primary: 6 });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('PRIMARY_OUT_OF_RANGE');
    expect(r.primaryInRange).toBe(false);
    expect(r.secondaryInRange).toBe(true);
  });

  it('次槽越界 → SECONDARY_OUT_OF_RANGE', () => {
    const r = attributed({ ...BASE, secondary: 3 });
    expect(r.reason).toBe('SECONDARY_OUT_OF_RANGE');
    expect(r.primaryInRange).toBe(true);
  });

  it('日涨跌越界 → DAILY_CHANGE_OUT_OF_RANGE（选落在 ±5% 内、涨停区间的 +6%：3.18/3 − 1）', () => {
    const r = attributed({ ...BASE, snapshotPrice: 3.18 });
    expect(r.reason).toBe('DAILY_CHANGE_OUT_OF_RANGE');
  });

  it('基准动量不过 → BELOW_BENCHMARK', () => {
    const r = attributed({ ...BASE, primary: 0.1, benchmarkPrimary: 0.2 });
    expect(r.reason).toBe('BELOW_BENCHMARK');
  });

  it('MA 不过 → BELOW_MA20 / MA_NOT_BULLISH', () => {
    expect(attributed({ ...BASE, snapshotPrice: 3.0 }).reason).toBe('BELOW_MA20');
    expect(attributed({ ...BASE, ma5: 3.0 }).reason).toBe('MA_NOT_BULLISH');
  });

  it('消融：只留 MA（其余四层全关）时，主槽/基准失败不再触发', () => {
    const cfg = ablationByKey('ma-only');
    const r = attributed({ ...BASE, primary: 99, secondary: 99, benchmarkPrimary: -5 }, cfg);
    // snapshot 3.15 > ma20 3.05 且四线多头 ⇒ 仅 MA 层下应通过
    expect(r.pass).toBe(true);
  });

  it('消融：去掉日涨跌过滤（no-daily-change）时，±5% 外但在涨停区间内的日不再被拒', () => {
    const cfg = ablationByKey('no-daily-change');
    // +6%（3.18/3）：日涨跌层拒、但涨停层放行（<3.3）
    const r = attributed({ ...BASE, snapshotPrice: 3.18 }, cfg);
    expect(r.pass).toBe(true);
  });

  it('消融：只留主槽区间（wsm-only）时 MA 层不拦', () => {
    const cfg = ablationByKey('wsm-only');
    const r = attributed({ ...BASE, ma5: 3.0, primary: 1, benchmarkPrimary: -5 }, cfg);
    expect(r.pass).toBe(true);
  });

  it('执行层约束（停牌/涨停）不受消融开关影响', () => {
    for (const v of ABLATION_VARIANTS) {
      const r = attributed({ ...BASE, hasBar: false, snapshotPrice: null }, ablationByKey(v.key));
      expect(r.reason).toBe('SUSPENDED');
      const limit = attributed({ ...BASE, snapshotPrice: 3.31 }, ablationByKey(v.key));
      // 涨停（§9.3「触及即算」：price >= prev×1.10 = 3.3）：3.31 ⇒ AT_LIMIT
      expect(limit.reason).toBe('AT_LIMIT');
    }
  });
});

describe('layerEliminationCounts', () => {
  const mk = (over: Partial<L1FilterInput> = {}): L1FilterInput => ({ ...BASE, ...over });
  it('按首个否决层归集', () => {
    const rows = [
      mk(), // 全过
      mk({ snapshotPrice: 3.4 }), // 日涨跌
      mk({ snapshotPrice: 3.0 }), // MA（价 < ma20）
      mk({ primary: 6 }), // 主槽
      mk({ secondary: 3 }), // 次槽
      mk({ primary: 0.1, benchmarkPrimary: 0.2 }), // 基准
    ];
    const c = layerEliminationCounts(rows);
    expect(c.dailyChange).toBe(1);
    expect(c.ma).toBe(1);
    expect(c.primary).toBe(1);
    expect(c.secondary).toBe(1);
    expect(c.benchmark).toBe(1);
    expect(c.allPass).toBe(1);
  });
});

describe('correlationMatrix / spearman', () => {
  it('完全同向两列相关 = 1，反向 = -1', () => {
    const m = correlationMatrix([
      [1, -1],
      [2, -2],
      [3, -3],
    ]);
    expect(m[0][1]).toBeCloseTo(-1, 9);
    expect(
      correlationMatrix([
        [1, 1],
        [2, 2],
        [3, 3],
      ])[0][1],
    ).toBeCloseTo(1, 9);
  });

  it('spearman：单调非线性也 = 1；ties 用平均秩（手算核对：x=[1,1,2,3]→[1.5,1.5,3,4]，y=[2,1,4,3]→[2,1,4,3] ⇒ 0.7379）', () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 9);
    expect(spearmanRankCorrelation([1, 1, 2, 3], [2, 1, 4, 3])).toBeCloseTo(0.737864787, 6);
    expect(Number.isNaN(spearmanRankCorrelation([1, 2], [2, 1]))).toBe(true); // <3 截面
  });
});

describe('momentumIcSeries', () => {
  it('恒为 0 的未来收益 ⇒ IC 未定义（NaN），不计入', () => {
    const s = momentumIcSeries(
      [
        [0.1, 0.2, 0.3, 0.4],
        [0.4, 0.3, 0.2, 0.1],
      ],
      [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      5,
    );
    expect(s.validSections).toBe(0);
    expect(Number.isNaN(s.mean)).toBe(true);
  });

  it('排序与未来收益完全同序 ⇒ IC = 1', () => {
    const s = momentumIcSeries(
      [
        [1, 2, 3, 4],
        [2, 1, 4, 3],
      ],
      [
        [0.01, 0.02, 0.03, 0.04],
        [0.02, 0.01, 0.04, 0.03],
      ],
      10,
    );
    expect(s.validSections).toBe(2);
    expect(s.mean).toBeCloseTo(1, 9);
    expect(s.positiveRatio).toBe(1);
  });

  it('未来收益 null 的截面（不足期）不计入', () => {
    const s = momentumIcSeries([[1, 2, 3, 4]], [[null, null, null, null]], 20);
    expect(s.validSections).toBe(0);
  });
});
