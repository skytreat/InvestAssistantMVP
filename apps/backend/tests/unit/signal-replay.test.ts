/**
 * signal-replay.test.ts —— F 域「区间回放」
 *
 * 覆盖四类：
 *   ① 正常回放：按真实交易日逐日跑插件、按各自交易日落库（`origin = 'replay'`）
 *   ② 幂等重跑：重复执行不产生重复行（靠 `UNIQUE(user_id, asset_code, plugin_id, trade_date)` + INSERT OR IGNORE）
 *   ③ 区间边界：起点 `MAX(trade_date)+1`、库空默认 20 日、锚点晚于终点、单日、自动 60 日截断、显式硬上限 250
 *   ④ dry-run 与写库的差异（不写信号行）
 *
 * 无前视（第 T 天只用 T 及之前行情）见 `signal-replay-no-lookahead.test.ts`。
 *
 * 测试环境约束（沿用 t85b / f-signal-plugin-fixes）：
 *   - 顶层覆盖 `SQLITE_DB_PATH` 到临时库，每个用例后销毁；
 *   - DuckDB / 插件执行一律 mock，不依赖真实行情库（CI 只有 12KB 空壳库）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-signal-replay-'));
const TEST_DB = path.join(tmpDir, 'signal-replay.db');
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import * as marketDataMod from '../../src/services/marketData.js';
import * as engineMod from '../../src/services/pluginEngine.js';
import {
  replaySignals,
  resolveReplayRange,
  ReplayRangeTooLargeError,
  DEFAULT_MAX_AUTO_TRADING_DAYS,
  HARD_MAX_REPLAY_TRADING_DAYS,
} from '../../src/services/signalReplay.js';

const USER = 9901;

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

/** 建用户 + 自选（FK 要求 user_account 先存在） */
function seedUser(symbols: string[]): void {
  const db = ConfigStore.getInstance().db;
  db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash) VALUES (?, 'replay_user', 'x')`,
  ).run(USER);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, 'watch')`,
  );
  for (const s of symbols) stmt.run(USER, s);
}

/** 直接种一条存量信号（模拟日常链路已落库的 live 信号） */
function seedSignal(assetCode: string, pluginId: string, tradeDate: string, origin = 'live'): void {
  ConfigStore.getInstance()
    .db.prepare(
      `INSERT OR IGNORE INTO user_strategy_signal
       (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, origin, is_final)
       VALUES (?, ?, ?, 'monitor', ?, 'buy', 'seed', ?, 1)`,
    )
    .run(USER, assetCode, pluginId, tradeDate, origin);
}

/** 每日的插件执行结果：1 条信号 + 1 个 SKIP（便于断言 stats 汇总） */
function mkDayResult(label: string) {
  return {
    signals: [{ symbol: 'sh600000', signalType: 'BUY' as const, label }],
    stats: { total: 2, success: 1, timeout: 0, error: 0, skip: 1, noData: 0 },
    results: [
      {
        pluginId: 'rsi_oversold',
        status: 'SUCCESS' as const,
        durationMs: 1,
        klines: 62,
        signals: [{ symbol: 'sh600000', signalType: 'BUY' as const, label }],
      },
      {
        pluginId: 'macd_cross',
        status: 'SKIP' as const,
        durationMs: 0,
        klines: 62,
        skipReason: 'NO_SIGNAL' as const,
        signals: [],
      },
    ],
  };
}

function rowCount(): number {
  const row = ConfigStore.getInstance()
    .db.prepare(`SELECT COUNT(*) AS c FROM user_strategy_signal`)
    .get() as {
    c: number;
  };
  return row.c;
}

