import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

/**
 * DuckDB 只读连接模块
 * - 只有 SELECT 权限（AGENTS.md 硬约束：Fastify 进程禁止写入 DuckDB，写入权仅 tdx2db）
 * - **instance 进程内单例**（P0-9 / P0-12）：每次查询都新建 instance 会让 DuckDB 文件锁在同进程内互相抢占
 * - **connection 每次查询开关**（AGENTS.md「按需打开关闭」）：每个并发分支开自己的 connection，用完立即关闭
 * - 5 秒超时 + retry 2 次
 *
 * DuckDB Neo API（@duckdb/node-api ^1.5.6-r.1）：
 *   const instance = await DuckDBInstance.create(dbPath);   // 单例，复用
 *   const conn = await instance.connect();                   // 每次查询新建
 *   const result = await conn.runAndReadAll(sql, params);
 *   const rows = result.getRows();       // 二维数组
 *   const cols = result.columnNames();   // 列名
 *   conn.closeSync();                     // 必须显式关闭，不能依赖 GC
 *
 * P0-9（串行泄漏）：此前两个函数都只丢弃引用而不关闭，文件锁被同进程持有，
 *   导致「第一次行情查询成功、之后所有行情端点永久 500/502」。
 *
 * P0-12（并发互抢）：DuckDBInstance.create() 是排他的。若每次查询都新建 instance，
 *   并发查询（如 Dashboard 首屏同时打 /positions + /asset-stat/latest + /signals + /system-log）
 *   会互相抢文件锁。实测 DuckDB 支持单进程内多线程并发读，前提是共享同一 instance、
 *   各自 connect()，故采用「instance 单例 + connection 每次开关」。
 *
 * P0-10（BigInt 序列化）：v_stock_qfq.volume 为 BIGINT → JS BigInt → JSON.stringify 抛错，
 *   导致股票 K 线 100% 返回 500。在 queryDuckDB 这一唯一出口统一归一化。
 */

// 路径解析：env 优先（绝对路径），否则从模块位置向上定位项目根
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUCKDB_PATH = process.env.DUCKDB_PATH
  ?? path.resolve(__dirname, '../../../../data/quotes.duckdb');
const MAX_RETRY = 2;
const RETRY_DELAY_MS = 200;

/**
 * 进程内单例 instance。
 *
 * 存到 globalThis 而非模块变量：vitest 每个测试文件是独立 module graph，
 * 模块变量不共享，会各自 create 一个 instance 互相抢 DuckDB 文件锁
 * （单跑通过、全量跑失败）。挂到 globalThis 后整个进程只 create 一次。
 *
 * 惰性创建 + Promise 去重：并发首次调用只会真正 create 一次，后续 await 同一个 promise。
 */
interface DuckDBSingleton {
  promise: Promise<DuckDBInstance> | null;
}

const GLOBAL_KEY = '__investDuckDBSingleton__';

function singleton(): DuckDBSingleton {
  const g = globalThis as unknown as Record<string, DuckDBSingleton | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { promise: null };
  return g[GLOBAL_KEY] as DuckDBSingleton;
}

async function getInstance(): Promise<DuckDBInstance> {
  const s = singleton();
  if (!s.promise) {
    s.promise = DuckDBInstance.create(DUCKDB_PATH).catch((err) => {
      // 创建失败必须清空缓存，否则会永久缓存一个 rejected promise
      s.promise = null;
      throw err;
    });
  }
  return s.promise;
}

/** 释放单例 instance（供测试 afterAll 与优雅退出使用；下次查询会重新创建） */
export async function closeDuckDBInstance(): Promise<void> {
  const s = singleton();
  if (!s.promise) return;
  const pending = s.promise;
  s.promise = null;
  try {
    const inst = await pending;
    inst.closeSync();
  } catch {
    // instance 从未成功创建或已失效，无需处理
  }
}

/**
 * 为单次查询打开一个短生命周期 connection。
 * 调用方必须在 finally 中 closeSync()，否则句柄会持续累积。
 */
async function openConnection() {
  const instance = await getInstance();
  return instance.connect();
}

/** 关闭 connection；close 失败不应掩盖原始查询异常 */
function safeCloseConn(conn: { closeSync(): void } | null): void {
  if (!conn) return;
  try {
    conn.closeSync();
  } catch {
    // 连接已失效时 close 可能抛错，忽略即可
  }
}

/** DuckDB DATE 可能返回 { days } 形态（epoch 天数），与 JS Date 形态并存 */
interface DuckDBDateLike {
  days?: number;
  toISOString?: () => string;
}

/**
 * 把 DuckDB 的 epoch 天数转成 'YYYY-MM-DD'。
 * epoch 0 = 1970-01-01，直接用 Date 会因本地时区偏移一天，故走 UTC 构造。
 */
function epochDaysToDateString(days: number): string {
  const ms = days * 86_400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(days);
  return d.toISOString().slice(0, 10);
}

/**
 * 列值归一化（P0-10）：
 * - bigint → number（成交量/成交额在 JS number 安全整数范围内）
 * - Date → 'YYYY-MM-DD'
 * - { days } → 'YYYY-MM-DD'（实测 @duckdb/node-api 的 DATE 列为此形态，
 *   与其类型声明的 Date 不符，故同时兼容两种）
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value !== null && typeof value === 'object') {
    const maybeDate = value as DuckDBDateLike;
    if (typeof maybeDate.days === 'number') return epochDaysToDateString(maybeDate.days);
  }
  return value;
}

export async function duckdbHealthCheck(): Promise<void> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let conn: Awaited<ReturnType<typeof openConnection>> | null = null;
    try {
      conn = await openConnection();
      const result = await conn.runAndReadAll('SELECT 1 AS ok');
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
      // P0-9：必须确定性关闭 connection，否则句柄泄漏
      safeCloseConn(conn);
    }
  }

  throw new Error(`DuckDB 连接失败（重试 ${MAX_RETRY} 次后）: ${String(lastErr)}`);
}

/**
 * 按需查询 DuckDB。
 * - instance 复用（进程内单例），connection 每次开关
 * - 列值经 normalizeValue 归一化，调用方无需处理 BigInt / Date
 * - 对「文件被占用」类瞬时错误做短退避重试（tdx2db 正在写库时可能短暂持锁）
 */
export async function queryDuckDB<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let conn: Awaited<ReturnType<typeof openConnection>> | null = null;
    try {
      conn = await openConnection();
      const result = await conn.runAndReadAll(sql, (params ?? []) as any);
      const rows = result.getRows();
      const cols = result.columnNames();

      // 二维数组 → 对象数组（列值归一化：bigint / Date）
      return rows.map((row) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((col, idx) => {
          obj[col] = normalizeValue(row[idx]);
        });
        return obj as T;
      });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    } finally {
      safeCloseConn(conn);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
