/**
 * kline-signal-isolation.test.ts —— K 线路由信号查询的 3 个契约缺口
 *
 * 覆盖：
 *   🔴 P1（越权读取）：`GET /api/quote/:symbol/kline` 的信号查询原先**只按 `asset_code` 过滤**
 *      ⇒ 多用户部署时会下发**别人的信号**（连别人的 `metrics_json` 指标明细一起）。
 *      → 断言：用户 A 的 token 查标的 X ⇒ 响应 signals **只含 A 的**，不含 B 的。
 *   🔴 P1（防伪造）：请求里伪造 `?user_id=B` **无效**（user_id 只从 JWT 取）。
 *   🟡 P2-1（形状一致性）：`klines` 为空时响应**必须有 `signals` 键**且为 `[]`。
 *   🟡 P2-2（口径统一）：`GET /api/signal` 与 K 线的信号**集合口径一致**
 *      （同一用户 + 同一标的 + >20 条时，两个端点返回同一个行集合）。
 *
 * ⚠️ DuckDB 全 mock（与 t53-kline.test.ts / t70-kline-signal-metrics.test.ts 同款）：
 *    本文件不依赖真实行情库，CI 的 12KB 空壳行情库环境下也能跑。
 * ⚠️ 走 `createTestApp()` ⇒ 带全局 `onRequest` 鉴权钩子（真实 JWT 链路），
 *    不用手工注入 request.user —— 否则测不到「user_id 从 JWT 取」这条断言。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, cleanupIntegrationTest, makeUserToken } from '../integration/_helpers.js';
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

/** 造 n 根已知收盘价的日线，返回**降序**（与 DuckDB `ORDER BY date DESC` 一致） */
function makeBars(n: number, base: number): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const c = base + i;
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    bars.push({
      date,
      open: c,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1000 + i,
      amount: c * 1000,
    });
  }
  return bars.reverse();
}

const BAR_COUNT = 120;
const SYMBOL = 'sh600000';

/** 行情 mock 模式：`normal` 有日线 / `empty` 无日线（触发 klines 为空分支） */
type BarMode = 'normal' | 'empty';
let barMode: BarMode = 'normal';

const duckMod = await import('../../src/db/duckdb.js');
vi.spyOn(duckMod, 'queryDuckDB').mockImplementation(async (sql: string) => {
  if (sql.includes('raw_symbol_class')) return [{ class: 'stock' }];
  if (sql.includes('FROM v_stock_qfq')) {
    // ⚠️ 必须**每次返回新数组** —— 路由里 `rows.reverse()` 会就地翻转 mock 返回的数组，
    //    复用同一个数组会让第 2 次调用的顺序与第 1 次相反（假绿/假红随机）。
    return barMode === 'empty' ? [] : makeBars(BAR_COUNT, 100);
  }
  return [];
});

/** 用户 B（与用户 A = 管理员 隔离）*/
const USER_B_ID = 99301;
const USER_B_NAME = 'kline_scope_user_b';

let bundle: TestAppBundle;
let userBToken: string;

beforeAll(async () => {
  bundle = await createTestApp();
  bundle.db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role)
       VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(USER_B_ID, USER_B_NAME);
  userBToken = makeUserToken(USER_B_ID, USER_B_NAME);
});

afterAll(async () => {
  await bundle.app.close();
  cleanupIntegrationTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  barMode = 'normal';
  bundle.db.db.prepare('DELETE FROM user_strategy_signal WHERE asset_code = ?').run(SYMBOL);
});

