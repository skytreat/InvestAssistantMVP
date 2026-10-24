import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, DuckDBTypeId } from '@duckdb/node-api';

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

/**
 * 解析 DuckDB 行情库路径。
 *
 * 🔴 **必须惰性求值（连接时读 env），不能在模块加载时快照**（2026-10-20 实测教训）：
 * 模块级 `const DUCKDB_PATH = process.env.DUCKDB_PATH ?? …` 在 **import 时**求值，
 * 而测试侧的档位切换（`tests/_marketData.ts` 的 `resolveMarketData()`）是在
 * **测试文件 import 之后**才把 `process.env.DUCKDB_PATH` 指向迷你库
 * ⇒ 快照拿到的是**切换前**的路径（真库）。
 *
 * 实测后果（`MARKET_DATA_MODE=mini` 仍慢）：
 *   `smoke-m3`「SQLite 热备份」**31.4s**（备份的仍是 1.24GB 真库）
 *   `smoke-m1`「健康检查」**18.5s**（检查的仍是真库）
 *   ⇒ 迷你库档只快了 4%（244.7s → 234.6s），**慢用例根本没被优化到**。
 *
 * ⇒ 改为函数，**每次连接时读 env** ⇒ 谁最后设置 env 谁生效（测试档位切换即靠这个）。
 */
export function resolveDuckDBPath(): string {
  return process.env.DUCKDB_PATH ?? path.resolve(__dirname, '../../../../data/quotes.duckdb');
}
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
  /** 当前打开的 instance；为 null 表示已释放（下次查询惰性重建） */
  promise: Promise<DuckDBInstance> | null;
  /** 进程内写窗口标志：为 true 时 getInstance() **不得**重建 instance
   *  （防止并发查询抢回文件锁 ⇒ 外部写进程 tdx2db 又被挡，见 ADR-012 §2.3.3） */
  writing: boolean;
  /** 外部写进程（tdx2db）写窗口标志：哨兵存在期间禁止重建 instance（方向 A） */
  externalWriting: boolean;
  /** 哨兵轮询定时器（进程内只允许一个） */
  sentinelWatcher: ReturnType<typeof setInterval> | null;
}

const GLOBAL_KEY = '__investDuckDBSingleton__';

function singleton(): DuckDBSingleton {
  const g = globalThis as unknown as Record<string, DuckDBSingleton | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { promise: null, writing: false, externalWriting: false, sentinelWatcher: null };
  }
  const s = g[GLOBAL_KEY] as DuckDBSingleton;
  // 兼容已存在的旧结构（热更新 / 测试跨文件复用 globalThis 时）
  if (s.externalWriting === undefined) s.externalWriting = false;
  if (s.sentinelWatcher === undefined) s.sentinelWatcher = null;
  return s;
}

/** 进程内写窗口是否打开（方向 B：Node 主动触发 tdx2db 时置 true） */
export function isDuckDBWriting(): boolean {
  return singleton().writing || singleton().externalWriting;
}

/** 打开写窗口：置标志 + 释放 instance，返回 release 函数 */
export async function enterDuckDBWriteWindow(): Promise<() => void> {
  const s = singleton();
  if (s.writing) {
    throw new Error('DuckDB 写窗口已在进行中（并发 rerun 不允许）');
  }
  s.writing = true;
  await closeDuckDBInstance();
  return () => {
    s.writing = false;
    // 下次查询惰性重建
  };
}

