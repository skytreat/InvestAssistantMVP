/**
 * T61 · 前端指标适配层对 golden 的断言（SDD §12.5 F5 · `kline_render`）
 *
 * 🎯 **本文件的定位**
 *
 * SDD §12.5 的 F5「K 线图 + 副图指标渲染正确」指定的测试载体是
 * `apps/frontend` → `frontend.test.tsx` → 用例名 `kline_render`。
 * 本文件即为该载体的**指标计算正确性**部分。
 *
 * ⚠️ **F5 的 Canvas/副图渲染部分待 T70（Wave 5）交付；本文件覆盖 F5 的指标计算正确性部分。**
 * Canvas 绘制依赖 `klinecharts@10.1.0`（Wave 5 / T70 才引入），
 * 故本文件**不实现** Canvas 渲染、**不引入** klinecharts 依赖。
 * T70 落地后应在同一文件（或其扩展文件）里补：
 * - Canvas 绘制无异常
 * - 副图 MACD/RSI 覆盖层正确
 *
 * 🔒 **KDJ 禁止任何容差**
 *
 * KDJ 是本项目**唯一的递归平滑指标**（`SMA` 递归 + `K₀ = D₀ = 50` 初值），
 * 累加顺序即结果，两端实现只要有一处字节差异就会在末位数值上体现。
 * 故本文件对 K/D/J 一律用 `toBe` 严格相等（**不用** `toBeCloseTo`、
 * **不设** epsilon），golden 的 `null` 位置要求前端结果必须是 `NaN`。
 *
 * 📌 **与 `packages/core/tests/kdj.parity.test.ts` 的分工**
 *
 * - `packages/core/tests/kdj.parity.test.ts`：core ↔ frontend 两份实现的
 *   **逐位一致性**（含两份源文件字节一致），以及 golden ↔ core 的回归。
 * - **本文件**：golden ↔ frontend 的**逐位回归**，以及**不依赖 golden 的
 *   口径自洽校验**（防「两边一起错」）。
 * → 两边**不重复**：core ↔ frontend 的一致性不在本文件重复断言。
 *
 * 📦 **golden 读取方式**
 *
 * 用 `fs.readFileSync` + `JSON.parse` 读 `packages/core/tests/fixtures/golden/kdj.json`
 * （**只读**，不修改），而非 `import ... from '*.json'` ——
 * 后者依赖 `resolveJsonModule` + 特定 moduleResolution，与 vitest 的解析路径耦合。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from '../../src/indicators/kdj';
import {
  calculateBoll,
  BOLL_DEFAULT_PERIOD,
  BOLL_DEFAULT_STDDEV,
  type BollResult,
} from '../../src/indicators/bollinger';

/* ------------------------------------------------------------------ *
 * golden 数据集（只读）
 * ------------------------------------------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件位于 `apps/frontend/tests/unit/`，向上 4 层 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'packages/core/tests/fixtures/golden/kdj.json');

/** golden 里的一根 K 线 */
interface GoldenBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** golden 里的布林带（`null` 表示 NaN / ±Infinity）*/
interface GoldenBoll {
  params: { period: number; stdDev: number };
  upper: Array<number | null>;
  middle: Array<number | null>;
  lower: Array<number | null>;
  pb: Array<number | null>;
  width: Array<number | null>;
}

