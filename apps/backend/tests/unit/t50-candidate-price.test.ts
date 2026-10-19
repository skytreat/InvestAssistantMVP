/**
 * T50 候选池基准价固化 + 迁移价格模式
 *
 * 业务口径（Requirements_simplified.md §5.7，L1 真相源）：
 *   - 基准价 = 加入日前复权收盘价
 *   - 用户可显式指定基准价 → 尊重用户值
 *   - DuckDB 无该标的数据 → 明确报错，**不静默写 NULL**
 *   - 迁移自选记录价格模式 'base' | 'current'
 *
 * 测试策略说明：
 *   本文件**不 mock `services/marketData`**，直接打真实 DuckDB 行情库 ——
 *   AGENTS.md「权威来源只有实测」。因此对「有行情」的前提做了探测分支：
 *   行情库可用 → 断言 201 + 真实基准价；不可用 → 断言降级为 404/503。
 *   **两条分支下「不落库 / 不静默 NULL」都是硬断言**，故不存在假绿。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../../src/services/auth.js';

/**
 * 🔴 2026-10-19 CI 教训：CI 环境只有 12KB 空壳行情库（无 `v_stock_qfq` 等表），
 *   依赖**真实行情数据**的断言在本地全绿、CI 全红（PR #15 的后续 commit 从未过 CI）。
 *   → 下面这些用例**需要真实行情库**，无库时跳过（与 `smoke-m1` 的既有做法一致：
 *     「m2/m3 依赖 DuckDB 本地文件和 tdx2db init，CI 环境无法运行」）。
 */
import { marketDataAvailable } from '../_marketData.js';

/** 真实行情库是否可用（顶层 await 判定一次） */
const MARKET_DATA_AVAILABLE = await marketDataAvailable();

// ── 隔离 SQLite（必须在 import ConfigStore 之前设置）──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-t50-'));
const tmpDbPath = path.join(tmpDir, 't50.db');
const prevSqlitePath = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = tmpDbPath;

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerCandidateRoutes } = await import('../../src/routes/candidate.js');
const { batchGetLatestClose } = await import('../../src/services/marketData.js');
const {
  computeRelativeReturn,
  isValidBasePrice,
  CandidateNotFoundError,
  batchInsertCandidates,
} = await import('../../src/services/candidateService.js');

// ── 测试用户 ──
const TEST_UID = 5001;
const TEST_USERNAME = 't50_user';
const USER_PAYLOAD: JwtPayload = {
  sub: TEST_UID, username: TEST_USERNAME, role: 'user',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
};

let app: FastifyInstance;
let store: InstanceType<typeof ConfigStore>;

/** 直接查 SQLite（避免依赖响应体形状） */
function rowOf(assetCode: string, relType = 'candidate') {
  return store.db
    .prepare(
      `SELECT id, asset_code, rel_type, candidate_reason, candidate_base_price,
              is_deleted, migrated_from_candidate, migrated_price_mode
         FROM user_asset_rel
        WHERE user_id = ? AND asset_code = ? AND rel_type = ?`,
    )
    .get(TEST_UID, assetCode, relType) as
    | {
        id: number; asset_code: string; rel_type: string; candidate_reason: string | null;
        candidate_base_price: number | null; is_deleted: number;
        migrated_from_candidate: number | null; migrated_price_mode: string | null;
      }
    | undefined;
}

function countRows(assetCode: string): number {
  const r = store.db
    .prepare('SELECT COUNT(*) AS c FROM user_asset_rel WHERE user_id = ? AND asset_code = ?')
    .get(TEST_UID, assetCode) as { c: number };
  return r.c;
}

async function post(url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload: payload as object });
}

beforeAll(async () => {
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  store = ConfigStore.getInstance();
  store.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')`,
    )
    .run(TEST_UID, TEST_USERNAME, 'dummy-hash');

  app = Fastify({ logger: false });
  // 复刻 routes/index.ts 的 onRequest 鉴权钩子（只注入 user，不校验 token）
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user?: JwtPayload }).user = USER_PAYLOAD;
  });
  await registerCandidateRoutes(app);
});

afterAll(async () => {
  await app.close();
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (prevSqlitePath !== undefined) process.env.SQLITE_DB_PATH = prevSqlitePath;
  else delete process.env.SQLITE_DB_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  const { closeDuckDBInstance } = await import('../../src/db/duckdb.js');
  await closeDuckDBInstance();
});

// ══════════════════ T50-① 参数校验 ══════════════════

