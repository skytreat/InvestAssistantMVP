/**
 * T52 KDJ 单元测试
 *
 * 覆盖：初值 K₀=D₀=50、窗口除零（Hn=Ln）、数据不足期 NaN/Infinity、
 * RSV 无前值时的填充策略、手算可验证的小样本。
 */
import { describe, it, expect } from 'vitest';
import {
  calculateKDJ,
  KDJ_DEFAULT_N,
  KDJ_DEFAULT_M1,
  KDJ_DEFAULT_M2,
  KDJ_INITIAL_VALUE,
  RSV_PERCENT_SCALE,
  J_K_COEFFICIENT,
  J_D_COEFFICIENT,
  type KDJResult,
} from '../src/indicators/kdj';

const N = KDJ_DEFAULT_N;

/** 构造 n 根单边递增的 K 线：high[i] = low[i] = base + i，最后一根 close 落在窗口最高点 */
function ramp(n: number, base = 10): { highs: number[]; lows: number[]; closes: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = base + i;
    highs.push(v);
    lows.push(v);
    closes.push(v);
  }
  return { highs, lows, closes };
}

describe('KDJ · 默认参数与常量', () => {
  it('默认参数即通达信 (9, 3, 3)，公式常数全部具名', () => {
    expect(KDJ_DEFAULT_N).toBe(9);
    expect(KDJ_DEFAULT_M1).toBe(3);
    expect(KDJ_DEFAULT_M2).toBe(3);
    expect(KDJ_INITIAL_VALUE).toBe(50);
    expect(RSV_PERCENT_SCALE).toBe(100);
    expect(J_K_COEFFICIENT).toBe(3);
    expect(J_D_COEFFICIENT).toBe(2);
  });
});

describe('KDJ · 初值 K₀ = D₀ = 50', () => {
  it('首个可算 bar 的 K/D 由 K₀=D₀=50 递推得出（手算校验）', () => {
    // 窗口 = 第 0..8 根：high 最高 = 18，low 最低 = 10，第 8 根 close = 18 → RSV = 100
    const highs = [18, 11, 12, 13, 14, 15, 16, 17, 18];
    const lows = [10, 10, 11, 12, 13, 14, 15, 16, 17];
    const closes = [18, 11, 12, 13, 14, 15, 16, 17, 18];

    const { k, d, j } = calculateKDJ(highs, lows, closes);

    // RSV = 100 * (18 - 10) / (18 - 10) = 100
    // K = (1*100 + 2*50)/3 = 200/3 = 66.666...
    // D = (1*K + 2*50)/3 = (66.666... + 100)/3 = 55.555...
    const expectedRsv = RSV_PERCENT_SCALE;
    const expectedK = (expectedRsv + (KDJ_DEFAULT_M1 - 1) * KDJ_INITIAL_VALUE) / KDJ_DEFAULT_M1;
    const expectedD = (expectedK + (KDJ_DEFAULT_M2 - 1) * KDJ_INITIAL_VALUE) / KDJ_DEFAULT_M2;
    const expectedJ = J_K_COEFFICIENT * expectedK - J_D_COEFFICIENT * expectedD;

    expect(k[N - 1]).toBe(expectedK);
    expect(d[N - 1]).toBe(expectedD);
    expect(j[N - 1]).toBe(expectedJ);
    expect(k[N - 1]).toBeCloseTo(66.6667, 4);
    expect(d[N - 1]).toBeCloseTo(55.5556, 4);
    expect(j[N - 1]).toBeCloseTo(88.8889, 4);
  });

  it('RSV = 0 时 K 应低于初值 50', () => {
    // 单边下跌：最后一根收盘 = 窗口最低价 → RSV = 0 → K = (0 + 2*50)/3 = 33.33
    const len = N;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < len; i++) {
      const v = 30 - i; // 30, 29, ... 22
      highs.push(v);
      lows.push(v);
      closes.push(v);
    }
    const { k } = calculateKDJ(highs, lows, closes);
    expect(k[N - 1]).toBe((0 + (KDJ_DEFAULT_M1 - 1) * KDJ_INITIAL_VALUE) / KDJ_DEFAULT_M1);
    expect(k[N - 1]).toBeLessThan(KDJ_INITIAL_VALUE);
  });
});

