/**
 * head-shoulder.test.ts — 头肩顶 / 头肩底单测
 *
 * 覆盖（对应 docs/client/pattern_recognition_design.md §8）：
 *   标准命中（向下 / 向上倾斜颈线）、头不够高、两肩差超限、
 *   右肩已破颈线、未突破、超出确认窗口、输入不足。
 *
 * 全部为纯函数测试，不依赖 DuckDB / ConfigStore。
 */
import { describe, it, expect } from 'vitest';
import type { DailyKline } from '@invest/core';
import { buildZigZag, detectHeadShoulders } from '../../src/services/patterns/index.js';

/** 影线偏移（1 分钱）：让 high/low 有区分度，又不显著影响百分比判据 */
const PAD = 0.01;

function dateOf(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** 按「拐点 + 线性插值」构造日线序列（同双顶/双底测试的构造器） */
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

/**
 * 标准头肩顶（颈线**向下倾斜**）：
 * 左肩 100@20 → 颈1 97@30 → 头 104@42 → 颈2 96@54 → 右肩 99.5@66 → 跌破颈线
 */
function headShouldersTopBars(): DailyKline[] {
  return makeBars(
    [
      { index: 0, price: 90 },
      { index: 20, price: 100 },
      { index: 30, price: 97 },
      { index: 42, price: 104 },
      { index: 54, price: 96 },
      { index: 66, price: 99.5 },
      { index: 74, price: 94 },
      { index: 80, price: 90 },
    ],
    90,
  );
}

/** 标准头肩底（颈线**向上倾斜**） */
function headShouldersBottomBars(): DailyKline[] {
  return makeBars(
    [
      { index: 0, price: 110 },
      { index: 20, price: 100 },
      { index: 30, price: 103 },
      { index: 42, price: 96 },
      { index: 54, price: 104 },
      { index: 66, price: 100.5 },
      { index: 74, price: 108 },
      { index: 80, price: 110 },
    ],
    90,
  );
}

describe('头肩：ZigZag 前置条件', () => {
  it('标准头肩顶序列 → 5 个枢轴且高低交替', () => {
    const zig = buildZigZag(headShouldersTopBars());
    expect(zig.map((p) => [p.index, p.type])).toEqual([
      [20, 'high'],
      [30, 'low'],
      [42, 'high'],
      [54, 'low'],
      [66, 'high'],
    ]);
  });
});

describe('头肩顶', () => {
  it('标准形态命中：五点角色 / 向下斜率颈线 / 收盘跌破确认', () => {
    const out = detectHeadShoulders(headShouldersTopBars());
    expect(out).toHaveLength(1);

    const p = out[0];
    expect(p.kind).toBe('head_shoulders_top');
    expect(p.points.map((x) => x.role)).toEqual([
      'left_shoulder',
      'neck1',
      'head',
      'neck2',
      'right_shoulder',
    ]);
    // 枢轴价格取 high/low（含 1 分钱影线）
    expect(p.points[0].index).toBe(20);
    expect(p.points[0].price).toBeCloseTo(100.01, 4);
    expect(p.points[2].index).toBe(42);
    expect(p.points[2].price).toBeCloseTo(104.01, 4);

    // 两点连线带斜率：颈1(30, 96.99) → 颈2(54, 95.99)，每 bar 约 -0.0417
    expect(p.neckline.from.index).toBe(30);
    expect(p.neckline.to.index).toBe(54);
    expect(p.neckline.slope).toBeCloseTo((95.99 - 96.99) / 24, 6);
    expect(p.neckline.slope).toBeLessThan(0);

    // 确认 bar 在右肩之后、窗口内，且收盘价确实低于该 bar 的颈线
    const bars = headShouldersTopBars();
    expect(p.breakout.index).toBeGreaterThan(66);
    expect(p.breakout.index).toBeLessThanOrEqual(54 + 20);
    const neckAtBreak = p.neckline.from.price + p.neckline.slope * (p.breakout.index - 30);
    expect(bars[p.breakout.index].close).toBeLessThan(neckAtBreak);
    expect(p.confirmIndex).toBe(p.breakout.index);
  });

  it('头不高于两肩（与左肩相等）→ 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 90 },
        { index: 20, price: 100 },
        { index: 30, price: 97 },
        { index: 42, price: 100 }, // 头与左肩等高
        { index: 54, price: 96 },
        { index: 66, price: 99.5 },
        { index: 74, price: 94 },
        { index: 80, price: 90 },
      ],
      90,
    );
    expect(detectHeadShoulders(bars)).toEqual([]);
  });

  it('两肩高度差 > 5% → 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 90 },
        { index: 20, price: 102 },
        { index: 30, price: 97 },
        { index: 42, price: 106 },
        { index: 54, price: 94 },
        { index: 66, price: 96.5 }, // 与左肩 102 相差 5.7%
        { index: 74, price: 92 },
        { index: 80, price: 90 },
      ],
      90,
    );
    const out = detectHeadShoulders(bars);
    expect(out).toEqual([]);
  });

  it('右肩已跌到颈线下方 → 结构不成立，不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 90 },
        { index: 20, price: 100 },
        { index: 30, price: 94 },
        { index: 42, price: 104 },
        { index: 54, price: 100 },
        { index: 66, price: 102.6 }, // 颈线在 66 处约 103 → 右肩已在其下方
        { index: 74, price: 92 },
        { index: 80, price: 90 },
      ],
      90,
    );
    expect(detectHeadShoulders(bars)).toEqual([]);
  });

  it('收盘价始终在颈线上方（未跌破）→ 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 90 },
        { index: 20, price: 100 },
        { index: 30, price: 97 },
        { index: 42, price: 104 },
        { index: 54, price: 96 },
        { index: 66, price: 99.5 },
        { index: 74, price: 98 }, // 颈线约 95.16，未跌破
        { index: 80, price: 98 },
      ],
      90,
    );
    expect(detectHeadShoulders(bars)).toEqual([]);
  });

  it('跌破发生在确认窗口之后（第 20 根窗口外）→ 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 90 },
        { index: 20, price: 100 },
        { index: 30, price: 97 },
        { index: 42, price: 104 },
        { index: 54, price: 96 },
        { index: 66, price: 99.5 },
        { index: 74, price: 97.5 }, // 窗口末端（54+20=74）仍在颈线上方
        { index: 77, price: 93.75 }, // 第 77 根才跌破
        { index: 80, price: 93.75 },
      ],
      90,
    );
    expect(detectHeadShoulders(bars)).toEqual([]);
  });
});

