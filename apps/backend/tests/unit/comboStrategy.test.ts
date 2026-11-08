/**
 * T133 / PA-06 —— 组合策略引擎接入
 *
 * 覆盖：
 * - AND + min 合成（同向成立 / 混合方向不成立 / 单条件跳过不成立）；
 * - 条件独立开关（停用条件不参与，启用 < 2 ⇒ 不成立）；
 * - 失败隔离（单个条件抛错只影响该标的，其他标的照常求值）；
 * - 条件白名单（风险类 / 组合级插件不能当条件 ⇒ 组合标 ERROR，不执行）；
 * - 适用品种：`cross_border` 在行情层无分类字段 ⇒ **fail-closed**（不产出信号）；
 * - 引擎接线：`executeAllPlugins` 的 `results` 里出现 `plugin_id = combo:<id>`（普通插件口径不变）。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 组合执行器会写 system_log；单测里改成空实现，避免每个用例都拉 ConfigStore
vi.mock('../../src/services/logger.js', () => ({
  writeSystemLog: () => {},
  withSystemLogBuffer: async <T>(fn: () => Promise<T>) => fn(),
}));

import { ensureComboTables } from '../../src/config/comboSchema.js';
import { ConfigStore } from '../../src/config/configStore.js';
import { createCombo } from '../../src/services/comboRepo.js';
import { executeCombos, resolveComboSymbols, comboPluginId } from '../../src/services/comboStrategy.js';
import { definePlugin, type Plugin, type PluginExecutionResult } from '../../src/services/pluginEngine.js';

function makePlugin(id: string, overrides: Partial<Plugin> = {}): Plugin {
  return definePlugin({
    id,
    name: id,
    version: '1.0.0',
    author: 'test',
    period: 'daily',
    category: 'monitor',
    subCategory: 'momentum',
    complexity: 'simple',
    paramSchema: [{ key: 'symbol', label: '标的', type: 'string', runtimeInjected: true }],
    execute: async () => [],
    ...overrides,
  });
}

const PLUGIN_A = makePlugin('a_plugin');
const PLUGIN_B = makePlugin('b_plugin');
const RISK_PLUGIN = makePlugin('risk_plugin', { subCategory: 'risk', requiresPositions: true });

function exec(
  pluginId: string,
  signalType: 'BUY' | 'SELL' | 'HOLD' | null,
  strength: number | null,
  status: PluginExecutionResult['status'] = 'SUCCESS',
  symbol = 'sh600000',
): PluginExecutionResult {
  return {
    pluginId,
    status,
    durationMs: 1,
    ...(status === 'SKIP' ? { skipReason: 'NO_SIGNAL' as const } : {}),
    signals:
      signalType === null
        ? []
        : [
            {
              symbol,
              signalType,
              strength: strength ?? undefined,
              pluginId,
              timestamp: '2026-11-08T00:00:00.000Z',
            },
          ],
  };
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE user_account (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.prepare(`INSERT INTO user_account (id) VALUES (1)`).run();
  db.exec(`CREATE TABLE asset_class (
    symbol TEXT PRIMARY KEY,
    asset_class TEXT NOT NULL,
    rule_hit TEXT,
    source TEXT,
    updated_by INTEGER,
    updated_at TEXT
  );`);
  ensureComboTables(db);
});

afterEach(() => {
  db.close();
});

function seedCombo(
  conditions: Array<{ pluginId: string; enabled?: boolean }>,
  assetScope: 'all' | 'exclude_cash' | 'cross_border' = 'all',
) {
  return createCombo(db, {
    userId: 1,
    name: '测试组合',
    assetScope,
    conditions: conditions.map((c) => ({ pluginId: c.pluginId, enabled: c.enabled })),
  });
}

describe('PA-06 组合执行器', () => {
  it('同向成立 → 合成 combo:<id> 信号，strength 取最弱一环', async () => {
    const combo = seedCombo([{ pluginId: 'a_plugin' }, { pluginId: 'b_plugin' }]);

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000'],
      plugins: [PLUGIN_A, PLUGIN_B],
      runCondition: async (plugin) =>
        plugin.id === 'a_plugin' ? exec('a_plugin', 'BUY', 0.9) : exec('b_plugin', 'BUY', 0.4),
    });

    expect(outcome.signals).toHaveLength(1);
    const signal = outcome.signals[0];
    expect(signal.pluginId).toBe(comboPluginId(combo.id));
    expect(signal.symbol).toBe('sh600000');
    expect(signal.signalType).toBe('BUY');
    expect(signal.strength).toBe(0.4);
    expect(signal.metrics).toEqual({ strength: 0.4, conditionCount: 2 });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].pluginId).toBe(comboPluginId(combo.id));
    expect(outcome.results[0].status).toBe('SUCCESS');
    expect(outcome.stats).toEqual({ enabled: 1, ran: 1, matchedSignals: 1, failed: 0 });
  });

  it('混合方向 / 单条件跳过 → 不成立，结果记 SKIP(NO_SIGNAL)', async () => {
    const combo = seedCombo([{ pluginId: 'a_plugin' }, { pluginId: 'b_plugin' }]);

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000'],
      plugins: [PLUGIN_A, PLUGIN_B],
      runCondition: async (plugin) =>
        plugin.id === 'a_plugin'
          ? exec('a_plugin', 'BUY', 0.8)
          : exec('b_plugin', 'SELL', 0.8),
    });

    expect(outcome.signals).toHaveLength(0);
    expect(outcome.results[0].status).toBe('SKIP');
    expect(outcome.results[0].skipReason).toBe('NO_SIGNAL');
    expect(outcome.stats.matchedSignals).toBe(0);
    expect(outcome.stats.failed).toBe(0);
  });

  it('停用条件不参与求值：3 条件停 1 个仍按剩余 2 个求值', async () => {
    const combo = seedCombo([
      { pluginId: 'a_plugin' },
      { pluginId: 'b_plugin' },
      { pluginId: 'c_plugin', enabled: false },
    ]);
    const pluginC = makePlugin('c_plugin');
    const called: string[] = [];

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000'],
      plugins: [PLUGIN_A, PLUGIN_B, pluginC],
      runCondition: async (plugin) => {
        called.push(plugin.id);
        return exec(plugin.id, 'BUY', 0.7);
      },
    });

    expect(called).toEqual(['a_plugin', 'b_plugin']);
    expect(outcome.signals).toHaveLength(1);
    expect(outcome.signals[0].strength).toBe(0.7);
    expect(outcome.results[0].pluginId).toBe(comboPluginId(combo.id));
  });

  it('启用条件不足 2 个 → 配置级失败，不执行任何条件', async () => {
    const combo = seedCombo([{ pluginId: 'a_plugin' }, { pluginId: 'b_plugin', enabled: false }]);
    const runCondition = vi.fn(async () => exec('a_plugin', 'BUY', 1));

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000'],
      plugins: [PLUGIN_A, PLUGIN_B],
      runCondition,
    });

    expect(runCondition).not.toHaveBeenCalled();
    expect(outcome.signals).toHaveLength(0);
    expect(outcome.results[0].pluginId).toBe(comboPluginId(combo.id));
    expect(outcome.results[0].status).toBe('SKIP');
    expect(outcome.stats.failed).toBe(1);
  });

  it('风险类插件不能当条件 → 组合标 ERROR，不执行', async () => {
    const combo = seedCombo([{ pluginId: 'a_plugin' }, { pluginId: 'risk_plugin' }]);
    const runCondition = vi.fn(async () => exec('a_plugin', 'BUY', 1));

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000'],
      plugins: [PLUGIN_A, RISK_PLUGIN],
      runCondition,
    });

    expect(runCondition).not.toHaveBeenCalled();
    expect(outcome.results[0].pluginId).toBe(comboPluginId(combo.id));
    expect(outcome.results[0].status).toBe('ERROR');
    expect(outcome.results[0].error).toContain('risk_plugin');
    expect(outcome.stats.failed).toBe(1);
  });

  it('条件抛错只影响该标的，其他标的照常求值（失败隔离）', async () => {
    seedCombo([{ pluginId: 'a_plugin' }, { pluginId: 'b_plugin' }]);

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000', 'sz000001'],
      plugins: [PLUGIN_A, PLUGIN_B],
      runCondition: async (plugin, _params, symbol) => {
        if (plugin.id === 'a_plugin' && symbol === 'sh600000') {
          throw new Error('boom');
        }
        return exec(plugin.id, 'BUY', 0.5, 'SUCCESS', symbol);
      },
    });

    expect(outcome.signals.map((s) => s.symbol)).toEqual(['sz000001']);
  });

  it('适用品种 cross_border 无标维分类 → fail-closed（不产出信号）', async () => {
    const combo = seedCombo([{ pluginId: 'a_plugin' }, { pluginId: 'b_plugin' }], 'cross_border');
    const runCondition = vi.fn(async () => exec('a_plugin', 'BUY', 1));

    const outcome = await executeCombos({
      db,
      userId: 1,
      symbols: ['sh600000'],
      plugins: [PLUGIN_A, PLUGIN_B],
      runCondition,
    });

    expect(runCondition).not.toHaveBeenCalled();
    expect(outcome.signals).toHaveLength(0);
    expect(outcome.results[0].status).toBe('ERROR');
    expect(outcome.results[0].pluginId).toBe(comboPluginId(combo.id));
  });
});

describe('PA-06 适用品种解析', () => {
  it('exclude_cash 按 asset_class 过滤现金类', async () => {
    db.prepare(
      `INSERT INTO asset_class (symbol, asset_class, source) VALUES ('sh600000', 'risk', 'manual'), ('cash_x', 'cash', 'manual')`,
    ).run();

    const resolved = await resolveComboSymbols('exclude_cash', ['sh600000', 'cash_x', 'sz000001'], db);

    expect(resolved).toEqual({ ok: true, symbols: ['sh600000', 'sz000001'] });
  });

  it('all 原样返回去重后的标的域', async () => {
    const resolved = await resolveComboSymbols('all', ['sh600000', 'sh600000', 'sz000001'], db);
    expect(resolved).toEqual({ ok: true, symbols: ['sh600000', 'sz000001'] });
  });
});

// ---------------------------------------------------------------------------
// 引擎接线（executeAllPlugins → results 里出现 combo:<id>）
// ---------------------------------------------------------------------------
describe('PA-06 引擎接线', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-combo-engine-'));
  const TEST_DB = path.join(tmpDir, 'combo-engine.db');
  let originalEnv: string | undefined;

  beforeAll(() => {
    originalEnv = process.env.SQLITE_DB_PATH;
    process.env.SQLITE_DB_PATH = TEST_DB;
  });

  afterEach(() => {
    const store = (ConfigStore as unknown as { _instance: { db: Database.Database } | null })._instance;
    if (store) {
      try {
        store.db.close();
      } catch {
        /* ignore */
      }
    }
    (ConfigStore as unknown as { _instance: unknown })._instance = null;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = originalEnv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('启用组合进入 executeAllPlugins 的 results（普通插件统计口径不变）', async () => {
    const duckdbMod = await import('../../src/db/duckdb.js');
    vi.spyOn(duckdbMod, 'queryDuckDB').mockResolvedValue([] as never);

    const store = ConfigStore.getInstance();
    store.db
      .prepare('INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (1, ?, ?, ?)')
      .run('combo_engine', 'hash', 'admin');
    createCombo(store.db, {
      userId: 1,
      name: '引擎接线组合',
      conditions: [{ pluginId: 'rsi_oversold' }, { pluginId: 'macd_cross' }],
    });

    const { executeAllPlugins, getAllPlugins } = await import('../../src/services/pluginEngine.js');
    const batch = await executeAllPlugins({ userId: 1, symbols: ['sh600000'] });

    const comboResults = batch.results.filter((r) => r.pluginId.startsWith('combo:'));
    expect(comboResults).toHaveLength(1);
    // 行情为空 ⇒ 条件都 SKIP(NO_DATA)，组合不成立
    expect(comboResults[0].status).toBe('SKIP');
    expect(batch.stats.combo).toEqual({ enabled: 1, ran: 1, matchedSignals: 0, failed: 0 });
    // 组合不并入普通插件 total（total 仍按 monitor 插件数统计）
    expect(batch.stats.total).toBe(getAllPlugins().filter((p) => p.category === 'monitor').length);
  });
});
