/**
 * position_risk_alert —— V3 六分类 risk 代表（持仓快照级风险提示）
 *
 * 覆盖四组契约：
 *  A. 插件行为：三条快照级规则（单票占比超限 / 浮亏触及止损 / 仓位集中度）
 *     + 只输出 HOLD、**不带 strength**、多规则合并为一条、各类「不臆造信号」的跳过分支
 *  B. 落库：`sub_category='risk'` 且 `strength IS NULL`
 *  C. 读取侧：持仓卡「最新一条」按 `sub_category <> 'risk'` 过滤（风险不抢徽标位）
 *  D. 分级隔离：F1 的强/中/弱分位只吃 `strength IS NOT NULL` 的信号，
 *     风险 HOLD（strength 为 NULL）加入后，分位候选集必须**逐行不变**
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- 必须在 import src 之前覆盖 SQLITE_DB_PATH（隔离开发库）---
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-risk-alert-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

const { queryDuckDBMock } = vi.hoisted(() => ({ queryDuckDBMock: vi.fn() }));
vi.mock('../../src/db/duckdb.js', () => ({ queryDuckDB: queryDuckDBMock }));

import {
  executePlugin,
  builtinPlugins,
  deriveDefaultParams,
  type PluginContext,
  type Plugin,
  type PluginExecutionResult,
  type PluginPositionView,
} from '../../src/services/pluginEngine.js';
import { calculateSMA } from '../../src/services/indicators.js';
import { persistSignals, persistBatchSignals } from '../../src/services/signalService.js';
import { getLatestSignalsByAssets } from '../../src/services/todaySignals.js';
import { ConfigStore } from '../../src/config/configStore.js';
import { calculateBoll, calculateRSI } from '@invest/core';

const UID = 9101;
const findPlugin = (id: string): Plugin => {
  const p = builtinPlugins.find((x) => x.id === id);
  if (!p) throw new Error(`内置插件不存在: ${id}`);
  return p;
};

/** 构造一条持仓视图（市值 / 数量 / 成本三者自洽，便于反推现价） */
function pos(
  symbol: string,
  quantity: number,
  avgCost: number,
  marketValue: number,
  assetClass: 'risk' | 'cash' = 'risk',
): PluginPositionView {
  return { symbol, quantity, avgCost, marketValue, assetClass };
}

/** 插件的 execute() 是纯计算：context 只提供快照，零行情 IO */
function ctxWith(
  positions: PluginPositionView[],
  equity: number,
  available = true,
): PluginContext {
  return {
    async getDailyKlines() {
      return [];
    },
    async batchGetDailyKlines() {
      return new Map();
    },
    calculateRSI,
    calculateMACD: () => ({ dif: [], dea: [], macd: [] }),
    calculateSMA,
    calculateBoll,
    positions: () => positions,
    cash: 0,
    equity,
    positionsAvailable: available,
  };
}

/** 跑一次插件（默认参数 + 覆盖项；`concentrationThreshold: 1` 等于关掉集中度规则） */
async function run(
  ctx: PluginContext,
  params: Record<string, unknown> = {},
): Promise<PluginExecutionResult> {
  return executePlugin(findPlugin('position_risk_alert'), params, ctx);
}

// ---------------------------------------------------------------------------
// A. 插件元数据与行为
// ---------------------------------------------------------------------------

describe('A. position_risk_alert 元数据', () => {
  const plugin = findPlugin('position_risk_alert');

  it('是 monitor / risk 且声明 requiresPositions（组合级插件）', () => {
    expect(plugin.category).toBe('monitor');
    expect(plugin.subCategory).toBe('risk');
    expect(plugin.requiresPositions).toBe(true);
  });

  it('默认参数由 paramSchema 派生，且不含 symbol（组合级插件不按标的执行）', () => {
    expect(plugin.defaultParams).toEqual(deriveDefaultParams(plugin.paramSchema));
    expect(plugin.defaultParams).toMatchObject({
      maxPositionWeight: 0.3,
      stopLossRatio: 0.1,
      concentrationTopN: 3,
      concentrationThreshold: 0.6,
    });
    expect(plugin.paramSchema?.some((f) => f.key === 'symbol')).toBe(false);
  });
});

