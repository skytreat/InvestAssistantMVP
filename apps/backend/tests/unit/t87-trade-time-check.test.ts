/**
 * G4.5 配套 —— `GET /api/trade/check-duplicate`（交易时刻占用预检，只读）
 *
 * ── 这个端点解决什么 ──
 *   T87 把唯一键改成「同日同刻」：
 *     `UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time)`
 *   ⇒ 同一用户 + 同一标的 + 同一类型 + **同一时刻**只能有一条。
 *   前端提交前不知道该时刻是否已被占用 ⇒ 只能提交后吃 409 `TRADE_DUPLICATE`。
 *   ADR-003 §「缓解措施（必做）」要求前端做**提交前预检** —— 本端点就是那个预检的数据源。
 *
 * ── 本文件钉死的契约 ──
 *   ① 未占用 → `{ taken: false }`；已占用 → `{ taken: true, taken_at: <ISO8601> }`
 *   ② **参数缺失 / 非法 → 400 `PARAM_INVALID`，绝不返回 `taken:false`**
 *      （`taken:false` 的语义是「确定没被占用」；把「查失败」也表达成它，
 *        前端会把「查失败」误当「没占用」而放行提交 —— 正是本端点要消灭的体验。）
 *   ③ **只查当前用户**（`user_id` 取自 token，**绝不信请求参数**）
 *   ④ **软删除记录不再占用唯一键**（T87b：唯一键改为部分唯一索引 `WHERE is_deleted = 0`）
 *   ⑤ 性能：预检是**单条等值索引 seek**，不扫表（`EXPLAIN QUERY PLAN` 断言）
 *
 * ── SQLite 隔离 ──
 *   `mkdtempSync` 临时库 + 覆盖 `SQLITE_DB_PATH`（必须在 import ConfigStore 之前）。
 *   本文件**不触碰 DuckDB**（预检只查 SQLite），故 CI 无行情库也能全绿。
 *
 * ── 用例互不依赖 ──
 *   vitest 开了 `sequence.shuffle`（T81 守卫）⇒ 每个用例用**独立的标的代码**，
 *   不依赖「上一个用例先插过某行」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// ── SQLite 隔离（必须在 import ConfigStore 之前设置）──
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'invest-t87-check-'));
const ORIG_SQLITE_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = path.join(TMP_DIR, 't87-check.db');

const { ConfigStore } = await import('../../src/config/configStore.js');
const { registerRoutes } = await import('../../src/routes/index.js');
const { TRADE_TIME_OCCUPANCY_SQL } = await import('../../src/routes/trade.js');
const { signToken } = await import('../../src/services/auth.js');

/** 两个用户，用于验证用户隔离 */
const USER_A = { id: 8101, username: 'chk_user_a' };
const USER_B = { id: 8102, username: 'chk_user_b' };

let app: FastifyInstance;
let db: ReturnType<typeof ConfigStore.getInstance>['db'];
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  // 用**真实的** registerRoutes —— 顺带验证本端点确实被注册（漏注册 = 404 = 契约漂移）
  await registerRoutes(app);

  db = ConfigStore.getInstance().db;

  for (const u of [USER_A, USER_B]) {
    db.prepare(
      "INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (?, ?, ?, 'user')",
    ).run(u.id, u.username, 'dummy-hash');
  }
  tokenA = signToken({ sub: USER_A.id, username: USER_A.username, role: 'user' });
  tokenB = signToken({ sub: USER_B.id, username: USER_B.username, role: 'user' });
});