/** 插入一条信号（`userId` 缺省 = 用户 A = 管理员）*/
function insertSignal(opts: {
  userId?: number;
  tradeDate: string;
  pluginId: string;
  direction?: string;
  label?: string;
  strength?: number | null;
  metricsJson?: string | null;
  assetCode?: string;
  isDeleted?: number;
}): void {
  bundle.db.db
    .prepare(
      `INSERT INTO user_strategy_signal
         (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label, strength, metrics_json, is_final, is_deleted)
       VALUES (?, ?, ?, 'monitor', ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      opts.userId ?? bundle.userId,
      opts.assetCode ?? SYMBOL,
      opts.pluginId,
      opts.tradeDate,
      opts.direction ?? 'buy',
      opts.label ?? '测试信号',
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

async function getKline(token: string, url: string): Promise<{ raw: string; data: Record<string, unknown> }> {
  const res = await bundle.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
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

describe('P1 · K 线路由的 signals 必须按 user_id 隔离', () => {
  it('用户 A 的 token 查标的 X ⇒ signals 只含 A 的信号，不含 B 的', async () => {
    // A 的信号
    insertSignal({
      tradeDate: '2026-10-10',
      pluginId: 'a_only',
      label: 'A 的信号',
      metricsJson: '{"who":"A"}',
    });
    // B 的信号（**同一标的**、日期更近 —— 排序上更靠前，最容易被误下发）
    insertSignal({
      userId: USER_B_ID,
      tradeDate: '2026-10-20',
      pluginId: 'b_only',
      label: 'B 的信号',
      metricsJson: '{"who":"B"}',
    });

    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);

    // A 自己的信号在
    expect(signals.length).toBe(1);
    expect(signals[0].plugin_id).toBe('a_only');
    expect(signals[0].metrics_json).toBe('{"who":"A"}');

    // 🔴 B 的信号**绝不能**出现（含指标明细）
    expect(signals.map((s) => s.plugin_id)).not.toContain('b_only');
    expect(signals.map((s) => s.label)).not.toContain('B 的信号');
    expect(signals.map((s) => s.metrics_json)).not.toContain('{"who":"B"}');
  });

  it('用户 B 的 token 查同一标的 ⇒ 只看到 B 的信号（隔离是双向的）', async () => {
    insertSignal({
      tradeDate: '2026-10-10',
      pluginId: 'a_only',
      metricsJson: '{"who":"A"}',
    });
    insertSignal({
      userId: USER_B_ID,
      tradeDate: '2026-10-20',
      pluginId: 'b_only',
      metricsJson: '{"who":"B"}',
    });

    const { data } = await getKline(userBToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);

    expect(signals.length).toBe(1);
    expect(signals[0].plugin_id).toBe('b_only');
    expect(signals.map((s) => s.plugin_id)).not.toContain('a_only');
  });

  it('伪造 ?user_id=B 无效（A 的 token 仍只返回 A 的信号）', async () => {
    insertSignal({
      tradeDate: '2026-10-10',
      pluginId: 'a_only',
      metricsJson: '{"who":"A"}',
    });
    insertSignal({
      userId: USER_B_ID,
      tradeDate: '2026-10-20',
      pluginId: 'b_only',
      metricsJson: '{"who":"B"}',
    });

    const { data } = await getKline(
      bundle.adminToken,
      `/api/quote/${SYMBOL}/kline?fq=qfq&user_id=${USER_B_ID}`,
    );
    const plugins = signalsOf(data).map((s) => s.plugin_id);

    expect(plugins).toEqual(['a_only']);
    expect(plugins).not.toContain('b_only');
  });

  it('伪造 user_id 也不能「反向」拿到别人的信号（B 的 token + ?user_id=A 仍是 B 的）', async () => {
    insertSignal({
      tradeDate: '2026-10-10',
      pluginId: 'a_only',
      metricsJson: '{"who":"A"}',
    });
    insertSignal({
      userId: USER_B_ID,
      tradeDate: '2026-10-20',
      pluginId: 'b_only',
      metricsJson: '{"who":"B"}',
    });

    const { data } = await getKline(userBToken, `/api/quote/${SYMBOL}/kline?fq=qfq&user_id=${bundle.userId}`);
    const plugins = signalsOf(data).map((s) => s.plugin_id);

    expect(plugins).toEqual(['b_only']);
    expect(plugins).not.toContain('a_only');
  });

  it('软删除的信号不下发（用户隔离不得放宽 is_deleted 口径）', async () => {
    insertSignal({ tradeDate: '2026-10-10', pluginId: 'a_alive' });
    insertSignal({ tradeDate: '2026-10-11', pluginId: 'a_deleted', isDeleted: 1 });

    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    expect(signalsOf(data).map((s) => s.plugin_id)).toEqual(['a_alive']);
  });
});

describe('P2-1 · klines 为空时响应仍含 signals 键（形状一致性）', () => {
  it('无日线 → 200 且 signals 存在、为空数组', async () => {
    barMode = 'empty';
    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);

    expect(data.klines).toEqual([]);
    expect(data.indicators).toBeNull();
    // 🔴 形状一致性：`signals` 键**必须存在**（前端不必写 Array.isArray 兜底）
    expect('signals' in data).toBe(true);
    expect(Array.isArray(data.signals)).toBe(true);
    expect(data.signals).toEqual([]);
  });

  it('无日线时**别的用户**的信号也不会「漏」进来（空集 + 隔离双保险）', async () => {
    barMode = 'empty';
    insertSignal({
      userId: USER_B_ID,
      tradeDate: '2026-10-20',
      pluginId: 'b_only',
      metricsJson: '{"who":"B"}',
    });

    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    expect(data.signals).toEqual([]);
  });

  it('有日线时 signals 也是数组（同一形状，两条分支一致）', async () => {
    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    expect(Array.isArray(data.signals)).toBe(true);
    expect(data.signals).toEqual([]);
  });
});

describe('P2-2 · K 线与 GET /api/signal 的信号集合口径一致', () => {
  /** 造 25 条信号（>20 ⇒ 触发「最近 N 条 vs 最早 N 条」的分歧）*/
  function seed25(): void {
    for (let i = 1; i <= 25; i++) {
      insertSignal({
        tradeDate: `2026-10-${String(i).padStart(2, '0')}`,
        pluginId: `p_${String(i).padStart(2, '0')}`,
        metricsJson: '{"i":' + i + '}',
      });
    }
  }

  async function getSignalList(url: string): Promise<Array<{ trade_date: string; plugin_id: string }>> {
    const res = await bundle.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${bundle.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: Array<{ trade_date: string; plugin_id: string }>;
      pagination: { total: number; totalPages: number };
    };
    expect(body.pagination.total).toBe(25);
    return body.data;
  }

  it('同一用户 + 同一标的 + 25 条信号 ⇒ 两端返回**同一个行集合**', async () => {
    seed25();

    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    const klineSignals = signalsOf(data);

    // 默认 page_size = 20（与 SIGNAL_LIMIT 同值）
    const list = await getSignalList(`/api/signal?asset_code=${SYMBOL}`);

    const key = (r: { trade_date: string; plugin_id: string }) => `${r.trade_date}|${r.plugin_id}`;
    expect(klineSignals.length).toBe(20);
    expect(list.length).toBe(20);
    expect(klineSignals.map(key).sort()).toEqual(list.map(key).sort());
  });

  it('两端取的都是**最近 20 条**（不是最早的 20 条），且**按 trade_date 升序**排列', async () => {
    seed25();

    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    const klineDates = signalsOf(data).map((s) => s.trade_date);

    const list = await getSignalList(`/api/signal?asset_code=${SYMBOL}`);
    const listDates = list.map((r) => r.trade_date);

    // 最近 20 条 = 2026-10-06 ~ 2026-10-25（最早的 5 条 = 10-01 ~ 10-05 落在窗口外）
    expect(klineDates[0]).toBe('2026-10-06');
    expect(klineDates[klineDates.length - 1]).toBe('2026-10-25');
    expect(listDates[0]).toBe('2026-10-06');
    expect(listDates[listDates.length - 1]).toBe('2026-10-25');

    // 页内仍然升序（G5.5「signals 升序」不受影响）
    expect([...klineDates].sort()).toEqual(klineDates);
    expect([...listDates].sort()).toEqual(listDates);
  });

  it('GET /api/signal 第 2 页 = 更早的 5 条（窗口向后翻页）', async () => {
    seed25();
    const page2 = await getSignalList(`/api/signal?asset_code=${SYMBOL}&page=2`);
    expect(page2.map((r) => r.trade_date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
  });

  it('K 线的 signals 仍是**升序**且长度封顶 20（回归护栏）', async () => {
    seed25();
    const { data } = await getKline(bundle.adminToken, `/api/quote/${SYMBOL}/kline?fq=qfq`);
    const signals = signalsOf(data);
    expect(signals.length).toBe(20);
    const dates = signals.map((s) => s.trade_date);
    expect([...dates].sort()).toEqual(dates);
  });
});
