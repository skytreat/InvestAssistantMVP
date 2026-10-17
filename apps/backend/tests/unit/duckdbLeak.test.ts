/**
 * T80 回归测试：DuckDB 连接泄漏（P0-9）
 * 核心断言：连续多次 queryDuckDB 必须全部成功。
 * 修复前：第 1 次成功，第 2 次起报 "File is already open in node.exe (PID <self>)"。
 */
import { describe, it, expect } from 'vitest';
import { queryDuckDB, duckdbHealthCheck } from '../../src/db/duckdb.js';

describe('P0-9 DuckDB 连接泄漏', () => {
  it('连续 3 次查询全部成功（修复前第 2 次起必失败）', async () => {
    for (let i = 1; i <= 3; i++) {
      const rows = await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');
      expect(rows, `第 ${i} 次查询失败`).toHaveLength(1);
      expect(rows[0].ok).toBe(1);
    }
  });

  it('不同 SQL 混合连续 9 次查询全部成功', async () => {
    const sqls = [
      'SELECT 1 AS ok',
      "SELECT COUNT(*) AS c FROM raw_holidays",
      "SELECT COUNT(*) AS c FROM raw_symbol_class",
      "SELECT COUNT(*) AS c FROM raw_kline_daily WHERE date = (SELECT MAX(date) FROM raw_kline_daily)",
      "SELECT COUNT(*) AS c FROM v_stock_qfq WHERE symbol = 'sh600519'",
    ];
    for (let round = 0; round < 2; round++) {
      for (const [i, sql] of sqls.entries()) {
        const rows = await queryDuckDB(sql);
        expect(rows.length, `round${round + 1} sql#${i + 1} 失败`).toBeGreaterThanOrEqual(0);
      }
    }
  }, 30000);

  it('duckdbHealthCheck 连续 3 次全通过', async () => {
    for (let i = 1; i <= 3; i++) {
      await expect(duckdbHealthCheck(), `第 ${i} 次健康检查失败`).resolves.toBeUndefined();
    }
  }, 20000);

  it('查询失败时句柄仍被释放（close 不掩盖原始异常）', async () => {
    await expect(queryDuckDB('SELECT * FROM 不存在的表_xxx')).rejects.toThrow();
    // 关键：上一条故意失败后，下一条仍必须成功 → 证明 finally 生效
    const rows = await queryDuckDB<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  }, 20000);
});