afterAll(async () => {
  await app?.close().catch(() => {});
  try {
    (db as any)?.close();
  } catch {
    /* ignore */
  }
  (ConfigStore as unknown as { _instance: unknown })._instance = null;
  if (ORIG_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
  else process.env.SQLITE_DB_PATH = ORIG_SQLITE_PATH;
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 插入一条交易记录（直接写库，绕开 POST 的其它校验） */
function insertTrade(
  userId: number,
  assetCode: string,
  tradeType: string,
  tradeDate: string,
  tradeTime: string,
  createdAt?: string,
): number {
  const info = db
    .prepare(
      `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted, created_at)
       VALUES (?, ?, ?, ?, ?, 100, 10, 0, 0, ?)`,
    )
    .run(userId, assetCode, tradeType, tradeDate, tradeTime, createdAt ?? '2026-10-01 09:30:00');
  return Number(info.lastInsertRowid);
}

/** 调用预检端点 */
async function check(
  token: string | null,
  params: Record<string, string | undefined>,
): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, v);
  }
  const res = await app.inject({
    method: 'GET',
    url: `/api/trade/check-duplicate?${qs.toString()}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('G4.5 · check-duplicate · 基本语义', () => {
  it('未占用 → 200 + taken:false（且不带 taken_at）', async () => {
    const { status, body } = await check(tokenA, {
      asset_code: 'szCHKFREE',
      trade_type: 'buy',
      trade_date: '2026-06-01',
      trade_time: '09:00:00',
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.code).toBe(0);
    expect(typeof body.timestamp).toBe('string');
    expect(body.data.taken).toBe(false);
    expect(body.data.taken_at).toBeUndefined();
  });

  it('已占用 → 200 + taken:true + taken_at 非空', async () => {
    insertTrade(USER_A.id, 'szCHKHIT', 'buy', '2026-06-02', '10:00:00');
    const { status, body } = await check(tokenA, {
      asset_code: 'szCHKHIT',
      trade_type: 'buy',
      trade_date: '2026-06-02',
      trade_time: '10:00:00',
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.taken).toBe(true);
    expect(typeof body.data.taken_at).toBe('string');
    expect(body.data.taken_at.length).toBeGreaterThan(0);
  });

  it('taken_at = 该记录的 created_at（服务器本地墙钟 → ISO 8601）', async () => {
    insertTrade(USER_A.id, 'szCHKISO', 'buy', '2026-06-03', '11:00:00', '2026-05-20 08:15:30');
    const { body } = await check(tokenA, {
      asset_code: 'szCHKISO',
      trade_type: 'buy',
      trade_date: '2026-06-03',
      trade_time: '11:00:00',
    });
    expect(body.data.taken).toBe(true);
    // 服务器本地时区解释 → 转 UTC ISO（桌面应用：后端与前端同机 ⇒ 时区一致）
    const expected = new Date(2026, 4, 20, 8, 15, 30).toISOString();
    expect(body.data.taken_at).toBe(expected);
    expect(body.data.taken_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('唯一键的其余维度任一不同 → 不占用（type / date / time / 标的）', async () => {
    insertTrade(USER_A.id, 'szCHKDIM', 'buy', '2026-06-04', '13:00:00');
    const dims: Array<Record<string, string>> = [
      { asset_code: 'szCHKDIM', trade_type: 'add', trade_date: '2026-06-04', trade_time: '13:00:00' },
      { asset_code: 'szCHKDIM', trade_type: 'buy', trade_date: '2026-06-05', trade_time: '13:00:00' },
      { asset_code: 'szCHKDIM', trade_type: 'buy', trade_date: '2026-06-04', trade_time: '13:00:01' },
      { asset_code: 'szCHKOTH', trade_type: 'buy', trade_date: '2026-06-04', trade_time: '13:00:00' },
    ];
    for (const d of dims) {
      const { body } = await check(tokenA, d);
      expect(body.data.taken, JSON.stringify(d)).toBe(false);
    }
  });
});

/**
 * 🔴 软删除口径 —— **以 DDL 实测为准**（T87b 修复后口径已翻转）
 *
 * `user_trade_record` 的唯一键是**部分唯一索引**
 *   `idx_user_trade_record_unique_live ON (user_id, asset_code, trade_type, trade_date, trade_time)
 *    WHERE is_deleted = 0`
 * —— **只约束「未软删」的活记录** ⇒ **软删除的记录不再占用唯一键**。
 *
 * 实测证据（探针脚本）：
 *   1. 插入 (u, code, buy, 2026-10-20, 10:30:00) → 成功
 *   2. `UPDATE ... SET is_deleted = 1` → 软删
 *   3. 再 INSERT 同键 → **成功**（修复前会抛 `UNIQUE constraint failed`）
 *
 * ⇒ 预检**必须**只看活记录（`is_deleted = 0`），否则会造出
 *   「预检说占用、提交却成功」的新矛盾。
 */
describe('G4.5 · check-duplicate · 软删除口径（部分唯一索引）', () => {
  it('软删除记录不再占用唯一键 → taken:false（与 INSERT 实际行为一致）', async () => {
    const id = insertTrade(USER_A.id, 'szCHKSOFT', 'buy', '2026-06-06', '14:00:00');
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(id);

    const { status, body } = await check(tokenA, {
      asset_code: 'szCHKSOFT',
      trade_type: 'buy',
      trade_date: '2026-06-06',
      trade_time: '14:00:00',
    });
    expect(status).toBe(200);
    expect(body.data.taken, '软删记录不再占用唯一键 → 预检必须报 taken:false').toBe(false);
  });

  it('实证锚点：软删后再 INSERT 同键**确实成功**（证明上面的 taken:false 是对的）', () => {
    const id = insertTrade(USER_A.id, 'szCHKSOFT2', 'buy', '2026-06-07', '14:00:00');
    db.prepare('UPDATE user_trade_record SET is_deleted = 1 WHERE id = ?').run(id);
    expect(() =>
      db
        .prepare(
          `INSERT INTO user_trade_record
             (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, is_deleted)
           VALUES (?, 'szCHKSOFT2', 'buy', '2026-06-07', '14:00:00', 100, 10, 0, 0)`,
        )
        .run(USER_A.id),
    ).not.toThrow();
  });

  it('未软删的记录同样 taken:true（对照组）', async () => {
    insertTrade(USER_A.id, 'szCHKLIVE', 'buy', '2026-06-08', '15:00:00');
    const { body } = await check(tokenA, {
      asset_code: 'szCHKLIVE',
      trade_type: 'buy',
      trade_date: '2026-06-08',
      trade_time: '15:00:00',
    });
    expect(body.data.taken).toBe(true);
  });
});

describe('G4.5 · check-duplicate · 用户隔离', () => {
  it('A 用户的记录不影响 B 用户 → B 查同一键 taken:false', async () => {
    insertTrade(USER_A.id, 'szCHKISO2', 'buy', '2026-06-09', '16:00:00');
    const { body } = await check(tokenB, {
      asset_code: 'szCHKISO2',
      trade_type: 'buy',
      trade_date: '2026-06-09',
      trade_time: '16:00:00',
    });
    expect(body.data.taken).toBe(false);
  });

  it('B 用户查自己的记录 → taken:true', async () => {
    insertTrade(USER_B.id, 'szCHKB', 'buy', '2026-06-10', '16:30:00');
    const { body } = await check(tokenB, {
      asset_code: 'szCHKB',
      trade_type: 'buy',
      trade_date: '2026-06-10',
      trade_time: '16:30:00',
    });
    expect(body.data.taken).toBe(true);
  });

  it('伪造 user_id 查询参数无效（user_id 只认 token）', async () => {
    insertTrade(USER_A.id, 'szCHKFAKE', 'buy', '2026-06-11', '17:00:00');
    // 用 A 的 token，但试图查 B 的 user_id → 应按 A 查 ⇒ taken:true
    const { body } = await check(tokenA, {
      asset_code: 'szCHKFAKE',
      trade_type: 'buy',
      trade_date: '2026-06-11',
      trade_time: '17:00:00',
      user_id: String(USER_B.id),
    });
    expect(body.data.taken).toBe(true);
  });
});

describe('G4.5 · check-duplicate · 参数校验（缺参数 / 非法 → 400 PARAM_INVALID）', () => {
  const base = {
    asset_code: 'szCHKARG',
    trade_type: 'buy',
    trade_date: '2026-06-12',
    trade_time: '18:00:00',
  };

  it('缺 asset_code → 400 PARAM_INVALID', async () => {
    const { status, body } = await check(tokenA, { ...base, asset_code: undefined });
    expect(status).toBe(400);
    expect(body.error).toBe('PARAM_INVALID');
    expect(body.code).toBe('PARAM_INVALID');
    // 🔴 T89b：响应体**不再有** `success` 键
    expect('success' in body).toBe(false);
  });

  it('缺 trade_type → 400 PARAM_INVALID', async () => {
    const { status, body } = await check(tokenA, { ...base, trade_type: undefined });
    expect(status).toBe(400);
    expect(body.error).toBe('PARAM_INVALID');
  });

  it('缺 trade_date → 400 PARAM_INVALID', async () => {
    const { status, body } = await check(tokenA, { ...base, trade_date: undefined });
    expect(status).toBe(400);
    expect(body.error).toBe('PARAM_INVALID');
  });

  it('缺 trade_time → 400 PARAM_INVALID', async () => {
    const { status, body } = await check(tokenA, { ...base, trade_time: undefined });
    expect(status).toBe(400);
    expect(body.error).toBe('PARAM_INVALID');
  });

  it('非法 trade_type（sell / foo）→ 400 PARAM_INVALID', async () => {
    for (const t of ['sell', 'foo', 'BUY']) {
      const { status, body } = await check(tokenA, { ...base, trade_type: t });
      expect(status, `trade_type=${t}`).toBe(400);
      expect(body.error).toBe('PARAM_INVALID');
    }
  });

  it('非法 trade_date（2026-13-45 / 2026-02-30 / 20260612 / 空串）→ 400 PARAM_INVALID', async () => {
    for (const d of ['2026-13-45', '2026-02-30', '20260612', '', '2026-6-1']) {
      const { status, body } = await check(tokenA, { ...base, trade_date: d });
      expect(status, `trade_date=${d}`).toBe(400);
      expect(body.error).toBe('PARAM_INVALID');
    }
  });

  it('非法 trade_time（25:00:00 / 09:30 / abc）→ 400 PARAM_INVALID', async () => {
    for (const t of ['25:00:00', '09:30', 'abc', '09:60:00', '']) {
      const { status, body } = await check(tokenA, { ...base, trade_time: t });
      expect(status, `trade_time=${t}`).toBe(400);
      expect(body.error).toBe('PARAM_INVALID');
    }
  });

  it('🔴 400 响应体是错误 envelope（data === null），绝不是 { taken:false }', async () => {
    const { status, body } = await check(tokenA, { ...base, trade_time: '99:99:99' });
    expect(status).toBe(400);
    expect(body.data).toBeNull();
    expect(Object.keys(body.data ?? {})).not.toContain('taken');
    expect(body.code).toBe('PARAM_INVALID');
    expect('success' in body).toBe(false);
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });
});

describe('G4.5 · check-duplicate · 鉴权与性能', () => {
  it('未带 token → 401 UNAUTHORIZED（端点必须鉴权）', async () => {
    const { status, body } = await check(null, {
      asset_code: 'szCHKAUTH',
      trade_type: 'buy',
      trade_date: '2026-06-13',
      trade_time: '19:00:00',
    });
    expect(status).toBe(401);
    expect(body.error).toBe('UNAUTHORIZED');
  });

  it('性能：预检是等值索引 seek，不扫表（EXPLAIN QUERY PLAN 断言线上同一条 SQL）', () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${TRADE_TIME_OCCUPANCY_SQL}`)
      .all(USER_A.id, 'szCHKP', 'buy', '2026-06-14', '20:00:00') as Array<{ detail: string }>;
    expect(plan.length).toBeGreaterThan(0);
    const detail = plan.map((p) => p.detail).join(' | ');
    // 走索引
    expect(detail).toContain('USING INDEX');
    // 不扫表（'SEARCH' 里不含 'SCAN'，两者互不为子串）
    expect(detail).not.toContain('SCAN');
    // 用的是 5 列**部分唯一索引**（T87b：唯一键改为 WHERE is_deleted = 0 的部分索引），
    // 且 5 列全部等值约束
    expect(detail).toContain('idx_user_trade_record_unique_live');
    expect(detail).toContain(
      '(user_id=? AND asset_code=? AND trade_type=? AND trade_date=? AND trade_time=?)',
    );
  });
});

