/**
 * holding.test.ts — SDD §12.5 F3 / F4 的指定测试载体
 *
 * | SDD §12.5 | 指定用例 | 本文件 describe |
 * |---|---|---|
 * | F3 持仓实时聚合查询正确（移动加权成本） | `avg_cost_calc_5_scenarios` | 「avg_cost_calc_5_scenarios — SDD §12.3 A1-A5 五个场景」 |
 * | F4 双口径收益率切换正确 | `yield_caliber_switch` | 「yield_caliber_switch — 价格口径 / 实际口径」 |
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 口径与隔离
 *   - 被测代码：src/services/positionCalculator.ts（calcPosition）+ src/services/assetStat.ts
 *     （insertAssetStatSnapshots，双口径快照的唯一写入点）
 *   - SQLite：mkdtempSync 临时库（AGENTS.md「测试优先 :memory: 或 mkdtempSync」），
 *     绝不碰 apps/backend/data/business.db
 *   - 行情价格：mock `services/marketData.js` 的 batchGetDaily —— 双口径需要「当日收盘价」，
 *     用真实 DuckDB 会让断言依赖本机行情库内容（CI 无行情库），故隔离成固定价格
 *   - 每个场景都与**手写计算器**对比，误差门槛 0.001 元（SDD §12.5 F3 通过标准）
 * ──────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DailyKline } from '@invest/core';

// ---------------------------------------------------------------------------
// SQLite 隔离：必须在 import ConfigStore 之前设好 SQLITE_DB_PATH
// ---------------------------------------------------------------------------
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-holding-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 'holding.db');

// ---------------------------------------------------------------------------
// 行情价格 mock：双口径需要当日收盘价，固定 12.00 元
// ---------------------------------------------------------------------------
const CLOSE_PRICE = 12;

const { batchGetDailyMock } = vi.hoisted(() => ({
  batchGetDailyMock: vi.fn<
    (symbols: string[], date: string, period?: string) => Promise<Map<string, DailyKline>>
  >(),
}));

vi.mock('../../src/services/marketData.js', () => ({
  batchGetDaily: batchGetDailyMock,
  getDailyBySymbol: vi.fn(),
  getDailyRange: vi.fn(),
  batchGetDailyRange: vi.fn(),
  batchGetLatestClose: vi.fn(),
  isTradingDay: vi.fn(),
  getLatestTradingDay: vi.fn(),
  toDateString: (v: unknown) => String(v),
}));

const { ConfigStore } = await import('../../src/config/configStore.js');
const { calcPosition } = await import('../../src/services/positionCalculator.js');
const { insertAssetStatSnapshots } = await import('../../src/services/assetStat.js');

let db: ReturnType<typeof ConfigStore.getInstance>;

// ---------------------------------------------------------------------------
// 手写计算器（SDD §12.5 F3：与手写计算器对比，误差 < 0.001 元）
// ---------------------------------------------------------------------------

interface RawTrade {
  tradeType: 'buy' | 'add' | 'reduce' | 'clear' | 'dividend' | 'bonus' | 'transfer';
  quantity: number;
  price: number;
  fee: number;
}

interface HandResult {
  quantity: number;
  avgCost: number;
  costBasis: number;
  realizedPnL: number;
}

/**
 * 手写计算器 —— **规格口径**（Requirements §5.1 / SDD §12.3）
 *   - buy / add          → 增加持仓与成本
 *   - reduce / clear     → 卖出（均价不变），结算已实现盈亏
 *   - bonus（送转）      → 股数按送转比例增加，均价按比例稀释
 *   - dividend/transfer  → 不影响持仓与成本
 */
function handCalcSpec(trades: RawTrade[]): HandResult {
  let quantity = 0;
  let costBasis = 0;
  let realizedPnL = 0;
  for (const t of trades) {
    if (t.tradeType === 'buy' || t.tradeType === 'add') {
      costBasis += t.quantity * t.price + t.fee;
      quantity += t.quantity;
    } else if (t.tradeType === 'reduce' || t.tradeType === 'clear') {
      if (quantity <= 0) continue;
      const avgCost = costBasis / quantity;
      realizedPnL += t.quantity * t.price - t.fee - t.quantity * avgCost;
      quantity -= t.quantity;
      costBasis = quantity * avgCost;
      if (quantity <= 0) { quantity = 0; costBasis = 0; }
    } else if (t.tradeType === 'bonus' && quantity > 0) {
      // 送转：股数增加（quantity 字段即送转股数），成本不变 → 均价稀释
      quantity += t.quantity;
    }
  }
  return { quantity, avgCost: quantity > 0 ? costBasis / quantity : 0, costBasis, realizedPnL };
}

