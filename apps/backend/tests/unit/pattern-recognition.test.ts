/**
 * pattern-recognition.test.ts — ZigZag + 双顶/双底单测
 *
 * 覆盖（对应 docs/client/pattern_recognition_design.md §12）：
 *   构造序列命中、边界不误判、deviation 单调性、输入不足。
 *
 * 全部为纯函数测试，不依赖 DuckDB / ConfigStore。
 */
import { describe, it, expect } from 'vitest';
import type { DailyKline } from '@invest/core';
import { buildZigZag, detectDoubleTopBottom, findRawPivots } from '../../src/services/patterns/index.js';

/** 影线偏移（1 分钱）：让 high/low 有区分度，又不显著影响百分比判据 */
const PAD = 0.01;

function dateOf(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 按「拐点 + 线性插值」构造日线序列：单调段不会产生额外枢轴。
 *
 * @param waypoints 升序排列的 {index, price}
 * @param total     总 bar 数；最后一个拐点之后价格保持不变
 */
function makeBars(waypoints: Array<{ index: number; price: number }>, total: number): DailyKline[] {
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  const prices: number[] = new Array(total).fill(last.price);

  for (let i = 0; i < first.index; i++) prices[i] = first.price;

  for (let w = 0; w + 1 < waypoints.length; w++) {
    const a = waypoints[w];
    const b = waypoints[w + 1];
    for (let i = a.index; i <= b.index; i++) {
      const t = (i - a.index) / (b.index - a.index);
      prices[i] = a.price + (b.price - a.price) * t;
    }
  }

  return prices.map((price, i) => ({
    date: dateOf(i),
    open: price,
    high: price + PAD,
    low: price - PAD,
    close: price,
    volume: 1_000_000,
    amount: price * 1_000_000,
  }));
}

/** 标准双顶：顶 100 / 100，谷 97，间隔 30 bar，随后跌破颈线 */
function doubleTopBars(): DailyKline[] {
  return makeBars(
    [
      { index: 0, price: 95 },
      { index: 25, price: 100 },
      { index: 40, price: 97 },
      { index: 55, price: 100 },
      { index: 62, price: 99 },
      { index: 70, price: 95 },
    ],
    90,
  );
}

/** 标准双底：底 100 / 100，峰 103，间隔 30 bar，随后升破颈线 */
function doubleBottomBars(): DailyKline[] {
  return makeBars(
    [
      { index: 0, price: 105 },
      { index: 25, price: 100 },
      { index: 40, price: 103 },
      { index: 55, price: 100 },
      { index: 62, price: 101.5 },
      { index: 70, price: 105 },
    ],
    90,
  );
}

describe('ZigZag 摆动点', () => {
  it('标准双顶序列 → 3 个枢轴（high/low/high），索引正确', () => {
    const bars = doubleTopBars();
    const zig = buildZigZag(bars);
    expect(zig).toHaveLength(3);
    expect(zig.map((p) => [p.index, p.type])).toEqual([
      [25, 'high'],
      [40, 'low'],
      [55, 'high'],
    ]);
  });

  it('输入不足 2×half+1 根 → 返回空数组，不抛错', () => {
    const bars = makeBars(
      [
        { index: 0, price: 100 },
        { index: 9, price: 101 },
      ],
      10,
    );
    expect(() => findRawPivots(bars)).not.toThrow();
    expect(findRawPivots(bars)).toEqual([]);
    expect(buildZigZag(bars)).toEqual([]);
    expect(detectDoubleTopBottom(bars)).toEqual([]);
  });

  it('deviation 越大 → ZigZag 枢轴数单调不增', () => {
    // 单个摆动幅度 2.22%：2.5% 起被过滤
    const bars = makeBars(
      [
        { index: 0, price: 95 },
        { index: 25, price: 100 },
        { index: 40, price: 97.8 },
        { index: 55, price: 100 },
        { index: 70, price: 95 },
      ],
      90,
    );
    const counts = [1.5, 2, 2.5, 3, 5].map((d) => buildZigZag(bars, { deviationPct: d }).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });

  it('deviation 越大 → 形态数量单调不增', () => {
    const bars = makeBars(
      [
        { index: 0, price: 95 },
        { index: 25, price: 100 },
        { index: 40, price: 97.8 },
        { index: 55, price: 100 },
        { index: 70, price: 95 },
      ],
      90,
    );
    const counts = [1.5, 2, 2.5, 3, 5].map((d) => detectDoubleTopBottom(bars, { deviationPct: d }).length);
    expect(counts[0]).toBe(1);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});

describe('双顶识别', () => {
  it('标准双顶 → 命中 1 条，points / neckline / 确认点正确', () => {
    const bars = doubleTopBars();
    const patterns = detectDoubleTopBottom(bars);
    expect(patterns).toHaveLength(1);

    const p = patterns[0];
    expect(p.kind).toBe('double_top');
    expect(p.points.map((x) => x.role)).toEqual(['first', 'middle', 'second']);
    expect(p.points.map((x) => x.index)).toEqual([25, 40, 55]);
    expect(p.startIndex).toBe(25);
    // 颈线为水平（slope=0），价位 = 谷的 low
    expect(p.neckline.slope).toBe(0);
    expect(p.neckline.from.price).toBeCloseTo(97 - PAD, 6);
    expect(p.neckline.to.price).toBeCloseTo(97 - PAD, 6);
    expect(p.confirmIndex).toBe(p.endIndex);
    expect(p.breakout.close).toBeLessThan(p.neckline.from.price);
    expect(p.metrics.separationBars).toBe(30);
    expect(p.metrics.middlePositionPct).toBeCloseTo(50, 6);
  });

  it('两顶价差恰好 2% → 命中；2.1% → 不命中', () => {
    const at = (top2: number) =>
      makeBars(
        [
          { index: 0, price: 95 },
          { index: 25, price: 100 },
          { index: 40, price: 96.5 },
          { index: 55, price: top2 },
          { index: 65, price: 96 },
        ],
        80,
      );
    expect(detectDoubleTopBottom(at(102), { deviationPct: 1 })).toHaveLength(1);
    expect(detectDoubleTopBottom(at(102.1), { deviationPct: 1 })).toHaveLength(0);
  });

  it('间隔 10 / 60 命中；9 / 61 不命中', () => {
    const build = (top1: number, valley: number, top2: number, end: number) =>
      makeBars(
        [
          { index: 0, price: 95 },
          { index: top1, price: 100 },
          { index: valley, price: 96.5 },
          { index: top2, price: 100 },
          { index: top2 + 10, price: 95 },
        ],
        end,
      );
    expect(detectDoubleTopBottom(build(20, 50, 80, 120), { deviationPct: 1 })).toHaveLength(1); // 60
    expect(detectDoubleTopBottom(build(30, 35, 40, 70), { deviationPct: 1 })).toHaveLength(1); // 10
    expect(detectDoubleTopBottom(build(30, 35, 39, 70), { deviationPct: 1 })).toHaveLength(0); // 9
    expect(detectDoubleTopBottom(build(20, 50, 81, 120), { deviationPct: 1 })).toHaveLength(0); // 61
  });

  it('中间谷深 2.02% 命中；1.92% 不命中', () => {
    const build = (valleyPrice: number) =>
      makeBars(
        [
          { index: 0, price: 95 },
          { index: 25, price: 100 },
          { index: 40, price: valleyPrice },
          { index: 55, price: 100 },
          { index: 65, price: 94.5 },
        ],
        80,
      );
    expect(detectDoubleTopBottom(build(98), { deviationPct: 1 })).toHaveLength(1);
    expect(detectDoubleTopBottom(build(98.1), { deviationPct: 1 })).toHaveLength(0);
  });

  it('谷位 0.2 / 0.8 边界命中；0.167 / 0.867 不命中', () => {
    const build = (valley: number) =>
      makeBars(
        [
          { index: 0, price: 95 },
          { index: 25, price: 100 },
          { index: valley, price: 96.5 },
          { index: 55, price: 100 },
          { index: 65, price: 95 },
        ],
        80,
      );
    expect(detectDoubleTopBottom(build(31), { deviationPct: 1 })).toHaveLength(1); // 0.2
    expect(detectDoubleTopBottom(build(49), { deviationPct: 1 })).toHaveLength(1); // 0.8
    expect(detectDoubleTopBottom(build(30), { deviationPct: 1 })).toHaveLength(0); // 0.167
    expect(detectDoubleTopBottom(build(51), { deviationPct: 1 })).toHaveLength(0); // 0.867
  });

  it('未跌破颈线 → 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 95 },
        { index: 25, price: 100 },
        { index: 40, price: 97 },
        { index: 55, price: 100 },
        { index: 90, price: 99 },
      ],
      100,
    );
    expect(detectDoubleTopBottom(bars)).toHaveLength(0);
  });

  it('收盘价恰好接触颈线（跌破幅度 0）→ 不命中', () => {
    // 颈线 = 谷的 low = 97 - PAD = 96.99；末段收盘恰好 96.99
    const bars = makeBars(
      [
        { index: 0, price: 95 },
        { index: 25, price: 100 },
        { index: 40, price: 97 },
        { index: 55, price: 100 },
        { index: 70, price: 96.99 },
      ],
      100,
    );
    expect(detectDoubleTopBottom(bars)).toHaveLength(0);
  });

  it('跌破发生在第 21 根（超出确认窗口）→ 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 95 },
        { index: 25, price: 100 },
        { index: 40, price: 97 },
        { index: 55, price: 100 },
        { index: 76, price: 99 },
        { index: 77, price: 95 },
      ],
      100,
    );
    expect(detectDoubleTopBottom(bars)).toHaveLength(0);
  });
});

