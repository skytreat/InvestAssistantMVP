// src/services/scheduler.ts
// T21: Fastify @fastify/schedule cron 注册 + 4 段串行调度
// 底层是 toad-scheduler: CronJob + AsyncTask

import type { FastifyInstance } from 'fastify';
import { CronJob, AsyncTask } from 'toad-scheduler';
import { runAllChecks } from './validator.js';
import { executeAllPlugins } from './pluginEngine.js';
import { importDividendEvents } from './exDividendSync.js';
import { writeSystemLog } from './logger.js';

/**
 * 注册所有 cron 任务（由 server.ts 在 Fastify 启动后调用）
 *
 * cron 表达式（5 段标准格式：分 时 日 月 周）:
 *   17:01 → '1 17 * * 1-5'  （周一到周五 17:01，交易日排除周末）
 *   17:02 → '2 17 * * 1-5'
 *   17:03 → '3 17 * * 1-5'
 *   17:05 → '5 17 * * 1-5'
 *
 * 注意：法定节假日不排除（MVP 简化），C1 交易日历校验会在非交易日自动返回 WARN+SKIP
 */
export function registerCronJobs(app: FastifyInstance): void {
  if (!app.scheduler) {
    writeSystemLog({
      logType: 'startup', level: 'ERROR',
      message: '@fastify/schedule 未注册，无法初始化 cron',
    });
    return;
  }

  // === 17:01 数据校验 C1-C12 ===
  app.scheduler.addCronJob(new CronJob(
    { cronExpression: '1 17 * * 1-5' },
    new AsyncTask('datacheck-c1-c12', async () => {
      writeSystemLog({
        logType: 'datacheck', level: 'INFO', message: 'C1-C12 校验开始',
      });
      const date = new Date().toISOString().slice(0, 10);
      try {
        const summaries = await runAllChecks(date);
        const errors = summaries.filter(s => s.result === 'ERROR').length;
        const warns = summaries.filter(s => s.result === 'WARN').length;
        writeSystemLog({
          logType: 'datacheck',
          level: errors > 0 ? 'ERROR' : warns > 0 ? 'WARN' : 'SUCCESS',
          message: `C1-C12 校验完成: ERROR=${errors} WARN=${warns} TOTAL=${summaries.length}`,
        });
      } catch (err: any) {
        writeSystemLog({
          logType: 'datacheck', level: 'ERROR',
          message: 'C1-C12 校验异常', detail: String(err),
        });
      }
    }),
  ));

  // === 17:02 插件信号生成 ===
  app.scheduler.addCronJob(new CronJob(
    { cronExpression: '2 17 * * 1-5' },
    new AsyncTask('signal-generate', async () => {
      writeSystemLog({
        logType: 'signal_generate', level: 'INFO', message: '插件信号生成开始',
      });
      try {
        const result = await executeAllPlugins();
        writeSystemLog({
          logType: 'signal_generate',
          level: result.stats.error > 0 || result.stats.timeout > 0 ? 'WARN' : 'SUCCESS',
          message: `信号生成完成: signals=${result.signals.length} stats=${JSON.stringify(result.stats)}`,
        });
      } catch (err: any) {
        writeSystemLog({
          logType: 'signal_generate', level: 'ERROR',
          message: '插件信号生成异常', detail: String(err),
        });
      }
    }),
  ));

  // === 17:03 除权自动导入 ===
  app.scheduler.addCronJob(new CronJob(
    { cronExpression: '3 17 * * 1-5' },
    new AsyncTask('dividend-import', async () => {
      writeSystemLog({
        logType: 'dividend_import', level: 'INFO', message: '除权自动导入开始',
      });
      const date = new Date().toISOString().slice(0, 10);
      try {
        const result = await importDividendEvents(date);
        writeSystemLog({
          logType: 'dividend_import',
          level: result.errors > 0 ? 'ERROR' : result.eventsProcessed > 0 ? 'SUCCESS' : 'SKIP',
          message: `除权导入完成: events=${result.eventsProcessed} imported=${result.importedDividend + result.importedBonus} skipped=${result.duplicatesSkipped + result.holdingsSkipped} errors=${result.errors}`,
        });
      } catch (err: any) {
        writeSystemLog({
          logType: 'dividend_import', level: 'ERROR',
          message: '除权自动导入异常', detail: String(err),
        });
      }
    }),
  ));

  // === 17:05 备份（MVP 简化占位） ===
  app.scheduler.addCronJob(new CronJob(
    { cronExpression: '5 17 * * 1-5' },
    new AsyncTask('backup', async () => {
      writeSystemLog({
        logType: 'backup', level: 'INFO', message: '备份开始（MVP 简化占位）',
      });
      // TODO Phase 3 实现：
      //   1. DuckDB: COPY v_stock_qfq TO parquet
      //   2. SQLite: PRAGMA wal_checkpoint(TRUNCATE) + VACUUM INTO
      writeSystemLog({
        logType: 'backup', level: 'SKIP',
        message: '备份 MVP 简化占位，Phase 3 实现',
      });
    }),
  ));

  writeSystemLog({
    logType: 'startup', level: 'INFO',
    message: '4 段 cron 已注册: 17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份',
  });
}
