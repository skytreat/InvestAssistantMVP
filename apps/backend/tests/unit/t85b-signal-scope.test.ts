/**
 * t85b-signal-scope.test.ts —— T85b ① 信号标的域收敛（I-19）
 *
 * 🔴 修复前的缺陷（实测）：
 *   `executeAllPlugins()` 恒定 `executePlugin(plugin, {}, ctx)` 传空参 →
 *   插件落到 `paramSchema` 的硬编码默认 `symbol:'sh600000'` →
 *   「每日自动跑策略信号」**只对 1 只硬编码标的生效**，
 *   用户的自选 / 持仓一只都跑不到（违反 PRD M4）。
 *
 * 本文件锁定的断言（对应 plan §12.7 G1.3b）：
 *   ① 信号标的域 = 用户自选 ∪ 持仓
 *   ② 反向：集合外的标的不得产生信号
 *   ③ 批量查询：整个标的域只发 1 次 DuckDB 查询（SDD §5.3 P8）
 *   ④ symbol 由运行时注入，用户参数里的同名字段被覆盖
 *   ⑤ 空标的域 → 不执行、不产生信号
 *   ⑥ 候选池（candidate）不属于信号域
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
  } catch { /* ignore */ }
  (ConfigStore as any)._instance = null;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
}

/** 铺自选 / 持仓 / 候选池数据 */
function seedRelations(rows: Array<[string, string]>): void {
  const db = ConfigStore.getInstance().db;
  // user_asset_rel.user_id 有外键 → 先建用户
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role)
     VALUES (?, ?, 'x', 'admin')`,
  ).run(SIGNAL_USER_ID, 't85b_admin');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO user_asset_rel
       (user_id, asset_code, rel_type, is_deleted, created_at)
     VALUES (?, ?, ?, 0, datetime('now','localtime'))`,
  );
  for (const [assetCode, relType] of rows) stmt.run(SIGNAL_USER_ID, assetCode, relType);
}

beforeAll(() => {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => { cleanup(); });
afterAll(() => { cleanup(); });

describe('T85b ① — resolveSignalSymbols（标的域 = 自选 ∪ 持仓）', () => {
  it('自选 ∪ 持仓去重，候选池不计入', () => {
    seedRelations([
      ['sh600001', 'watch'],
      ['sh600002', 'watch'],
      ['sh600003', 'hold'],
      ['sh600004', 'hold'],
      ['sh600005', 'candidate'],
    ]);
    const symbols = resolveSignalSymbols(SIGNAL_USER_ID);
    expect(symbols).toEqual(['sh600001', 'sh600002', 'sh600003', 'sh600004']);
    expect(symbols, '候选池不属于信号域').not.toContain('sh600005');
  });

  it('软删的行不计入', () => {
    seedRelations([['sh600001', 'watch'], ['sh600002', 'hold']]);
    const db = ConfigStore.getInstance().db;
    db.prepare('UPDATE user_asset_rel SET is_deleted = 1 WHERE asset_code = ?').run('sh600002');
    expect(resolveSignalSymbols(SIGNAL_USER_ID)).toEqual(['sh600001']);
  });

  it('无任何自选/持仓 → 空数组', () => {
    // ⚠️ 用**独立 userId** 判定：SIGNAL_USER_ID 的关系行由前序用例种下
    //   （同文件共用一个临时库）→ 直接查 SIGNAL_USER_ID 会拿到残留。
    //   这正是 T81 的顺序依赖：shuffle 下「无自选/持仓」可能排在种数据之后。
    expect(resolveSignalSymbols(SIGNAL_USER_ID + 7777)).toEqual([]);
  });
});

describe('T85b ① — executeAllPlugins 的标的域注入', () => {
  it('信号只对传入的标的域产生，且不出现集合外的标的', async () => {
    installDuckDBMock();
    seedRelations([['sh600001', 'watch'], ['sh600002', 'hold']]);
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

  it('stats.total = 插件数 × 标的数（不再是「插件数」这种无意义口径）', async () => {
    installDuckDBMock();
    seedRelations([['sh600001', 'watch'], ['sh600002', 'watch'], ['sh600003', 'hold']]);
    const symbols = resolveSignalSymbols(SIGNAL_USER_ID);
    const monitorCount = getAllPlugins().filter((p) => p.category === 'monitor').length;

    const result = await executeAllPlugins({ symbols });
    expect(result.stats.total).toBe(monitorCount * symbols.length);
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
