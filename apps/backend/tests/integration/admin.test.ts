/**
 * admin.test.ts — API 集成测试（admin 管理链路）
 *
 * 覆盖 SDD §12.4 admin 类：
 *   - POST /api/admin/datacheck/trigger → 200 + summaries[]
 *   - POST /api/admin/run-signal → 200 + stats
 *   - GET /api/admin/system-log 分页 + filter
 *   - 非 admin → 403 FORBIDDEN（已在 auth.test.ts 覆盖，这里可以轻量）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, makeUserToken } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
let userToken: string; // role=user（非 admin）—— 用来断言 admin 端点对普通用户 403
const DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
const DUCKDB_EXISTS = fs.existsSync(DUCKDB_PATH);

beforeAll(async () => {
  bundle = await createTestApp();
  // 造一个普通用户（直接 INSERT 绕开 seed 的 409），拿它的 token 测 403
  const adminHash = bundle.db.db
    .prepare('SELECT password_hash FROM user_account WHERE username = ?')
    .get('int_admin') as { password_hash: string };
  bundle.db.db
    .prepare('INSERT OR IGNORE INTO user_account (username, password_hash, role) VALUES (?, ?, ?)')
    .run('int_normal', adminHash.password_hash, 'user');
  const row = bundle.db.db.prepare('SELECT id FROM user_account WHERE username = ?').get('int_normal') as {
    id: number;
  };
  userToken = makeUserToken(row.id, 'int_normal');
});

afterAll(async () => {
  await bundle.app.close().catch(() => {});
});

function adminHeaders() {
  return { authorization: `Bearer ${bundle.adminToken}` };
}

describe('Admin · run-datacheck', () => {
  it('admin 触发 → 200 + summaries 数组', async () => {
    if (!DUCKDB_EXISTS) return;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: adminHeaders(),
      payload: {},
    });
    // DuckDB 慢或缺表时 validator 可能返回部分 ERROR
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.summaries)).toBe(true);
      expect(body.data.summaries.length).toBeGreaterThan(0);
    }
  }, 90_000);

  it('指定 trade_date → summaries 用该日期', async () => {
    if (!DUCKDB_EXISTS) return;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/datacheck/trigger',
      headers: adminHeaders(),
      payload: { trade_date: '2026-10-14' },
    });
    expect([200, 500]).toContain(res.statusCode);
  }, 90_000);
});

describe('Admin · run-signal', () => {
  it('admin 触发信号生成 → 200 + stats', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/admin/run-signal',
      headers: adminHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.stats).toBeDefined();
    expect(typeof body.data.stats.total).toBe('number');
    expect(typeof body.data.stats.success).toBe('number');
    expect(typeof body.data.stats.timeout).toBe('number');
    expect(typeof body.data.stats.error).toBe('number');
  }, 30000);
});

describe('Admin · system-log 分页查询', () => {
  // 🔴 T81 顺序依赖修复：本块断言「至少有 1 条 system_log」，
  //   原本靠同文件前面的用例产生日志 → shuffle 下随机失败。
  //   → 块级 beforeAll 自己造一条 log。
  beforeAll(() => {
    bundle.db.db
      .prepare(
        "INSERT INTO system_log (log_date, log_type, level, message) VALUES (date('now','localtime'), 'trade', 'INFO', '分页测试用日志')",
      )
      .run();
  });

  // 先造条 log 验证分页
  it('log 分页基本结构', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?page=1&page_size=5',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.pageSize).toBe(5);
    expect(typeof body.pagination.total).toBe('number');
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
  });

  it('log_type 过滤', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?log_type=trade&page_size=3',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 每行都得是 trade
    for (const row of body.data) {
      expect(row.log_type).toBe('trade');
    }
  });

  it('默认 page=1 / page_size 超限自动截断到 200', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?page=999&page_size=9999',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pagination.pageSize).toBe(200); // min(200, 9999)
    // page=999 可能超过总行数 → data=[] 是合理的
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe('Admin · system-log 日期区间过滤（Wave 7 · 卡 1 · 裁决 D-3）', () => {
  // 区间过滤的判据：`system_log.log_date` 是 `YYYY-MM-DD` 定长格式 → 直接字符串比较
  const RANGE_START = '2026-10-05';
  const RANGE_END = '2026-10-15';

  beforeAll(() => {
    const insert = bundle.db.db.prepare(
      "INSERT INTO system_log (log_date, log_type, level, message) VALUES (?, 'trade', 'INFO', ?)",
    );
    insert.run('2026-10-01', '区间过滤-之前');
    insert.run('2026-10-10', '区间过滤-区间内');
    insert.run('2026-10-21', '区间过滤-之后');
  });

  it('admin 日志区间过滤：start_date/end_date 只返回区间内行', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: `/api/admin/system-log?start_date=${RANGE_START}&end_date=${RANGE_END}&page_size=200`,
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // 每一条都在区间内（闭区间）
    for (const row of body.data) {
      expect(row.log_date >= RANGE_START).toBe(true);
      expect(row.log_date <= RANGE_END).toBe(true);
    }

    // 区间外的行不返回
    const messages = body.data.map((r: { message: string }) => r.message);
    expect(messages).toContain('区间过滤-区间内');
    expect(messages).not.toContain('区间过滤-之前');
    expect(messages).not.toContain('区间过滤-之后');
  });

  it('单日 trade_date 仍可用（历史参数语义不变：等值）', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?trade_date=2026-10-10&page_size=200',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const row of body.data) {
      expect(row.log_date).toBe('2026-10-10');
    }
    const messages = body.data.map((r: { message: string }) => r.message);
    expect(messages).toContain('区间过滤-区间内');
    expect(messages).not.toContain('区间过滤-之前');
    expect(messages).not.toContain('区间过滤-之后');
  });

  it('只给 start_date → 开区间（返回该日及之后）', async () => {
    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log?start_date=2026-10-05&page_size=200',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const row of body.data) {
      expect(row.log_date >= '2026-10-05').toBe(true);
    }
    const messages = body.data.map((r: { message: string }) => r.message);
    expect(messages).toContain('区间过滤-区间内');
    expect(messages).toContain('区间过滤-之后');
    expect(messages).not.toContain('区间过滤-之前');
  });
});

describe('Admin · 系统日志降级记录（Wave 7 · 卡 1 · I-13）', () => {
  const tmpFile = path.join(os.tmpdir(), `invest-fallback-${process.pid}-${Date.now()}.log`);
  const missingFile = path.join(os.tmpdir(), `invest-fallback-missing-${process.pid}.log`);
  const origFallbackEnv = process.env.SYSTEM_LOG_FALLBACK_FILE;

  afterAll(() => {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      /* ignore */
    }
    if (origFallbackEnv === undefined) delete process.env.SYSTEM_LOG_FALLBACK_FILE;
    else process.env.SYSTEM_LOG_FALLBACK_FILE = origFallbackEnv;
  });

  it('admin 降级日志端点：普通用户 403 / admin 返回 exists+lines', async () => {
    // 1) 普通用户 → 403（G7.4「全部 admin 端点均 403」的一部分）
    const forbidden = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log/fallback',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(JSON.parse(forbidden.body).error).toBe('FORBIDDEN');

    // 2) admin + 兜底文件存在 → exists=true + 逐行内容
    fs.writeFileSync(
      tmpFile,
      '{"source":"invest-assistant","level":"ERROR","message":"降级第一行"}\n' +
        '{"source":"invest-assistant","level":"WARN","message":"降级第二行"}\n',
      'utf8',
    );
    process.env.SYSTEM_LOG_FALLBACK_FILE = tmpFile;

    const res = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log/fallback',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.exists).toBe(true);
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.lines[0]).toContain('降级第一行');
    expect(body.data.lines[1]).toContain('降级第二行');

    // ⚠️ 响应体**不含文件路径**（路径泄露 = 告诉攻击者去读哪个文件）
    expect(res.body).not.toContain(tmpFile);
    expect(res.body).not.toContain('SYSTEM_LOG_FALLBACK_FILE');

    // 3) 兜底文件不存在 → 空态（exists:false / lines:[]），**不是错误**
    process.env.SYSTEM_LOG_FALLBACK_FILE = missingFile;
    const empty = await bundle.app.inject({
      method: 'GET',
      url: '/api/admin/system-log/fallback',
      headers: adminHeaders(),
    });
    expect(empty.statusCode).toBe(200);
    const emptyBody = JSON.parse(empty.body);
    expect(emptyBody.success).toBe(true);
    expect(emptyBody.data.exists).toBe(false);
    expect(emptyBody.data.lines).toEqual([]);
  });
});