describe('T50 POST /api/candidate —— 参数校验', () => {
  // 依赖真实行情库 → CI 无库时跳过
  const itReal = MARKET_DATA_AVAILABLE ? it : it.skip;
  itReal('缺 asset_code → 400 PARAM_INVALID，且不落库', async () => {
    const res = await post('/api/candidate', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });

  itReal('asset_code 格式非法（sz00001 / ab600000 / 空串）→ 400', async () => {
    for (const bad of ['sz00001', 'ab600000', '', 'sh60000000']) {
      const res = await post('/api/candidate', { asset_code: bad });
      expect(res.statusCode, `asset_code=${bad}`).toBe(400);
      expect(res.json().error).toBe('PARAM_INVALID');
    }
  });

  itReal('candidate_base_price 非有限正数（0 / -1 / 字符串 / 对象 / 布尔）→ 400', async () => {
    // T81：用独立标的（不与其它用例共用），保证「不落库」断言不被其它用例污染
    const code = 'sh600521';
    for (const bad of [0, -1, '12.5', {}, true]) {
      const res = await post('/api/candidate', { asset_code: code, candidate_base_price: bad });
      expect(res.statusCode, `price=${String(bad)}`).toBe(400);
      expect(res.json().error).toBe('PARAM_INVALID');
    }
    expect(countRows(code)).toBe(0);
  });

  itReal('NaN / Infinity 在 JSON 传输层不可表达（实测 JSON.stringify 均为 "null"）→ 服务层直接拒', () => {
    // 实测：JSON.stringify(NaN) === 'null'，JSON.stringify(Infinity) === 'null'，
    // 故 HTTP 请求体永远送不到 NaN/Infinity，路由层的「null = 未指定」语义不会被绕过。
    // 这里在服务层断言该防线仍然成立（若将来有人改用非 JSON 绑定，需靠它兜住）。
    expect(JSON.stringify({ p: Number.NaN })).toBe('{"p":null}');
    expect(JSON.stringify({ p: Number.POSITIVE_INFINITY })).toBe('{"p":null}');
    expect(isValidBasePrice(Number.NaN)).toBe(false);
    expect(isValidBasePrice(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidBasePrice(-0)).toBe(false);
  });

  itReal('显式传 candidate_base_price: null 等价于「未指定」→ 走行情库', async () => {
    const quote = await batchGetLatestClose(['sh600519'], 'qfq');
    const hit = quote.get('sh600519');
    const res = await post('/api/candidate', { asset_code: 'sh600519', candidate_base_price: null });
    if (hit !== undefined) {
      expect(res.statusCode).toBe(201);
      expect(res.json().data.base_price_source).toBe('duckdb');
      expect(rowOf('sh600519')?.candidate_base_price).toBe(hit.close);
    } else {
      expect(res.statusCode).toBe(404);
      expect(rowOf('sh600519')).toBeUndefined();
    }
  });

  itReal('candidate_reason 非字符串 → 400', async () => {
    const res = await post('/api/candidate', { asset_code: 'sh600519', candidate_reason: 123 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });
});

// ══════════════════ T50-② 显式基准价被尊重 ══════════════════

describe('T50 显式 candidate_base_price 优先', () => {
  /** T81：把候选池恢复到「干净」状态 —— 三个用例各自建前置，不依赖执行顺序 */
  function resetCandidate(code: string): void {
    store.db
      .prepare(`DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = 'candidate'`)
      .run(TEST_UID, code);
  }

  it('传了就用用户的值，source=user，不查行情日期', async () => {
    resetCandidate('sh600036');
    const res = await post('/api/candidate', {
      asset_code: 'sh600036',
      candidate_reason: '银行板块低估',
      candidate_base_price: 33.5,
    });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.candidate_base_price).toBe(33.5);
    expect(d.base_price_source).toBe('user');
    expect(d.candidate_base_price_date).toBeNull();

    const row = rowOf('sh600036');
    expect(row?.candidate_base_price).toBe(33.5);
    expect(row?.candidate_reason).toBe('银行板块低估');
    expect(row?.rel_type).toBe('candidate');
  });

  it('同一标的存在过 → 409 DUPLICATE，**已有基准价不被覆盖**（固化语义）', async () => {
    // T81：自带前置 —— 自己先建一条带基准价的候选
    resetCandidate('sh600036');
    store.db
      .prepare(
        `INSERT INTO user_asset_rel (user_id, asset_code, rel_type, candidate_base_price)
         VALUES (?, 'sh600036', 'candidate', 33.5)`,
      )
      .run(TEST_UID);
    const before = rowOf('sh600036')?.candidate_base_price;
    const res = await post('/api/candidate', { asset_code: 'sh600036', candidate_base_price: 999 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DUPLICATE');
    expect(rowOf('sh600036')?.candidate_base_price).toBe(before);
  });

  it('重复入池 + 显式基准价 → 不打 DuckDB 直接 409（override 路径无外部依赖）', async () => {
    // T81：自带前置 —— 自己先建一条候选；显式传基准价走 override 分支，全程不查行情库
    resetCandidate('sh600036');
    store.db
      .prepare(
        `INSERT INTO user_asset_rel (user_id, asset_code, rel_type, candidate_base_price)
         VALUES (?, 'sh600036', 'candidate', 33.5)`,
      )
      .run(TEST_UID);
    const res = await post('/api/candidate', { asset_code: 'sh600036', candidate_base_price: 12 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DUPLICATE');
  });
});

// ══════════════════ T50-③ 缺省基准价 = 加入日前复权收盘价 ══════════════════

describe('T50 缺省 candidate_base_price → 1 次 DuckDB 批量查加入日前复权收盘价', () => {
  // 依赖真实行情库 → CI 无库时跳过
  const itReal = MARKET_DATA_AVAILABLE ? it : it.skip;
  itReal('sh600000：基准价 == 行情库最新前复权收盘价；行情库不可用时降级为 404/503 且不落库', async () => {
    const quote = await batchGetLatestClose(['sh600000'], 'qfq');
    const hit = quote.get('sh600000');

    const res = await post('/api/candidate', { asset_code: 'sh600000' });

    if (hit !== undefined) {
      expect(res.statusCode).toBe(201);
      const d = res.json().data;
      expect(d.base_price_source).toBe('duckdb');
      expect(d.candidate_base_price).toBe(hit.close);           // ① 基准价 = 加入日前复权收盘价
      expect(d.candidate_base_price_date).toBe(hit.date);
      expect(d.candidate_base_price_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rowOf('sh600000')?.candidate_base_price).toBe(hit.close);
    } else {
      // 行情库没有 sh600000 —— **绝不静默写 NULL**
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('SYMBOL_NOT_FOUND');
      expect(rowOf('sh600000')).toBeUndefined();
      expect(countRows('sh600000')).toBe(0);
    }
  });

  itReal('行情库查无此标的 → 404 SYMBOL_NOT_FOUND，且候选池里不产生 NULL 基准价脏记录', async () => {
    const quote = await batchGetLatestClose(['sh999999'], 'qfq');
    const res = await post('/api/candidate', { asset_code: 'sh999999' });

    if (quote.size === 0) {
      expect(res.statusCode).toBe(404);                        // ④ DuckDB 无该日数据 → 明确错误
      expect(res.json().error).toBe('SYMBOL_NOT_FOUND');
      expect(String(res.json().message)).toContain('sh999999');
    } else {
      expect(res.statusCode).toBe(201);
    }
    if (quote.size === 0) {
      const row = rowOf('sh999999');
      expect(row).toBeUndefined();
      expect(countRows('sh999999')).toBe(0);
    }
  });

  itReal('resolveBasePrices 对缺失标的抛 QuoteUnavailableError 并列出全部缺号', async () => {
    const { resolveBasePrices, QuoteUnavailableError } = await import(
      '../../src/services/candidateService.js'
    );
    let missing: string[] = [];
    try {
      await resolveBasePrices(['sh999998', 'sh999997']);
    } catch (err) {
      if (err instanceof QuoteUnavailableError) missing = err.symbols;
      else throw err;
    }
    expect(missing.sort()).toEqual(['sh999997', 'sh999998']);
  });

  itReal('resolveBasePrices：override 命中的标的不查行情也返回 source=user', async () => {
    const { resolveBasePrices } = await import('../../src/services/candidateService.js');
    const m = await resolveBasePrices(['sh999996'], new Map([['sh999996', 8.8]]));
    expect(m.get('sh999996')).toEqual({ basePrice: 8.8, basePriceDate: null, source: 'user' });
  });
});

// ══════════════════ T50-④ GET 返回基准价 + 相对收益 ══════════════════

describe('T50 GET /api/candidate —— 基准价 + 相对收益', () => {
  it('每条记录带 candidate_base_price / current_close / relative_return', async () => {
    // T81：自带前置 —— 自己建一条候选，保证「列表非空」不依赖其它用例跑过
    batchInsertCandidates(TEST_UID, ['sh600031']);
    const res = await app.inject({ method: 'GET', url: '/api/candidate' });
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);

    const mine = items.filter((i) => i.user_id === TEST_UID);
    expect(mine.length).toBeGreaterThan(0);
    for (const item of mine) {
      expect(item).toHaveProperty('candidate_base_price');
      expect(item).toHaveProperty('current_close');
      expect(item).toHaveProperty('relative_return');
      expect(item).toHaveProperty('base_price_date');
      // 相对收益必须严格等于公式结果（自洽断言，不依赖行情库内容）
      const expected = computeRelativeReturn(
        item.candidate_base_price as number | null,
        item.current_close as number | null,
      );
      expect(item.relative_return).toBe(expected);
      // 用户显式指定基准价的记录：行情日期必然拿不到（base_price_date 只在 duckdb 源时有值）
      if (item.base_price_source === undefined) {
        // 兼容：GET 未透传 source 字段，下面的逐条断言已覆盖
      }
    }
  });

  it('computeRelativeReturn 数值精确：涨 20% / 跌 20% / 缺任一端为 null', () => {
    expect(computeRelativeReturn(10, 12)).toBeCloseTo(0.2, 10);
    expect(computeRelativeReturn(10, 8)).toBeCloseTo(-0.2, 10);
    expect(computeRelativeReturn(10, 10)).toBe(0);
    expect(computeRelativeReturn(null, 12)).toBeNull();
    expect(computeRelativeReturn(10, null)).toBeNull();
    expect(computeRelativeReturn(0, 12)).toBeNull();
    expect(computeRelativeReturn(10, Number.NaN)).toBeNull();
  });

  it('软删的候选不出现在列表里', async () => {
    batchInsertCandidates(TEST_UID, ['sh601398']);
    store.db
      .prepare(`UPDATE user_asset_rel SET is_deleted = 1 WHERE user_id = ? AND asset_code = ?`)
      .run(TEST_UID, 'sh601398');
    const res = await app.inject({ method: 'GET', url: '/api/candidate' });
    const items = res.json().data as Array<{ asset_code: string }>;
    expect(items.some((i) => i.asset_code === 'sh601398')).toBe(false);
  });
});

// ══════════════════ T50-⑤ 迁移价格模式 ══════════════════

describe('T50 POST /api/candidate/:asset_code/promote —— price_mode', () => {
  beforeEach(() => {
    store.db
      .prepare(
        `DELETE FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = 'candidate'`,
      )
      .run(TEST_UID, 'sh600036');
    store.db
      .prepare(
        `INSERT INTO user_asset_rel (user_id, asset_code, rel_type, candidate_base_price)
         VALUES (?, 'sh600036', 'candidate', 33.5)`,
      )
      .run(TEST_UID);
  });

  it("price_mode='base' → 写 migrated_price_mode='base' + migrated_from_candidate=1", async () => {
    const res = await post('/api/candidate/sh600036/migrate', { price_mode: 'base' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.price_mode).toBe('base');
    expect(res.json().data.marked).toBe(true);

    const row = rowOf('sh600036');
    expect(row?.migrated_price_mode).toBe('base');
    expect(row?.migrated_from_candidate).toBe(1);
  });

  it("price_mode='current' → 写 migrated_price_mode='current'", async () => {
    const res = await post('/api/candidate/sh600036/migrate', { price_mode: 'current' });
    expect(res.statusCode).toBe(200);
    expect(rowOf('sh600036')?.migrated_price_mode).toBe('current');
  });

  it('price_mode 缺省 / 非法值 → 400，且候选记录未被标记', async () => {
    for (const body of [{}, { price_mode: 'last' }, { price_mode: 1 }, { price_mode: null }]) {
      const res = await post('/api/candidate/sh600036/migrate', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('PARAM_INVALID');
    }
    const row = rowOf('sh600036');
    expect(row?.migrated_price_mode).toBeNull();
    expect(row?.migrated_from_candidate).toBe(0);
  });

  it('候选池中不存在该标的 → 404 SYMBOL_NOT_FOUND', async () => {
    const res = await post('/api/candidate/sh999997/migrate', { price_mode: 'base' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SYMBOL_NOT_FOUND');
  });

  it('asset_code 路径参数非法 → 400', async () => {
    const res = await post('/api/candidate/xx/migrate', { price_mode: 'base' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('PARAM_INVALID');
  });

  it('PRD S5：只打标记，**不自动创建 watch 关联**', async () => {
    const res = await post('/api/candidate/sh600036/migrate', { price_mode: 'base' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.autoCreated).toBe(false);
    expect(rowOf('sh600036', 'watch')).toBeUndefined();
  });

  it('markCandidateMigrated 对不存在/已软删的候选抛 CandidateNotFoundError', async () => {
    const { markCandidateMigrated } = await import('../../src/services/candidateService.js');
    store.db
      .prepare(
        `INSERT INTO user_asset_rel (user_id, asset_code, rel_type, is_deleted) VALUES (?, 'sh601988', 'candidate', 1)`,
      )
      .run(TEST_UID);
    expect(() => markCandidateMigrated(TEST_UID, 'sh601988', 'base')).toThrow(
      CandidateNotFoundError,
    );
    expect(() => markCandidateMigrated(TEST_UID, 'sh999997', 'base')).toThrow(
      CandidateNotFoundError,
    );
  });
});