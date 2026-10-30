/**
 * T152 · K 线交易标记（路由集成）
 *
 * 覆盖：
 * - GET /api/quote/:symbol/kline 响应含 trades[]
 * - 全历史回放（窗口首日买入不是 open 时保持 add）
 * - 4 类标记 / 同日逐笔 / 窗口过滤
 * - 分红、送股、转增、软删除不返回
 * - qfq / hfq / bfq / raw 的 adj_price
 * - 交易查询失败降级 trades: []，K 线仍 200
 * - 跨券商合并持仓（不按 broker_code 分组）
 *
 * ⚠️ DuckDB 全 mock（与 t53-kline.test.ts 同款），CI 无真实行情库也能跑。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from '../integration/_helpers.js';
import type { TestAppBundle } from '../integration/_helpers.js';
import { makeUserToken } from '../integration/_helpers.js';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  adj_factor?: number;
}

const BAR_COUNT = 120;
const START = Date.UTC(2024, 0, 1);

function makeBars(base: number, adjFactor?: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const c = base + i;
    const date = new Date(START + i * 86_400_000).toISOString().slice(0, 10);
    bars.push({
      date,
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1000 + i,
      amount: c * 1000,
      ...(adjFactor === undefined ? {} : { adj_factor: adjFactor }),
    });
  }
  return bars.reverse();
}

const duckMod = await import('../../src/db/duckdb.js');
const _querySpy = vi.spyOn(duckMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
  if (sql.includes('raw_symbol_class')) return [{ class: 'stock' }];
  if (sql.includes('FROM v_stock_qfq')) return makeBars(100, 1.5);
  if (sql.includes('FROM v_stock_hfq')) return makeBars(300, 2.5);
  if (sql.includes('FROM v_stock_bfq')) return makeBars(200);
  if (sql.includes('FROM raw_kline_daily')) return makeBars(700);
  return [];
});

let bundle: TestAppBundle;

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  bundle.db.db.prepare('DELETE FROM user_trade_record').run();
  bundle.db.db.prepare("DELETE FROM system_log WHERE log_type = 'trade'").run();
});

function headers(token = bundle.adminToken): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface InsertTradeOpts {
  userId?: number;
  assetCode: string;
  tradeType: string;
  tradeDate: string;
  tradeTime?: string | null;
  quantity: number;
  price: number;
  fee?: number;
  isDeleted?: number;
  brokerCode?: string | null;
}

function insertTrade(opts: InsertTradeOpts): void {
  bundle.db.db
    .prepare(
      `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
          broker_code, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.userId ?? bundle.userId,
      opts.assetCode,
      opts.tradeType,
      opts.tradeDate,
      opts.tradeTime === undefined ? '09:30:00' : opts.tradeTime,
      opts.quantity,
      opts.price,
      opts.fee ?? 0,
      opts.brokerCode ?? null,
      opts.isDeleted ?? 0,
    );
}

interface TradeResponse {
  id: number;
  trade_date: string;
  trade_time: string | null;
  trade_type: string;
  marker_type: string;
  quantity: number;
  price: number;
  adj_price: number;
}

async function getTrades(symbol: string, fq = 'qfq'): Promise<{ status: number; trades: TradeResponse[] }> {
  const res = await bundle.app.inject({
    method: 'GET',
    url: `/api/quote/${symbol}/kline?fq=${fq}&days=500`,
    headers: headers(),
  });
  const body = JSON.parse(res.body) as { data?: { trades?: TradeResponse[] } };
  return { status: res.statusCode, trades: body.data?.trades ?? [] };
}

describe('T152 · trades[] 契约', () => {
  const SYMBOL = 'sh600001';

  it('全历史回放 + 跨券商合并 + 4 类标记 + 同日逐笔', async () => {
    // 窗口外（2023-12）已有一笔买入 —— 窗口首日买入必须判 add，不能判 open
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2023-12-01',
      quantity: 100,
      price: 8,
      brokerCode: 'A',
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-01',
      quantity: 100,
      price: 10,
      brokerCode: 'B',
    });
    // 同日两笔（不同时间）必须逐笔返回，不能合并
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-02',
      tradeTime: '09:31:00',
      quantity: 50,
      price: 11,
      brokerCode: 'A',
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'add',
      tradeDate: '2024-01-02',
      tradeTime: '14:00:00',
      quantity: 50,
      price: 11.5,
      brokerCode: 'B',
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'reduce',
      tradeDate: '2024-01-03',
      quantity: 80,
      price: 12,
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'clear',
      tradeDate: '2024-01-04',
      quantity: 220,
      price: 13,
    });

    const { status, trades } = await getTrades(SYMBOL);
    expect(status).toBe(200);
    // 窗口外的 2023-12 记录不返回；窗口内 5 笔逐笔返回
    expect(trades.map((t) => t.trade_date)).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
    ]);
    expect(trades.map((t) => t.marker_type)).toEqual(['add', 'add', 'add', 'reduce', 'close']);
    expect(trades.map((t) => t.trade_type)).toEqual(['buy', 'buy', 'add', 'reduce', 'clear']);
    expect(trades[0].trade_time).toBe('09:30:00');
    // qfq 因子 1.5
    expect(trades[0].adj_price).toBeCloseTo(15, 6);
    expect(trades[0].price).toBe(10);
    // 同日两笔保留各自时间
    expect(trades[1].trade_time).toBe('09:31:00');
    expect(trades[2].trade_time).toBe('14:00:00');
  });

  it('窗口首日无更早历史 → 买入判 open', async () => {
    const SYMBOL = 'sh600002';
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-01',
      quantity: 100,
      price: 10,
    });
    const { trades } = await getTrades(SYMBOL);
    expect(trades).toHaveLength(1);
    expect(trades[0].marker_type).toBe('open');
  });

  it('bonus / dividend / transfer / 软删除不返回；bonus 仍参与后续持仓推导', async () => {
    const SYMBOL = 'sh600003';
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-01',
      quantity: 100,
      price: 10,
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'bonus',
      tradeDate: '2024-01-02',
      quantity: 100,
      price: 0,
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'dividend',
      tradeDate: '2024-01-03',
      quantity: 100,
      price: 0.5,
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'transfer',
      tradeDate: '2024-01-04',
      quantity: 100,
      price: 0,
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-05',
      quantity: 100,
      price: 11,
      isDeleted: 1,
    });
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'reduce',
      tradeDate: '2024-01-06',
      quantity: 150,
      price: 12,
    });

    const { trades } = await getTrades(SYMBOL);
    expect(trades.map((t) => t.trade_type)).toEqual(['buy', 'reduce']);
    // 送股后持仓 200，卖 150 仍剩 50 ⇒ reduce；若 bonus 被忽略则会误判 close
    expect(trades[1].marker_type).toBe('reduce');
  });

  it('qfq / hfq / bfq / raw 的 adj_price', async () => {
    const SYMBOL = 'sh600004';
    insertTrade({
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-02',
      quantity: 100,
      price: 10,
    });

    expect((await getTrades(SYMBOL, 'qfq')).trades[0].adj_price).toBeCloseTo(15, 6);
    expect((await getTrades(SYMBOL, 'hfq')).trades[0].adj_price).toBeCloseTo(25, 6);
    expect((await getTrades(SYMBOL, 'bfq')).trades[0].adj_price).toBe(10);
    expect((await getTrades(SYMBOL, 'raw')).trades[0].adj_price).toBe(10);
  });

  it('user_id 只取 JWT：看不到其他用户的交易', async () => {
    const SYMBOL = 'sh600005';
    const otherId = 999001;
    bundle.db.db
      .prepare(
        `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
      )
      .run(otherId, 't152_other', 'dummy');
    insertTrade({
      userId: otherId,
      assetCode: SYMBOL,
      tradeType: 'buy',
      tradeDate: '2024-01-02',
      quantity: 100,
      price: 10,
    });

    const { trades } = await getTrades(SYMBOL);
    expect(trades).toEqual([]);

    const otherToken = makeUserToken(otherId, 't152_other');
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/quote/${SYMBOL}/kline?fq=qfq`,
      headers: headers(otherToken),
    });
    const body = JSON.parse(res.body) as { data: { trades: TradeResponse[] } };
    expect(body.data.trades).toHaveLength(1);
  });

  it('交易查询失败 → 降级 trades: []，K 线仍 200，并写 WARN', async () => {
    const SYMBOL = 'sh600006';
    const db = bundle.db.db;
    db.exec('ALTER TABLE user_trade_record RENAME TO user_trade_record_t152_bak');
    try {
      const res = await bundle.app.inject({
        method: 'GET',
        url: `/api/quote/${SYMBOL}/kline?fq=qfq`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: { klines: unknown[]; trades: unknown[] } };
      expect(body.data.klines.length).toBeGreaterThan(0);
      expect(body.data.trades).toEqual([]);

      const log = db
        .prepare(
          `SELECT level, message FROM system_log
           WHERE log_type = 'trade' AND level = 'WARN'
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as { level: string; message: string } | undefined;
      expect(log?.level).toBe('WARN');
      expect(log?.message).toContain('交易标记');
    } finally {
      db.exec('ALTER TABLE user_trade_record_t152_bak RENAME TO user_trade_record');
    }
  });
});
