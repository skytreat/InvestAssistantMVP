/**
 * schedulerBackup.test.ts — G10.3 / T103
 *
 * 覆盖 17:05 备份 cron 的日志语义：
 *   - `duckdb.skipped=true`（ENABLE_QUOTE_BACKUP=false）→ `duckdb=SKIP` 且 `level=SUCCESS`
 *   - 未跳过且成功 → `duckdb=OK` + SUCCESS（回归）
 *   - 真实失败 → `duckdb=FAIL` + ERROR（skip 不得掩盖失败）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runFullBackupMock } = vi.hoisted(() => ({
  runFullBackupMock: vi.fn(),
}));

vi.mock('../../src/services/backup.js', () => ({
  runFullBackup: runFullBackupMock,
}));

import { registerCronJobs } from '../../src/services/scheduler.js';
import * as loggerNs from '../../src/services/logger.js';

function collectJobs(): any[] {
  const jobs: any[] = [];
  const fakeApp = {
    scheduler: {
      addCronJob: (job: any) => jobs.push(job),
    },
  } as any;
  registerCronJobs(fakeApp);
  return jobs;
}

async function runBackupTask(jobs: any[]): Promise<void> {
  const backupJob = jobs.find((job) => job.id === 'backup');
  expect(backupJob, '必须注册 id=backup 的 cron').toBeDefined();
  await backupJob.task.executeAsync();
}

function summaryLogs(logSpy: ReturnType<typeof vi.spyOn>) {
  return logSpy.mock.calls
    .map((call) => call[0] as any)
    .filter((entry) => entry?.logType === 'backup' && entry?.message?.includes('备份完成'));
}

describe('scheduler — 17:05 备份日志（ENABLE_QUOTE_BACKUP）', () => {
  beforeEach(() => {
    runFullBackupMock.mockReset();
  });

  it('duckdb.skipped=true → duckdb=SKIP 且 level=SUCCESS（不得误报 ERROR）', async () => {
    runFullBackupMock.mockResolvedValue({
      sqlite: { success: true, size: 1024 },
      duckdb: { success: true, skipped: true },
      cleanedFiles: 0,
    });

    const logSpy = vi.spyOn(loggerNs, 'writeSystemLog').mockImplementation(() => {});
    try {
      await runBackupTask(collectJobs());

      const summaries = summaryLogs(logSpy);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].message).toContain('duckdb=SKIP');
      expect(summaries[0].level).toBe('SUCCESS');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('未跳过且成功 → duckdb=OK + SUCCESS（默认行为回归）', async () => {
    runFullBackupMock.mockResolvedValue({
      sqlite: { success: true, size: 1024 },
      duckdb: { success: true, size: 2048 },
      cleanedFiles: 1,
    });

    const logSpy = vi.spyOn(loggerNs, 'writeSystemLog').mockImplementation(() => {});
    try {
      await runBackupTask(collectJobs());

      const summaries = summaryLogs(logSpy);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].message).toContain('duckdb=OK');
      expect(summaries[0].level).toBe('SUCCESS');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('DuckDB 真实失败（未 skipped）→ duckdb=FAIL + ERROR', async () => {
    runFullBackupMock.mockResolvedValue({
      sqlite: { success: true, size: 1024 },
      duckdb: { success: false, error: 'disk full' },
      cleanedFiles: 0,
    });

    const logSpy = vi.spyOn(loggerNs, 'writeSystemLog').mockImplementation(() => {});
    try {
      await runBackupTask(collectJobs());

      const summaries = summaryLogs(logSpy);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].message).toContain('duckdb=FAIL');
      expect(summaries[0].level).toBe('ERROR');
    } finally {
      logSpy.mockRestore();
    }
  });
});
