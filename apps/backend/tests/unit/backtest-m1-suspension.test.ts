import { describe, expect, it } from 'vitest';
import {
  applyZeroVolumePolicy,
  applyZeroVolumePolicyMap,
  findBarByDate,
  isSuspended,
} from '../../src/services/backtest/marketPanel.js';
import type { Bar } from '../../src/services/backtest/types.js';

function bar(date: string, close: number, volume = 1000): Bar {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    preclose: close,
    volume,
    amount: volume * close,
  };
}

describe('停牌形态①——缺 bar', () => {
  // d2 缺失（停牌一天）
  const bars = [bar('2026-10-07', 1.0), bar('2026-10-09', 1.2)];

  it('当日无 bar ⇒ suspended / reason=missing-bar', () => {
    expect(isSuspended(bars, '2026-10-08')).toEqual({ suspended: true, reason: 'missing-bar' });
  });

  it('有 bar 的日子不误判', () => {
    expect(isSuspended(bars, '2026-10-09')).toEqual({ suspended: false, reason: null });
  });

  it('空序列 / undefined 一律按缺 bar', () => {
    expect(isSuspended([], '2026-10-08').reason).toBe('missing-bar');
    expect(isSuspended(undefined, '2026-10-08').reason).toBe('missing-bar');
  });

  it('显式关闭形态① ⇒ 缺 bar 不再判停牌', () => {
    expect(isSuspended(bars, '2026-10-08', { missingBar: false })).toEqual({
      suspended: false,
      reason: null,
    });
  });
});

describe('停牌形态②——volume=0', () => {
  // d2 有 bar 但成交量为 0（实测全库 ETF 这类行的 amount 也恒为 0）
  const bars = [bar('2026-10-07', 1.0), bar('2026-10-08', 1.1, 0), bar('2026-10-09', 1.2)];

  it('有 bar 但 volume=0 ⇒ suspended / reason=zero-volume', () => {
    expect(isSuspended(bars, '2026-10-08')).toEqual({ suspended: true, reason: 'zero-volume' });
  });

  it('形态② 优先于形态①（bar 存在时不报 missing-bar）', () => {
    expect(isSuspended(bars, '2026-10-08').reason).not.toBe('missing-bar');
  });

  it('显式关闭形态② ⇒ volume=0 不再判停牌', () => {
    expect(isSuspended(bars, '2026-10-08', { zeroVolume: false })).toEqual({
      suspended: false,
      reason: null,
    });
  });

  it('两条都关 ⇒ 只剩「是否有 bar」的原始事实，全不判停牌', () => {
    const off = { missingBar: false, zeroVolume: false };
    expect(isSuspended(bars, '2026-10-08', off).suspended).toBe(false);
    expect(isSuspended(bars, '2026-10-10', off).suspended).toBe(false);
  });
});

describe('零量序列策略 —— 「剔除该日并缩短窗口」不自造 0 收益', () => {
  // 停牌日 10-08 的 close 与 10-07 完全相同 ⇒ 若「保留并填 0 收益」，会凭空多出 1 个 0% 收益
  const bars = [bar('2026-10-07', 1.0), bar('2026-10-08', 1.0, 0), bar('2026-10-09', 1.2)];

  const returnsOf = (series: readonly Bar[]): number[] =>
    series.slice(1).map((b, i) => (b.close - series[i].close) / series[i].close);

  it('keep：原样 3 根（下游自己负责不把停牌日算成 0%）', () => {
    const kept = applyZeroVolumePolicy(bars, 'keep');
    expect(kept).toHaveLength(3);
    // ← 这就是「自造 0 收益」的形态（浮点：1.2/1.0-1 有 1e-16 量级误差，故用 closeTo）
    expect(returnsOf(kept)[0]).toBe(0);
    expect(returnsOf(kept)[1]).toBeCloseTo(0.2, 12);
  });

  it('drop：剔除停牌日 ⇒ 序列缩短为 2 根，收益只剩 1 个且**不是 0**', () => {
    const dropped = applyZeroVolumePolicy(bars, 'drop');
    expect(dropped.map((b) => b.date)).toEqual(['2026-10-07', '2026-10-09']);
    const returns = returnsOf(dropped);
    expect(returns).toHaveLength(1);
    expect(returns[0]).toBeCloseTo(0.2, 12);
    expect(returns).not.toContain(0);
  });

  it('drop 不丢信息：被剔掉的日期可由原序列反推', () => {
    const dropped = applyZeroVolumePolicy(bars, 'drop');
    expect(dropped.some((b) => b.date === '2026-10-08')).toBe(false);
    expect(findBarByDate(bars, '2026-10-08')?.volume).toBe(0);
  });

  it('Map 版本对每只标的分别生效', () => {
    const map = new Map<string, Bar[]>([
      ['a', bars],
      ['b', [bar('2026-10-07', 2.0), bar('2026-10-09', 2.4)]],
    ]);
    const dropped = applyZeroVolumePolicyMap(map, 'drop');
    expect(dropped.get('a')).toHaveLength(2);
    expect(dropped.get('b')).toHaveLength(2);
    expect(applyZeroVolumePolicyMap(map, 'keep')).toBe(map);
  });
});

describe('findBarByDate —— 二分查找', () => {
  const bars = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12'].map((d) => bar(d, 1));

  it('命中 / 未命中 / 空数组', () => {
    expect(findBarByDate(bars, '2026-10-07')?.date).toBe('2026-10-07');
    expect(findBarByDate(bars, '2026-10-12')?.date).toBe('2026-10-12');
    expect(findBarByDate(bars, '2026-10-10')).toBeUndefined();
    expect(findBarByDate([], '2026-10-10')).toBeUndefined();
  });
});
