/**
 * t51-indicators.test.ts — T51「指标库接入 + 适配层 + 黄金数据集」落地断言
 *
 * 与 packages/core 的 golden 回归网分工：
 * - core/tests/adapters.golden.test.ts：221 条真实行情的 RSI / MACD / SMA 逐位回归
 * - 本文件只覆盖**后端侧的落地状态**：依赖精确锁版本、适配层形状契约、柱值 A 股口径
 *
 * ⚠️ 断言逐位相等，不允许容差：
 * - RSI 库侧已做 2 位小数取整，容差会掩盖取整行为的变化
 * - MACD 柱值是 A 股 2×(DIF-DEA)，任何缩放漂移都必须显式暴露
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateRSI,
  calculateMACD,
  calculateSMA,
  RSI_INSUFFICIENT_VALUE,
  A_SHARE_HISTOGRAM_SCALE,
} from '@invest/core';
import { MACD, RSI, SMA } from 'fast-technical-indicators';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(rel: string): PkgJson {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as PkgJson;
}

/** 生成一段有足够波动、长度可控的收盘价（升序时间） */
function makeCloses(n: number, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(base + Math.sin(i / 3) * 5 + i * 0.1);
  }
  return out;
}

describe('T51 落地状态 · fast-technical-indicators 精确锁版本', () => {
  it('core 与 frontend 的 package.json 均为精确 1.1.6（无 ^ / ~）', () => {
    for (const rel of ['packages/core/package.json', 'apps/frontend/package.json']) {
      const pkg = readPkg(rel);
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      const declared = all['fast-technical-indicators'];
      expect(declared, `${rel} 应声明 fast-technical-indicators`).toBe('1.1.6');
      expect(declared.startsWith('^') || declared.startsWith('~'), `${rel} 禁止 ^ / ~`).toBe(false);
    }
  });

  it('node_modules 实际安装版本 = 1.1.6', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'node_modules/fast-technical-indicators/package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('1.1.6');
  });
});

describe('T51 适配层 · 数组补齐（形状契约）', () => {
  it('RSI 返回长度恒等于输入长度', () => {
    const closes = makeCloses(60);
    for (const n of [0, 1, 13, 14, 15, 40, 60]) {
      const slice = closes.slice(0, n);
      expect(calculateRSI(slice, 14).length).toBe(n);
    }
  });

  it('MACD 三序列长度恒等于输入长度（长度足够时）', () => {
    const closes = makeCloses(60);
    const r = calculateMACD(closes);
    expect(r.dif.length).toBe(closes.length);
    expect(r.dea.length).toBe(closes.length);
    expect(r.macd.length).toBe(closes.length);
  });

  it('SMA 返回长度恒等于输入长度', () => {
    const closes = makeCloses(60);
    for (const p of [5, 10, 20, 60, 100]) {
      expect(calculateSMA(closes, p).length).toBe(closes.length);
    }
  });

  it('RSI 数据不足期填 50（保持既有对外契约，不是 NaN / undefined）', () => {
    const rsi = calculateRSI([100, 101, 102], 14);
    expect(rsi).toEqual([RSI_INSUFFICIENT_VALUE, RSI_INSUFFICIENT_VALUE, RSI_INSUFFICIENT_VALUE]);
    expect(rsi.some((v) => Number.isNaN(v))).toBe(false);
  });
});

describe('T51 适配层 · A 股柱值 = 2 × (DIF - DEA)', () => {
  it('柱值严格等于 2 × (DIF - DEA)，而非美式 1 ×', () => {
    expect(A_SHARE_HISTOGRAM_SCALE).toBe(2);
    const closes = makeCloses(80);
    const r = calculateMACD(closes);
    for (let i = 0; i < r.macd.length; i++) {
      if (Number.isNaN(r.dea[i])) continue;
      expect(r.macd[i]).toBe(2 * (r.dif[i] - r.dea[i]));
    }
  });

  it('适配层只做 padding + ×2，不改动库的 DIF / signal 原值', () => {
    const closes = makeCloses(60);
    const lib = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const r = calculateMACD(closes);

    const pad = closes.length - lib.length;
    expect(pad).toBeGreaterThan(0);
    for (let i = 0; i < lib.length; i++) {
      const idx = pad + i;
      expect(r.dif[idx]).toBe(lib[i].MACD);
      if (lib[i].signal === undefined) {
        expect(Number.isNaN(r.dea[idx])).toBe(true);
      } else {
        expect(r.dea[idx]).toBe(lib[i].signal);
      }
      if (lib[i].histogram === undefined) {
        expect(Number.isNaN(r.macd[idx])).toBe(true);
      } else {
        expect(r.macd[idx]).toBe((lib[i].histogram as number) * A_SHARE_HISTOGRAM_SCALE);
      }
    }
    // 头部播种期为 NaN，不是 0
    expect(Number.isNaN(r.dif[0])).toBe(true);
    expect(Number.isNaN(r.macd[0])).toBe(true);
  });

  it('库原样 histogram === DIF - signal（证明 ×2 是适配层引入，不是库口径）', () => {
    const closes = makeCloses(60);
    const lib = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const withSignal = lib.filter((x) => x.signal !== undefined && x.histogram !== undefined);
    expect(withSignal.length).toBeGreaterThan(0);
    for (const x of withSignal) {
      expect(x.histogram).toBe((x.MACD as number) - (x.signal as number));
    }
  });
});

describe('T51 · 适配层与库直接调用的等价性（跨口径）', () => {
  it('RSI：适配层补齐后 == 库原始短数组（逐位）', () => {
    const closes = makeCloses(60);
    const lib = RSI.calculate({ values: closes, period: 14 });
    const adapted = calculateRSI(closes, 14);
    const pad = closes.length - lib.length;
    for (let i = 0; i < lib.length; i++) {
      expect(adapted[pad + i]).toBe(lib[i]);
    }
    for (let i = 0; i < pad; i++) {
      expect(adapted[i]).toBe(RSI_INSUFFICIENT_VALUE);
    }
  });

  it('SMA：适配层补齐后 == 库原始短数组（逐位）', () => {
    const closes = makeCloses(60);
    const lib = SMA.calculate({ period: 5, values: closes });
    const adapted = calculateSMA(closes, 5);
    const pad = closes.length - lib.length;
    for (let i = 0; i < lib.length; i++) {
      expect(adapted[pad + i]).toBe(lib[i]);
    }
    for (let i = 0; i < pad; i++) {
      expect(Number.isNaN(adapted[i])).toBe(true);
    }
  });
});