async function getInstance(): Promise<DuckDBInstance> {
  const s = singleton();
  // 方向 B：写窗口期间禁止重建 instance（否则并发查询会抢回锁 ⇒ tdx2db 失败）
  if (s.writing) {
    throw new Error('DuckDB 正在被行情更新写入（inProcessWriting），请稍后重试');
  }
  // 方向 A：外部 tdx2db 正在写库（哨兵存在）⇒ 禁止重建 instance
  if (s.externalWriting) {
    throw new Error('DuckDB 正在被行情更新写入（tdx2db sentinel），请稍后重试');
  }
  // 竞态兜底：watcher 还没看到哨兵时，查询也不能抢锁
  if (isDuckDBWriteSentinelPresent()) {
    s.externalWriting = true;
    await closeDuckDBInstance();
    throw new Error('DuckDB 正在被行情更新写入（tdx2db sentinel），请稍后重试');
  }
  if (!s.promise) {
    // access_mode: 'READ_ONLY' —— 落实 AGENTS.md:376「Fastify 对 DuckDB 只有 SELECT 权限」
    // （默认读写模式会持写锁，挡住 tdx2db 的 cron 写入）
    s.promise = DuckDBInstance.create(resolveDuckDBPath(), { access_mode: 'READ_ONLY' }).catch((err) => {
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

/** 哨兵文件路径（惰性读 env，供方向 A 使用） */
export function getDuckDBWriteSentinelPath(): string {
  return process.env.TDX2DB_WRITE_SENTINEL ?? '/opt/invol/IA_Prod/.tdx2db-writing';
}

/** 检查哨兵是否存在（方向 A：外部写进程在写库） */
export function isDuckDBWriteSentinelPresent(): boolean {
  try {
    return fs.existsSync(getDuckDBWriteSentinelPath());
  } catch {
    return false;
  }
}

/**
 * 检查一次哨兵并切换外部写窗口（方向 A 的核心动作）。
 *
 * - 哨兵出现：置 externalWriting=true 并**立即释放 instance**，让出文件锁给 tdx2db；
 * - 哨兵消失：清 externalWriting，下一次查询惰性重建 instance。
 *
 * @returns 当前哨兵是否存在
 */
export async function syncDuckDBWriteSentinel(): Promise<boolean> {
  const s = singleton();
  const present = isDuckDBWriteSentinelPresent();
  if (present && !s.externalWriting) {
    s.externalWriting = true;
    await closeDuckDBInstance();
  } else if (!present && s.externalWriting) {
    s.externalWriting = false;
  }
  return present;
}

/**
 * 启动方向 A 哨兵轮询（进程内幂等）。
 *
 * 17:00 的 tdx2db 是**独立进程**，不会经过 Node，因此 Node 必须主动轮询哨兵，
 * 在写窗口开始时释放 DuckDB instance；否则 tdx2db 会因文件锁冲突直接失败
 * （2026-10-23 生产实测：`Conflicting lock is held in /usr/bin/node`）。
 */
export function startDuckDBWriteSentinelWatcher(pollMs = 1_000): void {
  const s = singleton();
  if (s.sentinelWatcher) return;
  s.sentinelWatcher = setInterval(() => {
    void syncDuckDBWriteSentinel();
  }, pollMs);
  // 不因轮询定时器阻止进程退出（测试 / 优雅关闭）
  s.sentinelWatcher.unref?.();
}

/** 停止方向 A 哨兵轮询（幂等） */
export function stopDuckDBWriteSentinelWatcher(): void {
  const s = singleton();
  if (!s.sentinelWatcher) return;
  clearInterval(s.sentinelWatcher);
  s.sentinelWatcher = null;
  s.externalWriting = false;
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

/**
 * 整列归一化（列主序路径专用）
 *
 * 与逐格 {@link normalizeValue} 口径完全一致，区别只在 DATE 走**记忆化**：
 * 同一批结果里日期高度重复（实测 372635 行日线只有 ~9000 个不同日期），
 * 逐格转换要为每行 new Date + toISOString（实测 ~1.1s），记忆化后只剩一次查表。
 *
 * ⚠️ **按列类型短路**：VARCHAR / DOUBLE / BOOLEAN 等列的驱动返回值本就是 JS 原生类型，
 *   无需遍历整列（实测 372635 行的 VARCHAR 列遍历一次 ~30ms，8 列就是 ~250ms）。
 *   只有 BIGINT（→ number）与 DATE/TIMESTAMP（→ 'YYYY-MM-DD'）需要真正转换。
 */
function normalizeColumn(
  values: unknown[],
  dateCache: Map<number, string>,
  needsConversion: boolean,
): unknown[] {
  if (!needsConversion) return values;

  const out = new Array<unknown>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v === 'bigint') {
      out[i] = Number(v);
    } else if (v instanceof Date) {
      out[i] = v.toISOString().slice(0, 10);
    } else if (v !== null && typeof v === 'object') {
      const days = (v as DuckDBDateLike).days;
      if (typeof days === 'number') {
        let s = dateCache.get(days);
        if (s === undefined) {
          s = epochDaysToDateString(days);
          dateCache.set(days, s);
        }
        out[i] = s;
      } else {
        out[i] = v;
      }
    } else {
      out[i] = v;
    }
  }
  return out;
}

/** 列主序查询结果 */
export interface DuckDBColumnarResult {
  /** 列名（与 columns 的下标一一对应） */
  names: string[];
  /**
   * 取**归一化后**的某一列（按列名）
   *
   * ⚠️ 归一化是**惰性 + 记忆化**的：首次取该列时计算并缓存。
   *   实测选股路径一次要取 372635 行 × 8 列 —— 若一次性把所有列都归一化，
   *   单这一步就要 ~250ms；而实际只有 `date`（需 epoch→字符串）与 `volume`（bigint→number）
   *   两列需要转换，其余列是原始 string / number。
   */
  column(name: string): unknown[];
  /** 取**归一化后**的某一列（按下标） */
  columnAt(index: number): unknown[];
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
        return; // 成功
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
      // P0-9：必须确定性关闭 connection，否则句柄泄漏
      safeCloseConn(conn);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 列主序查询出口（选股路径的性能关键）
 *
 * 🔴 **为什么需要它**（2026-10-20 实测，`/opt/invol/quotes.duckdb` 1.24GB 真库）：
 *   选股要一次性取回「5000 标的 × 120 天」= **372635 行**日线。
 *   {@link queryDuckDB} 返回**行主序对象数组** —— 每行都要 new 一个 8 属性的对象，
 *   实测「行对象化」这一步单独就要 **~1.1s**，比 DuckDB 执行 SQL 本身还慢。
 *   列主序只造 8 个列数组（每列 372635 个元素），JS 侧省掉 37 万次对象分配。
 *   实测同一查询：行主序 ~3.8s vs 列主序 ~2.1s。
 *
 * ⚠️ **归一化口径与 {@link queryDuckDB} 完全一致**（bigint → number、DATE → 'YYYY-MM-DD'），
 *   区别只在 DATE 走记忆化（见 {@link normalizeColumn}）。
 *
 * ⚠️ 返回的是**列数组**，调用方按列名取用；行序 = DuckDB 返回序（SQL 里 ORDER BY 决定）。
 */
export async function queryDuckDBColumnar(sql: string, params?: unknown[]): Promise<DuckDBColumnarResult> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let conn: Awaited<ReturnType<typeof openConnection>> | null = null;
    try {
      conn = await openConnection();
      const reader = await conn.streamAndReadAll(sql, (params ?? []) as any);
      await reader.readAll();
      const names = reader.columnNames();
      const rawColumns = reader.getColumns();

      // ⚠️ 哪些列需要真正转换？只有 BIGINT（→ number）与 DATE/TIMESTAMP（→ 'YYYY-MM-DD'）。
      //   其余列（VARCHAR / DOUBLE / BOOLEAN）驱动直接给 JS 原生值，遍历整列纯属浪费。
      const needsConversion = names.map((_, idx) => {
        const typeId = reader.columnTypeId(idx);
        return (
          typeId === DuckDBTypeId.BIGINT ||
          typeId === DuckDBTypeId.UBIGINT ||
          typeId === DuckDBTypeId.DATE ||
          typeId === DuckDBTypeId.TIMESTAMP ||
          typeId === DuckDBTypeId.TIMESTAMP_S ||
          typeId === DuckDBTypeId.TIMESTAMP_MS ||
          typeId === DuckDBTypeId.TIMESTAMP_NS
        );
      });

      // 归一化缓存：列下标 → 归一化后的列（惰性计算，只算一次）
      const normalizedCache = new Map<number, unknown[]>();
      const dateCache = new Map<number, string>();
      const normalizeAt = (index: number): unknown[] => {
        const cached = normalizedCache.get(index);
        if (cached) return cached;
        const normalized = normalizeColumn(rawColumns[index], dateCache, needsConversion[index]);
        normalizedCache.set(index, normalized);
        return normalized;
      };

      const indexByName = new Map<string, number>();
      names.forEach((n, idx) => indexByName.set(n, idx));

      return {
        names,
        column: (name: string): unknown[] => {
          const idx = indexByName.get(name);
          if (idx === undefined) {
            throw new Error(`queryDuckDBColumnar: 结果里没有列 "${name}"（实际列：${names.join(', ')}）`);
          }
          return normalizeAt(idx);
        },
        columnAt: (index: number): unknown[] => normalizeAt(index),
      };
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
