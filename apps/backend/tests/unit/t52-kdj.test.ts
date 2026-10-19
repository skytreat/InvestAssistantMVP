/**
 * t52-kdj.test.ts — T52 KDJ / 布林带落地断言（后端侧）
 *
 * 与 packages/core 的分工：
 * - core/tests/kdj.test.ts：公式 / 初值 / 除零 / 数据不足期
 * - core/tests/kdj.parity.test.ts：core 与 frontend 两份实现逐位相等
 * - 本文件：从 @invest/core 消费侧验证 golden 221 条逐位数值、kline.ts 私有 sma 已迁走、无魔法数
 *
 * 🔒 KDJ 是唯一递归平滑指标，**禁止任何容差**。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateKDJ } from '@invest/core';
import golden from '../../../../packages/core/tests/fixtures/golden/kdj.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');

interface GoldenBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
interface GoldenFile {
  meta: { barCount: number; library: string; source: string };
  bars: GoldenBar[];
  params: { n: number; m1: number; m2: number };
  expectedEncoded: { k: Array<number | null>; d: Array<number | null>; j: Array<number | null> };
}

const g = golden as unknown as GoldenFile;
const bars = g.bars;
const highs = bars.map((b) => b.high);
const lows = bars.map((b) => b.low);
const closes = bars.map((b) => b.close);

/** 逐位断言：golden 里 null 表示 NaN / ±Infinity */
function expectBitwise(actual: number[], expected: Array<number | null>, label: string): void {
  expect(actual.length, `${label} 长度`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) {
      expect(Number.isNaN(actual[i]), `${label}[${i}] 应为 NaN`).toBe(true);
    } else {
      expect(actual[i], `${label}[${i}] 逐位`).toBe(expected[i] as number);
    }
  }
}

describe('T52 KDJ golden · 221 条固定行情逐位断言（@invest/core 消费侧）', () => {
  it('golden 元数据自证来自真实 DuckDB 行情', () => {
    expect(g.meta.barCount).toBe(221);
    expect(bars.length).toBe(221);
    expect(g.meta.library).toBe('fast-technical-indicators@1.1.6');
    expect(g.meta.source).toContain('v_stock_qfq');
    expect(g.params).toEqual({ n: 9, m1: 3, m2: 3 });
  });

  it('K 逐位一致', () => {
    expectBitwise(calculateKDJ(highs, lows, closes).k, g.expectedEncoded.k, 'K');
  });

  it('D 逐位一致', () => {
    expectBitwise(calculateKDJ(highs, lows, closes).d, g.expectedEncoded.d, 'D');
  });

  it('J 逐位一致', () => {
    expectBitwise(calculateKDJ(highs, lows, closes).j, g.expectedEncoded.j, 'J');
  });

  it('初值 K₀ = D₀ = 50（前 8 根数据不足期为 NaN，第 9 根由 50 递推）', () => {
    const r = calculateKDJ(highs, lows, closes);
    expect(r.k.slice(0, 8).every((v) => Number.isNaN(v))).toBe(true);
    expect(r.d.slice(0, 8).every((v) => Number.isNaN(v))).toBe(true);
    // 第 9 根 = (RSV + 2*50)/3，不等于 50（除非 RSV 恰为 50）
    expect(Number.isNaN(r.k[8])).toBe(false);
    expect(g.expectedEncoded.k.slice(0, 8).every((v) => v === null)).toBe(true);
  });

  it('221 条行情上不存在 ±Infinity', () => {
    const r = calculateKDJ(highs, lows, closes);
    for (const series of [r.k, r.d, r.j]) {
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });

  it('全等常数序列（Hn=Ln 除零）不产生 Infinity', () => {
    const len = 30;
    const h = new Array<number>(len).fill(9);
    const l = new Array<number>(len).fill(9);
    const c = new Array<number>(len).fill(9);
    const r = calculateKDJ(h, l, c);
    for (const series of [r.k, r.d, r.j]) {
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });
});

describe('T52 · routes/kline.ts 私有 sma() 已迁至 core', () => {
  const klineSrc = readFileSync(
    path.join(REPO_ROOT, 'apps/backend/src/routes/kline.ts'),
    'utf8'
  );

  it('kline.ts 不再定义私有 sma 函数', () => {
    expect(/function\s+sma\s*\(/i.test(klineSrc)).toBe(false);
    expect(/const\s+sma\s*=/i.test(klineSrc)).toBe(false);
  });

  it('kline.ts 从 @invest/core 引入 calculateSMA', () => {
    expect(klineSrc).toMatch(/calculateSMA/);
    expect(klineSrc).toMatch(/from\s+'@invest\/core'/);
  });
});

describe('T52 · KDJ 无魔法数（公式常数具名）', () => {
  const kdjSrc = readFileSync(
    path.join(REPO_ROOT, 'packages/core/src/indicators/kdj.ts'),
    'utf8'
  );

  it('9 / 3 / 3 / 50 / 2 / 3 全部以具名常量出现', () => {
    for (const name of [
      'KDJ_DEFAULT_N',
      'KDJ_DEFAULT_M1',
      'KDJ_DEFAULT_M2',
      'KDJ_INITIAL_VALUE',
      'RSV_PERCENT_SCALE',
      'SMA_WEIGHT_CURRENT',
      'J_K_COEFFICIENT',
      'J_D_COEFFICIENT',
    ]) {
      expect(kdjSrc, `缺少具名常量 ${name}`).toContain(name);
    }
  });

  it('库内不存在 KDJ，不得用 Stochastic 替代', async () => {
    const mod = await import('fast-technical-indicators');
    expect('KDJ' in mod).toBe(false);
    expect('Stochastic' in mod).toBe(true);
  });
});
