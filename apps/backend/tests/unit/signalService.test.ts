/**
 * signalService.test.ts — Phase 3 SDD §12.3 单元测试
 *
 * 覆盖 src/services/signalService.ts：
 *   persistSignals / persistBatchSignals / getTradeDate
 *
 * 依赖 ConfigStore 单例，测试前用临时 SQLite 文件，测试后删除
 *
 * 注意：user_strategy_signal 有 FOREIGN KEY (user_id) REFERENCES user_account(id)
 *       必须先往 user_account 插对应 user_id
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- 关键：在 import src 之前设置 SQLITE_DB_PATH ---
// T81：顶层写 env 必须留原值并在 afterAll 还原，否则会漏给下一个测试文件
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-signal-test-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import {
  persistSignals,
  persistBatchSignals,
  getTradeDate,
} from '../../src/services/signalService.js';
import type { PluginSignal } from '../../src/services/pluginEngine.js';

const TEST_USER_ID = 1;

let db: ReturnType<typeof ConfigStore.getInstance>;

beforeAll(() => {
  db = ConfigStore.getInstance();
  // 创建测试用户（满足 FOREIGN KEY 约束）
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`
  ).run(TEST_USER_ID, 'signal_test_user', 'dummy-hash');
});

afterAll(() => {
  try {
    (db.db as any).close();
  } catch {
    // ignore
  }
  for (const f of [tmpDbPath, tmpDbPath + '-wal', tmpDbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

// --- 辅助：构造 PluginSignal（含 label，signalService 会访问 s.label ?? s.signalType） ---
function makeSignal(symbol: string, signalType: PluginSignal['signalType']): PluginSignal & { label?: string } {
  return {
    symbol,
    signalType,
    pluginId: 'test_plugin',
    timestamp: new Date().toISOString(),
    params: {},
    label: `${signalType}_${symbol}`,
  };
}

describe('signalService — persistSignals 正常持久化', () => {
  it('UNIQUE(user_id, asset_code, plugin_id, trade_date) 生效', () => {
    const signals = [makeSignal('sh600000', 'BUY')];
    const tradeDate = '2026-10-15';
    const result = persistSignals(signals as PluginSignal[], 'test_plugin', 'monitor', tradeDate, TEST_USER_ID);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    // 确认 DB 里有新行
    const row = db.db
      .prepare('SELECT * FROM user_strategy_signal WHERE asset_code = ? AND trade_date = ?')
      .get('sh600000', tradeDate);
    expect(row).toBeDefined();
    expect((row as any).direction).toBe('buy');
  });
});

describe('signalService — persistSignals 幂等', () => {
  it('连续两次同样的信号 → 第二次 changes=0（skipped++）', () => {
    const signals = [makeSignal('sh600036', 'SELL')];
    const tradeDate = '2026-10-16';

    const first = persistSignals(signals as PluginSignal[], 'idem_plugin', 'monitor', tradeDate, TEST_USER_ID);
    expect(first.inserted).toBe(1);
    expect(first.skipped).toBe(0);

    // 相同 key 再插入一次 → ON CONFLICT DO NOTHING → skipped
    const second = persistSignals(signals as PluginSignal[], 'idem_plugin', 'monitor', tradeDate, TEST_USER_ID);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

describe('signalService — persistSignals 空信号', () => {
  it('signals=[] → inserted=0, skipped=0', () => {
    const result = persistSignals([], 'empty_plugin', 'monitor', '2026-10-17', TEST_USER_ID);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe('signalService — persistBatchSignals 正常', () => {
  it('批量持久化多个 plugin 的信号', () => {
    const batch = [
      { pluginId: 'rsi_plugin', pluginCategory: 'monitor' as const, signals: [makeSignal('sz000001', 'BUY')] as PluginSignal[] },
      { pluginId: 'macd_plugin', pluginCategory: 'monitor' as const, signals: [makeSignal('sh601318', 'SELL')] as PluginSignal[] },
    ];
    const result = persistBatchSignals(batch, '2026-10-18', TEST_USER_ID);
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);

    // 再插一次 → 全部 skipped
    const result2 = persistBatchSignals(batch, '2026-10-18', TEST_USER_ID);
    expect(result2.inserted).toBe(0);
    expect(result2.skipped).toBe(2);
  });
});

describe('signalService — getTradeDate', () => {
  it('返回 UTC+8 YYYY-MM-DD 格式', () => {
    const dateStr = getTradeDate();
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 验证是有效的日期
    const d = new Date(dateStr + 'T00:00:00+08:00');
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('返回的日期等于今日 UTC+8', () => {
    const now = new Date();
    const offset = 8 * 60;
    const local = new Date(now.getTime() + offset * 60 * 1000);
    const expected = local.toISOString().slice(0, 10);
    expect(getTradeDate()).toBe(expected);
  });
});
