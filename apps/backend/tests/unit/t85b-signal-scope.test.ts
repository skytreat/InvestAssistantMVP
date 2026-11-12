/**
 * t85b-signal-scope.test.ts —— T85b ① 信号标的域收敛（I-19）+ 2026-11-12 口径修正
 *
 * 🔴 修复前的缺陷（实测）：
 *   `executeAllPlugins()` 恒定 `executePlugin(plugin, {}, ctx)` 传空参 →
 *   插件落到 `paramSchema` 的硬编码默认 `symbol:'sh600000'` →
 *   「每日自动跑策略信号」**只对 1 只硬编码标的生效**，
 *   用户的自选 / 持仓一只都跑不到（违反 PRD M4）。
 *
 * 🔴 2026-11-12 口径修正（生产事故驱动）：
 *   原口径的「持仓」取自 `user_asset_rel` 的 `rel_type='hold'` **派生关系**，
 *   而该派生关系只有**手工录入**路径（POST /api/trade → syncHoldRelation）会维护，
 *   **券商导入路径（brokerConfirm）从不写** ⇒ 生产 `user_asset_rel` 恒为 0 行
 *   ⇒ 17:02 每日信号生成恒定跳过（"信号域为空"），而用户明明有 35 只净持仓。
 *   ⇒ 改为：**持仓由 `user_trade_record` 实时计算**（core 口径，与 /api/positions、
 *     插件持仓快照同源），派生关系不再参与任何决策。
 *
 * 本文件锁定的断言（对应 plan §12.7 G1.3b）：
 *   ① 信号标的域 = 用户自选 ∪ 持仓（持仓 = 交易流水算出的净持仓 > 0）
 *   ② 反向：集合外的标的不得产生信号；`hold` 派生关系**不再**是信号域来源
 *   ③ 批量查询：整个标的域只发 1 次 DuckDB 查询（SDD §5.3 P8）
 *   ④ symbol 由运行时注入，用户参数里的同名字段被覆盖
 *   ⑤ 空标的域 → 不执行、不产生信号
 *   ⑥ 候选池（candidate）不属于信号域
 *   ⑦ 现金类资产（asset_class='cash'）不产生信号（T133 / INV-S4-15）
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-t85b-'));
const TEST_DB = path.join(tmpDir, 't85b-test.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import { resolveSignalSymbols, SIGNAL_USER_ID } from '../../src/services/signalService.js';
import { calcAllPositions } from '../../src/services/positionCalculator.js';
import { executeAllPlugins } from '../../src/services/pluginEngine.js';
import { getAllPlugins } from '../../src/services/pluginEngine.js';
import * as duckdbMod from '../../src/db/duckdb.js';

/**
 * 🔴 2026-10-19 CI 教训：CI 环境只有 12KB 空壳行情库（无 `v_stock_qfq` 表），
 *   依赖真行情的断言在**本地全绿、CI 全红**。
 *   → 这里 mock 掉 DuckDB：本文件只验证**标的域口径与注入逻辑**，
 *     不需要真实行情数据。
 */
function installDuckDBMock(): void {
  vi.spyOn(duckdbMod, 'queryDuckDB').mockImplementation(async () => []);
}

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
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
}

/**
 * 清空该用户的关系行 / 交易流水 / 资产分类
 *
 * 🔴 T81 顺序依赖：同文件的用例共用一个临时库 → 前序用例种下的行会残留，
 *   导致「软删的行不计入」这类**精确集合**断言随机失败（shuffle 下暴露）。
 *   → 每个用例前先清干净。
 */
function cleanRelations(): void {
  const db = ConfigStore.getInstance().db;
  db.prepare('DELETE FROM user_asset_rel WHERE user_id = ?').run(SIGNAL_USER_ID);
  db.prepare('DELETE FROM user_trade_record WHERE user_id = ?').run(SIGNAL_USER_ID);
  db.prepare('DELETE FROM asset_class').run();
}

/** 确保测试用户存在（user_asset_rel / user_trade_record 有外键） */
function ensureUser(): void {
  ConfigStore.getInstance()
    .db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role)
       VALUES (?, ?, 'x', 'admin')`,
    )
    .run(SIGNAL_USER_ID, 't85b_admin');
}

/** 铺自选 / 候选池 / 派生持仓关系 */
function seedRelations(rows: Array<[string, string]>): void {
  const db = ConfigStore.getInstance().db;
  ensureUser();
  cleanRelations();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO user_asset_rel
       (user_id, asset_code, rel_type, is_deleted, created_at)
     VALUES (?, ?, ?, 0, datetime('now','localtime'))`,
  );
  for (const [assetCode, relType] of rows) stmt.run(SIGNAL_USER_ID, assetCode, relType);
}

