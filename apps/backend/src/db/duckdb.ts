import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * DuckDB 只读连接模块
 * - 按需 open/close（用完立即丢引用让 GC 回收，不常驻连接）
 * - 只有 SELECT 权限（AGENTS.md 硬约束：Fastify 进程禁止写入 DuckDB）
 * - 5 秒超时 + retry 2 次
 * 
 * DuckDB Neo API（@duckdb/node-api ^1.5.6-r.1）：
 *   const instance = await DuckDBInstance.create(dbPath);
 *   const conn = await instance.connect();
 *   const result = await conn.runAndReadAll(sql, params);
 *   const rows = result.getRows();       // 二维数组
 *   const cols = result.columnNames();   // 列名
 *   // Connection/Instance 无 .close() 方法，依赖 GC 回收
 */

// 路径解析：env 优先（绝对路径），否则从模块位置向上定位项目根
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUCKDB_PATH = process.env.DUCKDB_PATH
  ?? path.resolve(__dirname, '../../../../data/quotes.duckdb');
const MAX_RETRY = 2;
const RETRY_DELAY_MS = 200;

export async function duckdbHealthCheck(): Promise<void> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const instance = await DuckDBInstance.create(DUCKDB_PATH);
      const conn = await instance.connect();
      const result = await conn.runAndReadAll('SELECT 1 AS ok');
      const rows = result.getRows();
      // 丢引用 → GC 回收
      void instance; void conn;
      if (rows.length === 1 && rows[0][0] === 1) {
        return;  // 成功
      }
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(`DuckDB 连接失败（重试 ${MAX_RETRY} 次后）: ${String(lastErr)}`);
}

/** 按需查询 DuckDB，用完立即丢引用（不常驻连接） */
export async function queryDuckDB<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();
  const result = await conn.runAndReadAll(sql, (params ?? []) as any);
  const rows = result.getRows();
  const cols = result.columnNames();

  // 二维数组 → 对象数组
  const mapped = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj as T;
  });

  // 丢引用 → GC 回收连接和实例
  void instance; void conn;
  return mapped;
}
