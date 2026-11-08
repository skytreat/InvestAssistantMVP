/**
 * 回测批量「写窗口」守卫（方案 §7.1 / D1）
 *
 * 17:00 systemd timer 触发 tdx2db 写行情；17:04 纸面账户日更要同时读行情并写回测库
 * （`data/backtest.db`）。此期间再跑回测批量任务会：
 *   - 与 `tdx2db` 抢 DuckDB 文件锁（`Conflicting lock`）；
 *   - 与纸面日更抢 `backtest.db` 的写锁（`SQLITE_BUSY`）。
 * 故 17:00–17:10（Asia/Shanghai，工作日）禁止 `run` / `sweep`。
 *
 * 时区：**必须按 Asia/Shanghai 判定**。服务器进程时区可能是 UTC，
 * 用 `Date#getHours()` 会把 17:00 CST 判成 09:00。这里用 `Intl` 固定时区。
 *
 * 运维逃生阀：`BACKTEST_WRITE_WINDOW_GUARD=off` 跳过守卫（仅限人工确认后的补跑）。
 */
export const BACKTEST_WRITE_WINDOW_LABEL = '17:00–17:10';

const WINDOW_START_MINUTE = 17 * 60;
const WINDOW_END_MINUTE = 17 * 60 + 10;

const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export interface ShanghaiClock {
  /** `Mon` / `Tue` / ... */
  weekday: string;
  /** 当日分钟数（0–1439） */
  minutes: number;
}

/** 把任意 `Date` 折算成 Asia/Shanghai 的星期与分钟数（纯函数，便于单测） */
export function shanghaiClock(now: Date): ShanghaiClock {
  const parts = SHANGHAI_CLOCK.formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // 部分引擎午夜会返回 '24'，取模归一
  const hour = Number(pick('hour')) % 24;
  const minute = Number(pick('minute'));
  return { weekday: pick('weekday'), minutes: hour * 60 + minute };
}

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

/** 是否落在「禁止跑回测批量任务」的窗口（工作日 17:00 ≤ t < 17:10） */
export function isInBacktestWriteWindow(now: Date): boolean {
  const clock = shanghaiClock(now);
  if (!WEEKDAYS.has(clock.weekday)) return false;
  return clock.minutes >= WINDOW_START_MINUTE && clock.minutes < WINDOW_END_MINUTE;
}

export class BacktestWriteWindowError extends Error {
  readonly code = 'BACKTEST_WRITE_WINDOW';
  constructor(message: string) {
    super(message);
    this.name = 'BacktestWriteWindowError';
  }
}

/** 命中窗口即抛（CLI `run` / `sweep` 入口调用；`BACKTEST_WRITE_WINDOW_GUARD=off` 可跳过） */
export function assertBacktestWriteWindowOpen(now: Date = new Date()): void {
  if (process.env.BACKTEST_WRITE_WINDOW_GUARD === 'off') return;
  if (!isInBacktestWriteWindow(now)) return;
  throw new BacktestWriteWindowError(
    `${BACKTEST_WRITE_WINDOW_LABEL}（Asia/Shanghai）是行情写入与纸面日更窗口，禁止触发回测批量任务；` +
      '请错峰到 17:10 之后；确有补跑需要时经人工确认后设置 BACKTEST_WRITE_WINDOW_GUARD=off',
  );
}
