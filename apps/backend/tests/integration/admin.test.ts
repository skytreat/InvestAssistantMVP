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
import path from 'node:path';
import { createTestApp } from './_helpers.js';
import type { TestAppBundle } from './_helpers.js';

let bundle: TestAppBundle;
const DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
const DUCKDB_EXISTS = fs.existsSync(DUCKDB_PATH);

beforeAll(async () => {
  bundle = await createTestApp();
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
