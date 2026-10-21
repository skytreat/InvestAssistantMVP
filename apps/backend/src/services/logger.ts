// src/services/logger.ts
import { ConfigStore } from '../config/configStore.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';

const FALLBACK_FILE = '/var/log/invol/err.log';

export interface SystemLogEntry {
  logType: string; // datacheck / signal_generate / dividend_import / backup / trigger_manual / startup
  level: string; // INFO / WARN / ERROR / SKIP / SUCCESS
  message: string;
  detail?: string;
  checkItem?: string;
  logDate?: string; // YYYY-MM-DD，默认今天
}

// =====================================================================
// SDD §6 S6 日志脱敏 —— 在 writeSystemLog 内部统一做，三层降级自动脱敏
// =====================================================================

/** 金额脱敏：末 4 位换 ****，只处理整数部分 ≥ 4 位的金额 */
function maskAmount(text: string): string {
  return text.replace(/\b(\d{4,})(\.\d+)?\b/g, (_match, intPart: string, _decPart: string | undefined) => {
    const maskedInt = intPart.slice(0, -4) + '****';
    return maskedInt;
  });
}

/** 用户标识脱敏：username 保留前 2 位，后面 **** */
function maskUserId(text: string): string {
  return text.replace(/(username[:=]\s*)([a-zA-Z0-9_]{2,})/gi, (m, prefix, name: string) => {
    if (name.length <= 2) return m;
    return `${prefix}${name.slice(0, 2)}****`;
  });
}

/**
 * writeSystemLog 三层降级：
 * 1. 正常：写 SQLite system_log
 * 2. SQLite 不可用：降级 console.error → systemd journal 自动捕获
 * 3. 都不可用：降级写文件 /var/log/invol/err.log
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 **批量缓冲模式**（选股 ≤3s 的关键一步）
 *
 * 选股一次请求会对 5000 个标的各跑一次插件 → **5000 条 plugin_execute 日志**。
 * 逐条 auto-commit 实测 **~1.0s**（占选股总耗时 30%+），把 PE2「选股 ≤3s」直接顶穿。
 *
 * 缓冲模式下：
 * - `SKIP` / `SUCCESS` / `INFO` 进内存缓冲，批量结束时**单事务**落库（实测 ~50ms）；
 * - `WARN` / `ERROR` **立即落库**（关键诊断信息不能因进程崩溃丢失）；
 * - 落库的**行内容**与逐条写完全一致（含脱敏后的 message/detail），
 *   只是提交次数从 5000 降到 1。
 *
 * ⚠️ **顺序不完全一致**（2026-10-21 实测澄清，勿再声称「顺序一致」）：
 *   WARN/ERROR 立即落库 → 拿到的是**较小的 rowid**；缓冲行在 flush 时才落库 → rowid 更大。
 *   ⇒ 一条 INFO 之后紧跟一条 WARN 时，库里 WARN 在前、INFO 在后（与调用顺序相反）。
 *   这不影响任何现有断言（system_log 无顺序语义），但**审计读日志时不能假设 id 序 = 调用序**。
 *
 * ⚠️ **缓冲作用域 = 单次请求**（AsyncLocalStorage）：
 *   - 用模块级全局变量做缓冲会让**并发请求互相串台**（A 请求的 flush 会把 B 请求的日志提前落库，
 *     B 后续日志退化成逐条写 → 性能回退）；
 *   - 用 ALS 之后，缓冲只对 `withSystemLogBuffer` 包裹的那段异步调用链可见，
 *     请求之外（如 cron 任务）写的日志**立即落库**，语义与改造前一致。
 */
export function writeSystemLog(entry: SystemLogEntry): void {
  const { logType, level, message, detail, checkItem, logDate } = entry;
  const date = logDate ?? new Date().toISOString().slice(0, 10);

  // SDD §6 S6 脱敏 —— 三层降级统一使用 safeMessage/safeDetail
  // ⚠️ 脱敏**必须在这里做**（唯一入口）：缓冲里的行与立即落库的行用的是同一份 safeMessage/safeDetail，
  //   否则「缓冲路径」会绕过脱敏，把 username / 金额明文写进 system_log。
  const safeMessage = maskAmount(maskUserId(message ?? ''));
  const safeDetail = detail ? maskAmount(maskUserId(detail)) : undefined;

  // Level 校验
  const ALLOWED_LEVELS = ['INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS'];
  if (!ALLOWED_LEVELS.includes(level)) {
    console.warn('[writeSystemLog] 非法 level:', level, '允许:', ALLOWED_LEVELS);
  }

  // 缓冲模式：非关键等级进缓冲，WARN/ERROR 立即落库
  const buffer = _bufferStore.getStore();
  if (buffer !== undefined && !buffer.closed && level !== 'WARN' && level !== 'ERROR') {
    buffer.push({ logType, level, message: safeMessage, detail: safeDetail, checkItem, logDate: date });
    return;
  }

  writeNow({ logType, level, message: safeMessage, detail: safeDetail, checkItem, logDate: date });
}