describe('头肩底', () => {
  it('标准形态命中：颈线斜率向上 + 收盘升破确认', () => {
    const out = detectHeadShoulders(headShouldersBottomBars());
    expect(out).toHaveLength(1);

    const p = out[0];
    expect(p.kind).toBe('head_shoulders_bottom');
    expect(p.neckline.from.index).toBe(30);
    expect(p.neckline.to.index).toBe(54);
    expect(p.neckline.slope).toBeGreaterThan(0);

    const bars = headShouldersBottomBars();
    expect(p.breakout.index).toBeGreaterThan(66);
    expect(p.breakout.index).toBeLessThanOrEqual(74);
    const neckAtBreak = p.neckline.from.price + p.neckline.slope * (p.breakout.index - 30);
    expect(bars[p.breakout.index].close).toBeGreaterThan(neckAtBreak);
  });

  it('收盘价始终在颈线下方（未升破）→ 不命中', () => {
    const bars = makeBars(
      [
        { index: 0, price: 110 },
        { index: 20, price: 100 },
        { index: 30, price: 103 },
        { index: 42, price: 96 },
        { index: 54, price: 104 },
        { index: 66, price: 100.5 },
        { index: 74, price: 100 }, // 颈线约 105.5，未升破
        { index: 80, price: 100 },
      ],
      90,
    );
    expect(detectHeadShoulders(bars)).toEqual([]);
  });
});

describe('头肩：输入不足', () => {
  it('少于 2×half+1 根 → 返回空数组，不抛错', () => {
    const bars = makeBars(
      [
        { index: 0, price: 100 },
        { index: 9, price: 101 },
      ],
      10,
    );
    expect(() => detectHeadShoulders(bars)).not.toThrow();
    expect(detectHeadShoulders(bars)).toEqual([]);
  });
});
