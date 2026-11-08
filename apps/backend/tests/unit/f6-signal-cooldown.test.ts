/**
 * F6 —— 信号冷却（**只做展示层合并去重**）
 *
 * 钉死的口径（用户裁决，不可改）：
 *   ① 同策略 + 同标的 + 同方向，冷却窗口（默认 3 根 K 线、可用 `SIGNAL_COOLDOWN_BARS` 配置）内合并为一条
 *   ② 合并只发生在**展示查询**（`GET /api/signal?dedupe=1`），信号生成/交易链路一条不少
 *   ③ `cooldown_until` 生成时照写，但**只供展示判断**
 *   ④ 合并行标注「连续第 N 日选中」
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const ORIGINAL_COOLDOWN_ENV = process.env.SIGNAL_COOLDOWN_BARS;
const tmpDbPath = path.join(os.tmpdir(), `invest-f6-cooldown-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

import { ConfigStore } from '../../src/config/configStore.js';
import { registerSignalRoutes } from '../../src/routes/signal.js';
import {
  assignSignalCooldowns,
  collapseSignalsByCooldown,
  resolveSignalCooldownBars,
} from '../../src/services/signalService.js';
import type { JwtPayload } from '../../src/services/auth.js';

const TEST_USER_ID = 8831;
type AuthedRequest = FastifyRequest & { user: JwtPayload };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>;

/** 2026-11-02 是周一（2026-11-06 周五）*/
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';

interface RowFixture {
  id: number;
  plugin_id: string;
  asset_code: string;
  direction: string;
  trade_date: string;
  created_at: string;
  cooldown_until?: string | null;
}

/** 造一条纯函数入参（不落库）*/
function row(id: number, tradeDate: string, opts: Partial<RowFixture> = {}): RowFixture {
  return {
    id,
    plugin_id: 'p1',
    asset_code: 'sh600001',
    direction: 'buy',
    trade_date: tradeDate,
    created_at: `${tradeDate} 17:00:00`,
    cooldown_until: null,
    ...opts,
  };
}

function insertSignal(
  code: string,
  tradeDate: string,
  opts: {
    plugin?: string;
    direction?: 'buy' | 'sell' | 'hold';
    cooldownUntil?: string | null;
    userId?: number;
  } = {},
): void {
  db.db
    .prepare(
      `INSERT INTO user_strategy_signal
         (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label,
          strength, cooldown_until, metrics_json, is_final)
       VALUES (?, ?, ?, 'monitor', ?, ?, 'L', 0.5, ?, '{}', 1)`,
    )
    .run(
      opts.userId ?? TEST_USER_ID,
      code,
      opts.plugin ?? 'p1',
      tradeDate,
      opts.direction ?? 'buy',
      opts.cooldownUntil ?? null,
    );
}