describe('A. 三条快照级规则', () => {
  it('单票占比超限 → 一条 HOLD，label / metrics 带阈值与实际值', async () => {
    // A 市值 400 / 权益 1000 = 40% > 30%；B / C 各 30% 不越界；现价 100 = 成本 90 ⇒ 无浮亏
    const res = await run(
      ctxWith([pos('sh600000', 4, 90, 400), pos('sh600001', 3, 100, 300), pos('sh600002', 3, 100, 300)], 1000),
      { concentrationThreshold: 1 }, // 关掉集中度规则，隔离单票占比
    );

    expect(res.status).toBe('SUCCESS');
    expect(res.signals).toHaveLength(1);
    const s = res.signals[0];
    expect(s.symbol).toBe('sh600000');
    expect(s.signalType).toBe('HOLD');
    // 🔴 不带 strength：交给 F1 的 `strength IS NOT NULL` 自动排除
    expect(s.strength).toBeUndefined();
    expect(s.label).toContain('单票占比超限');
    expect(s.label).toContain('40.0%');
    expect(s.label).toContain('30.0%');
    expect(s.metrics).toMatchObject({ weight: 0.4, maxPositionWeight: 0.3, ruleCount: 1 });
  });

  it('浮亏触及止损 → 一条 HOLD（现价 88 / 成本 100 ⇒ -12%）', async () => {
    const res = await run(
      ctxWith([pos('sh600000', 3, 100, 264), pos('sh600001', 1, 100, 736)], 1000),
      { concentrationThreshold: 1, maxPositionWeight: 0.8 },
    );

    expect(res.signals).toHaveLength(1);
    const s = res.signals[0];
    expect(s.symbol).toBe('sh600000');
    expect(s.signalType).toBe('HOLD');
    expect(s.label).toContain('浮亏触及止损');
    expect(s.label).toContain('-12.0%');
    expect(s.metrics?.unrealizedRatio).toBeCloseTo(-0.12, 6);
    expect(s.metrics?.stopLossRatio).toBe(0.1);
  });

  it('仓位集中度：只标记贡献集中度的前 N 名，第 N+1 名不出信号', async () => {
    // 前 3 名合计 800 / 1000 = 80% > 60%，第 4 名（200）不在前 3 名
    const res = await run(
      ctxWith(
        [pos('sh600000', 3, 100, 300), pos('sh600001', 2, 100, 250), pos('sh600002', 2, 100, 250), pos('sh600003', 2, 100, 200)],
        1000,
      ),
      { maxPositionWeight: 0.5 }, // 关掉单票占比规则
    );

    const symbols = res.signals.map((s) => s.symbol);
    expect(symbols).toHaveLength(3);
    expect(symbols).not.toContain('sh600003');
    for (const s of res.signals) {
      expect(s.signalType).toBe('HOLD');
      expect(s.label).toContain('仓位集中度偏高');
      expect(s.metrics).toMatchObject({
        topNWeight: 0.8,
        concentrationThreshold: 0.6,
        concentrationTopN: 3,
      });
    }
  });

  it('多规则命中的同一标的**合并为一条**（唯一键一天只能落一条）', async () => {
    // A：市值 700 / 权益 1000（占比超限），现价 100 / 成本 500 ⇒ 浮亏 -80%，且是前 1 名（集中度）
    // B：市值 300，占比 30% 不越界
    const res = await run(
      ctxWith([pos('sh600000', 7, 500, 700), pos('sh600001', 3, 100, 300)], 1000),
      { concentrationTopN: 1, concentrationThreshold: 0.3 },
    );

    const a = res.signals.filter((s) => s.symbol === 'sh600000');
    expect(a).toHaveLength(1);
    expect(a[0].label).toContain('浮亏触及止损');
    expect(a[0].label).toContain('单票占比超限');
    expect(a[0].label).toContain('仓位集中度偏高');
    expect(a[0].metrics?.ruleCount).toBe(3);
  });
});

