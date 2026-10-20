import { describe, it, expect, afterAll } from 'vitest';
import { queryDuckDB, duckdbHealthCheck, closeDuckDBInstance } from '../../src/db/duckdb.js';

/**
 * 回归测试：P0-9（串行泄漏）/ P0-12（并发互抢）/ P0-10（BigInt 序列化）
 *
 * 刻意不依赖行情库内容（不用 raw_holidays / v_stock_qfq 等真实表），
 * 因为 CI 环境没有 data/quotes.duckdb。这三个问题都发生在 connect/close、
 * 文件锁与序列化阶段，与表是否存在无关。
 */

afterAll(async () => {
  await closeDuckDBInstance();
});

describe('P0-9 DuckDB 连接泄漏（串行）', () => {
  it('连续 3 次查询全部成功（修复前第 2 次起必失败）', async () => {
    for (let i = 1; i <= 3; i++) {
      const rows = await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');
      expect(rows, `第 ${i} 次查询失败`).toHaveLength(1);
      expect(rows[0].ok).toBe(1);
    }
  });

  it('duckdbHealthCheck 连续 3 次全通过', async () => {
    for (let i = 1; i <= 3; i++) {
      await expect(duckdbHealthCheck(), `第 ${i} 次健康检查失败`).resolves.toBeUndefined();
    }
  }, 20000);

  it('查询失败时 connection 仍被释放（close 不掩盖原始异常）', async () => {
    await expect(queryDuckDB('SELECT * FROM __t80_missing')).rejects.toThrow();
    const rows = await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  }, 20000);
});

describe('P0-12 DuckDB 并发互抢（instance 单例）', () => {
  it('并发 5 次查询全部成功且结果一致', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => queryDuckDB<{ ok: number }>('SELECT 1 AS ok')),
    );
    for (const [i, rows] of results.entries()) {
      expect(rows, `并发第 ${i} 个失败`).toHaveLength(1);
      expect(rows[0].ok).toBe(1);
    }
  }, 20000);

  it('并发 8 次查询（成功与失败混合）互不影响', async () => {
    const tasks = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? queryDuckDB<{ ok: number }>('SELECT 1 AS ok')
        : queryDuckDB(`SELECT * FROM __t80_missing_${i}`).catch(() => 'EXPECTED_ERROR'),
    );
    const results = await Promise.all(tasks);
    results.forEach((r, i) => {
      if (i % 2 === 0) {
        expect((r as { ok: number }[])[0].ok, `并发成功分支 #${i} 失败`).toBe(1);
      } else {
        expect(r, `并发失败分支 #${i} 未按预期报错`).toBe('EXPECTED_ERROR');
      }
    });
  }, 20000);

  it('并发下 healthCheck 与普通查询可共存', async () => {
    const out = await Promise.all([
      duckdbHealthCheck(),
      queryDuckDB<{ ok: number }>('SELECT 1 AS ok'),
      duckdbHealthCheck(),
      queryDuckDB<{ ok: number }>('SELECT 1 AS ok'),
    ]);
    expect(out[1][0].ok).toBe(1);
    expect(out[3][0].ok).toBe(1);
  }, 20000);
});

describe('P0-10 BigInt / Date 归一化', () => {
  it('查询结果不含 bigint 类型（否则 JSON.stringify 会抛）', async () => {
    const rows = await queryDuckDB<Record<string, unknown>>('SELECT 1::BIGINT AS big_col, 1 AS norm_col');
    expect(rows).toHaveLength(1);
    for (const [k, v] of Object.entries(rows[0])) {
      expect(typeof v, `列 ${k} 仍是 ${typeof v}，JSON 序列化会失败`).not.toBe('bigint');
    }
    expect(rows[0].big_col).toBe(1);
  }, 20000);

  it('查询结果可被 JSON.stringify（回归 P0-10 原始症状）', async () => {
    const rows = await queryDuckDB('SELECT 1::BIGINT AS big_col');
    expect(() => JSON.stringify(rows)).not.toThrow();
  }, 20000);

  it('DATE 列归一化为 YYYY-MM-DD 字符串', async () => {
    const rows = await queryDuckDB<{ d: unknown }>("SELECT DATE '2026-10-15' AS d");
    expect(() => JSON.stringify(rows)).not.toThrow();
    // @duckdb/node-api 的 DATE 实测返回 { days: epoch天数 }，
    // normalizeValue 应转成 'YYYY-MM-DD' 字符串。
    expect(rows[0].d, 'DATE 未被归一化为字符串').toBe('2026-10-15');
  }, 20000);

  it('epoch 0 边界不发生时区偏移（应得 1970-01-01）', async () => {
    const rows = await queryDuckDB<{ d: unknown }>("SELECT DATE '1970-01-01' AS d");
    expect(rows[0].d).toBe('1970-01-01');
  }, 20000);

  it('DATE 归一化结果不受本地时区影响', async () => {
    // 跨月边界日：若用本地时区构造，在 UTC+8 会偏移成前一天
    const rows = await queryDuckDB<{ d: unknown }>("SELECT DATE '2026-03-01' AS d");
    expect(rows[0].d).toBe('2026-03-01');
  }, 20000);
});
