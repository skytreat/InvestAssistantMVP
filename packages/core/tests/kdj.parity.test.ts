/**
 * T52 KDJ golden 回归 + 前后端逐位一致性
 *
 * 🔒 KDJ 是本项目**唯一的递归平滑指标**，两份实现（core / frontend）
 * 必须**逐位相等，不允许容差**。本测试同时锁两层：
 * 1. 源文件字节一致（漂移的最早拦截点）
 * 2. 221 条真实行情上 K/D/J 逐位相等（含 NaN 的位置）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateKDJ, KDJ_DEFAULT_N, KDJ_DEFAULT_M1, KDJ_DEFAULT_M2 } from '../src/indicators/kdj';
import { calculateBoll } from '../src/indicators/bollinger';
import { calculateKDJ as calculateKDJFrontend } from '../../../apps/frontend/src/indicators/kdj';
import { calculateBoll as calculateBollFrontend } from '../../../apps/frontend/src/indicators/bollinger';
import golden from './fixtures/golden/kdj.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const bars = golden.bars;
const highs = bars.map((b) => b.high);
const lows = bars.map((b) => b.low);
const closes = bars.map((b) => b.close);

/** NaN 用 toBe 比较时不自等，故用 Number.isNaN 单独判定 */
function expectBitwise(actual: number[], expected: Array<number | null>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) {
      expect(Number.isNaN(actual[i])).toBe(true);
    } else {
      expect(actual[i]).toBe(expected[i] as number);
    }
  }
}

describe('KDJ golden · 221 条真实行情逐位断言', () => {
  it('golden 元数据自证来自真实 DuckDB 行情', () => {
    expect(golden.meta.barCount).toBe(221);
    expect(bars.length).toBe(221);
    expect(golden.meta.library).toBe('fast-technical-indicators@1.1.6');
    expect(golden.meta.source).toContain('v_stock_qfq');
    expect(golden.params).toEqual({ n: 9, m1: 3, m2: 3 });
  });

  it('K 逐位一致', () => {
    expectBitwise(calculateKDJ(highs, lows, closes).k, golden.expectedEncoded.k);
  });

  it('D 逐位一致', () => {
    expectBitwise(calculateKDJ(highs, lows, closes).d, golden.expectedEncoded.d);
  });

  it('J 逐位一致', () => {
    expectBitwise(calculateKDJ(highs, lows, closes).j, golden.expectedEncoded.j);
  });

  it('221 条行情上不存在 Infinity', () => {
    const r = calculateKDJ(highs, lows, closes);
    for (const series of [r.k, r.d, r.j]) {
      expect(series.some((v) => v === Infinity || v === -Infinity)).toBe(false);
    }
  });

  it('数据不足期恰好前 8 根为 NaN（n=9）', () => {
    const r = calculateKDJ(highs, lows, closes);
    const nanCount = r.k.filter((v) => Number.isNaN(v)).length;
    expect(nanCount).toBe(KDJ_DEFAULT_N - 1);
    expect(golden.expectedEncoded.k.slice(0, KDJ_DEFAULT_N - 1).every((v) => v === null)).toBe(true);
  });

  it('布林带(20, 2) 逐位一致', () => {
    const b = calculateBoll(closes, golden.boll.params.period, golden.boll.params.stdDev);
    expectBitwise(b.upper, golden.boll.upper);
    expectBitwise(b.middle, golden.boll.middle);
    expectBitwise(b.lower, golden.boll.lower);
    expectBitwise(b.pb, golden.boll.pb);
    expectBitwise(b.width, golden.boll.width);
  });
});

describe('KDJ · core 与 frontend 逐位一致（零容差）', () => {
  it('两份源文件字节一致 —— 改一份必须同步另一份', () => {
    for (const name of ['kdj.ts', 'bollinger.ts']) {
      const coreSrc = readFileSync(path.join(REPO_ROOT, 'packages/core/src/indicators', name), 'utf8');
      const feSrc = readFileSync(path.join(REPO_ROOT, 'apps/frontend/src/indicators', name), 'utf8');
      expect(feSrc, `${name} 两份实现已漂移`).toBe(coreSrc);
    }
  });

  it('221 条真实行情 K/D/J 逐位相等', () => {
    const core = calculateKDJ(highs, lows, closes);
    const fe = calculateKDJFrontend(highs, lows, closes);
    for (let i = 0; i < 221; i++) {
      if (Number.isNaN(core.k[i])) {
        expect(Number.isNaN(fe.k[i])).toBe(true);
      } else {
        expect(fe.k[i]).toBe(core.k[i]);
        expect(fe.d[i]).toBe(core.d[i]);
        expect(fe.j[i]).toBe(core.j[i]);
      }
    }
  });

  it('横盘除零序列上 K/D/J 逐位相等', () => {
    const len = 50;
    const h = new Array<number>(len).fill(9);
    const l = new Array<number>(len).fill(9);
    const c = new Array<number>(len).fill(9);
    expect(calculateKDJFrontend(h, l, c)).toEqual(calculateKDJ(h, l, c));
  });

  it('非默认 (n,m1,m2) 下两份仍逐位相等', () => {
    const core = calculateKDJ(highs, lows, closes, 14, 5, 3);
    const fe = calculateKDJFrontend(highs, lows, closes, 14, 5, 3);
    expect(fe.k).toEqual(core.k);
    expect(fe.d).toEqual(core.d);
    expect(fe.j).toEqual(core.j);
  });

  it('布林带 core 与 frontend 逐位相等', () => {
    expect(calculateBollFrontend(closes, 20, 2)).toEqual(calculateBoll(closes, 20, 2));
  });

  it('两份实现导出的默认参数常量一致', () => {
    // 通过实际行为反证：frontend 副本使用同一组默认参数
    const a = calculateKDJ(highs, lows, closes);
    const b = calculateKDJFrontend(highs, lows, closes);
    expect(b.k.length).toBe(a.k.length);
    const explicit = calculateKDJFrontend(highs, lows, closes, KDJ_DEFAULT_N, KDJ_DEFAULT_M1, KDJ_DEFAULT_M2);
    expect(explicit.k).toEqual(b.k);
  });
});