/** `packages/core/tests/fixtures/golden/kdj.json` 的结构 */
interface GoldenKdj {
  meta: {
    source: string;
    barCount: number;
    firstDate: string;
    lastDate: string;
    library: string;
    encoding: string;
  };
  note: string;
  bars: GoldenBar[];
  params: { n: number; m1: number; m2: number };
  expected: { k: Array<number | null>; d: Array<number | null>; j: Array<number | null> };
  expectedEncoded: { k: Array<number | null>; d: Array<number | null>; j: Array<number | null> };
  boll: GoldenBoll;
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenKdj;

const bars: GoldenBar[] = golden.bars;
const highs: number[] = bars.map((b) => b.high);
const lows: number[] = bars.map((b) => b.low);
const closes: number[] = bars.map((b) => b.close);

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */

/**
 * 把前端结果归一化成 golden 的编码形式
 *
 * golden 的编码约定（见 `meta.encoding`）：`Number.isFinite(v) ? v : null`，
 * 即 `null` 表示 NaN / ±Infinity。前端内部用 NaN 表示数据不足期。
 */
function toNullable(series: number[]): Array<number | null> {
  return series.map((v) => (Number.isFinite(v) ? v : null));
}

/**
 * 逐位断言（**零容差**）
 *
 * - golden 为 `null` → 实际必须是 NaN
 * - golden 为数值 → 实际必须 `toBe` 严格相等（不使用 `toBeCloseTo`）
 */
function expectBitwise(actual: number[], expected: Array<number | null>, label: string): void {
  expect(actual.length, `${label} 长度`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    if (exp === null) {
      expect(Number.isNaN(actual[i]), `${label}[${i}] 应为 NaN`).toBe(true);
    } else {
      expect(actual[i], `${label}[${i}] 期望 ${exp}，实际 ${actual[i]}`).toBe(exp);
    }
  }
}

/** 用 golden 的 params 调前端 KDJ */
function calcKdj(): KDJResult {
  return calculateKDJ(highs, lows, closes, golden.params.n, golden.params.m1, golden.params.m2);
}

/** 用 golden 的 params 调前端布林带 */
function calcBoll(): BollResult {
  return calculateBoll(closes, golden.boll.params.period, golden.boll.params.stdDev);
}

/* ------------------------------------------------------------------ *
 * golden 自证
 * ------------------------------------------------------------------ */

describe('kline_render · golden 数据集自证', () => {
  it('kline_render: golden 来自真实行情（221 根 K 线 + 固定库版本）', () => {
    expect(golden.meta.barCount).toBe(221);
    expect(bars.length).toBe(221);
    expect(golden.meta.library).toBe('fast-technical-indicators@1.1.6');
    expect(golden.meta.source).toContain('v_stock_qfq');
    expect(golden.params).toEqual({ n: 9, m1: 3, m2: 3 });
    expect(golden.boll.params).toEqual({ period: 20, stdDev: 2 });
    // 前端默认参数必须与 golden 用的参数一致
    expect(KDJ_DEFAULT_N).toBe(golden.params.n);
    expect(KDJ_DEFAULT_M1).toBe(golden.params.m1);
    expect(KDJ_DEFAULT_M2).toBe(golden.params.m2);
    expect(BOLL_DEFAULT_PERIOD).toBe(golden.boll.params.period);
    expect(BOLL_DEFAULT_STDDEV).toBe(golden.boll.params.stdDev);
  });

  it('kline_render: golden 的 expected 与 expectedEncoded 两种编码一致', () => {
    expect(golden.expected).toEqual(golden.expectedEncoded);
  });

  it('kline_render: golden 的 note 声明「禁止任何容差」', () => {
    expect(golden.note).toContain('禁止任何容差');
    expect(golden.meta.encoding).toContain('Number.isFinite');
  });
});

/* ------------------------------------------------------------------ *
 * KDJ 对 golden 逐位相等
 * ------------------------------------------------------------------ */

describe('kline_render · KDJ 指标对 golden 逐位相等（零容差）', () => {
  it('kline_render: K/D/J 三个序列对 golden 221 条行情逐位相等', () => {
    const r = calcKdj();
    expect(toNullable(r.k), 'K 序列与 golden 逐位相等').toEqual(golden.expected.k);
    expect(toNullable(r.d), 'D 序列与 golden 逐位相等').toEqual(golden.expected.d);
    expect(toNullable(r.j), 'J 序列与 golden 逐位相等').toEqual(golden.expected.j);
    // 逐位严格断言（toBe，零容差）
    expectBitwise(r.k, golden.expected.k, 'K');
    expectBitwise(r.d, golden.expected.d, 'D');
    expectBitwise(r.j, golden.expected.j, 'J');
  });

  it('kline_render: 第 100 位 K 与 golden 严格相等（toBe，不允许任何容差）', () => {
    const r = calcKdj();
    const expectedK = golden.expected.k[100];
    expect(expectedK).not.toBeNull();
    // 严格相等：Object.is 语义，double 的每一位都必须相同
    expect(r.k[100]).toBe(expectedK as number);
    // 差额必须精确为 0（显式表达「零容差」，不依赖 toBe 的实现细节）
    expect(r.k[100] - (expectedK as number)).toBe(0);
    // D / J 同点同样严格相等
    expect(r.d[100]).toBe(golden.expected.d[100] as number);
    expect(r.j[100]).toBe(golden.expected.j[100] as number);
  });

  it('kline_render: 数据不足期恰好前 n-1（=8）根为 NaN，第 9 根（index 8）起为有限值', () => {
    const r = calcKdj();
    const warmup = golden.params.n - 1;
    for (let i = 0; i < warmup; i++) {
      expect(r.k[i], `K[${i}] 应为 NaN`).toBe(NaN);
      expect(r.d[i], `D[${i}] 应为 NaN`).toBe(NaN);
      expect(r.j[i], `J[${i}] 应为 NaN`).toBe(NaN);
    }
    for (let i = warmup; i < r.k.length; i++) {
      expect(Number.isFinite(r.k[i]), `K[${i}] 应为有限值`).toBe(true);
      expect(Number.isFinite(r.d[i]), `D[${i}] 应为有限值`).toBe(true);
      expect(Number.isFinite(r.j[i]), `J[${i}] 应为有限值`).toBe(true);
    }
    // NaN 的总数恰好等于 warmup 期（不多不少）
    expect(r.k.filter((v) => Number.isNaN(v)).length).toBe(warmup);
    // golden 的 null 位置也必须恰好落在 warmup 期
    expect(golden.expected.k.slice(0, warmup).every((v) => v === null)).toBe(true);
    expect(golden.expected.k.slice(warmup).every((v) => v !== null)).toBe(true);
  });

  it('kline_render: K/D/J 三个序列长度均等于 K 线数量', () => {
    const r = calcKdj();
    expect(r.k.length).toBe(bars.length);
    expect(r.d.length).toBe(bars.length);
    expect(r.j.length).toBe(bars.length);
  });

  it('kline_render: 221 条行情上不存在 Infinity', () => {
    const r = calcKdj();
    for (const series of [r.k, r.d, r.j]) {
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 口径自洽（不依赖 golden，防「两边一起错」）
 * ------------------------------------------------------------------ */

describe('kline_render · KDJ 口径自洽（独立于 golden 的防错校验）', () => {
  it('kline_render: J === 3*K - 2*D 逐点成立（源码系数常量）', () => {
    const r = calcKdj();
    expect(J_K_COEFFICIENT).toBe(3);
    expect(J_D_COEFFICIENT).toBe(2);
    let checked = 0;
    for (let i = 0; i < r.k.length; i++) {
      if (Number.isNaN(r.k[i]) || Number.isNaN(r.d[i]) || Number.isNaN(r.j[i])) {
        continue;
      }
      expect(r.j[i], `J[${i}] 应等于 3*K-2*D`).toBe(J_K_COEFFICIENT * r.k[i] - J_D_COEFFICIENT * r.d[i]);
      checked += 1;
    }
    // 至少要检查到 200 个有效点，否则断言形同虚设
    expect(checked).toBeGreaterThanOrEqual(200);
  });

  it('kline_render: K/D 落在 [0, 100] 区间（J 允许越界）', () => {
    const r = calcKdj();
    for (let i = golden.params.n - 1; i < r.k.length; i++) {
      expect(r.k[i]).toBeGreaterThanOrEqual(0);
      expect(r.k[i]).toBeLessThanOrEqual(100);
      expect(r.d[i]).toBeGreaterThanOrEqual(0);
      expect(r.d[i]).toBeLessThanOrEqual(100);
    }
  });

  it('kline_render: 默认参数与显式参数结果一致', () => {
    const byDefault = calculateKDJ(highs, lows, closes);
    const byExplicit = calculateKDJ(highs, lows, closes, golden.params.n, golden.params.m1, golden.params.m2);
    expect(byDefault.k).toEqual(byExplicit.k);
    expect(byDefault.d).toEqual(byExplicit.d);
    expect(byDefault.j).toEqual(byExplicit.j);
  });

  it('kline_render: highs/lows/closes 长度不一致时抛 RangeError', () => {
    expect(() => calculateKDJ(highs.slice(1), lows, closes)).toThrow(RangeError);
    expect(() => calculateKDJ(highs, lows.slice(1), closes)).toThrow(RangeError);
    expect(() => calculateKDJ(highs, lows, closes.slice(1))).toThrow(RangeError);
    // 多给一根同样报错
    expect(() => calculateKDJ([...highs, 1], lows, closes)).toThrow(RangeError);
  });

  it('kline_render: 长度一致但内容为空时返回等长的空序列（不抛错）', () => {
    const r = calculateKDJ([], [], []);
    expect(r.k).toEqual([]);
    expect(r.d).toEqual([]);
    expect(r.j).toEqual([]);
  });

  it('kline_render: 首个窗口即横盘（Hn===Ln 除零）→ RSV 取初值，K/D/J 均为 50', () => {
    // 全部等值的序列：每个窗口都有 Hn === Ln → 分母为 0
    const len = golden.params.n;
    const highs = new Array<number>(len).fill(7);
    const lows = new Array<number>(len).fill(7);
    const closes = new Array<number>(len).fill(7);
    const r = calculateKDJ(highs, lows, closes);
    // 尚无前值可沿用 → RSV 取初值 50 → K=(50+2*50)/3=50，D=50，J=3*50-2*50=50
    expect(KDJ_INITIAL_VALUE).toBe(50);
    expect(RSV_PERCENT_SCALE).toBe(100);
    expect(r.k[len - 1]).toBe(KDJ_INITIAL_VALUE);
    expect(r.d[len - 1]).toBe(KDJ_INITIAL_VALUE);
    expect(r.j[len - 1]).toBe(KDJ_INITIAL_VALUE);
    // 除零不得污染出 Infinity
    for (const series of [r.k, r.d, r.j]) {
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });

  it('kline_render: 中途横盘 → RSV 沿用前值，K/D 不跳变', () => {
    const n = golden.params.n;
    const len = n + 4;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < len; i++) {
      // 前 n 根递增造出 RSV=100；随后 4 根全部相等 → 窗口恒定 → RSV 沿用 100
      const v = i < n ? 10 + i : 10 + (n - 1);
      highs.push(v);
      lows.push(v);
      closes.push(v);
    }
    const r = calculateKDJ(highs, lows, closes);
    const expectedK = (RSV_PERCENT_SCALE + (KDJ_DEFAULT_M1 - 1) * KDJ_INITIAL_VALUE) / KDJ_DEFAULT_M1;
    expect(r.k[n - 1]).toBe(expectedK);
    // RSV 保持 100 → K 继续向 100 收敛而非跳变
    expect(r.k[n]).toBe((RSV_PERCENT_SCALE + (KDJ_DEFAULT_M1 - 1) * r.k[n - 1]) / KDJ_DEFAULT_M1);
    expect(r.k[n]).toBeGreaterThan(r.k[n - 1]);
    expect(r.d[n]).toBe((r.k[n] + (KDJ_DEFAULT_M2 - 1) * r.d[n - 1]) / KDJ_DEFAULT_M2);
  });
});

/* ------------------------------------------------------------------ *
 * BOLL 对 golden 逐位相等
 * ------------------------------------------------------------------ */

describe('kline_render · 布林带 BOLL 对 golden 逐位相等', () => {
  it('kline_render: BOLL(20, 2) 的 upper/middle/lower/pb/width 全部逐位相等', () => {
    const b = calcBoll();
    expect(toNullable(b.upper)).toEqual(golden.boll.upper);
    expect(toNullable(b.middle)).toEqual(golden.boll.middle);
    expect(toNullable(b.lower)).toEqual(golden.boll.lower);
    expect(toNullable(b.pb)).toEqual(golden.boll.pb);
    expect(toNullable(b.width)).toEqual(golden.boll.width);
    expectBitwise(b.upper, golden.boll.upper, 'BOLL.upper');
    expectBitwise(b.middle, golden.boll.middle, 'BOLL.middle');
    expectBitwise(b.lower, golden.boll.lower, 'BOLL.lower');
    expectBitwise(b.pb, golden.boll.pb, 'BOLL.pb');
    expectBitwise(b.width, golden.boll.width, 'BOLL.width');
  });

  it('kline_render: BOLL 前 period-1（=19）根为 NaN，第 20 根（index 19）起为有限值', () => {
    const b = calcBoll();
    const warmup = golden.boll.params.period - 1;
    for (let i = 0; i < warmup; i++) {
      expect(b.upper[i], `upper[${i}] 应为 NaN`).toBe(NaN);
      expect(b.middle[i], `middle[${i}] 应为 NaN`).toBe(NaN);
      expect(b.lower[i], `lower[${i}] 应为 NaN`).toBe(NaN);
      expect(b.pb[i], `pb[${i}] 应为 NaN`).toBe(NaN);
      expect(b.width[i], `width[${i}] 应为 NaN`).toBe(NaN);
    }
    for (let i = warmup; i < b.upper.length; i++) {
      expect(Number.isFinite(b.upper[i]), `upper[${i}] 应为有限值`).toBe(true);
      expect(Number.isFinite(b.middle[i]), `middle[${i}] 应为有限值`).toBe(true);
      expect(Number.isFinite(b.lower[i]), `lower[${i}] 应为有限值`).toBe(true);
    }
    expect(b.upper.length).toBe(bars.length);
  });

  it('kline_render: BOLL 口径自洽（上下轨对称 + pb/width 定义）', () => {
    const b = calcBoll();
    const warmup = golden.boll.params.period - 1;
    for (let i = warmup; i < b.upper.length; i++) {
      // 上下轨关于中轨对称（总体标准差口径 → 上下轨各偏离 2 倍 sigma）
      expect(b.upper[i] - b.middle[i], `upper[${i}] 与 middle[${i}] 的偏移`).toBe(b.middle[i] - b.lower[i]);
      // %B = (close - lower) / (upper - lower)
      expect(b.pb[i], `pb[${i}]`).toBe((closes[i] - b.lower[i]) / (b.upper[i] - b.lower[i]));
      // 带宽 = (upper - lower) / middle
      expect(b.width[i], `width[${i}]`).toBe((b.upper[i] - b.lower[i]) / b.middle[i]);
    }
  });

  it('kline_render: BOLL 空输入返回 5 条等长空序列', () => {
    const b = calculateBoll([]);
    expect(b.upper).toEqual([]);
    expect(b.middle).toEqual([]);
    expect(b.lower).toEqual([]);
    expect(b.pb).toEqual([]);
    expect(b.width).toEqual([]);
  });
});
