/**
 * assetStat.test.ts — 单元测试 src/services/assetStat.ts（T60⑥ 双口径数学用例）
 *
 * 覆盖 insertAssetStatSnapshots：
 *   - 空用户表 → inserted=0
 *   - 无持仓无分红 → 全零快照
 *   - 纯价格上涨（无分红）→ priceYield 正确，actualYield = priceYield
 *   - 价格下跌 + 有分红 → actualYield > priceYield（分红补差）
 *   - 价格不变 + 有分红 → priceYield≈0, actualYield>0
 *   - 多标持仓 → 合计市值/成本正确
 *   - batchGetDaily 返回空 → close=0 兜底
 *   - 纯分红用户（无买卖）→ 只写分红收益
 *   - 加仓后成本正确（移动加权）
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-as-'));
const TEST_DB = path.join(tmpDir, 'as-test.db');
const ORIGINAL_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

// mock marketData（assetStat 内部调 batchGetDaily 取当日收盘价）
const { batchGetDailyMock } = vi.hoisted(() => ({
  batchGetDailyMock:
    vi.fn<(symbols: string[], date: string, period?: string) => Promise<Map<string, { close: number }>>>(),
}));

vi.mock('../../src/services/marketData.js', () => ({
  batchGetDaily: batchGetDailyMock,
  getDailyBySymbol: vi.fn(),
  getDailyRange: vi.fn(),
  batchGetDailyRange: vi.fn(),
  batchGetLatestClose: vi.fn(),
  isTradingDay: vi.fn(),
  getLatestTradingDay: vi.fn(),
  resolveLatestQuoteDate: vi.fn().mockResolvedValue(null),
  resolveTargetTradeDate: vi.fn().mockResolvedValue(null),
  toDateString: (v: unknown) => String(v),
}));

const { ConfigStore } = await import('../../src/config/configStore.js');
const { insertAssetStatSnapshots } = await import('../../src/services/assetStat.js');

function cleanup(): void {
  (ConfigStore as any)._instance = null;
  process.env.SQLITE_DB_PATH = TEST_DB;
}

afterAll(() => {
  if (ORIGINAL_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

/** 造用户，返回 user_id（幂等：已存在则忽略）*/
function seedUser(username: string): number {
  const db = ConfigStore.getInstance().db;
  db.prepare(
    "INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, 'user')",
  ).run(username, 'x');
  return Number(db.prepare('SELECT id FROM user_account WHERE username = ?').get(username)?.id);
}