describe('双底识别', () => {
  it('标准双底 → 命中 1 条，向上突破确认', () => {
    const bars = doubleBottomBars();
    const patterns = detectDoubleTopBottom(bars);
    expect(patterns).toHaveLength(1);

    const p = patterns[0];
    expect(p.kind).toBe('double_bottom');
    expect(p.points.map((x) => [x.role, x.index])).toEqual([
      ['first', 25],
      ['middle', 40],
      ['second', 55],
    ]);
    expect(p.breakout.close).toBeGreaterThan(p.neckline.from.price);
    expect(p.metrics.separationBars).toBe(30);
    expect(p.metrics.middlePositionPct).toBeCloseTo(50, 6);
  });

  it('两底价差 2.1% → 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 105 },
        { index: 25, price: 100 },
        { index: 40, price: 103 },
        { index: 55, price: 97.9 },
        { index: 70, price: 106 },
      ],
      90,
    );
    expect(detectDoubleTopBottom(bars, { deviationPct: 1 })).toHaveLength(0);
  });

  it('未升破颈线 → 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 105 },
        { index: 25, price: 100 },
        { index: 40, price: 103 },
        { index: 55, price: 100 },
        { index: 90, price: 102 },
      ],
      100,
    );
    expect(detectDoubleTopBottom(bars)).toHaveLength(0);
  });
});