/**
 * 🔴 端到端一致性：预检结论必须与 `POST /api/trade` 的实际结果一致
 *
 * 「预检说未被占用 → POST 就一定 201」与「预检说已被占用 → POST 必然 409」，
 * 是这个端点存在的全部意义；若两者会打架，预检就是噪音。
 */
describe('G4.5 · check-duplicate · 与 POST /api/trade 的行为一致', () => {
  it('预检 taken:true ⇒ 实际提交必吃 409 TRADE_DUPLICATE', async () => {
    const payload = {
      asset_code: 'szCHKE2E',
      trade_type: 'buy',
      trade_date: '2026-06-15',
      trade_time: '10:30:00',
      quantity: 100,
      price: 10,
      trade_reason: '预检一致性测试建仓',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: { authorization: `Bearer ${tokenA}` },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const pre = await check(tokenA, {
      asset_code: payload.asset_code,
      trade_type: payload.trade_type,
      trade_date: payload.trade_date,
      trade_time: payload.trade_time,
    });
    expect(pre.body.data.taken).toBe(true);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { ...payload, quantity: 200, trade_reason: '重复提交' },
    });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.body).error).toBe('TRADE_DUPLICATE');
  });

  it('预检 taken:false ⇒ 实际提交 201', async () => {
    const payload = {
      asset_code: 'szCHKE2F',
      trade_type: 'buy',
      trade_date: '2026-06-16',
      trade_time: '10:31:00',
      quantity: 100,
      price: 10,
      trade_reason: '预检一致性测试（未占用）',
    };
    const pre = await check(tokenA, {
      asset_code: payload.asset_code,
      trade_type: payload.trade_type,
      trade_date: payload.trade_date,
      trade_time: payload.trade_time,
    });
    expect(pre.body.data.taken).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/trade',
      headers: { authorization: `Bearer ${tokenA}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
  });
});
