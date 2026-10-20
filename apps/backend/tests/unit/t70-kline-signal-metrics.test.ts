/**
 * t70-kline-signal-metrics.test.ts — K 线路由补下发 `metrics_json`（T70 / T71 配套）
 *
 * 背景：
 *   `GET /api/quote/:symbol/kline` 原先的信号 SELECT 只取
 *   `trade_date / direction / label / strength / plugin_id` ⇒ **不下发信号指标明细**。
 *   前端为了 hover tooltip（F-K8）不得不**再发一次** `GET /api/signal?asset_code=` 补取
 *   ⇒ 多一次网络往返（PRD §6.3「零网络请求」类要求被破坏）。
 *
 * 本文件覆盖：
 *   ① `signals[]` 每项**必含** `metrics_json` 字段（null / 空对象 / 有内容 三种都正确下发）
 *   ② **既有字段一个不少**（trade_date / direction / label / strength / plugin_id 逐字段断言）
 *   ③ 与 `GET /api/signal` 中同一信号的 `metrics_json` **逐字节一致**（两份端点口径统一）
 *   ④ **体积护栏**：带明细后响应体的增幅有界（明细不会把响应撑爆）
 *   ⑤ 软删除的信号不出现；`SIGNAL_LIMIT`（近 20 条）仍然生效
 *
 * ⚠️ DuckDB 全 mock（与 t53-kline.test.ts 同款做法）：本文件不依赖真实行情库，
 *    CI 的 12KB 空壳行情库环境下也能跑。
 * ⚠️ `/api/quote/:symbol/kline` 不在 PUBLIC_ROUTES 内，必须带 Bearer token。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, cleanupIntegrationTest } from '../integration/_helpers.js';
import type { TestAppBundle } from '../integration/_helpers.js';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/** 造 n 根日线（**降序**，与 DuckDB `ORDER BY date DESC` 一致） */
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

const BAR_COUNT = 120;
const SYMBOL = 'sh600000';

const duckMod = await import('../../src/db/duckdb.js');
vi.spyOn(duckMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
  if (sql.includes('raw_symbol_class')) return [{ class: 'stock' }];
  if (sql.includes('FROM v_stock_qfq')) return makeBars(BAR_COUNT, 100);
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
  bundle.db.db.prepare('DELETE FROM user_strategy_signal WHERE asset_code = ?').run(SYMBOL);
});