/** 造交易记录 */
function seedTrade(
  userId: number,
  assetCode: string,
  tradeType: string,
  quantity: number,
  price: number,
  fee: number,
  date: string,
): void {
  const db = ConfigStore.getInstance().db;
  db.prepare(
    `INSERT INTO user_trade_record
       (user_id, asset_code, trade_type, quantity, price, fee, trade_date, trade_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, assetCode, tradeType, quantity, price, fee, date, '09:30:00');
}

/** 读快照 */
function readSnapshot(userId: number, tradeDate: string) {
  const db = ConfigStore.getInstance().db;
  return db
    .prepare(
      `SELECT total_assets_price_yield, total_assets_actual_yield,
              total_profit_price, total_profit_actual
       FROM user_asset_stat WHERE user_id = ? AND trade_date = ?`,
    )
    .get(userId, tradeDate) as
      | {
          total_assets_price_yield: number;
          total_assets_actual_yield: number;
          total_profit_price: number;
          total_profit_actual: number;
        }
      | undefined;
}

const TRADE_DATE = '2026-10-15';

/** mock batchGetDaily：给定 symbol→close 映射 */
function mockPrices(prices: Record<string, number>): void {
  batchGetDailyMock.mockImplementation(async (symbols: string[]) => {
    const m = new Map<string, { close: number }>();
    for (const s of symbols) m.set(s, { close: prices[s] ?? 0 });
    return m;
  });
}

describe('assetStat — insertAssetStatSnapshots', () => {
  afterEach(() => {
    // 清空数据，避免跨测试泄漏（先子表后父表）
    const cs = (ConfigStore as any)._instance;
    if (cs) {
      const db = cs.db;
      try {
        db.exec('DELETE FROM user_trade_record');
        db.exec('DELETE FROM user_asset_stat');
        db.exec('DELETE FROM user_asset_rel');
        db.exec('DELETE FROM user_account');
      } catch {
        /* 首次运行表可能尚未建好 */
      }
    }
    cleanup();
    vi.restoreAllMocks();
    batchGetDailyMock.mockReset();
    batchGetDailyMock.mockResolvedValue(new Map());
  });

  it('空用户表 → inserted=0', async () => {
    const result = await insertAssetStatSnapshots(TRADE_DATE);
    expect(result.inserted).toBe(0);
  });

  it('无持仓无分红用户 → 全零快照', async () => {
    const userId = seedUser('zero_user');
    const result = await insertAssetStatSnapshots(TRADE_DATE);
    expect(result.inserted).toBe(1);
    const snap = readSnapshot(userId, TRADE_DATE);
    expect(snap).toBeDefined();
    expect(snap!.total_assets_price_yield).toBe(0);
    expect(snap!.total_assets_actual_yield).toBe(0);
    expect(snap!.total_profit_price).toBe(0);
    expect(snap!.total_profit_actual).toBe(0);
  });

  it('纯价格上涨（无分红）→ priceYield 正确，actualYield = priceYield', async () => {
    const userId = seedUser('price_up');
    // 买入 1000 股 @ 10 元，手续费 5 元 → costBasis = 10005
    seedTrade(userId, 'sh600000', 'buy', 1000, 10, 5, '2026-10-01');
    mockPrices({ sh600000: 12 });

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    const costBasis = 1000 * 10 + 5; // 10005
    const priceProfit = 1000 * 12 - costBasis; // 1995
    const expectedPriceYield = priceProfit / costBasis; // ~0.19939

    expect(snap.total_profit_price).toBeCloseTo(priceProfit, 4);
    expect(snap.total_assets_price_yield).toBeCloseTo(expectedPriceYield, 6);
    // 无分红 → actual = price
    expect(snap.total_profit_actual).toBeCloseTo(priceProfit, 4);
    expect(snap.total_assets_actual_yield).toBeCloseTo(expectedPriceYield, 6);
  });

  it('价格下跌 + 有分红 → actualYield > priceYield（分红补差）', async () => {
    const userId = seedUser('price_down_div');
    // 买入 500 股 @ 20 元，手续费 10 元 → costBasis = 10010
    seedTrade(userId, 'sh600000', 'buy', 500, 20, 10, '2026-09-01');
    // 分红 500 股 × 1 元 = 500 元
    seedTrade(userId, 'sh600000', 'dividend', 500, 1, 0, '2026-10-05');
    mockPrices({ sh600000: 18 });

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    const costBasis = 500 * 20 + 10; // 10010
    const priceProfit = 500 * 18 - costBasis; // -1010
    const actualProfit = priceProfit + 500; // -510
    const expectedPriceYield = priceProfit / costBasis; // -0.100899...
    const expectedActualYield = actualProfit / costBasis; // -0.050949...

    expect(snap.total_profit_price).toBeCloseTo(priceProfit, 4);
    expect(snap.total_profit_actual).toBeCloseTo(actualProfit, 4);
    expect(snap.total_assets_price_yield).toBeCloseTo(expectedPriceYield, 6);
    expect(snap.total_assets_actual_yield).toBeCloseTo(expectedActualYield, 6);
    // 分红补差后 actual 收益率比 price 高（亏损更少）
    expect(snap.total_assets_actual_yield).toBeGreaterThan(snap.total_assets_price_yield);
  });

  it('价格不变 + 有分红 → priceYield≈0, actualYield>0', async () => {
    const userId = seedUser('flat_div');
    // 买入 200 股 @ 5 元，手续费 2 元 → costBasis = 1002
    seedTrade(userId, 'sz000001', 'buy', 200, 5, 2, '2026-09-15');
    // 分红 200 股 × 0.3 元 = 60 元
    seedTrade(userId, 'sz000001', 'dividend', 200, 0.3, 0, '2026-10-01');
    mockPrices({ sz000001: 5 });

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    const costBasis = 200 * 5 + 2; // 1002
    const priceProfit = 200 * 5 - costBasis; // -2
    const actualProfit = priceProfit + 60; // 58
    const expectedPriceYield = priceProfit / costBasis; // -0.001996...
    const expectedActualYield = actualProfit / costBasis; // 0.057884...

    expect(snap.total_assets_price_yield).toBeCloseTo(expectedPriceYield, 6);
    expect(snap.total_assets_actual_yield).toBeCloseTo(expectedActualYield, 6);
    expect(snap.total_assets_actual_yield).toBeGreaterThan(0);
  });

  it('多标持仓 → 合计市值/成本正确', async () => {
    const userId = seedUser('multi');
    // 标的 A：买 100 @ 10, fee 1 → costBasis_A = 1001
    seedTrade(userId, 'sh600000', 'buy', 100, 10, 1, '2026-09-01');
    // 标的 B：买 200 @ 20, fee 2 → costBasis_B = 4002
    seedTrade(userId, 'sh600036', 'buy', 200, 20, 2, '2026-09-01');
    // 分红 A：100 * 0.5 = 50
    seedTrade(userId, 'sh600000', 'dividend', 100, 0.5, 0, '2026-10-01');
    mockPrices({ sh600000: 11, sh600036: 22 });

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    const totalCostBasis = 1001 + 4002; // 5003
    const totalMarketValue = 100 * 11 + 200 * 22; // 5500
    const priceProfit = totalMarketValue - totalCostBasis; // 497
    const actualProfit = priceProfit + 50; // 547
    const expectedPriceYield = priceProfit / totalCostBasis; // ~0.099340
    const expectedActualYield = actualProfit / totalCostBasis; // ~0.109334

    expect(snap.total_profit_price).toBeCloseTo(priceProfit, 4);
    expect(snap.total_profit_actual).toBeCloseTo(actualProfit, 4);
    expect(snap.total_assets_price_yield).toBeCloseTo(expectedPriceYield, 6);
    expect(snap.total_assets_actual_yield).toBeCloseTo(expectedActualYield, 6);
  });

  it('batchGetDaily 返回空 Map（DuckDB 无数据）→ close=0 兜底', async () => {
    const userId = seedUser('no_data');
    seedTrade(userId, 'sh600000', 'buy', 100, 10, 1, '2026-09-01');
    batchGetDailyMock.mockResolvedValue(new Map());

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    const costBasis = 100 * 10 + 1; // 1001
    const priceProfit = -costBasis; // close=0 → marketValue=0 → -1001
    expect(snap.total_profit_price).toBeCloseTo(priceProfit, 4);
    expect(snap.total_assets_price_yield).toBeCloseTo(priceProfit / costBasis, 6); // -1
  });

  it('纯分红用户（无买卖记录）→ 只写分红收益', async () => {
    const userId = seedUser('div_only');
    // 只有分红记录，没有买卖
    seedTrade(userId, 'sh600000', 'dividend', 300, 0.8, 0, '2026-10-01');
    batchGetDailyMock.mockResolvedValue(new Map());

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    // 无持仓 → marketValue=0, costBasis=0
    // 分红 = 300 * 0.8 = 240
    const dividends = 240;
    // priceProfit = 0 - 0 = 0
    // actualProfit = 0 + 240 = 240
    // priceYield: costBasis=0 → 0（除零保护）
    // actualYield: costBasis=0 → 0（除零保护）
    expect(snap.total_profit_price).toBe(0);
    expect(snap.total_profit_actual).toBe(dividends);
    expect(snap.total_assets_price_yield).toBe(0);
    expect(snap.total_assets_actual_yield).toBe(0);
  });

  it('加仓后成本正确（移动加权）', async () => {
    const userId = seedUser('add_buy');
    // 第一次买 100 @ 10, fee 1 → cost=1001
    seedTrade(userId, 'sh600000', 'buy', 100, 10, 1, '2026-09-01');
    // 加仓 100 @ 12, fee 1.5 → totalCostBasis = 1001 + 1200 + 1.5 = 2202.5, qty=200
    seedTrade(userId, 'sh600000', 'add', 100, 12, 1.5, '2026-09-15');
    mockPrices({ sh600000: 11 });

    await insertAssetStatSnapshots(TRADE_DATE);
    const snap = readSnapshot(userId, TRADE_DATE)!;

    const costBasis = 100 * 10 + 1 + 100 * 12 + 1.5; // 2202.5
    const priceProfit = 200 * 11 - costBasis; // -2.5
    expect(snap.total_profit_price).toBeCloseTo(priceProfit, 4);
    expect(snap.total_assets_price_yield).toBeCloseTo(priceProfit / costBasis, 6);
  });
});
