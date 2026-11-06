/**
 * f-signal-plugin-fixes.test.ts —— F 域插件引擎三项修复
 *
 * P1-2 SKIP 分类：`skipReason` 区分 `NO_DATA`（取不到日线）与 `NO_SIGNAL`（指标未触发），
 *               结果里带 `klines` 根数；批量统计带 `noData`（`skip = noData + noSignal`）。
 * P1-3 用户插件配置：`executeAllPlugins` 读 `user_plugin_config`
 *               （`enabled=0` 过滤、`params_json` 合并，运行时 `symbol` 优先）。
 * P2-5 内置插件 label：`rsi_oversold` / `macd_cross` 产出描述性文字而非恒 BUY / SELL。
 * P3-6 ETF 取数缺口：`getDailyKlines` 回退统一走批量入口（`batchGetDailyRange` 内部按品种选视图），
 *               见 `pluginEngineCoverage.test.ts`（该用例直接断言 spy 的入参）。
 *
 * 测试环境：临时 SQLite 库 + DuckDB mock（CI 的行情库是空壳，真库可能被写入进程独占锁）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { DailyKline } from '@invest/core';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-f-plugin-'));
const TEST_DB = path.join(tmpDir, 'f-plugin.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { SIGNAL_USER_ID } from '../../src/services/signalService.js';
import {
  buildPluginContext,
  builtinPlugins,
  executeAllPlugins,
  executePlugin,
  getAllPlugins,
  type PluginContext,
} from '../../src/services/pluginEngine.js';
import * as duckdbMod from '../../src/db/duckdb.js';

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

/** 全部 DuckDB 查询返回空：模拟「行情库不可用 / 无数据」 */
function installEmptyDuckDBMock(): void {
  vi.spyOn(duckdbMod, 'queryDuckDB').mockResolvedValue([] as never);
}

function db() {
  return ConfigStore.getInstance().db;
}