describe('A. 不臆造信号（跳过分支）', () => {
  it('equity <= 0：不拿 0 做分母，直接不出信号', async () => {
    const res = await run(ctxWith([pos('sh600000', 4, 90, 0), pos('sh600001', 1, 100, 0)], 0));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toHaveLength(0);
  });

  it('marketValue = 0 的标的被跳过（取不到价 ≠ 零仓位风险）', async () => {
    const res = await run(
      ctxWith([pos('sh600000', 4, 100, 0), pos('sh600001', 10, 100, 1000)], 1000),
      { concentrationThreshold: 1 },
    );
    expect(res.signals.map((s) => s.symbol)).toEqual(['sh600001']);
  });

  it('cash 类持仓不参与占比 / 止损判断（但市值仍计入 equity 分母）', async () => {
    const res = await run(
      ctxWith([pos('sh511990', 100, 1, 1000, 'cash'), pos('sh600000', 1, 100, 100)], 1100),
      { concentrationThreshold: 1 },
    );
    // 唯一 risk 持仓市值 100 / 权益 1100 ≈ 9.1% < 30% ⇒ 无信号；cash 1000 若参与会被误报 90.9%
    expect(res.signals).toHaveLength(0);
  });

  it('无持仓 → 零信号（SKIP 而非报错）', async () => {
    const res = await run(ctxWith([], 1000));
    expect(res.status).toBe('SKIP');
    expect(res.signals).toHaveLength(0);
  });

  it('持仓快照不可用（回放 / 无 userId）→ SKIP + POSITION_UNAVAILABLE', async () => {
    const res = await run(ctxWith([pos('sh600000', 4, 90, 400)], 1000, false));
    expect(res.status).toBe('SKIP');
    expect(res.skipReason).toBe('POSITION_UNAVAILABLE');
    expect(res.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B~D. 落库 / 读取侧 / 分级隔离（需要真实 SQLite）
// ---------------------------------------------------------------------------

describe('B. 落库与读取侧（真实 SQLite）', () => {
  let db: ReturnType<typeof ConfigStore.getInstance>;

  beforeAll(() => {
    queryDuckDBMock.mockImplementation(async () => []);
    db = ConfigStore.getInstance();
    db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
      )
      .run(UID, 'risk_alert_user');
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(UID);
  });

  // ⚠️ vitest `sequence.shuffle=true` 会打乱**文件内用例顺序** ⇒ 每条用例必须自带干净起点，
  //    否则前一条用例留下的 (user_id, asset_code, plugin_id, trade_date) 会让 INSERT OR IGNORE 静默落 0 条。
  beforeEach(() => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(UID);
  });

  afterAll(() => {
    if (ORIGINAL_SQLITE_DB_PATH === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(tmpDbPath + suffix);
      } catch {
        /* 文件已被关闭或不存在：忽略 */
      }
    }
  });

  it('persistSignals 写入 sub_category = risk 且 strength 为 NULL', async () => {
    const res = await run(
      ctxWith([pos('sh600000', 4, 90, 400), pos('sh600001', 3, 100, 300), pos('sh600002', 3, 100, 300)], 1000),
      { concentrationThreshold: 1 },
    );
    const p = persistSignals(
      res.signals,
      'position_risk_alert',
      'monitor',
      '2026-11-06',
      UID,
      'live',
      'risk',
    );
    expect(p.inserted).toBe(1);

    const row = db.db
      .prepare(
        `SELECT direction, sub_category, strength, plugin_category FROM user_strategy_signal
         WHERE user_id = ? AND plugin_id = 'position_risk_alert' AND asset_code = 'sh600000' AND trade_date = '2026-11-06'`,
      )
      .get(UID) as
      | { direction: string; sub_category: string | null; strength: number | null; plugin_category: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.direction).toBe('hold'); // 风险提示落 hold，不是 sell
    expect(row?.sub_category).toBe('risk'); // 读取侧稳定判据
    expect(row?.strength).toBeNull(); // 🔴 不参与 F1 分位
    expect(row?.plugin_category).toBe('monitor');
  });

  it('persistBatchSignals 同样透传 subCategory', async () => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(UID);
    const p = persistBatchSignals(
      [
        {
          pluginId: 'position_risk_alert',
          pluginCategory: 'monitor',
          subCategory: 'risk',
          signals: [
            {
              symbol: 'sh600001',
              signalType: 'HOLD',
              label: '仓位集中度偏高（前 3 名合计 80.0% > 60.0%）',
              pluginId: 'position_risk_alert',
              timestamp: '2026-11-06T00:00:00.000Z',
            },
          ],
        },
      ],
      '2026-11-06',
      UID,
    );
    expect(p.inserted).toBe(1);
    const row = db.db
      .prepare(
        `SELECT sub_category, direction FROM user_strategy_signal WHERE user_id = ? AND asset_code = 'sh600001'`,
      )
      .get(UID) as { sub_category: string | null; direction: string } | undefined;
    expect(row?.sub_category).toBe('risk');
    expect(row?.direction).toBe('hold');
  });

  it('持仓卡「最新一条」不取风险信号（风险不抢徽标位）', async () => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(UID);
    // 前天：真实交易信号（momentum / buy）
    persistSignals(
      [
        {
          symbol: 'sh600519',
          signalType: 'BUY',
          label: '金叉',
          strength: 80,
          pluginId: 'macd_cross',
          timestamp: '2026-11-04T00:00:00.000Z',
        },
      ],
      'macd_cross',
      'monitor',
      '2026-11-04',
      UID,
      'live',
      'trend',
    );
    // 今天：风险提示（risk / hold）—— 日期更新，若不排除会抢占「最新一条」
    persistSignals(
      [
        {
          symbol: 'sh600519',
          signalType: 'HOLD',
          label: '浮亏触及止损（-12.0% ≤ -10.0%）',
          pluginId: 'position_risk_alert',
          timestamp: '2026-11-06T00:00:00.000Z',
        },
        {
          symbol: 'sz000001',
          signalType: 'HOLD',
          label: '单票占比超限（40.0% > 30.0%）',
          pluginId: 'position_risk_alert',
          timestamp: '2026-11-06T00:00:00.000Z',
        },
      ],
      'position_risk_alert',
      'monitor',
      '2026-11-06',
      UID,
      'live',
      'risk',
    );

    const latest = await getLatestSignalsByAssets(UID, ['sh600519', 'sz000001']);
    // 有交易信号的标的：取到的是那笔 BUY，而不是今天的风险 HOLD
    expect(latest.get('sh600519')).toMatchObject({
      plugin_id: 'macd_cross',
      direction: 'buy',
      trade_date: '2026-11-04',
    });
    // 只有风险信号的标的：不出现（徽标位留空，由持仓风险区单独呈现）
    expect(latest.has('sz000001')).toBe(false);
  });

  it('F1 分级隔离：风险 HOLD（strength NULL）不改变分位候选集', () => {
    db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(UID);

    // 交易信号：带 strength，参与强/中/弱分位
    const tradeScores: Array<[string, string, number]> = [
      ['sh600000', 'macd_cross', 88],
      ['sh600001', 'rsi_oversold', 72],
      ['sh600002', 'volume_price_breakout', 65],
      ['sh600003', 'boll_reversion', 40],
    ];
    for (const [symbol, pluginId, strength] of tradeScores) {
      db.db
        .prepare(
          `INSERT INTO user_strategy_signal
             (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, origin, sub_category, is_final)
           VALUES (?, ?, ?, 'monitor', '2026-11-06', 'buy', '买入', ?, 'live', 'trend', 1)`,
        )
        .run(UID, symbol, pluginId, strength);
    }

    /**
     * F1 `assignSignalGrades` 的分位候选集查询（契约快照）
     * 源码位置：`apps/backend/src/services/` 中按 `strength IS NOT NULL` 取当日全部信号。
     * 这里直接用同一 SQL 断言「风险 HOLD 加入前后逐行一致」——
     * 即：分位分母只含交易信号，分级阈值不受风险提示影响。
     */
    const gradeCandidates = (): Array<{ id: number; strength: number }> =>
      db.db
        .prepare(
          `SELECT id, strength FROM user_strategy_signal
           WHERE user_id = ? AND trade_date = ? AND is_deleted = 0 AND strength IS NOT NULL
           ORDER BY strength DESC, id ASC`,
        )
        .all(UID, '2026-11-06') as Array<{ id: number; strength: number }>;

    const before = gradeCandidates();
    expect(before).toHaveLength(4);

    // 加入 3 条风险 HOLD（只输出 HOLD、无 strength ⇒ 落库为 NULL）
    const riskSignals = [
      {
        symbol: 'sh600000',
        signalType: 'HOLD' as const,
        label: '浮亏触及止损（-12.0% ≤ -10.0%）',
        pluginId: 'position_risk_alert',
        timestamp: '2026-11-06T00:00:00.000Z',
      },
      {
        symbol: 'sh600002',
        signalType: 'HOLD' as const,
        label: '单票占比超限（40.0% > 30.0%）',
        pluginId: 'position_risk_alert',
        timestamp: '2026-11-06T00:00:00.000Z',
      },
      {
        symbol: 'sh600004',
        signalType: 'HOLD' as const,
        label: '仓位集中度偏高（前 3 名合计 80.0% > 60.0%）',
        pluginId: 'position_risk_alert',
        timestamp: '2026-11-06T00:00:00.000Z',
      },
    ];
    persistSignals(riskSignals, 'position_risk_alert', 'monitor', '2026-11-06', UID, 'live', 'risk');

    const after = gradeCandidates();
    // 分母未被稀释：候选集与不加风险 HOLD 时逐行相同（分级阈值因此不变）
    expect(after).toEqual(before);
    expect(
      db.db
        .prepare(
          `SELECT COUNT(*) AS n FROM user_strategy_signal
           WHERE user_id = ? AND trade_date = '2026-11-06' AND sub_category = 'risk'`,
        )
        .get(UID),
    ).toEqual({ n: 3 });
  });
});
