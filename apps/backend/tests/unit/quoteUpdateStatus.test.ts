import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-quote-status-'));
const TEST_DB = path.join(tmpDir, 'quote-status.db');
const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
process.env.SQLITE_DB_PATH = TEST_DB;

import { ConfigStore } from '../../src/config/configStore.js';
import {
  parseSystemctlShow,
  classifyTdx2dbStatus,
  readTdx2dbRunStatus,
  reportTdx2dbRunOutcome,
  queryLatestTdx2dbTiming,
} from '../../src/services/quoteUpdateStatus.js';

const NOW = Date.parse('2026-10-23T17:01:00Z');

function show(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    Result: 'success',
    ExecMainStatus: '0',
    ExecMainStartTimestamp: 'Fri 2026-10-23 17:00:02 UTC',
    ExecMainExitTimestamp: 'Fri 2026-10-23 17:00:42 UTC',
    ActiveState: 'inactive',
    SubState: 'dead',
    ...overrides,
  };
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function latestLog(): { level: string; message: string; detail: string | null } {
  return ConfigStore.getInstance()
    .db.prepare(
      `SELECT level, message, detail FROM system_log
       WHERE log_type = 'tdx2db_update' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { level: string; message: string; detail: string | null };
}

beforeAll(() => {
  ConfigStore.getInstance();
});

beforeEach(() => {
  ConfigStore.getInstance().db.exec("DELETE FROM system_log WHERE log_type = 'tdx2db_update'");
});

afterAll(() => {
  try {
    const store = (ConfigStore as any)._instance;
    if (store) (store.db as any).close();
  } catch {
    /* ignore */
  }
  (ConfigStore as any)._instance = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
});

describe('T105 行情更新结果归集', () => {
  it('parseSystemctlShow 解析 Key=Value', () => {
    expect(parseSystemctlShow(show())).toMatchObject({ Result: 'success', ExecMainStatus: '0' });
  });

  it('17:00 成功 → SUCCESS + durationSec', () => {
    const status = classifyTdx2dbStatus(parseSystemctlShow(show()), NOW);
    expect(status.state).toBe('SUCCESS');
    expect(status.durationSec).toBe(40);
    expect(status.message).toContain('成功');
  });

  it('17:00 失败 → FAIL（带 exit_code）', () => {
    const status = classifyTdx2dbStatus(
      parseSystemctlShow(
        show({ Result: 'exit-code', ExecMainStatus: '1', ActiveState: 'failed', SubState: 'failed' }),
      ),
      NOW,
    );
    expect(status.state).toBe('FAIL');
    expect(status.exitCode).toBe(1);
    expect(status.message).toContain('失败');
  });

  it('最近一次运行是昨天的 → NOT_RUN', () => {
    const status = classifyTdx2dbStatus(
      parseSystemctlShow(
        show({
          ExecMainStartTimestamp: 'Thu 2026-10-22 17:00:02 UTC',
          ExecMainExitTimestamp: 'Thu 2026-10-22 17:00:40 UTC',
        }),
      ),
      NOW,
    );
    expect(status.state).toBe('NOT_RUN');
    expect(status.message).toContain('不属于本轮');
  });

  it('17:00 更新耗时 32 分钟仍属本轮（Node 会等到写窗口结束再判状态）', () => {
    const status = classifyTdx2dbStatus(
      parseSystemctlShow(
        show({
          ExecMainStartTimestamp: 'Fri 2026-10-23 17:00:02 UTC',
          ExecMainExitTimestamp: 'Fri 2026-10-23 17:32:02 UTC',
        }),
      ),
      Date.parse('2026-10-23T17:32:10Z'),
    );
    expect(status.state).toBe('SUCCESS');
    expect(status.durationSec).toBe(32 * 60);
  });

  it('无任何运行记录 → NOT_RUN', () => {
    const status = classifyTdx2dbStatus(
      parseSystemctlShow(
        show({ ExecMainStartTimestamp: '', ExecMainExitTimestamp: '', ActiveState: 'inactive' }),
      ),
      NOW,
    );
    expect(status.state).toBe('NOT_RUN');
  });

  it('仍在运行（activating）→ RUNNING', () => {
    const status = classifyTdx2dbStatus(
      parseSystemctlShow(
        show({
          ActiveState: 'activating',
          SubState: 'start',
          ExecMainExitTimestamp: '',
          Result: '',
        }),
      ),
      NOW,
    );
    expect(status.state).toBe('RUNNING');
  });

  it('systemctl 不存在 → UNKNOWN（本地/CI 不误报）', async () => {
    const status = await readTdx2dbRunStatus({
      now: NOW,
      exec: async () => {
        throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(status.state).toBe('UNKNOWN');
  });

  it('report 成功写 SUCCESS；失败写 ERROR；不可读写 SKIP', async () => {
    const ok = await reportTdx2dbRunOutcome({
      now: NOW,
      exec: async () => ({ stdout: show(), stderr: '' }),
    });
    expect(ok.state).toBe('SUCCESS');
    let log = latestLog();
    expect(log.level).toBe('SUCCESS');
    expect(JSON.parse(log.detail!).duration_s).toBe(40);

    await reportTdx2dbRunOutcome({
      now: NOW,
      exec: async () => ({
        stdout: show({ Result: 'exit-code', ExecMainStatus: '1', ActiveState: 'failed' }),
        stderr: '',
      }),
    });
    log = latestLog();
    expect(log.level).toBe('ERROR');

    await reportTdx2dbRunOutcome({
      now: NOW,
      exec: async () => {
        throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
      },
    });
    log = latestLog();
    expect(log.level).toBe('SKIP');
  });

  it('queryLatestTdx2dbTiming 只认带 duration_s 的行（跳过补跑日志）', () => {
    const store = ConfigStore.getInstance();
    store.writeLog(
      'tdx2db_update',
      'SUCCESS',
      '17:00 行情更新成功（耗时 40s）',
      JSON.stringify({ state: 'SUCCESS', duration_s: 40 }),
      undefined,
      '2026-10-23',
    );
    store.writeLog(
      'tdx2db_update',
      'SUCCESS',
      'WARN/ERROR 触发 tdx2db 补跑（systemd-run）成功',
      JSON.stringify({ rerun: true }),
      undefined,
      '2026-10-23',
    );

    const row = queryLatestTdx2dbTiming('2026-10-23');
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.detail!).duration_s).toBe(40);
    expect(queryLatestTdx2dbTiming('2026-10-24')).toBeNull();
  });
});