function seedUser(id: number, username: string): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role)
       VALUES (?, ?, 'dummy-hash', 'admin')`,
    )
    .run(id, username);
}

function seedPluginConfig(pluginId: string, enabled: 0 | 1, params?: Record<string, unknown>): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO user_plugin_config (user_id, plugin_id, enabled, params_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(SIGNAL_USER_ID, pluginId, enabled, params === undefined ? null : JSON.stringify(params));
}

function barsFromCloses(closes: number[]): DailyKline[] {
  return closes.map((close) => ({
    date: '2026-01-01',
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    amount: close * 1000,
  }));
}

/** 用真实算法上下文 + 指定日线派生 stub（避免碰 DuckDB） */
function stubContext(klines: DailyKline[]): PluginContext {
  const base = buildPluginContext();
  return {
    ...base,
    getDailyKlines: async () => klines,
    batchGetDailyKlines: async (symbols: string[]) =>
      new Map<string, DailyKline[]>(symbols.map((s) => [s, klines])),
  };
}

beforeAll(() => {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  cleanup();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('F 域 P1-2 — SKIP 分类（NO_DATA vs NO_SIGNAL）', () => {
  const rsiPlugin = builtinPlugins.find((p) => p.id === 'rsi_oversold')!;

  it('取不到日线 → SKIP + skipReason=NO_DATA + klines=0', async () => {
    const res = await executePlugin(rsiPlugin, { symbol: 'sh600000' }, stubContext(barsFromCloses([])));
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('NO_DATA');
    expect(res.klines).toBe(0);
  });

  it('有 62 根日线但指标未触发 → SKIP + skipReason=NO_SIGNAL + klines=62', async () => {
    const res = await executePlugin(
      rsiPlugin,
      // 阈值放宽到 1/99 ⇒ RSI 无论取值都落在中间地带，稳定产出「无信号」
      { symbol: 'sh600000', oversold: 1, overbought: 99 },
      stubContext(barsFromCloses(Array.from({ length: 62 }, (_, i) => 100 + Math.sin(i)))),
    );
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('NO_SIGNAL');
    expect(res.klines).toBe(62);
  });

  it('产出信号时 klines 同样带出（SUCCESS 不是 SKIP）', async () => {
    const res = await executePlugin(
      rsiPlugin,
      { symbol: 'sh600000' },
      // 单调下跌 ⇒ RSI 触底，超卖买入
      stubContext(barsFromCloses(Array.from({ length: 62 }, (_, i) => 100 - i))),
    );
    expect(res.status).toBe('SUCCESS');
    expect(res.skipReason).toBeUndefined();
    expect(res.klines).toBe(62);
    expect(res.signals).toHaveLength(1);
  });

  it('批量统计 noData 与 skip 可分离（全部无行情 ⇒ skip == noData）', async () => {
    installEmptyDuckDBMock();
    seedUser(SIGNAL_USER_ID, 'f_signal_admin');
    const res = await executeAllPlugins({ symbols: ['sh600000', 'sh600001'] });
    expect(res.stats.skip).toBeGreaterThan(0);
    expect(res.stats.noData).toBe(res.stats.skip);
    expect(res.stats.noData).toBe(res.stats.total);
  });
});

describe('F 域 P1-3 — user_plugin_config 在 executeAllPlugins 内生效', () => {
  it('enabled=0 的插件不执行，也不计入 stats.total', async () => {
    installEmptyDuckDBMock();
    seedUser(SIGNAL_USER_ID, 'f_signal_admin');
    seedPluginConfig('macd_cross', 0, { fast: 12 });

    const monitorCount = getAllPlugins().filter((p) => p.category === 'monitor').length;
    const res = await executeAllPlugins({ symbols: ['sh600000'] });

    expect(res.results.map((r) => r.pluginId)).not.toContain('macd_cross');
    expect(res.stats.total).toBe((monitorCount - 1) * 1);
  });

  it('params_json 合并进执行参数，运行时 symbol 覆盖配置里的 symbol', async () => {
    installEmptyDuckDBMock();
    seedUser(SIGNAL_USER_ID, 'f_signal_admin');
    seedPluginConfig('rsi_oversold', 1, { oversold: 20, symbol: 'sz999999' });

    const rsi = builtinPlugins.find((p) => p.id === 'rsi_oversold')!;
    const spy = vi.spyOn(rsi, 'execute').mockResolvedValue([]);

    await executeAllPlugins({ symbols: ['sh600000'] });

    expect(spy).toHaveBeenCalledTimes(1);
    const passed = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(passed.oversold).toBe(20); // 来自 params_json
    expect(passed.symbol).toBe('sh600000'); // 运行时注入优先
  });

  it('params_json 非法值 → 该插件 ERROR（证明配置确实被读取并参与校验）', async () => {
    installEmptyDuckDBMock();
    seedUser(SIGNAL_USER_ID, 'f_signal_admin');
    seedPluginConfig('rsi_oversold', 1, { oversold: 999 });

    const res = await executeAllPlugins({ symbols: ['sh600000'] });
    const rsiResult = res.results.find((r) => r.pluginId === 'rsi_oversold');
    expect(rsiResult?.status).toBe('ERROR');
    expect(rsiResult?.error ?? '').toContain('999');
  });

  it('无配置记录 → 默认全部启用（total = monitor 插件数 × 标的数）', async () => {
    installEmptyDuckDBMock();
    seedUser(SIGNAL_USER_ID, 'f_signal_admin');

    const monitorCount = getAllPlugins().filter((p) => p.category === 'monitor').length;
    const res = await executeAllPlugins({ symbols: ['sh600000', 'sh600001'] });
    expect(res.stats.total).toBe(monitorCount * 2);
  });
});

describe('F 域 P2-5 — 内置插件产出可读 label', () => {
  it('rsi_oversold 超卖买入：label 说明 RSI 数值与阈值', async () => {
    const rsi = builtinPlugins.find((p) => p.id === 'rsi_oversold')!;
    const res = await executePlugin(
      rsi,
      { symbol: 'sh600000' },
      stubContext(barsFromCloses(Array.from({ length: 62 }, (_, i) => 100 - i))),
    );
    const label = res.signals[0]?.label ?? '';
    expect(label).toContain('超卖');
    expect(label).toContain('RSI');
  });

  it('macd_cross 金叉：label 为描述性文字而不是裸 BUY', async () => {
    const macd = builtinPlugins.find((p) => p.id === 'macd_cross')!;
    // 40 根横盘 → 10 根下跌 → 2 根急拉：末两日 DIF 上穿 DEA（已离线验证）
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100);
    for (let i = 1; i <= 10; i++) closes.push(100 - i * 0.5);
    const bottom = closes[closes.length - 1];
    closes.push(bottom + 3, bottom + 6);

    const res = await executePlugin(macd, { symbol: 'sh600000' }, stubContext(barsFromCloses(closes)));
    expect(res.status).toBe('SUCCESS');
    expect(res.signals[0]?.signalType).toBe('BUY');
    expect(res.signals[0]?.label).toBe('MACD 金叉（DIF 上穿 DEA）');
  });
});
