// src/services/quoteUpdateStatus.ts
// T105：17:00 tdx2db（systemd oneshot）执行结果归集
//
// 背景（2026-10-23 生产实测）：
//   tdx2db 因 DuckDB 文件锁冲突失败，但 Node 侧完全不知情 ——
//   17:01 校验因「无行情数据」全部 SKIP，汇总日志 `ERROR=0 WARN=0`，看起来一切正常。
//
// 方案（ADR-012 补充 · 方案 A）：
//   17:01 由 Node 执行 `systemctl show tdx2db.service` 读取 ExecMain*，
//   把结果写入 system_log(tdx2db_update)，让管理端 / C8 / 校验闸门都能看到「更新到底成没成」。
//   - 不新增 HTTP 回调端点（不扩大攻击面）
//   - 不依赖 journalctl（invol 用户读不了 journal，需额外组权限）
//   - 无 systemd 环境（本地开发 / CI）→ SKIP，不误报

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from './logger.js';

const execFileAsync = promisify(execFile);

export const TDX2DB_UNIT = 'tdx2db.service';

/**
 * 一轮 17:00 更新的判定时限。
 * 超过 30 分钟仍看到的「最近一次运行」不属于本轮 ⇒ 视为未触发。
 */
const MAX_RUN_AGE_MS = 30 * 60 * 1000;

export type Tdx2dbRunState = 'SUCCESS' | 'FAIL' | 'NOT_RUN' | 'RUNNING' | 'UNKNOWN';

export interface Tdx2dbRunStatus {
  state: Tdx2dbRunState;
  result?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  /** 本轮执行时长（秒）；systemd 时间戳精度为秒 */
  durationSec?: number;
  message: string;
}

type ExecFn = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface ReadTdx2dbStatusOptions {
  /** 注入时钟（测试用） */
  now?: number;
  /** 注入 exec（测试用） */
  exec?: ExecFn;
  /** exec 超时（毫秒） */
  timeoutMs?: number;
}

/** 解析 `systemctl show -p Key=Value` 输出 */
export function parseSystemctlShow(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return fields;
}