describe('区间回放：正常回放与落库', () => {
  beforeEach(() => {
    cleanup();
    seedUser(['sh600000']);
    vi.spyOn(marketDataMod, 'resolveLatestQuoteDate').mockResolvedValue('2026-11-04');
    vi.spyOn(marketDataMod, 'listTradeDatesBetween').mockResolvedValue([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    vi.spyOn(engineMod, 'executeAllPlugins').mockImplementation(async (opts) =>
      mkDayResult(`信号@${opts.asOfDate}`),
    );
  });
  afterEach(cleanup);

  it('库空 + 无显式区间 → 默认窗口最近 N 个真实交易日，逐日按 trade_date 落 origin=replay', async () => {
    const result = await replaySignals({ userId: USER, dryRun: false });

    expect(result.startSource).toBe('default_window');
    expect(result.dayCount).toBe(3);
    expect(result.dates).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(result.totals.inserted).toBe(3);
    expect(result.totals.skip).toBe(3);
    expect(result.totals.noData).toBe(0);

    const rows = ConfigStore.getInstance()
      .db.prepare(`SELECT trade_date, origin, is_final FROM user_strategy_signal ORDER BY trade_date`)
      .all() as Array<{ trade_date: string; origin: string; is_final: number }>;
    expect(rows).toEqual([
      { trade_date: '2026-11-02', origin: 'replay', is_final: 1 },
      { trade_date: '2026-11-03', origin: 'replay', is_final: 1 },
      { trade_date: '2026-11-04', origin: 'replay', is_final: 1 },
    ]);
  });

  it('每次执行都带 asOfDate = 当日（逐日独立计算，不是一次算完再拆）', async () => {
    await replaySignals({ userId: USER, dryRun: false });
    const spy = engineMod.executeAllPlugins as unknown as ReturnType<typeof vi.fn>;
    expect(spy.mock.calls.map((c: any[]) => c[0].asOfDate)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('dry-run 默认开启：不写信号行，只给出 wouldInsert/wouldSkip 预估', async () => {
    seedSignal('sh600000', 'rsi_oversold', '2026-11-02');
    const before = rowCount();

    // 显式给起点，避免「种了信号 → 自动起点后移」干扰本用例
    const result = await replaySignals({ userId: USER, fromDate: '2026-11-02' });

    expect(result.dryRun).toBe(true);
    expect(result.totals.inserted).toBe(0);
    expect(result.days.map((d) => [d.wouldInsert, d.wouldSkip])).toEqual([
      [0, 1],
      [1, 0],
      [1, 0],
    ]);
    expect(rowCount()).toBe(before);
  });
});

describe('区间回放：幂等', () => {
  beforeEach(() => {
    cleanup();
    seedUser(['sh600000']);
    vi.spyOn(marketDataMod, 'resolveLatestQuoteDate').mockResolvedValue('2026-11-04');
    vi.spyOn(marketDataMod, 'listTradeDatesBetween').mockResolvedValue([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    vi.spyOn(engineMod, 'executeAllPlugins').mockImplementation(async (opts) =>
      mkDayResult(`信号@${opts.asOfDate}`),
    );
  });
  afterEach(cleanup);

  it('重复回放：第二次 inserted=0 / skipped=当日条数，总行数不变', async () => {
    const first = await replaySignals({ userId: USER, fromDate: '2026-11-02', dryRun: false });
    expect(first.totals.inserted).toBe(3);
    const afterFirst = rowCount();
    expect(afterFirst).toBe(3);

    const second = await replaySignals({ userId: USER, fromDate: '2026-11-02', dryRun: false });
    expect(second.totals.inserted).toBe(0);
    expect(second.totals.skipped).toBe(3);
    expect(second.totals.errors).toBe(0);
    expect(rowCount()).toBe(afterFirst);
  });
});

describe('区间回放：起点与区间边界', () => {
  const DATES = ['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'];

  beforeEach(() => {
    cleanup();
    seedUser(['sh600000']);
    vi.spyOn(marketDataMod, 'resolveLatestQuoteDate').mockResolvedValue('2026-11-04');
    // 按区间过滤：显式 from=to 时只能返回那一天
    vi.spyOn(marketDataMod, 'listTradeDatesBetween').mockImplementation(async (from: string, to: string) =>
      DATES.filter((d) => d >= from && d <= to),
    );
    vi.spyOn(engineMod, 'executeAllPlugins').mockImplementation(async (opts) =>
      mkDayResult(`信号@${opts.asOfDate}`),
    );
  });
  afterEach(cleanup);

  it('自动起点 = 库内 MAX(trade_date) 的次一交易日（锚点日不重算）', async () => {
    seedSignal('sh600000', 'rsi_oversold', '2026-11-02');
    const result = await replaySignals({ userId: USER, dryRun: true });

    expect(result.startSource).toBe('signal_max');
    expect(result.startAnchor).toBe('2026-11-02');
    expect(result.dates).toEqual(['2026-11-03', '2026-11-04']);
  });

  it('锚点晚于终点 → 空区间，不执行插件', async () => {
    seedSignal('sh600000', 'rsi_oversold', '2026-11-05');
    const result = await replaySignals({ userId: USER, toDate: '2026-11-04', dryRun: true });

    expect(result.dayCount).toBe(0);
    expect(result.dates).toEqual([]);
    expect(result.notes.join('')).toContain('晚于回放终点');
    expect(engineMod.executeAllPlugins).not.toHaveBeenCalled();
  });

  it('显式单日区间 from=to 只回放一天', async () => {
    const result = await replaySignals({
      userId: USER,
      fromDate: '2026-11-04',
      toDate: '2026-11-04',
      dryRun: true,
    });
    expect(result.dates).toEqual(['2026-11-04']);
    expect(result.dayCount).toBe(1);
  });

  it('自动区间超过 60 个交易日 → 截断为最近 60 并标记 truncated', async () => {
    // 生成 80 个连续交易日（跨月/跨年都不影响，日期来自「真实行情日」mock）
    const many: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      const d = new Date(Date.UTC(2026, 7, 1));
      d.setUTCDate(d.getUTCDate() + i);
      many.push(d.toISOString().slice(0, 10));
    }
    vi.spyOn(marketDataMod, 'listTradeDatesBetween').mockResolvedValue(many);
    seedSignal('sh600000', 'rsi_oversold', many[0]);

    const result = await resolveReplayRange({ userId: USER });
    expect(result.truncated).toBe(true);
    expect(result.dates).toHaveLength(DEFAULT_MAX_AUTO_TRADING_DAYS);
    expect(result.dates.at(-1)).toBe(many.at(-1));
  });

  it('显式区间超过硬上限 250 → 抛 ReplayRangeTooLargeError（不静默截断、不执行）', async () => {
    const many = Array.from({ length: HARD_MAX_REPLAY_TRADING_DAYS + 1 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1));
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    vi.spyOn(marketDataMod, 'listTradeDatesBetween').mockResolvedValue(many);

    await expect(
      replaySignals({ userId: USER, fromDate: '2025-01-01', dryRun: true }),
    ).rejects.toBeInstanceOf(ReplayRangeTooLargeError);
    expect(engineMod.executeAllPlugins).not.toHaveBeenCalled();
  });

  it('日期格式非法 → 直接拒绝（不猜口径）', async () => {
    await expect(replaySignals({ userId: USER, fromDate: '2026/11/02', dryRun: true })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
  });
});

describe('origin 列向后兼容', () => {
  beforeEach(() => {
    cleanup();
    vi.spyOn(marketDataMod, 'listTradeDatesBetween').mockResolvedValue(['2026-11-04']);
    vi.spyOn(engineMod, 'executeAllPlugins').mockImplementation(async (opts) =>
      mkDayResult(`信号@${opts.asOfDate}`),
    );
  });
  afterEach(cleanup);

  it('存量库（无 origin 列）迁移后：老行取 live，新回放行取 replay，读取侧不区分', async () => {
    // 1. 造一个「回放能力上线前」的库：user_strategy_signal 没有 origin 列
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const raw = new BetterSqlite3(TEST_DB);
    raw.exec(`
      CREATE TABLE user_strategy_signal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        asset_code TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_category TEXT NOT NULL CHECK (plugin_category IN ('monitor','filter')),
        trade_date TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('buy','sell','hold')),
        label TEXT NOT NULL,
        strength REAL,
        metrics_json TEXT,
        is_final INTEGER DEFAULT 1,
        is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(user_id, asset_code, plugin_id, trade_date)
      );
      INSERT INTO user_strategy_signal (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label)
      VALUES (7, 'sh600000', 'rsi_oversold', 'monitor', '2026-10-30', 'buy', '老行');
    `);
    raw.close();

    // 2. 打开 ConfigStore → 幂等补列
    const db = ConfigStore.getInstance().db;
    const cols = db.prepare(`PRAGMA table_info(user_strategy_signal)`).all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const originCol = cols.find((c) => c.name === 'origin');
    expect(originCol).toBeTruthy();
    expect(originCol?.dflt_value).toBe("'live'");
    expect(originCol?.notnull).toBe(1);

    const oldRow = db
      .prepare(
        `SELECT trade_date, origin FROM user_strategy_signal WHERE user_id = 7 AND trade_date = '2026-10-30'`,
      )
      .get() as { trade_date: string; origin: string };
    expect(oldRow.origin).toBe('live');

    // 3. 新回放行写 replay，且与老行共表共存（读取侧按 trade_date 取，不按 origin 过滤）
    db.prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash) VALUES (9902,'replay_user2','x')`,
    ).run();
    const replayRow = await replaySignals({
      userId: 9902,
      symbols: ['sh600000'],
      fromDate: '2026-11-04',
      toDate: '2026-11-04',
      dryRun: false,
      prefetchDays: 120,
    });
    expect(replayRow.totals.inserted).toBeGreaterThan(0);
    const mixed = db
      .prepare(`SELECT origin, COUNT(*) AS c FROM user_strategy_signal GROUP BY origin ORDER BY origin`)
      .all() as Array<{ origin: string; c: number }>;
    expect(mixed.map((r) => r.origin)).toEqual(['live', 'replay']);
  });
});
