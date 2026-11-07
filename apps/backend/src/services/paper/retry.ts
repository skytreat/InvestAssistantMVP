/**
 * 纸面账户 17:04 段的并发语义（方案 §12.1.3）
 *
 * - **SQLite `SQLITE_BUSY` / `SQLITE_LOCKED`**：短期重试（17:01-17:05 四段 cron 与
 *   `tdx2db` 都可能持有锁），耗尽后上抛，调用方映射成 `PAPER_DB_BUSY`（503），
 *   **pending 挂单保留**，下次运行补算。
 * - **DuckDB 锁冲突**：不重试、不映射成停牌 —— 直接 `PAPER_QUOTE_DB_BUSY`，
 *   由调度下一次补算（见 `settle.ts` 的 `isDuckDbBusy`）。
 */

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT']);

/** better-sqlite3 的 busy 判定（`code` 优先，消息兜底） */
export function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && BUSY_CODES.has(code)) return true;
  const message = (err as { message?: string } | null)?.message ?? '';
  return /database (table )?is locked|database is busy/i.test(message);
}

/** DuckDB 单文件锁被别的进程/句柄占用（回测批量任务与 17:04 段唯一可能冲突点） */
export function isDuckDbBusy(err: unknown): boolean {
  const message = (err as { message?: string } | null)?.message ?? '';
  return /Could not set lock on file|Conflicting lock is held|IO Error: Could not set lock/i.test(
    message,
  );
}

const DEFAULT_DELAYS_MS = [50, 200, 800] as const;

export interface BusyRetryOptions {
  /** 每两次尝试之间的等待；长度 = 重试次数 */
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 同步或异步任务包一层 busy 重试。
 *
 * ⚠️ `fn` **必须幂等**（本模块只用于「单事务写」——事务失败整体回滚，重跑不会半提交）。
 */
export async function withBusyRetry<T>(
  fn: () => T | Promise<T>,
  opts: BusyRetryOptions = {},
): Promise<T> {
  const delays = opts.delays ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= delays.length) throw err;
      await sleep(delays[attempt] ?? 0);
    }
  }
}