/** 解析 systemd 时间戳（如 `Fri 2026-10-23 17:00:23 UTC`）；空 / n/a 返回 null */
function parseSystemdTimestamp(value: string | undefined): Date | null {
  if (!value || value === 'n/a') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 把 `systemctl show` 的字段归类成可执行的结论。
 *
 * 纯函数，便于测试所有分支（无 systemd 的 CI 也能覆盖）。
 */
export function classifyTdx2dbStatus(fields: Record<string, string>, now = Date.now()): Tdx2dbRunStatus {
  const activeState = fields.ActiveState ?? '';
  const subState = fields.SubState ?? '';
  const result = fields.Result || undefined;
  const rawExit = fields.ExecMainStatus ?? '';
  const exitCode = /^\d+$/.test(rawExit) ? Number(rawExit) : undefined;
  const started = parseSystemdTimestamp(fields.ExecMainStartTimestamp);
  const finished = parseSystemdTimestamp(fields.ExecMainExitTimestamp);

  if (activeState === 'activating' || (activeState === 'active' && subState === 'start')) {
    return {
      state: 'RUNNING',
      result,
      exitCode,
      startedAt: started?.toISOString(),
      message: '17:00 行情更新仍在运行',
    };
  }

  if (!started) {
    return {
      state: 'NOT_RUN',
      result,
      exitCode,
      message: '17:00 行情更新未触发（systemd 无最近一次运行记录）',
    };
  }

  const ageMs = now - started.getTime();
  if (ageMs > MAX_RUN_AGE_MS || ageMs < -60_000) {
    return {
      state: 'NOT_RUN',
      result,
      exitCode,
      startedAt: started.toISOString(),
      message: `17:00 行情更新未触发（最近一次运行是 ${fields.ExecMainStartTimestamp}，不属于本轮）`,
    };
  }

  const durationSec =
    finished && finished.getTime() >= started.getTime()
      ? Math.round((finished.getTime() - started.getTime()) / 1000)
      : undefined;

  if (result === 'success' && (exitCode === undefined || exitCode === 0)) {
    return {
      state: 'SUCCESS',
      result,
      exitCode,
      startedAt: started.toISOString(),
      finishedAt: finished?.toISOString(),
      durationSec,
      message: `17:00 行情更新成功${durationSec !== undefined ? `（耗时 ${durationSec}s）` : ''}`,
    };
  }

  return {
    state: 'FAIL',
    result,
    exitCode,
    startedAt: started.toISOString(),
    finishedAt: finished?.toISOString(),
    durationSec,
    message: `17:00 行情更新失败（result=${result ?? 'unknown'}, exit_code=${exitCode ?? 'unknown'}）`,
  };
}

/** 读取 17:00 tdx2db.service 的最近一次执行结果（不写日志） */
export async function readTdx2dbRunStatus(opts: ReadTdx2dbStatusOptions = {}): Promise<Tdx2dbRunStatus> {
  const exec = (opts.exec ?? (execFileAsync as unknown as ExecFn)) as ExecFn;
  const now = opts.now ?? Date.now();
  try {
    const { stdout } = await exec(
      'systemctl',
      [
        'show',
        TDX2DB_UNIT,
        '--no-pager',
        '-p',
        'Result',
        '-p',
        'ExecMainStatus',
        '-p',
        'ExecMainStartTimestamp',
        '-p',
        'ExecMainExitTimestamp',
        '-p',
        'ActiveState',
        '-p',
        'SubState',
      ],
      { timeout: opts.timeoutMs ?? 10_000 },
    );
    return classifyTdx2dbStatus(parseSystemctlShow(stdout), now);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      state: 'UNKNOWN',
      message:
        code === 'ENOENT'
          ? '无法读取主题状态：本机无 systemctl（本地开发 / CI 环境正常）'
          : `无法读取 tdx2db.service 状态: ${String(err).slice(0, 200)}`,
    };
  }
}

/**
 * 读取结果并写入 system_log(tdx2db_update)。
 * 返回结论供调用方（校验闸门）决定「是否跳过 / 是否补跑」。
 */
export async function reportTdx2dbRunOutcome(
  opts: ReadTdx2dbStatusOptions = {},
): Promise<Tdx2dbRunStatus> {
  const status = await readTdx2dbRunStatus(opts);
  const level =
    status.state === 'SUCCESS'
      ? 'SUCCESS'
      : status.state === 'UNKNOWN'
        ? 'SKIP'
        : status.state === 'RUNNING'
          ? 'WARN'
          : 'ERROR';

  writeSystemLog({
    logType: 'tdx2db_update',
    level,
    message: status.message,
    detail: JSON.stringify({
      state: status.state,
      result: status.result,
      exit_code: status.exitCode,
      started_at: status.startedAt,
      finished_at: status.finishedAt,
      duration_s: status.durationSec,
    }),
  });

  return status;
}

/**
 * 读取某交易日最近一条**带结构化耗时**的 tdx2db_update 日志。
 *
 * 只认 detail 里含 `"duration_s"` 的行：
 *   - T105 写入的行带 duration_s（真实执行耗时）
 *   - 补跑（quoteRerun）写入的行没有 duration_s，不能用来算 C8
 */
export function queryLatestTdx2dbTiming(
  tradeDate: string,
): { createdAt: string; detail: string | null } | null {
  const db = ConfigStore.getInstance().db;
  const row = db
    .prepare(
      `SELECT created_at AS createdAt, detail AS detail
       FROM system_log
       WHERE log_type = 'tdx2db_update'
         AND log_date = ?
         AND detail LIKE '%"duration_s"%'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(tradeDate) as { createdAt: string; detail: string | null } | undefined;
  return row ?? null;
}