beforeAll(async () => {
  db = ConfigStore.getInstance();
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, 'dummy-hash', 'user')`,
    )
    .run(TEST_USER_ID, 'f6_cooldown_user');

  app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    (request as AuthedRequest).user = { sub: TEST_USER_ID, username: 'f6_cooldown_user' } as JwtPayload;
  });
  await registerSignalRoutes(app);
  await app.ready();
});

beforeEach(() => {
  db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
  // 用例间隔离：任何用例污染了冷却窗口配置都在这里复位
  delete process.env.SIGNAL_COOLDOWN_BARS;
});

afterAll(async () => {
  await app.close();
  if (db) db.db.prepare('DELETE FROM user_strategy_signal WHERE user_id = ?').run(TEST_USER_ID);
  try {
    fs.rmSync(tmpDbPath, { force: true });
    fs.rmSync(`${tmpDbPath}-wal`, { force: true });
    fs.rmSync(`${tmpDbPath}-shm`, { force: true });
  } catch {
    // ignore
  }
  if (ORIGINAL_SQLITE_DB_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  if (ORIGINAL_COOLDOWN_ENV === undefined) delete process.env.SIGNAL_COOLDOWN_BARS;
  else process.env.SIGNAL_COOLDOWN_BARS = ORIGINAL_COOLDOWN_ENV;
});

describe('F6 · 窗口配置', () => {
  it('默认 3 根 K 线；SIGNAL_COOLDOWN_BARS 可配置并有上下限', () => {
    delete process.env.SIGNAL_COOLDOWN_BARS;
    expect(resolveSignalCooldownBars()).toBe(3);

    process.env.SIGNAL_COOLDOWN_BARS = '5';
    expect(resolveSignalCooldownBars()).toBe(5);

    process.env.SIGNAL_COOLDOWN_BARS = '0';
    expect(resolveSignalCooldownBars()).toBe(3);

    process.env.SIGNAL_COOLDOWN_BARS = 'abc';
    expect(resolveSignalCooldownBars()).toBe(3);

    process.env.SIGNAL_COOLDOWN_BARS = '100';
    expect(resolveSignalCooldownBars()).toBe(20);

    delete process.env.SIGNAL_COOLDOWN_BARS;
  });
});

describe('F6 · 展示层合并去重（纯函数）', () => {
  it('窗口内同策略+标的+方向合并为一条，标注连续第 N 日选中，代表行取最新', () => {
    const rows = [
      row(1, MON, { cooldown_until: THU }),
      row(2, TUE, { cooldown_until: '2026-11-06' }),
      row(3, WED, { cooldown_until: '2026-11-09' }),
    ];
    const collapsed = collapseSignalsByCooldown(rows, 3);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].consecutive_days).toBe(3);
    // 代表行 = 最新一条（其分级/强度/标签即展示值）
    expect(collapsed[0].id).toBe(3);
    expect(collapsed[0].trade_date).toBe(WED);
  });

  it('超出冷却窗口 → 不再合并（窗口按 cooldown_until 判定）', () => {
    const rows = [
      row(1, MON, { cooldown_until: TUE }),
      // 11-05 > 11-03（窗口末端）→ 断链
      row(2, THU, { cooldown_until: '2026-11-10' }),
    ];
    const collapsed = collapseSignalsByCooldown(rows, 3);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.map((r) => r.consecutive_days)).toEqual([1, 1]);
  });

  it('不同策略 / 标的 / 方向不互相合并', () => {
    const rows = [
      row(1, MON),
      row(2, MON, { plugin_id: 'p2' }),
      row(3, MON, { asset_code: 'sh600002' }),
      row(4, MON, { direction: 'sell' }),
    ];
    expect(collapseSignalsByCooldown(rows, 3)).toHaveLength(4);
  });

  it('cooldown_until 缺失（历史行）→ 用 trade_date + N 个工作日兜底', () => {
    // 周一 +3 个工作日 = 周四 ⇒ 周二/周三/周四都落在窗口内
    const rows = [row(1, MON), row(2, TUE), row(3, WED), row(4, THU)];
    const collapsed = collapseSignalsByCooldown(rows, 3);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].consecutive_days).toBe(4);
    expect(collapsed[0].trade_date).toBe(THU);

    // 仅周一一条时，周二不在窗口（bars=1 ⇒ 周一 +1 工作日 = 周二 → 应合并）
    const oneBar = collapseSignalsByCooldown([row(1, MON), row(2, TUE)], 1);
    expect(oneBar).toHaveLength(1);
    expect(oneBar[0].consecutive_days).toBe(2);
  });

  it('输出按 trade_date ASC 稳定排序（与列表契约一致）', () => {
    const rows = [
      row(3, WED, { plugin_id: 'p3' }),
      row(1, MON, { plugin_id: 'p1' }),
      row(2, TUE, { plugin_id: 'p2' }),
    ];
    const collapsed = collapseSignalsByCooldown(rows, 3);
    expect(collapsed.map((r) => r.trade_date)).toEqual([MON, TUE, WED]);
  });
});

describe('F6 · cooldown_until 回填（只写展示列，不增删信号）', () => {
  it('按交易日回填整日信号，幂等且不改变行数', async () => {
    insertSignal('sh600001', MON);
    insertSignal('sh600002', MON);

    const first = await assignSignalCooldowns(MON, TEST_USER_ID, 3);
    expect(first.updated).toBe(2);
    // 周一 +3 工作日 = 周四（行情层不可用时的工作日兜底）
    expect(first.cooldownUntil).toBe(THU);

    const countAfter = (
      db.db.prepare('SELECT COUNT(*) AS c FROM user_strategy_signal WHERE user_id = ?').get(TEST_USER_ID) as {
        c: number;
      }
    ).c;
    expect(countAfter).toBe(2);

    const second = await assignSignalCooldowns(MON, TEST_USER_ID, 3);
    expect(second.updated).toBe(2);
    expect(second.cooldownUntil).toBe(THU);
  });
});

describe('F6 · GET /api/signal?dedupe=1', () => {
  it('窗口内重复信号合并为一条，分页 total 按合并后计；不传 dedupe 保持原契约', async () => {
    insertSignal('sh600001', MON, { cooldownUntil: THU });
    insertSignal('sh600001', TUE, { cooldownUntil: '2026-11-06' });
    insertSignal('sh600001', WED, { cooldownUntil: '2026-11-09' });

    const raw = await app.inject({ method: 'GET', url: '/api/signal?page=1&page_size=20' });
    expect(raw.statusCode).toBe(200);
    const rawBody = raw.json() as {
      data: Array<{ trade_date: string; consecutive_days?: number }>;
      pagination: { total: number };
    };
    expect(rawBody.data).toHaveLength(3);
    expect(rawBody.pagination.total).toBe(3);
    expect(rawBody.data[0].consecutive_days).toBeUndefined();

    const merged = await app.inject({ method: 'GET', url: '/api/signal?page=1&page_size=20&dedupe=1' });
    expect(merged.statusCode).toBe(200);
    const mergedBody = merged.json() as {
      data: Array<{ trade_date: string; consecutive_days: number }>;
      pagination: { total: number };
      cooldown_bars: number;
      display_dedupe: boolean;
    };
    expect(mergedBody.data).toHaveLength(1);
    expect(mergedBody.data[0].trade_date).toBe(WED);
    expect(mergedBody.data[0].consecutive_days).toBe(3);
    expect(mergedBody.pagination.total).toBe(1);
    expect(mergedBody.cooldown_bars).toBe(3);
    expect(mergedBody.display_dedupe).toBe(true);
  });

  it('cooldown_bars 查询参数可覆盖窗口（有间隔的同一策略信号 → 窄窗口不合并）', async () => {
    // 历史行（无 cooldown_until）：周一与周四相隔 3 个工作日
    insertSignal('sh600001', MON);
    insertSignal('sh600001', THU);

    // 默认 3 根 K 线：周一 +3 工作日 = 周四 ⇒ 合并
    const wide = await app.inject({ method: 'GET', url: '/api/signal?page=1&page_size=20&dedupe=1' });
    const wideBody = wide.json() as { data: Array<{ consecutive_days: number }>; cooldown_bars: number };
    expect(wideBody.cooldown_bars).toBe(3);
    expect(wideBody.data).toHaveLength(1);
    expect(wideBody.data[0].consecutive_days).toBe(2);

    // 窗口收窄到 1 根：周一 +1 工作日 = 周二 ⇒ 周四超出窗口，不合并
    const narrow = await app.inject({
      method: 'GET',
      url: '/api/signal?page=1&page_size=20&dedupe=1&cooldown_bars=1',
    });
    const narrowBody = narrow.json() as {
      data: Array<{ consecutive_days: number }>;
      cooldown_bars: number;
    };
    expect(narrowBody.cooldown_bars).toBe(1);
    expect(narrowBody.data).toHaveLength(2);
  });
});
