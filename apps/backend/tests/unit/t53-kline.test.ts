/**
 * t53-kline.test.ts — T53 K 线路由能力补齐
 *
 * 覆盖 T53 验收点：
 * ① fq 四值白名单各返回 200 且映射到正确视图
 * ② 非法 fq → 400，绝不静默回落 qfq
 * ③ indicators 含 ma60（走 core 适配层），且与 calculateSMA 逐位一致
 * ④ signals 升序返回，与 klines 同序
 * ⑤ rsi / macd period 走 query 参数
 * ⑥ ETF 按 raw_symbol_class.class 路由到 v_etf_*，不硬编码 v_stock_*
 *
 * ⚠️ DuckDB 全部 mock：本测试不依赖行情库内容，可在无 data/quotes.duckdb 的 CI 环境跑。
 *    视图/列名清单由真实 DESCRIBE 实测（见汇报），此处只验证路由逻辑。
 * ⚠️ /api/kline 不在 PUBLIC_ROUTES 内，必须带 Bearer token（routes/index.ts 全局 onRequest 鉴权）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from '../integration/_helpers.js';
import type { TestAppBundle } from '../integration/_helpers.js';
import { calculateSMA } from '@invest/core';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** 造 n 根已知收盘价的日线，返回**降序**（与 DuckDB ORDER BY date DESC 一致） */
function makeBars(n: number, base: number): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const c = base + i;
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    bars.push({ date, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 + i, amount: c * 1000 });
  }
  return bars.reverse();
}

const VIEW_BASES: Record<string, number> = {
  v_stock_qfq: 100,
  v_stock_bfq: 200,
  v_stock_hfq: 300,
  v_etf_qfq: 400,
  v_etf_bfq: 500,
  v_etf_hfq: 600,
  raw_kline_daily: 700,
};

const BAR_COUNT = 120;

let symbolClass = 'stock';
const requestedViews: string[] = [];

const duckMod = await import('../../src/db/duckdb.js');
const querySpy = vi.spyOn(duckMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
  if (sql.includes('raw_symbol_class')) {
    return [{ class: symbolClass }];
  }
  const view = Object.keys(VIEW_BASES).find((v) => sql.includes(`FROM ${v}`));
  if (view) {
    requestedViews.push(view);
    return makeBars(BAR_COUNT, VIEW_BASES[view]);
  }
  return [];
});

let bundle: TestAppBundle;

beforeAll(async () => {
  bundle = await createTestApp();
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
});

afterEach(() => {
  querySpy.mockClear();
  requestedViews.length = 0;
  symbolClass = 'stock';
});

/** kline 路由需鉴权（routes/index.ts 全局 onRequest） */
function headers(): Record<string, string> {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

describe('T53 · fq 四值白名单', () => {
  const CASES: Array<{ fq: string; expectedView: string; base: number }> = [
    { fq: 'qfq', expectedView: 'v_stock_qfq', base: 100 },
    { fq: 'bfq', expectedView: 'v_stock_bfq', base: 200 },
    { fq: 'hfq', expectedView: 'v_stock_hfq', base: 300 },
    { fq: 'raw', expectedView: 'raw_kline_daily', base: 700 },
  ];

  it.each(CASES)('fq=$fq → 200 且映射到 $expectedView，首行 close=$base', async ({ fq, expectedView, base }) => {
    const res = await bundle.app.inject({ method: 'GET', url: `/api/kline/sh600000?fq=${fq}`, headers: headers() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { fq: string; klines: Array<{ close: number }> };
    };
    expect(body.data.fq).toBe(fq);
    expect(body.data.klines.length).toBe(BAR_COUNT);
    // mock 返回降序，路由反转为升序 → 首行 = 最早 = base
    expect(body.data.klines[0].close).toBe(base);
    expect(requestedViews).toContain(expectedView);
  });

  it('非法 fq → 400 PARAM_INVALID，且不查询 DuckDB（不静默回落 qfq）', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/kline/sh600000?fq=xxx', headers: headers() });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string; message: string };
    expect(body.error).toBe('PARAM_INVALID');
    expect(body.message).toContain('fq');
    expect(requestedViews).toHaveLength(0);
  });

  it('非法 symbol → 400 INVALID_SYMBOL', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/kline/badcode', headers: headers() });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('INVALID_SYMBOL');
  });
});

