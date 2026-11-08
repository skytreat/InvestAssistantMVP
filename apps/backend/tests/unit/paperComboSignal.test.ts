/**
 * T133 / PA-09 —— 组合策略登记进纸面账户 + DB 信号源
 *
 * 覆盖：`resolvePaperStrategy` / `listPaperStrategies` 登记；DB 源「只取最新一天 + 无前视」；
 * `loadComboSignalSymbols` 装载区间标的。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigStore } from '../../src/config/configStore.js';
import { SIGNAL_USER_ID } from '../../src/services/signalService.js';
import { dbComboSignalSource, loadComboSignalSymbols } from '../../src/services/paper/comboSignalSource.js';
import { listPaperStrategies, resolvePaperStrategy } from '../../src/services/paper/strategies.js';
import { PaperError } from '../../src/services/paper/errors.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-paper-combo-'));
const TEST_DB = path.join(tmpDir, 'paper-combo.db');
let originalEnv: string | undefined;

beforeAll(() => {
  originalEnv = process.env.SQLITE_DB_PATH;
  process.env.SQLITE_DB_PATH = TEST_DB;
});

// 同一文件内共享一个 ConfigStore 单例；每个用例前清空信号表，避免顺序（shuffle）污染
beforeEach(() => {
  try {
    const db = ConfigStore.getInstance().db;
    db.prepare(
      "INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (1, 'system', 'hash', 'admin')",
    ).run();
    db.prepare('DELETE FROM user_strategy_signal').run();
  } catch {
    /* 首次建库前表已由 DDL 建立；失败不阻塞用例 */
  }
});

afterAll(() => {
  const store = (ConfigStore as unknown as { _instance: { db: { close: () => void } } | null })._instance;
  if (store) {
    try {
      store.db.close();
    } catch {
      /* ignore */
    }
  }
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  vi.restoreAllMocks();
  if (originalEnv === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = originalEnv;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedSignal(params: {
  symbol: string;
  tradeDate: string;
  direction: 'buy' | 'sell';
  strength: number | null;
  pluginId?: string;
  isDeleted?: 0 | 1;
}) {
  ConfigStore.getInstance()
    .db.prepare(
      `INSERT OR IGNORE INTO user_strategy_signal
         (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, origin, sub_category, is_final, is_deleted)
       VALUES (?, ?, ?, 'monitor', ?, ?, '测试', ?, NULL, 'replay', NULL, 1, ?)`,
    )
    .run(
      SIGNAL_USER_ID,
      params.symbol,
      params.pluginId ?? 'combo:c1',
      params.tradeDate,
      params.direction,
      params.strength,
      params.isDeleted ?? 0,
    );
}

describe('PA-09 纸面策略登记', () => {
  it('combo-signal-follow 已登记，按 (id, version) 可解析', () => {
    const list = listPaperStrategies();
    expect(list.some((item) => item.id === 'combo-signal-follow')).toBe(true);

    const strategy = resolvePaperStrategy('combo-signal-follow', '0.1.0');
    expect(strategy.id).toBe('combo-signal-follow');
    expect(strategy.version).toBe('0.1.0');
    expect(strategy.defaultParams).toMatchObject({ weight: 0.1 });
  });

  it('版本不符 → STRATEGY_VERSION_NOT_FOUND', () => {
    expect(() => resolvePaperStrategy('combo-signal-follow', '0.0.1')).toThrowError(PaperError);
    try {
      resolvePaperStrategy('combo-signal-follow', '0.0.1');
    } catch (err) {
      expect((err as PaperError).code).toBe('STRATEGY_VERSION_NOT_FOUND');
    }
  });
});

describe('PA-09 DB 信号源', () => {
  it('只取 trade_date <= asOf 的最新一天，且排除 strength=NULL / 其他插件 / 已删除', () => {
    // 历史日（不应被选中）
    seedSignal({ symbol: 'sh600000', tradeDate: '2026-11-05', direction: 'buy', strength: 0.9 });
    // 最新日（asOf=11-06）
    seedSignal({ symbol: 'sh600519', tradeDate: '2026-11-06', direction: 'buy', strength: 0.7 });
    seedSignal({ symbol: 'sh600036', tradeDate: '2026-11-06', direction: 'sell', strength: 0.5 });
    // 最新日但被过滤的
    seedSignal({ symbol: 'sh601318', tradeDate: '2026-11-06', direction: 'buy', strength: null });
    seedSignal({ symbol: 'sh601988', tradeDate: '2026-11-06', direction: 'buy', strength: 0.6, isDeleted: 1 });
    seedSignal({
      symbol: 'sh600030',
      tradeDate: '2026-11-06',
      direction: 'buy',
      strength: 0.8,
      pluginId: 'rsi_oversold',
    });
    // 未来日（无前视）
    seedSignal({ symbol: 'sz000001', tradeDate: '2026-11-07', direction: 'buy', strength: 0.95 });

    const signals = dbComboSignalSource.listSignals('c1', '2026-11-06');

    expect(signals.map((s) => s.symbol).sort()).toEqual(['sh600036', 'sh600519']);
    expect(signals.every((s) => s.tradeDate === '2026-11-06')).toBe(true);
    expect(signals.find((s) => s.symbol === 'sh600036')?.direction).toBe('sell');
  });

  it('空 comboId → 空数组（不查库）', () => {
    expect(dbComboSignalSource.listSignals('', '2026-11-06')).toEqual([]);
  });

  it('loadComboSignalSymbols 返回区间内去重标的', () => {
    seedSignal({ symbol: 'sh600000', tradeDate: '2026-11-05', direction: 'buy', strength: 0.8 });
    seedSignal({ symbol: 'sz000001', tradeDate: '2026-11-07', direction: 'buy', strength: 0.9 });

    expect(loadComboSignalSymbols('c1', '2026-11-01', '2026-11-07')).toEqual(['sh600000', 'sz000001']);
    expect(loadComboSignalSymbols('', '2026-11-01', '2026-11-07')).toEqual([]);
  });
});
