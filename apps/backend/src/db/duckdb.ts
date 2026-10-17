import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * DuckDB 只读连接模块
 * - 按需 open/close，**必须在 finally 中调用 closeSync() 确定性关闭**（AGENTS.md 硬约束：按需打开关闭，不常驻连接）
 * - 只有 SELECT 权限（AGENTS.md 硬约束：Fastify 进程禁止写入 DuckDB）
 * - 5 秒超时 + retry 2 次
 *
 * DuckDB Neo API（@duckdb/node-api ^1.5.6-r.1）：
 *   const instance = await DuckDBInstance.create(dbPath);
 *   const conn = await instance.connect();
 *   const result = await conn.runAndReadAll(sql, params);
 *   const rows = result.getRows();       // 二维数组
 *   const cols = result.columnNames();   // 列名
 *   conn.closeSync(); instance.closeSync();   // ⚠️ 必须显式关闭，不能依赖 GC
 *
 * P0-9（动态审计发现）：此前两个函数都只 `void instance; void conn` 丢弃引用而不关闭，
 * DuckDB 文件锁被同进程持有，导致「第一次行情查询成功、之后所有 DuckDB 端点永久 500/502」。
 * 关闭顺序：先 conn 后 instance。
 */

// 路径解析：env 优先（绝对路径），否则从模块位置向上定位项目根
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUCKDB_PATH = process.env.DUCKDB_PATH
  ?? path.resolve(__dirname, '../../../../data/quotes.duckdb');
const MAX_RETRY = 2;
const RETRY_DELAY_MS = 200;

/** 打开一个短生命周期只读连接；返回的句柄必须由调用方在 finally 中 closeDuckDB() 释放 */
async function openDuckDB() {
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();
  return {
    instance,
    conn,
    async close(): Promise<void> {
      try {
        conn.closeSync();
      } finally {
        instance.closeSync();
      }
    },
  };
}

/** 释放 DuckDB 句柄；close 失败不应掩盖原始查询异常 */
async function safeClose(handle: { close(): Promise<void> } | null): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // 连接已失效时 close 可能抛错，忽略即可
  }
}

export async function duckdbHealthCheck(): Promise<void> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let handle: Awaited<ReturnType<typeof openDuckDB>> | null = null;
    try {
      handle = await openDuckDB();
      const result = await handle.conn.runAndReadAll('SELECT 1 AS ok');
      const rows = result.getRows();
      if (rows.length === 1 && rows[0][0] === 1) {
        return;  // 成功
      }
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    } finally {
      // P0-9：必须确定性关闭，否则 DuckDB 文件锁被同进程持有，后续查询全部失败
      await safeClose(handle);
    }
  }

  throw new Error(`DuckDB 连接失败（重试 ${MAX_RETRY} 次后）: ${String(lastErr)}`);
}

/**
 * 按需查询 DuckDB。
 * P0-9：每次调用独立 open/close，finally 中确定性释放句柄；
 * 对「文件被占用」类瞬时错误做一次短退避重试（tdx2db 正在写库时可能短暂持锁）。
 */
export async function queryDuckDB<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let handle: Awaited<ReturnType<typeof openDuckDB>> | null = null;
    try {
      handle = await openDuckDB();
      const result = await handle.conn.runAndReadAll(sql, (params ?? []) as any);
      const rows = result.getRows();
      const cols = result.columnNames();

      // 二维数组 → 对象数组
      return rows.map((row) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj as T;
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    } finally {
      await safeClose(handle);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