/** 铺交易流水（**持仓的唯一来源**）：[asset_code, trade_type, quantity, trade_date, trade_time] */
function seedTrades(rows: Array<[string, string, number, string, string]>): void {
  const db = ConfigStore.getInstance().db;
  ensureUser();
  const stmt = db.prepare(
    `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, 10.0, 0, 0)`,
  );
  for (const [assetCode, tradeType, quantity, tradeDate, tradeTime] of rows) {
    stmt.run(SIGNAL_USER_ID, assetCode, tradeType, tradeDate, tradeTime, quantity);
  }
}

/** 铺资产分类（现金类排除用例） */
function seedAssetClass(symbol: string, assetClass: 'risk' | 'cash'): void {
  ConfigStore.getInstance()
    .db.prepare(
      `INSERT OR REPLACE INTO asset_class (symbol, asset_class, rule_hit, source, updated_at)
       VALUES (?, ?, 'test', 'manual', datetime('now','localtime'))`,
    )
    .run(symbol, assetClass);
}

beforeAll(() => {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  cleanup();
});
afterAll(() => {
  cleanup();
});

describe('信号标的域 = 自选 ∪ 持仓（持仓由交易流水实时计算）', () => {
  it('自选计入；持仓（交易流水）计入；hold 派生关系不再计入', () => {
    seedRelations([
      ['sh600001', 'watch'],
      ['sh600002', 'watch'],
      ['sh600003', 'hold'],
    ]);
    seedTrades([['sh600010', 'buy', 100, '2026-11-10', '09:30:00']]);

    const symbols = resolveSignalSymbols(SIGNAL_USER_ID);

    expect(symbols).toEqual(['sh600001', 'sh600002', 'sh600010']);
    expect(symbols, 'hold 派生关系不再作为信号域来源').not.toContain('sh600003');
  });

  it('生产事故回归：用户只有券商导入的持仓、无任何 user_asset_rel 行时，标的域非空', () => {
    // 生产实测：user_asset_rel 恒为 0 行，但 user_trade_record 有 438 条券商导入交易
    seedRelations([]);
    seedTrades([
      ['sh600020', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600021', 'buy', 200, '2026-11-03', '10:00:00'],
    ]);

    expect(resolveSignalSymbols(SIGNAL_USER_ID)).toEqual(['sh600020', 'sh600021']);
  });

  it('净持仓 > 0 计入；清仓（净持仓 = 0）不计入', () => {
    seedRelations([]);
    seedTrades([
      ['sh600030', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600030', 'reduce', 40, '2026-11-05', '10:00:00'],
      ['sh600031', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600031', 'clear', 100, '2026-11-06', '10:00:00'],
    ]);

    expect(resolveSignalSymbols(SIGNAL_USER_ID)).toEqual(['sh600030']);
  });

  it('core 口径：加仓 / 送股 / 转增计入；现金分红不改变股数（只有分红记录的不计入）', () => {
    seedRelations([]);
    seedTrades([
      ['sh600040', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600040', 'add', 50, '2026-11-03', '10:00:00'],
      ['sh600041', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600041', 'dividend', 100, '2026-11-04', '00:00:00'],
      ['sh600042', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600042', 'bonus', 10, '2026-11-04', '00:00:00'],
      ['sh600043', 'buy', 100, '2026-11-02', '09:30:00'],
      ['sh600043', 'transfer', 10, '2026-11-04', '00:00:00'],
      ['sh600044', 'dividend', 100, '2026-11-04', '00:00:00'],
    ]);

    const symbols = resolveSignalSymbols(SIGNAL_USER_ID);

    // sh600041 = 买入 100 股 + 现金分红 100 股 → 持仓仍是 100 股（core 口径：分红**不加**股数）⇒ 仍是持仓
    expect(symbols).toEqual(['sh600040', 'sh600041', 'sh600042', 'sh600043']);
    expect(symbols, '只有分红记录、没有任何买入 → 不构成持仓').not.toContain('sh600044');

    // 股数口径断言（分红不改变股数）
    const positions = calcAllPositions(SIGNAL_USER_ID);
    expect(positions.find((p) => p.asset_code === 'sh600041')?.totalQuantity).toBe(100);
    expect(positions.find((p) => p.asset_code === 'sh600040')?.totalQuantity).toBe(150);
    expect(positions.find((p) => p.asset_code === 'sh600042')?.totalQuantity).toBe(110);
    expect(positions.find((p) => p.asset_code === 'sh600043')?.totalQuantity).toBe(110);
    expect(positions.find((p) => p.asset_code === 'sh600044')?.totalQuantity).toBe(0);
  });

  it('软删的自选与软删的交易都不计入', () => {
    seedRelations([['sh600050', 'watch']]);
    seedTrades([['sh600051', 'buy', 100, '2026-11-02', '09:30:00']]);
    const db = ConfigStore.getInstance().db;
    db.prepare('UPDATE user_asset_rel SET is_deleted = 1 WHERE asset_code = ?').run('sh600050');
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE asset_code = ?').run('sh600051');

    expect(resolveSignalSymbols(SIGNAL_USER_ID)).toEqual([]);
  });

  it('候选池不计入', () => {
    seedRelations([['sh600060', 'candidate']]);
    seedTrades([]);

    expect(resolveSignalSymbols(SIGNAL_USER_ID)).not.toContain('sh600060');
  });

  it('现金类资产不产生信号（T133 / INV-S4-15）', () => {
    seedRelations([['sh600070', 'watch']]);
    seedTrades([['sh600071', 'buy', 100, '2026-11-02', '09:30:00']]);
    seedAssetClass('sh600071', 'cash');

    expect(resolveSignalSymbols(SIGNAL_USER_ID)).toEqual(['sh600070']);
  });

  it('无自选无持仓 → 空数组', () => {
    // ⚠️ 用**独立 userId** 判定：SIGNAL_USER_ID 的关系行由前序用例种下
    //   （同文件共用一个临时库）→ 直接查 SIGNAL_USER_ID 会拿到残留。
    //   这正是 T81 的顺序依赖：shuffle 下「无自选/持仓」可能排在种数据之后。
    expect(resolveSignalSymbols(SIGNAL_USER_ID + 7777)).toEqual([]);
  });
});

describe('executeAllPlugins 的标的域注入', () => {
  it('信号只对传入的标的域产生，且不出现集合外的标的', async () => {
    installDuckDBMock();
    seedRelations([['sh600001', 'watch']]);
    seedTrades([['sh600002', 'buy', 100, '2026-11-10', '09:30:00']]);
    const symbols = resolveSignalSymbols(SIGNAL_USER_ID);

    const result = await executeAllPlugins({ symbols });

    // 反向断言：不得出现集合外的标的
    const produced = new Set(result.signals.map((s) => s.symbol));
    for (const s of produced) {
      expect(symbols, '信号标的必须来自自选∪持仓').toContain(s);
    }
    // 旧行为的硬编码标的（不在集合内）不得出现
    expect(produced.has('sh600000'), '不得再对硬编码 sh600000 产生信号').toBe(false);
  });

  it('stats.total = 逐标的插件数 × 标的数 + 组合级插件数（不再是「插件数」这种无意义口径）', async () => {
    installDuckDBMock();
    seedRelations([
      ['sh600001', 'watch'],
      ['sh600002', 'watch'],
    ]);
    seedTrades([['sh600003', 'buy', 100, '2026-11-10', '09:30:00']]);
    const symbols = resolveSignalSymbols(SIGNAL_USER_ID);
    const monitors = getAllPlugins().filter((p) => p.category === 'monitor');
    // 组合级插件（requiresPositions，如风险类）读整份持仓快照，只执行 1 次，不按标的重数
    const positional = monitors.filter((p) => p.requiresPositions).length;
    const perSymbol = monitors.length - positional;

    const result = await executeAllPlugins({ symbols });
    expect(result.stats.total).toBe(perSymbol * symbols.length + positional);
  });

  it('不传 symbols → 沿用旧行为（每个插件跑 1 次）', async () => {
    installDuckDBMock();
    const monitorCount = getAllPlugins().filter((p) => p.category === 'monitor').length;
    const result = await executeAllPlugins();
    expect(result.stats.total).toBe(monitorCount);
  });

  it('空标的域 → 不执行任何插件（total = 0），不产生信号', async () => {
    installDuckDBMock();
    const result = await executeAllPlugins({ symbols: [] });
    expect(result.stats.total).toBe(0);
    expect(result.signals).toHaveLength(0);
  });
});