function headers(): Record<string, string> {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

/** 插入一条信号（`metrics_json` 传 null 表示库里的 NULL） */
function insertSignal(opts: {
  tradeDate: string;
  pluginId: string;
  direction?: string;
  label?: string;
  strength?: number | null;
  metricsJson?: string | null;
  isDeleted?: number;
  assetCode?: string;
}): void {
  bundle.db.db
    .prepare(
      `INSERT INTO user_strategy_signal
         (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final, is_deleted)
       VALUES (?, ?, ?, 'monitor', ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      bundle.userId,
      opts.assetCode ?? SYMBOL,
      opts.pluginId,
      opts.tradeDate,
      opts.direction ?? 'buy',
      opts.label ?? '测试信号',
      // ⚠️ 不能用 `opts.strength ?? 0.5` —— 那样「显式传 null」会被顶成 0.5，
      //    测不出「NULL 原样下发」这条断言。故用 in 判定区分「没传」与「传了 null」。
      'strength' in opts ? opts.strength : 0.5,
      'metricsJson' in opts ? opts.metricsJson : null,
      opts.isDeleted ?? 0,
    );
}

interface KlineSignal {
  trade_date: string;
  direction: string;
  label: string;
  strength: number | null;
  plugin_id: string;
  metrics_json: string | null;
}

async function getKline(url: string): Promise<{ raw: string; data: Record<string, unknown> }> {
  const res = await bundle.app.inject({
    method: 'GET',
    url,
    headers: headers(),
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as { data: Record<string, unknown> };
  return { raw: res.body, data: body.data };
}

function signalsOf(data: Record<string, unknown>): KlineSignal[] {
  const arr = data.signals;
  expect(Array.isArray(arr)).toBe(true);
  return arr as KlineSignal[];
}

describe('T70 · K 线 signals[] 必含 metrics_json', () => {
  it('每条信号都带 metrics_json 字段（即使值为 null）', async () => {
    insertSignal({ tradeDate: '2026-10-10', pluginId: 'rsi_oversold', metricsJson: null });
    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);
    expect(signals.length).toBe(1);
    // 字段必须在（哪怕是 null 也要有这个 key）
    expect('metrics_json' in signals[0]).toBe(true);
    expect(Object.keys(signals[0])).toContain('metrics_json');
    expect(signals[0].metrics_json).toBeNull();
  });

  it('metrics_json = null / 空对象 / 有内容 三种形态都原样下发', async () => {
    insertSignal({ tradeDate: '2026-10-10', pluginId: 'p_null', metricsJson: null });
    insertSignal({ tradeDate: '2026-10-11', pluginId: 'p_empty', metricsJson: '{}' });
    insertSignal({
      tradeDate: '2026-10-12',
      pluginId: 'p_content',
      metricsJson: '{"period":14,"oversold":30,"overbought":70,"days":120,"latestRSI":28.5}',
    });

    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const byPlugin = new Map(signalsOf(data).map((s) => [s.plugin_id, s]));

    expect(byPlugin.get('p_null')?.metrics_json).toBeNull();
    expect(byPlugin.get('p_empty')?.metrics_json).toBe('{}');
    expect(byPlugin.get('p_content')?.metrics_json).toBe(
      '{"period":14,"oversold":30,"overbought":70,"days":120,"latestRSI":28.5}',
    );
  });

  it('下发形态是**原始 JSON 文本**（与 /api/signal 同形态），不是解析后的对象', async () => {
    insertSignal({ tradeDate: '2026-10-12', pluginId: 'p_content', metricsJson: '{"rsi":28.5}' });
    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const sig = signalsOf(data)[0];
    expect(typeof sig.metrics_json).toBe('string');
    // 前端用同一个 parseMetricsJson 即可解析（字符串 → 对象）
    expect(JSON.parse(sig.metrics_json as string)).toEqual({ rsi: 28.5 });
  });
});

describe('T70 · 既有字段一个不少（回归护栏）', () => {
  it('signals[] 仍含全部 5 个既有字段，且值逐字段一致', async () => {
    insertSignal({
      tradeDate: '2026-10-12',
      pluginId: 'macd_cross',
      direction: 'sell',
      label: '死叉',
      strength: 0.75,
      metricsJson: '{"dif":-0.12,"dea":0.03}',
    });

    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);
    expect(signals.length).toBe(1);

    // 既有 5 个字段：一个都不能少
    expect(Object.keys(signals[0]).sort()).toEqual(
      ['direction', 'label', 'metrics_json', 'plugin_id', 'strength', 'trade_date'].sort(),
    );
    expect(signals[0].trade_date).toBe('2026-10-12');
    expect(signals[0].direction).toBe('sell');
    expect(signals[0].label).toBe('死叉');
    expect(signals[0].strength).toBe(0.75);
    expect(signals[0].plugin_id).toBe('macd_cross');
    // 新增字段
    expect(signals[0].metrics_json).toBe('{"dif":-0.12,"dea":0.03}');
  });

  it('strength 为 NULL 时下发 null（不被 0 顶替）', async () => {
    insertSignal({ tradeDate: '2026-10-12', pluginId: 'p_nostr', strength: null });
    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    expect(signalsOf(data)[0].strength).toBeNull();
  });

  it('signals 仍按 trade_date 升序（与 klines 同序），且长度上限仍是近 20 条', async () => {
    for (let i = 0; i < 30; i++) {
      const d = `2026-09-${String((i % 28) + 1).padStart(2, '0')}`;
      insertSignal({ tradeDate: d, pluginId: `p_${i}`, metricsJson: '{"x":1}' });
    }
    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);
    expect(signals.length).toBe(20);
    const dates = signals.map((s) => s.trade_date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('软删除（is_deleted=1）的信号不下发', async () => {
    insertSignal({ tradeDate: '2026-10-10', pluginId: 'p_alive', metricsJson: '{"x":1}' });
    insertSignal({
      tradeDate: '2026-10-11',
      pluginId: 'p_deleted',
      metricsJson: '{"x":2}',
      isDeleted: 1,
    });
    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const plugins = signalsOf(data).map((s) => s.plugin_id);
    expect(plugins).toEqual(['p_alive']);
  });
});

describe('T70 · 与 GET /api/signal 的 metrics_json 口径统一', () => {
  it('同一信号的 metrics_json 在两个端点**逐字节一致**', async () => {
    const raw = '{"period":14,"oversold":30,"overbought":70,"days":120,"latestRSI":28.5}';
    insertSignal({ tradeDate: '2026-10-10', pluginId: 'rsi_oversold', metricsJson: raw });
    insertSignal({ tradeDate: '2026-10-11', pluginId: 'macd_cross', metricsJson: null });

    const { data: klineData } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const klineSignals = signalsOf(klineData);

    const sigRes = await bundle.app.inject({
      method: 'GET',
      url: `/api/signal?asset_code=${SYMBOL}&page_size=200`,
      headers: headers(),
    });
    expect(sigRes.statusCode).toBe(200);
    const sigBody = JSON.parse(sigRes.body) as {
      data: Array<{
        trade_date: string;
        plugin_id: string;
        metrics_json: string | null;
      }>;
    };
    expect(Array.isArray(sigBody.data)).toBe(true);

    const key = (d: string, p: string) => `${d}|${p}`;
    const sigMap = new Map(sigBody.data.map((r) => [key(r.trade_date, r.plugin_id), r.metrics_json]));
    const klineMap = new Map(klineSignals.map((s) => [key(s.trade_date, s.plugin_id), s.metrics_json]));

    // 两个端点的信号集合一致（同一用户、同一标的）
    expect([...klineMap.keys()].sort()).toEqual([...sigMap.keys()].sort());

    for (const [k, v] of klineMap) {
      expect(v).toBe(sigMap.get(k));
    }
  });

  it('两个端点解析后的**内容**也一致（JSON.parse 后逐字段相等）', async () => {
    insertSignal({
      tradeDate: '2026-10-10',
      pluginId: 'rsi_oversold',
      metricsJson: '{"period":14,"latestRSI":28.5}',
    });
    const { data: klineData } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const sigRes = await bundle.app.inject({
      method: 'GET',
      url: `/api/signal?asset_code=${SYMBOL}&page_size=200`,
      headers: headers(),
    });
    const sigBody = JSON.parse(sigRes.body) as {
      data: Array<{ plugin_id: string; metrics_json: string | null }>;
    };
    const fromKline = JSON.parse(signalsOf(klineData)[0].metrics_json as string);
    const fromSignal = JSON.parse(
      sigBody.data.find((r) => r.plugin_id === 'rsi_oversold')?.metrics_json as string,
    );
    expect(fromKline).toEqual(fromSignal);
  });
});

describe('T70 · 体积护栏（明细不得把响应撑爆）', () => {
  it('20 条信号各带 6 键明细时，响应体积仍在合理范围', async () => {
    const metrics = JSON.stringify({
      period: 14,
      oversold: 30,
      overbought: 70,
      days: 120,
      latestRSI: 28.5,
      prevRSI: 31.2,
    });
    for (let i = 0; i < 20; i++) {
      insertSignal({
        tradeDate: `2026-10-${String(i + 1).padStart(2, '0')}`,
        pluginId: `p_${i}`,
        metricsJson: metrics,
      });
    }

    const { raw, data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);
    expect(signals.length).toBe(20);
    // **全部 20 条都带明细**（不只最近 N 条）—— 明细体积可控，无需裁剪
    expect(signals.every((s) => s.metrics_json !== null)).toBe(true);

    // ① 整包响应体积上限（120 根日线 + 20 条带明细信号）
    expect(raw.length).toBeLessThan(256 * 1024);

    // ② 明细带来的**净增量**有界：把 metrics_json 摘掉后重算整包长度
    const stripped = {
      ...data,
      signals: signals.map((s) => {
        const { metrics_json: _dropped, ...rest } = s;
        return rest;
      }),
    };
    const lenWith = JSON.stringify(data).length;
    const lenWithout = JSON.stringify(stripped).length;
    const overhead = lenWith - lenWithout;
    // 20 条 × ~95 字节 ≈ 1.9KB；给 5KB 的宽松上限做护栏
    expect(overhead).toBeGreaterThan(0);
    expect(overhead).toBeLessThan(5 * 1024);
  });

  it('单条信号的明细长度受限于插件产出的键数（≤200 字节）', async () => {
    insertSignal({
      tradeDate: '2026-10-10',
      pluginId: 'rsi_oversold',
      metricsJson: JSON.stringify({
        period: 14,
        oversold: 30,
        overbought: 70,
        days: 120,
        latestRSI: 28.5,
      }),
    });
    const { data } = await getKline(`/api/quote/${SYMBOL}/kline?fq=qfq`);
    const s = signalsOf(data)[0];
    expect((s.metrics_json as string).length).toBeLessThan(200);
  });
});
