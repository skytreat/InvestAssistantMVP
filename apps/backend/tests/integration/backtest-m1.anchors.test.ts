/**
 * M1 锚点 —— **真库规模断言（手动跑）**
 *
 * 逐条对应 `docs/audit/proposal-strategy-backtest-framework.md` §10 的 M1 验收锚点 1：
 *   T=2026-10-12 流动性阈值 ≈ 2172.6 万/日、全市场通过 673、固定池 112/114、动态池 140 组、固定池命中 115/115
 *
 * 🔒 这些数字是**全市场规模**断言 —— 迷你库只有 104 只 stock / 41 只 ETF，撑不起
 *   「673 只通过」「140 组动态池」这类数量门槛 ⇒ **必须真库**。
 *   故本文件只在 `vitest.anchors.config.ts` 下运行（`npm run test:anchors -w @invest/backend`），
 *   日常 `npm test` 已在主配置里排除 `*.anchors.test.ts`。
 *
 * ⚠️ **不用 `it.skipIf` 守卫**：`tests/anchors.setup.ts` 会在开跑前校验档位必须为 `full`
 *   且真库探测可用，否则直接抛错。若守卫仍用 skip，环境没配对时会得到「0 失败」的假绿。
 *
 * ⚠️ 实测口径提醒（2026-11-06）：流动性窗口是 **截至 asOf 含当天** 的 3 个交易日
 *   （v5.2 的 `previous_date` 是运行时口径；回测引擎在 T 开盘前决策须传 `asOf = T-1`）。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { UniverseSnapshot } from '../../src/services/backtest/universe/pointInTime.js';

type UniverseModule = typeof import('../../src/services/backtest/universe/pointInTime.js');

let universe: UniverseModule;

beforeAll(async () => {
  universe = await import('../../src/services/backtest/universe/pointInTime.js');
});

/* ─────────────────────────── 1. 数字锚点（T=2026-10-12） ─────────────────────────── */

describe('M1 锚点 · 时点名录（T=2026-10-12）', () => {
  let snap: UniverseSnapshot;

  beforeAll(async () => {
    snap = await universe.resolveUniverseAt('2026-10-12');
  }, 120_000);

  it('流动性阈值 ≈ 2172.6 万/日（近 3 日全市场 ETF 总额 / 20000）', () => {
    expect(snap.liquidity.fallback).toBe(false);
    expect(snap.liquidityDates).toEqual(['2026-10-08', '2026-10-09', '2026-10-12']);
    // 实测总额 4345.24 亿 → 2172.62 万
    expect(snap.liquidity.threshold / 1e4).toBeCloseTo(2172.6, 0);
    expect(snap.liquidity.avgTotal / 1e8).toBeCloseTo(4345.24, 1);
  });

  it('全市场通过流动性阈值 673 只', () => {
    expect(snap.marketLiquidityPassCount).toBe(673);
    // Universe(T) 同日有 bar 的 ETF（实测 2100），与「通过 673」是两个不同口径
    //
    // 🔒 **数据漂移告警点（严格相等，不许改成区间/加大容忍度）**
    //   核实记录（2026-11-07，只读查询真库 `data/quotes.duckdb`）：
    //     - 库文件 1,243,361,280 字节，mtime 2026-11-06（tdx2db 补行情后）
    //     - `raw_kline_daily` 窗口 1990-12-19 ~ 2026-11-06，共 8824 个交易日
    //     - ETF 元信息 2944 只；2026-10-12 全市场 bar 9716 根
    //     - `SELECT count(*) ... first_bar <= '2026-10-12' AND last_bar >= '2026-10-12'` = 2100
    //   原常量 2074 对应更早的行情快照；补齐后真值变为 2100。
    //   ⚠️ 此断言**故意**用严格相等：它一旦变红就是「行情数据版本变了」的告警。
    //      **必须人工复核**（重跑上面的只读查询、确认新值确实来自数据更新而非代码回归）
    //      后再改这个常量；**禁止**为了变绿改成区间断言或自动跟随数据变化。
    expect(snap.universeCount).toBe(2100);
  });

  it('固定池 112/114（流动性通过数，剔除 sh520830 / sh516190）', () => {
    expect(snap.fixedPoolSize).toBe(114);
    expect(snap.fixed.length).toBe(112);
    const passed = snap.fixed.map((p) => p.symbol);
    expect(passed).not.toContain('sh520830');
    expect(passed).not.toContain('sh516190');
  });

  it('固定池命中 115/115（114 只 + 防御标的 sh511880 全都有数据）', () => {
    expect(snap.fixedCoverageCount).toBe(115);
  });

  it('动态池 140 组（每组取成交额第一）', () => {
    const groups = new Map(snap.dynamic.groups.map((g) => [g.groupKey, g]));
    expect(groups.size).toBe(140);
    expect(snap.dynamic.pool.length).toBe(140);
    expect(snap.dynamic.pool.length).toBeLessThanOrEqual(300);
  });
});