/**
 * 手写计算器 —— **当前实现口径**（src/services/positionCalculator.ts mapToCoreTrade）
 *   - buy                → 增加持仓与成本
 *   - add / reduce / clear → 一律按**卖出**处理
 *   - dividend / bonus / transfer → 不参与移动加权（直接被过滤掉）
 *
 * ⚠️ 与 handCalcSpec 剩余**一处**差异是**已取证的实现偏差**（bonus 送转不计入，
 *    见本文件末尾「偏差记录」describe + §4-K 业务口径裁决），
 *    本函数只用于把当前行为钉住，不代表规格。
 */
function handCalcCurrent(trades: RawTrade[]): HandResult {
  let quantity = 0;
  let costBasis = 0;
  let realizedPnL = 0;
  for (const t of trades) {
    // ✅ `add`（加仓）现按 buy 处理（§4-A P0 已修）—— 与 handCalcSpec 在这一点上已一致。
    //    ⚠️ 剩余**唯一**差异是 `bonus`（送转）：spec 计入（股数增加、均价稀释），
    //    当前实现**不计** —— 属 §4-K 业务口径裁决（未拍板），故此处保持差异不动。
    if (t.tradeType === 'buy' || t.tradeType === 'add') {
      costBasis += t.quantity * t.price + t.fee;
      quantity += t.quantity;
    } else if (t.tradeType === 'reduce' || t.tradeType === 'clear') {
      if (quantity <= 0) continue;
      const avgCost = costBasis / quantity;
      const sellQty = Math.min(t.quantity, quantity);
      realizedPnL += sellQty * t.price - t.fee - sellQty * avgCost;
      quantity -= sellQty;
      costBasis = quantity * avgCost;
      if (quantity <= 0) { quantity = 0; costBasis = 0; }
    }
  }
  return { quantity, avgCost: quantity > 0 ? costBasis / quantity : 0, costBasis, realizedPnL };
}

// ---------------------------------------------------------------------------
// 造数
// ---------------------------------------------------------------------------

let userSeq = 3100;

