// src/services/alert.ts
// 每日行情链路失败的企业微信（群机器人）告警。
//
// 设计约束：
// - Node >= 22 内置 fetch，不引入第三方依赖；
// - 告警是旁路：任何失败都不得抛出、不得阻塞或回滚行情链路；
// - webhook URL 视为凭据：只从 env 读取，不写日志、不下发前端；
// - 同一 (日期, 失败类型) 当天只推一次（进程内去重，失败可重试）。

import { writeSystemLog } from './logger.js';

export const ALERT_LOG_TYPE = 'alert';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TEXT_BYTES = 2_000;

export interface WecomAlertInput {
  /** YYYY-MM-DD，与 system_log.log_date 同口径 */
  date: string;
  /** 去重键：同一日期同一 kind 只推一次 */
  kind: string;
  title: string;
  lines: string[];
  level?: 'ERROR' | 'WARN';
}

export type AlertSendReason =
  'SENT' | 'DISABLED' | 'NOT_CONFIGURED' | 'INVALID_URL' | 'NON_TRADING_DAY' | 'DUPLICATE' | 'SEND_FAILED';

export interface AlertSendResult {
  sent: boolean;
  reason: AlertSendReason;
}

export interface SendWecomAlertDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const sentKeys = new Set<string>();

/** 测试用：清空进程内去重记录 */
export function resetAlertDedupe(): void {
  sentKeys.clear();
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value.trim() : undefined;
}

export function isWecomAlertEnabled(): boolean {
  return (getEnv('ALERT_ENABLED') ?? 'true').toLowerCase() !== 'false';
}

export function getWecomWebhookUrl(): string | null {
  return getEnv('WECOM_WEBHOOK_URL') ?? null;
}

/**
 * 是否工作日（不含节假日判断）。
 *
 * 与 cron 的 `1-5` 口径保持一致：节假日 tdx2db 仍会按 timer 触发，
 * 此时链路异常同样值得告警；反过来，周末补跑失败不推送，避免噪声。
 */
export function isAlertableDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return false;
  const dow = day.getUTCDay();
  return dow >= 1 && dow <= 5;
}

function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'qyapi.weixin.qq.com';
  } catch {
    return false;
  }
}

function redactSecrets(text: string): string {
  return text.replace(/key=[^&\s]+/gi, 'key=****');
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let truncated = text;
  while (Buffer.byteLength(truncated, 'utf8') > maxBytes - 3) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

export function buildWecomText(input: WecomAlertInput): string {
  const content = [
    `[InvestAssistant] ${input.title}`,
    `日期：${input.date}`,
    `级别：${input.level ?? 'ERROR'}`,
    ...input.lines,
  ].join('\n');
  return truncateUtf8(content, MAX_TEXT_BYTES);
}

export function buildWecomPayload(input: WecomAlertInput): Record<string, unknown> {
  return {
    msgtype: 'text',
    text: { content: buildWecomText(input) },
  };
}

function logAlertFailure(message: string, detail: string): void {
  try {
    writeSystemLog({
      logType: ALERT_LOG_TYPE,
      level: 'ERROR',
      message,
      detail: redactSecrets(detail).slice(0, 500),
    });
  } catch {
    // 告警是旁路：日志兜底失败也不能反向影响调度
  }
}

export async function sendWecomAlert(
  input: WecomAlertInput,
  deps: SendWecomAlertDeps = {},
): Promise<AlertSendResult> {
  if (!isWecomAlertEnabled()) return { sent: false, reason: 'DISABLED' };

  const url = getWecomWebhookUrl();
  if (!url) return { sent: false, reason: 'NOT_CONFIGURED' };

  if (!isAlertableDay(input.date)) return { sent: false, reason: 'NON_TRADING_DAY' };

  if (!isAllowedWebhookUrl(url)) {
    logAlertFailure('企业微信告警未发送：WECOM_WEBHOOK_URL 不是企业微信官方地址', 'invalid webhook host');
    return { sent: false, reason: 'INVALID_URL' };
  }

  const dedupeKey = `${input.date}:${input.kind}`;
  if (sentKeys.has(dedupeKey)) return { sent: false, reason: 'DUPLICATE' };
  sentKeys.add(dedupeKey);

  const configuredTimeout = Number(getEnv('ALERT_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    deps.timeoutMs ??
    (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS);

  try {
    const fetchFn = deps.fetchFn ?? fetch;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWecomPayload(input)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
    if (!res.ok || body?.errcode !== 0) {
      throw new Error(
        `企业微信返回异常: http=${res.status} errcode=${body?.errcode ?? 'unknown'} errmsg=${body?.errmsg ?? ''}`,
      );
    }
    return { sent: true, reason: 'SENT' };
  } catch (err) {
    // 失败不占用当天的去重名额：后续阶段（如补跑终态）还有机会再推一次
    sentKeys.delete(dedupeKey);
    logAlertFailure('企业微信告警发送失败', err instanceof Error ? err.message : String(err));
    return { sent: false, reason: 'SEND_FAILED' };
  }
}