describe('KDJ · 数据不足期', () => {
  it('输入短于 n 根 → 全 NaN', () => {
    const { highs, lows, closes } = ramp(N - 1);
    const r: KDJResult = calculateKDJ(highs, lows, closes);
    expect(r.k.length).toBe(N - 1);
    expect(r.k.every((v) => Number.isNaN(v))).toBe(true);
    expect(r.d.every((v) => Number.isNaN(v))).toBe(true);
    expect(r.j.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('前 n-1 根为 NaN，第 n 根起有值', () => {
    const { highs, lows, closes } = ramp(N + 5);
    const { k } = calculateKDJ(highs, lows, closes);
    for (let i = 0; i < N - 1; i++) expect(Number.isNaN(k[i])).toBe(true);
    for (let i = N - 1; i < k.length; i++) expect(Number.isNaN(k[i])).toBe(false);
  });

  it('空输入 → 三个空数组，不抛错', () => {
    const r = calculateKDJ([], [], []);
    expect(r).toEqual({ k: [], d: [], j: [] });
  });

  it('不产生 Infinity：全等常数序列（Hn === Ln 除零）', () => {
    const len = 30;
    const highs = new Array<number>(len).fill(10);
    const lows = new Array<number>(len).fill(10);
    const closes = new Array<number>(len).fill(10);
    const r = calculateKDJ(highs, lows, closes);
    // NaN（数据不足期）是允许的；±Infinity 一律不允许
    for (const series of [r.k, r.d, r.j]) {
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });

  it('三序列长度不一致时抛 RangeError（不静默产出错位数据）', () => {
    expect(() => calculateKDJ([1, 2, 3], [1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});

describe('KDJ · RSV 无前值 / 除零的填充策略', () => {
  it('首个窗口就横盘（Hn=Ln）→ RSV 取初值 50', () => {
    const highs = new Array<number>(N).fill(7);
    const lows = new Array<number>(N).fill(7);
    const closes = new Array<number>(N).fill(7);
    const { k, d, j } = calculateKDJ(highs, lows, closes);
    // RSV = 50（无前值可沿用）→ K = (50 + 2*50)/3 = 50 → D = 50 → J = 50
    expect(k[N - 1]).toBe(KDJ_INITIAL_VALUE);
    expect(d[N - 1]).toBe(KDJ_INITIAL_VALUE);
    expect(j[N - 1]).toBe(KDJ_INITIAL_VALUE);
  });

  it('中途横盘 → RSV 沿用前值，K/D 不跳变', () => {
    const len = N + 4;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < len; i++) {
      // 前 N 根递增造出 RSV=100；随后 4 根全部相等 → 窗口恒定 → RSV 沿用 100
      const v = i < N ? 10 + i : 10 + (N - 1);
      highs.push(v);
      lows.push(v);
      closes.push(v);
    }
    const { k, d } = calculateKDJ(highs, lows, closes);
    const expectedK = (RSV_PERCENT_SCALE + (KDJ_DEFAULT_M1 - 1) * KDJ_INITIAL_VALUE) / KDJ_DEFAULT_M1;
    expect(k[N - 1]).toBe(expectedK);
    // RSV 保持 100 → K 继续向 100 收敛而非跳变
    expect(k[N]).toBe((RSV_PERCENT_SCALE + (KDJ_DEFAULT_M1 - 1) * k[N - 1]) / KDJ_DEFAULT_M1);
    expect(k[N]).toBeGreaterThan(k[N - 1]);
    expect(d[N]).toBe((k[N] + (KDJ_DEFAULT_M2 - 1) * d[N - 1]) / KDJ_DEFAULT_M2);
  });
});

describe('KDJ · 递推结构', () => {
  it('K / D / J 严格满足通达信递推式', () => {
    const { highs, lows, closes } = ramp(60, 20);
    const { k, d, j } = calculateKDJ(highs, lows, closes);
    for (let i = N; i < k.length; i++) {
      const prevK = k[i - 1];
      const prevD = d[i - 1];
      // 反推当期 RSV，验证 K 由 RSV 递推而来
      const rsv = k[i] * KDJ_DEFAULT_M1 - (KDJ_DEFAULT_M1 - 1) * prevK;
      expect(rsv).toBeGreaterThanOrEqual(0);
      expect(rsv).toBeLessThanOrEqual(RSV_PERCENT_SCALE + 1e-9);
      expect(d[i]).toBe((k[i] + (KDJ_DEFAULT_M2 - 1) * prevD) / KDJ_DEFAULT_M2);
      expect(j[i]).toBe(J_K_COEFFICIENT * k[i] - J_D_COEFFICIENT * d[i]);
    }
  });

  it('输出长度恒等于输入长度', () => {
    for (const n of [0, 1, 8, 9, 10, 221]) {
      const { highs, lows, closes } = ramp(n);
      const r = calculateKDJ(highs, lows, closes);
      expect(r.k.length).toBe(n);
      expect(r.d.length).toBe(n);
      expect(r.j.length).toBe(n);
    }
  });

  it('同一输入重复调用结果完全一致（无隐藏状态）', () => {
    const { highs, lows, closes } = ramp(80, 5);
    const a = calculateKDJ(highs, lows, closes);
    const b = calculateKDJ(highs, lows, closes);
    expect(a).toEqual(b);
  });

  it('非默认 n / m1 / m2 生效', () => {
    const { highs, lows, closes } = ramp(40, 30);
    const n = 14;
    const m1 = 3;
    const m2 = 5;
    const r = calculateKDJ(highs, lows, closes, n, m1, m2);
    // n=14 → 前 13 根 NaN
    for (let i = 0; i < n - 1; i++) expect(Number.isNaN(r.k[i])).toBe(true);
    const idx = n - 1;
    // 首个可算 bar 的前值是 K₀=D₀=50，而不是 k[idx-1]（那里是 NaN）
    const rsv = r.k[idx] * m1 - (m1 - 1) * KDJ_INITIAL_VALUE;
    expect(rsv).toBeGreaterThanOrEqual(0);
    expect(rsv).toBeLessThanOrEqual(RSV_PERCENT_SCALE + 1e-9);
    expect(r.d[idx]).toBe((r.k[idx] + (m2 - 1) * KDJ_INITIAL_VALUE) / m2);
    // m2=5 与默认 3 结果不同，证明参数真的透传了
    expect(r.d[idx]).not.toBe(
      (r.k[idx] + (KDJ_DEFAULT_M2 - 1) * KDJ_INITIAL_VALUE) / KDJ_DEFAULT_M2
    );
  });
});