/** 实际落库（SQLite → console.error → 文件 三层降级） */
function writeNow(
  entry: Required<Pick<SystemLogEntry, 'logType' | 'level' | 'message' | 'logDate'>> & {
    detail?: string;
    checkItem?: string;
  },
): void {
  const { logType, level, message, detail, checkItem, logDate } = entry;

  // 第 1 层：正常写 SQLite
  try {
    const config = ConfigStore.getInstance();
    config.writeLog(logType, level, message, detail, checkItem, logDate);
    return; // 成功，直接返回
  } catch (sqliteErr) {
    console.error('[writeSystemLog] SQLite 不可用，降级到 console.error:', sqliteErr);
  }

  // 第 2 层：console.error（systemd journal 自动捕获）
  const journalMsg = JSON.stringify({
    source: 'invest-assistant',
    logType,
    level,
    checkItem,
    message,
    detail,
    date: logDate,
  });
  console.error(journalMsg);

  // 第 3 层：写文件（如果 journal 也没接住）
  try {
    fs.appendFileSync(FALLBACK_FILE, journalMsg + '\n', { mode: 0o644 });
  } catch {
    // 彻底放弃
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 批量缓冲（AsyncLocalStorage 作用域 —— 见 writeSystemLog 上方注释）
// ──────────────────────────────────────────────────────────────────────────

/** system_log 批量写入的一行（与 {@link SystemLogEntry} 同构，detail/checkItem 可缺省） */
export interface BufferedLog {
  logType: string;
  level: string;
  message: string;
  detail?: string;
  checkItem?: string;
  /** 落库日期（YYYY-MM-DD）—— 缓冲时已填好（默认今天），不会为空 */
  logDate: string;
}

/** 缓冲区容器（带「已冲刷」标记 —— 见下方 closed 的用途） */
interface LogBuffer extends Array<BufferedLog> {
  /** 已冲刷：冲刷后再进来的日志必须立即落库，不能再进缓冲（否则会被静默丢弃） */
  closed: boolean;
}

/** 当前异步上下文里的日志缓冲（undefined = 不在缓冲作用域内 → 立即落库） */
const _bufferStore = new AsyncLocalStorage<LogBuffer>();

/**
 * 在缓冲作用域内执行一段逻辑，期间产生的非关键日志在结束时**单事务**落库
 *
 * - WARN / ERROR 始终立即落库（不受缓冲影响）；
 * - 无论回调正常返回还是抛异常，缓冲都会在 finally 里冲刷（不丢日志）；
 * - 批量落库失败时**降级为逐条写入**（不丢日志）。
 *
 * @example
 * ```ts
 * await withSystemLogBuffer(async () => {
 *   for (const s of symbols) await executePlugin(plugin, { symbol: s }, ctx);
 * });
 * ```
 */
export async function withSystemLogBuffer<T>(fn: () => Promise<T>): Promise<T> {
  const buffer: LogBuffer = Object.assign([] as BufferedLog[], { closed: false });
  try {
    return await _bufferStore.run(buffer, fn);
  } finally {
    flushBuffer(buffer);
  }
}

/**
 * 把缓冲区单事务落库（空缓冲直接返回）
 *
 * ⚠️ **冲刷后必须把缓冲标记为 closed**（2026-10-21 修正）：
 *   插件引擎的执行体是**游离 async IIFE**（`pluginEngine.ts` 的 `void (async () => …)()`），
 *   超时后它**仍可能在后台继续跑**。若它在此刻之后调用 `writeSystemLog`，
 *   日志会被 push 进**已经冲刷过的缓冲数组** ⇒ 永远不会再落库 ⇒ **静默丢日志**。
 *   ⇒ closed 标记让「迟到」的日志改走立即落库路径。
 */
function flushBuffer(buffer: LogBuffer): void {
  buffer.closed = true;
  if (buffer.length === 0) return;
  try {
    ConfigStore.getInstance().writeLogBatch(buffer);
  } catch (err) {
    console.error('[writeSystemLog] 批量落库失败，降级逐条写入:', err);
    for (const entry of buffer) writeNow(entry);
  }
}
