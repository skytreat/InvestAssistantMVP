/**
 * signal-replay-no-lookahead.test.ts —— F 域「无前视」验证
 *
 * 验收口径：**回放第 T 天的计算只能用 T 及之前的行情，不能用回放终点日的数据。**
 *
 * 验证方式（三层）：
 *   ① IO 层：`executeAllPlugins({ asOfDate: T })` 的批量取数终点必须是 T（不是今天）；
 *   ② 回落层：插件缓存未命中时的单标的查询，终点同样锁在 T；
 *   ③ 行为层：构造「T 之后暴涨」的行情 —— 即使数据源把未来行一并返回，
 *      引擎也必须丢弃（缓存过滤），两次执行的信号逐字段相同。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { DailyKline } from '@invest/core';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-signal-lookahead-'));
const TEST_DB = path.join(tmpDir, 'lookahead.db');
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import * as marketDataMod from '../../src/services/marketData.js';
import { buildPluginContext, executeAllPlugins, shiftTradeDate } from '../../src/services/pluginEngine.js';

const AS_OF = '2026-10-15';
const SYMBOL = 'sh600000';

function cleanup(): void {
  try {
    const store = (ConfigStore as any)._instance;
    if (store) (store.db as any).close();
  } catch {
    /* ignore */
  }
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TEST_DB + ext);
    } catch {
      /* ignore */
    }
  }
  vi.restoreAllMocks();
}

/** 生成截止 `lastDate`（含）的连续 K 线；`futureDays` 天则接在之后「暴涨」 */
function makeKlines(lastDate: string, count: number, futureDays = 0): DailyKline[] {
  const rows: DailyKline[] = [];
  // 截止日往前推 count 天，递减收盘价（让 RSI 落到超卖区，保证有信号可比对）
  let close = 200;
  for (let i = count - 1; i >= 0; i -= 1) {
    rows.push({
      date: shiftTradeDate(lastDate, -i),
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 1000,
      amount: 1000 * close,
    });
    close -= 0.5;
  }
  // 未来的 5 天：直线暴涨（一旦泄露进计算，RSI/MACD 会明显改变）
  for (let i = 1; i <= futureDays; i += 1) {
    const c = close + i * 30;
    rows.push({
      date: shiftTradeDate(lastDate, i),
      open: c,
      high: c + 0.2,
      low: c - 0.2,
      close: c,
      volume: 1000,
      amount: 1000 * c,
    });
  }
  return rows;
}

beforeEach(() => {
  cleanup();
  ConfigStore.getInstance();
});
afterEach(cleanup);

describe('无前视：取数终点锁定在 asOfDate', () => {
  it('① 批量取数终点 = asOfDate（不是今天），窗口起点按其前推 120 天', async () => {
    const spy = vi
      .spyOn(marketDataMod, 'batchGetDailyRange')
      .mockImplementation(async (symbols: string[], start: string, end: string) => {
        expect(end).toBe(AS_OF);
        return new Map(symbols.map((s) => [s, makeKlines(AS_OF, 130)]));
      });

    await executeAllPlugins({ symbols: [SYMBOL], asOfDate: AS_OF, prefetchDays: 120 });

    expect(spy.mock.calls[0][1]).toBe(shiftTradeDate(AS_OF, -120));
    expect(spy.mock.calls[0][2]).toBe(AS_OF);
  });

  it('② 缓存未命中的回落查询同样锁在 asOfDate（请求天数超过窗口才回落）', async () => {
    const spy = vi
      .spyOn(marketDataMod, 'batchGetDailyRange')
      .mockImplementation(async (symbols: string[], _start: string, end: string) => {
        expect(end).toBe(AS_OF);
        return new Map(symbols.map((s) => [s, makeKlines(end, 60)]));
      });

    const ctx = buildPluginContext({ klines: new Map(), windowDays: 0, endDate: AS_OF });
    const rows = await ctx.getDailyKlines(SYMBOL, 60);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBe(AS_OF);
    expect(rows.at(-1)?.date).toBe(AS_OF);
  });

  it('③ 数据源误返回未来行时，缓存也会丢弃它们（RSI 不改判）', async () => {
    // 场景 A：数据源「作弊」把 T 之后的暴涨也返回
    vi.spyOn(marketDataMod, 'batchGetDailyRange').mockImplementation(
      async (symbols: string[], _start: string, _end: string) =>
        new Map(symbols.map((s) => [s, makeKlines(AS_OF, 130, 5)])),
    );
    const leaked = await executeAllPlugins({ symbols: [SYMBOL], asOfDate: AS_OF, prefetchDays: 120 });

    // 场景 B：数据源只返回 T 及之前
    vi.spyOn(marketDataMod, 'batchGetDailyRange').mockImplementation(
      async (symbols: string[], _start: string, _end: string) =>
        new Map(symbols.map((s) => [s, makeKlines(AS_OF, 130, 0)])),
    );
    const clean = await executeAllPlugins({ symbols: [SYMBOL], asOfDate: AS_OF, prefetchDays: 120 });

    // 有信号才有区分力（断言不为空，否则「都没信号」也能假通过）
    expect(clean.signals.length).toBeGreaterThan(0);
    // timestamp 是执行时刻（必然不同），其余字段必须逐字段一致
    const strip = (rows: typeof clean.signals) => rows.map(({ timestamp: _ts, ...rest }: any) => rest);
    expect(strip(leaked.signals)).toEqual(strip(clean.signals));
    expect(leaked.stats).toEqual(clean.stats);
  });

  it('④ 日常链路（不传 asOfDate）仍以今天为终点，行为不变', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const spy = vi
      .spyOn(marketDataMod, 'batchGetDailyRange')
      .mockImplementation(async (symbols: string[], _start: string, end: string) => {
        expect(end).toBe(today);
        return new Map(symbols.map((s) => [s, makeKlines(end, 130)]));
      });

    const ctx = buildPluginContext({ klines: new Map(), windowDays: 0 });
    await ctx.getDailyKlines(SYMBOL, 60);
    expect(spy.mock.calls[0][2]).toBe(today);
  });
});