function createUser(): number {
  userSeq += 1;
  const id = userSeq;
  db.db.prepare(
    `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
  ).run(id, `holding_user_${id}`, 'dummy-hash');
  return id;
}

interface TradeInput {
  type: RawTrade['tradeType'];
  date: string;
  time?: string;
  quantity: number;
  price: number;
  fee?: number;
}

function insertTrades(userId: number, assetCode: string, trades: TradeInput[]): void {
  const stmt = db.db.prepare(
    `INSERT INTO user_trade_record
     (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  let seq = 0;
  for (const t of trades) {
    seq += 1;
    stmt.run(
      userId, assetCode, t.type, t.date, t.time ?? `09:0${seq}:00`,
      t.quantity, t.price, t.fee ?? 0, `holding.test.ts 造数`,
    );
  }
}

/** 与手写计算器对比，误差门槛 0.001 元（SDD §12.5 F3） */
function expectAvgCostMatches(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}：实际 ${actual} vs 手算 ${expected}`).toBeLessThan(0.001);
}

beforeAll(() => {
  db = ConfigStore.getInstance();
  batchGetDailyMock.mockImplementation(async (symbols: string[]) => {
    const map = new Map<string, DailyKline>();
    for (const s of symbols) {
      map.set(s, {
        date: '2026-10-12',
        open: CLOSE_PRICE,
        high: CLOSE_PRICE,
        low: CLOSE_PRICE,
        close: CLOSE_PRICE,
        volume: 1_000_000,
        amount: CLOSE_PRICE * 1_000_000,
      });
    }
    return map;
  });
});

afterAll(() => {
  // 先关连接（Windows 上打开的 .db 删不掉），再删临时目录
  try { (ConfigStore.getInstance().db as unknown as { close(): void }).close(); } catch { /* ignore */ }
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// ===========================================================================
// F3 · avg_cost_calc_5_scenarios
// ===========================================================================

describe('avg_cost_calc_5_scenarios — SDD §12.3 A1-A5 五个场景', () => {
  it('场景 1 · 首次买入（历史持仓为空）：avg_cost = 买入价（含手续费）', () => {
    const uid = createUser();
    const code = 'sh600001';
    const trades: RawTrade[] = [{ tradeType: 'buy', quantity: 100, price: 10, fee: 0 }];
    insertTrades(uid, code, [{ type: 'buy', date: '2026-01-05', quantity: 100, price: 10, fee: 0 }]);

    const pos = calcPosition(uid, code);
    const hand = handCalcSpec(trades);

    expect(pos.totalQuantity).toBe(100);
    expectAvgCostMatches(pos.avgCost, hand.avgCost, '场景 1');
    expectAvgCostMatches(pos.avgCost, 10, '场景 1 固定值');
    expect(pos.totalCostBasis).toBe(1000);
  });

  it('场景 2 · 连续多次买入不同价格：avg_cost = total_cost / total_qty', () => {
    const uid = createUser();
    const code = 'sh600002';
    const trades: RawTrade[] = [
      { tradeType: 'buy', quantity: 100, price: 10, fee: 1 },
      { tradeType: 'buy', quantity: 50, price: 12, fee: 0.5 },
      { tradeType: 'buy', quantity: 200, price: 8, fee: 2 },
    ];
    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 1 },
      { type: 'buy', date: '2026-01-06', time: '09:01:00', quantity: 50, price: 12, fee: 0.5 },
      { type: 'buy', date: '2026-01-07', time: '09:01:00', quantity: 200, price: 8, fee: 2 },
    ]);

    const pos = calcPosition(uid, code);
    const hand = handCalcSpec(trades);

    // 成本基 = 100*10+1 + 50*12+0.5 + 200*8+2 = 3203.5；数量 = 350
    expect(pos.totalQuantity).toBe(350);
    expectAvgCostMatches(pos.totalCostBasis, 3203.5, '场景 2 成本基');
    expectAvgCostMatches(pos.avgCost, hand.avgCost, '场景 2');
    expectAvgCostMatches(pos.avgCost, 3203.5 / 350, '场景 2 固定值');
  });

  it('场景 3 · 减仓（卖部分持仓）：avg_cost 不变，数量减少，已实现盈亏按均价结算', () => {
    const uid = createUser();
    const code = 'sh600003';
    const trades: RawTrade[] = [
      { tradeType: 'buy', quantity: 100, price: 10, fee: 0 },
      { tradeType: 'reduce', quantity: 30, price: 12, fee: 1 },
    ];
    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
      { type: 'reduce', date: '2026-01-10', time: '09:01:00', quantity: 30, price: 12, fee: 1 },
    ]);

    const pos = calcPosition(uid, code);
    const hand = handCalcSpec(trades);

    expect(pos.totalQuantity).toBe(70);
    expectAvgCostMatches(pos.avgCost, hand.avgCost, '场景 3');
    expectAvgCostMatches(pos.avgCost, 10, '场景 3 减仓后均价不变');
    // 净收入 30*12-1 = 359；成本 30*10 = 300 → 已实现 59
    expectAvgCostMatches(pos.realizedPnL, hand.realizedPnL, '场景 3 已实现盈亏');
    expectAvgCostMatches(pos.realizedPnL, 59, '场景 3 已实现盈亏固定值');
  });

  it('场景 4 · 清仓再买入：上一轮 avg_cost 对新持仓无影响', () => {
    const uid = createUser();
    const code = 'sh600004';
    const trades: RawTrade[] = [
      { tradeType: 'buy', quantity: 100, price: 10, fee: 0 },
      { tradeType: 'clear', quantity: 100, price: 12, fee: 0 },
      { tradeType: 'buy', quantity: 100, price: 20, fee: 0 },
    ];
    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
      { type: 'clear', date: '2026-01-20', time: '09:01:00', quantity: 100, price: 12, fee: 0 },
      { type: 'buy', date: '2026-02-05', time: '09:01:00', quantity: 100, price: 20, fee: 0 },
    ]);

    const pos = calcPosition(uid, code);
    const hand = handCalcSpec(trades);

    expect(pos.totalQuantity).toBe(100);
    expectAvgCostMatches(pos.avgCost, hand.avgCost, '场景 4');
    expectAvgCostMatches(pos.avgCost, 20, '场景 4 新持仓均价 = 新买入价');
    // 清仓那一笔的已实现盈亏保留：(100*12) - (100*10) = 200
    expectAvgCostMatches(pos.realizedPnL, hand.realizedPnL, '场景 4 已实现盈亏');
    expectAvgCostMatches(pos.realizedPnL, 200, '场景 4 已实现盈亏固定值');
  });

  it('场景 5 · 送转股（除权自动导入）：当前实现不计入移动加权（⚠️ 与 SDD §12.3 A5 存在偏差，见「偏差记录」）', () => {
    const uid = createUser();
    const code = 'sh600005';
    const trades: RawTrade[] = [
      { tradeType: 'buy', quantity: 100, price: 10, fee: 0 },
      { tradeType: 'bonus', quantity: 10, price: 0, fee: 0 },
    ];
    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
      { type: 'bonus', date: '2026-01-10', time: '00:00:00', quantity: 10, price: 0, fee: 0 },
    ]);

    const pos = calcPosition(uid, code);
    const current = handCalcCurrent(trades);
    const spec = handCalcSpec(trades);

    // 当前实现（mapToCoreTrade 把 bonus 直接过滤掉）：股数不变、均价不变
    expect(pos.totalQuantity).toBe(current.quantity);
    expectAvgCostMatches(pos.avgCost, current.avgCost, '场景 5（当前实现口径）');
    expect(pos.totalQuantity).toBe(100);
    expectAvgCostMatches(pos.avgCost, 10, '场景 5（当前实现口径）');

    // SDD §12.3 A5 的规格期望：送转 10 股 → 110 股，均价稀释到 1000/110 = 9.090909
    // → 当前实现与规格的差额（取证用，不做修复）
    expect(spec.quantity).toBe(110);
    expectAvgCostMatches(spec.avgCost, 1000 / 110, '场景 5（规格口径手算）');
    expect(pos.totalQuantity - spec.quantity).toBe(-10);
  });
});

// ===========================================================================
// F4 · yield_caliber_switch
// ===========================================================================

describe('yield_caliber_switch — 价格口径 / 实际口径独立可查', () => {
  it('同一持仓：价格口径不含分红，实际口径含分红福利 → 两个收益率可分别查出', async () => {
    const uid = createUser();
    const code = 'sh600007';
    const tradeDate = '2026-10-12';

    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
      // 除权自动导入的分红：每股 0.5 元 × 100 股 = 50 元福利
      { type: 'dividend', date: '2026-06-10', time: '00:00:00', quantity: 100, price: 0.5, fee: 0 },
    ]);

    // 成本口径：分红**不**进成本基（价格口径），持仓 100 股
    const pos = calcPosition(uid, code);
    expect(pos.totalQuantity).toBe(100);
    expectAvgCostMatches(pos.totalCostBasis, 1000, 'F4 成本基（不含分红）');

    await insertAssetStatSnapshots(tradeDate);

    const row = db.db.prepare(
      `SELECT total_assets_price_yield, total_assets_actual_yield, total_profit_price, total_profit_actual
         FROM user_asset_stat WHERE user_id = ? AND trade_date = ?`,
    ).get(uid, tradeDate) as {
      total_assets_price_yield: number;
      total_assets_actual_yield: number;
      total_profit_price: number;
      total_profit_actual: number;
    };

    expect(row).toBeDefined();

    // 市值 = 100 × 12（mock 收盘价）= 1200；成本 = 1000；分红 = 50
    // 价格口径 = (1200-1000)/1000 = 0.2 ；实际口径 = (1200-1000+50)/1000 = 0.25
    expectAvgCostMatches(row.total_assets_price_yield, 0.2, 'F4 价格口径收益率');
    expectAvgCostMatches(row.total_assets_actual_yield, 0.25, 'F4 实际口径收益率');
    expectAvgCostMatches(row.total_profit_price, 200, 'F4 价格口径利润');
    expectAvgCostMatches(row.total_profit_actual, 250, 'F4 实际口径利润');

    // 两口径互相独立：差额 = 分红福利 / 成本 = 50/1000 = 0.05
    expectAvgCostMatches(
      row.total_assets_actual_yield - row.total_assets_price_yield,
      0.05,
      'F4 两口径差值',
    );
    expect(row.total_assets_actual_yield).toBeGreaterThan(row.total_assets_price_yield);
  });

  it('无除权福利时两口径一致（切换口径不改变结果）', async () => {
    const uid = createUser();
    const code = 'sh600008';
    const tradeDate = '2026-10-13';

    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
    ]);

    await insertAssetStatSnapshots(tradeDate);

    const row = db.db.prepare(
      `SELECT total_assets_price_yield, total_assets_actual_yield
         FROM user_asset_stat WHERE user_id = ? AND trade_date = ?`,
    ).get(uid, tradeDate) as {
      total_assets_price_yield: number;
      total_assets_actual_yield: number;
    };

    expect(row).toBeDefined();
    expectAvgCostMatches(row.total_assets_price_yield, 0.2, 'F4 无分红价格口径');
    expectAvgCostMatches(row.total_assets_actual_yield, 0.2, 'F4 无分红实际口径');
    expect(row.total_assets_actual_yield).toBe(row.total_assets_price_yield);
  });
});

// ===========================================================================
// 偏差记录：已取证的实现偏差（锁定当前行为，不做修复）
// ===========================================================================

describe('偏差记录（已取证 · 本文件不改 src）', () => {
  it('✅ trade_type=add（加仓）按 buy 处理 → 持仓累加、均价重算（§4-A P0 已修）', () => {
    // 取证：src/services/positionCalculator.ts mapToCoreTrade 把 'add' 与 'reduce'/'clear'
    //       归到同一分支并返回 direction:'sell'；Requirements §5.1 定义加仓 = 增加持仓。
    const uid = createUser();
    const code = 'sh600009';
    const trades: RawTrade[] = [
      { tradeType: 'buy', quantity: 100, price: 10, fee: 0 },
      { tradeType: 'add', quantity: 100, price: 12, fee: 0 },
    ];
    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
      { type: 'add', date: '2026-01-06', time: '09:01:00', quantity: 100, price: 12, fee: 0 },
    ]);

    const pos = calcPosition(uid, code);
    const current = handCalcCurrent(trades);
    const spec = handCalcSpec(trades);

    // ✅ 偏差已消除（§4-A P0 修复）：`add`（加仓）现按 **buy** 处理 ——
    //    买入 100@10 + 加仓 100@12 → 持仓 200、均价 11（不再被当成卖出清零）。
    //    原实现把 add/reduce/clear 一起映射为 sell → 持仓归零 + 已实现盈亏被错记为 200。
    expect(pos.totalQuantity).toBe(200);
    expectAvgCostMatches(pos.avgCost, 11, 'add 加仓（修复后：200 股 / 均价 11）');
    expectAvgCostMatches(pos.realizedPnL, 0, 'add 加仓不应产生已实现盈亏');

    // 与规格手算一致
    expect(pos.totalQuantity).toBe(spec.quantity);
    expectAvgCostMatches(pos.avgCost, spec.avgCost, 'add 加仓（规格口径手算）');
    expectAvgCostMatches(pos.avgCost, current.avgCost, 'add 加仓（当前实现口径）');
  });

  it('⚠️ calcPosition 对「未来买入」不回放：asOfDate 只取 trade_date <= 该日', () => {
    // 口径说明：T84 的 asOfDate 是「回放到哪个时点」，只回放 trade_date <= asOfDate 的记录。
    const uid = createUser();
    const code = 'sh600010';
    insertTrades(uid, code, [
      { type: 'buy', date: '2026-01-05', time: '09:01:00', quantity: 100, price: 10, fee: 0 },
      { type: 'buy', date: '2026-03-05', time: '09:01:00', quantity: 100, price: 20, fee: 0 },
    ]);

    const atFeb = calcPosition(uid, code, '2026-02-01');
    expect(atFeb.totalQuantity).toBe(100);
    expectAvgCostMatches(atFeb.avgCost, 10, 'asOfDate 回放（2 月）');

    const atApr = calcPosition(uid, code, '2026-04-01');
    expect(atApr.totalQuantity).toBe(200);
    expectAvgCostMatches(atApr.avgCost, 15, 'asOfDate 回放（4 月）');
  });
});
