import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  buildWecomMarkdown,
  getWecomWebhookUrl,
  isAlertableDay,
  resetAlertDedupe,
  sendWecomAlert,
} from '../../src/services/alert.js';
import * as loggerNs from '../../src/services/logger.js';

vi.mock('../../src/services/logger.js', () => ({
  writeSystemLog: vi.fn(),
}));

const WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchOk() {
  return vi.fn(async () => jsonResponse({ errcode: 0, errmsg: 'ok' })) as unknown as typeof fetch;
}

beforeEach(() => {
  resetAlertDedupe();
  vi.mocked(loggerNs.writeSystemLog).mockReset();
  vi.stubEnv('WECOM_WEBHOOK_URL', WEBHOOK_URL);
  vi.stubEnv('ALERT_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('alert · 企业微信告警', () => {
  it('markdown 包含标题、日期与明细，并做长度截断', () => {
    const content = buildWecomMarkdown({
      date: '2026-11-12',
      kind: 'quote_chain_failed',
      title: '行情更新失败（更新未生效）',
      lines: ['状态：FAIL', '详情：mock'],
    });

    expect(content).toContain('行情更新失败（更新未生效）');
    expect(content).toContain('2026-11-12');
    expect(content).toContain('状态：FAIL');
    expect(content).toContain('详情：mock');
    expect(content).toContain('ERROR');

    const long = buildWecomMarkdown({
      date: '2026-11-12',
      kind: 'k',
      title: 'T',
      lines: ['x'.repeat(2_000)],
    });
    expect(long.length).toBeLessThanOrEqual(1_001);
    expect(long.endsWith('…')).toBe(true);
  });

  it('未配置 WECOM_WEBHOOK_URL → NOT_CONFIGURED 且不发起请求', async () => {
    vi.stubEnv('WECOM_WEBHOOK_URL', '');
    const fetchFn = fetchOk();

    const result = await sendWecomAlert(
      { date: '2026-11-12', kind: 'k', title: 'T', lines: [] },
      { fetchFn },
    );

    expect(result).toEqual({ sent: false, reason: 'NOT_CONFIGURED' });
    expect(getWecomWebhookUrl()).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('ALERT_ENABLED=false → DISABLED', async () => {
    vi.stubEnv('ALERT_ENABLED', 'false');
    const fetchFn = fetchOk();

    const result = await sendWecomAlert(
      { date: '2026-11-12', kind: 'k', title: 'T', lines: [] },
      { fetchFn },
    );

    expect(result).toEqual({ sent: false, reason: 'DISABLED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('周末不推送（与 cron 的 1-5 口径一致）', async () => {
    expect(isAlertableDay('2026-11-12')).toBe(true);
    expect(isAlertableDay('2026-11-13')).toBe(true);
    expect(isAlertableDay('2026-11-14')).toBe(false);
    expect(isAlertableDay('not-a-date')).toBe(false);

    const fetchFn = fetchOk();
    const result = await sendWecomAlert(
      { date: '2026-11-14', kind: 'k', title: 'T', lines: [] },
      { fetchFn },
    );

    expect(result).toEqual({ sent: false, reason: 'NON_TRADING_DAY' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('非企业微信官方地址 → INVALID_URL，且失败日志不含 webhook key', async () => {
    vi.stubEnv('WECOM_WEBHOOK_URL', 'https://example.com/webhook?key=test-secret');
    const fetchFn = fetchOk();

    const result = await sendWecomAlert(
      { date: '2026-11-12', kind: 'k', title: 'T', lines: [] },
      { fetchFn },
    );

    expect(result).toEqual({ sent: false, reason: 'INVALID_URL' });
    expect(fetchFn).not.toHaveBeenCalled();
    const log = vi.mocked(loggerNs.writeSystemLog).mock.calls[0][0];
    expect(log.logType).toBe('alert');
    expect(log.level).toBe('ERROR');
    expect(log.detail).not.toContain('test-secret');
  });

  it('成功发送 markdown 消息，并按 (date,kind) 去重', async () => {
    const fetchFn = fetchOk();
    const input = { date: '2026-11-12', kind: 'quote_chain_failed', title: 'T', lines: ['line-1'] };

    const first = await sendWecomAlert(input, { fetchFn });
    const second = await sendWecomAlert(input, { fetchFn });

    expect(first).toEqual({ sent: true, reason: 'SENT' });
    expect(second).toEqual({ sent: false, reason: 'DUPLICATE' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      msgtype: 'markdown',
      markdown: { content: expect.stringContaining('line-1') },
    });
  });

  it('企业微信 errcode 非 0 → SEND_FAILED，写 alert ERROR 日志且脱敏', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ errcode: 93000, errmsg: 'invalid webhook url' }),
    ) as unknown as typeof fetch;

    const result = await sendWecomAlert(
      { date: '2026-11-12', kind: 'k', title: 'T', lines: [] },
      { fetchFn },
    );

    expect(result).toEqual({ sent: false, reason: 'SEND_FAILED' });
    const log = vi.mocked(loggerNs.writeSystemLog).mock.calls[0][0];
    expect(log.logType).toBe('alert');
    expect(log.level).toBe('ERROR');
    expect(log.message).toContain('发送失败');
    expect(log.detail).not.toContain('test-secret');
  });

  it('告警日志本身写失败时仍不抛出（旁路契约）', async () => {
    vi.stubEnv('WECOM_WEBHOOK_URL', 'https://example.com/webhook?key=x');
    vi.mocked(loggerNs.writeSystemLog).mockImplementation(() => {
      throw new Error('log store down');
    });

    await expect(
      sendWecomAlert({ date: '2026-11-12', kind: 'k', title: 'T', lines: [] }, { fetchFn: fetchOk() }),
    ).resolves.toEqual({ sent: false, reason: 'INVALID_URL' });
  });

  it('发送失败不占用去重名额，后续阶段可重试', async () => {
    const failFetch = vi.fn(async () => {
      throw new Error(`network down: ${WEBHOOK_URL}`);
    }) as unknown as typeof fetch;
    const okFetch = fetchOk();

    const input = { date: '2026-11-12', kind: 'k', title: 'T', lines: [] };
    const first = await sendWecomAlert(input, { fetchFn: failFetch });
    const second = await sendWecomAlert(input, { fetchFn: okFetch });

    expect(first).toEqual({ sent: false, reason: 'SEND_FAILED' });
    expect(second).toEqual({ sent: true, reason: 'SENT' });
    const log = vi.mocked(loggerNs.writeSystemLog).mock.calls[0][0];
    expect(log.detail).not.toContain('test-secret');
  });
});