describe('T53 · ETF 路由', () => {
  it('class=etf 的标的走 v_etf_qfq，而不是 v_stock_qfq', async () => {
    symbolClass = 'etf';
    const res = await bundle.app.inject({ method: 'GET', url: '/api/kline/sh500001?fq=qfq', headers: headers() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { symbolClass: string; klines: Array<{ close: number }> };
    };
    expect(body.data.symbolClass).toBe('etf');
    expect(body.data.klines[0].close).toBe(VIEW_BASES.v_etf_qfq);
    expect(requestedViews).toContain('v_etf_qfq');
    expect(requestedViews).not.toContain('v_stock_qfq');
  });
});

describe('T53 · indicators 含 ma60（走 core 适配层）', () => {
  it('ma60 长度等于 klines 长度，且与 calculateSMA(closes, 60) 逐位一致', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/kline/sh600000?fq=qfq', headers: headers() });
    const body = JSON.parse(res.body) as {
      data: {
        klines: Array<{ close: number }>;
        indicators: {
          ma60: Array<number | null>;
          ma5: Array<number | null>;
          ma10: Array<number | null>;
          ma20: Array<number | null>;
        };
      };
    };
    const closes = body.data.klines.map((k) => k.close);
    expect(body.data.indicators.ma60.length).toBe(closes.length);
    expect(body.data.indicators.ma5.length).toBe(closes.length);
    expect(body.data.indicators.ma10.length).toBe(closes.length);
    expect(body.data.indicators.ma20.length).toBe(closes.length);

    const expected = calculateSMA(closes, 60);
    expect(body.data.indicators.ma60.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const actual: unknown = body.data.indicators.ma60[i];
      if (Number.isNaN(expected[i])) {
        // JSON 把 NaN 序列化成 null，两者都视为「无值」
        expect(actual === null || (typeof actual === 'number' && Number.isNaN(actual))).toBe(true);
      } else {
        expect(actual).toBe(expected[i]);
      }
    }
  });
});

describe('T53 · rsi / macd period 走 query 参数', () => {
  it('rsi_period / macd_* 透传到 indicators.params', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/kline/sh600000?fq=qfq&rsi_period=6&macd_fast=5&macd_slow=20&macd_signal=4',
      headers: headers(),
    });
    const body = JSON.parse(res.body) as {
      data: { indicators: { params: Record<string, number> } };
    };
    expect(body.data.indicators.params).toEqual({
      rsiPeriod: 6,
      macdFast: 5,
      macdSlow: 20,
      macdSignal: 4,
    });
  });

  it('非法 period → 400 PARAM_INVALID', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/api/kline/sh600000?rsi_period=1', headers: headers() });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('PARAM_INVALID');
  });
});

describe('T53 · signals 升序返回，与 klines 同序', () => {
  const SYMBOL = 'sz000001';

  it('signals 按 trade_date 升序，klines 按 date 升序', async () => {
    const insert = bundle.db.db.prepare(
      `INSERT INTO user_strategy_signal
         (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, is_final)
       VALUES (?, ?, ?, 'monitor', ?, 'buy', 't', 0.5, 1)`
    );
    // 故意乱序插入，验证路由排序
    for (const d of ['2026-10-05', '2026-10-01', '2026-10-03']) {
      insert.run(bundle.userId, SYMBOL, `p_${d}`, d);
    }

    const res = await bundle.app.inject({ method: 'GET', url: `/api/kline/${SYMBOL}?fq=qfq`, headers: headers() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: {
        klines: Array<{ date: string }>;
        signals: Array<{ trade_date: string }>;
      };
    };

    const signalDates = body.data.signals.map((s) => s.trade_date);
    expect(signalDates).toEqual(['2026-10-01', '2026-10-03', '2026-10-05']);

    const klineDates = body.data.klines.map((k) => k.date);
    const sorted = [...klineDates].sort();
    expect(klineDates).toEqual(sorted);
  });
});
