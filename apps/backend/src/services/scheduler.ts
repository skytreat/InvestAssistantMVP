// src/services/scheduler.ts
// T21: Fastify @fastify/schedule cron 注册 + 4 段串行调度
// 底层是 toad-scheduler: CronJob + AsyncTask

import type { FastifyInstance } from 'fastify';
import { CronJob, AsyncTask } from 'toad-scheduler';
import { runAllChecks } from './validator.js';
import { executeAllPlugins } from './pluginEngine.js';
import { importDividendEvents } from './exDividendSync.js';
import { writeSystemLog } from './logger.js';
import { persistSignals, getTradeDate } from './signalService.js';
import { runFullBackup } from './backup.js';
import { insertAssetStatSnapshots } from './assetStat.js';

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
    { id: 'datacheck-c1-c12' },
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
        // T27 补：从 result.results 里筛 SUCCESS 的，每个 plugin 单独持久化（保留 pluginId）
        const tradeDate = getTradeDate();
        let totalInserted = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        for (const pluginResult of result.results) {
          if (pluginResult.status !== 'SUCCESS' || pluginResult.signals.length === 0) continue;
          const persist = persistSignals(
            pluginResult.signals,
            pluginResult.pluginId,
            'monitor',
            tradeDate,
          );
          totalInserted += persist.inserted;
          totalSkipped += persist.skipped;
          totalErrors += persist.errors;
        }
        writeSystemLog({
          logType: 'signal_generate',
          level: totalErrors > 0 || result.stats.error > 0 || result.stats.timeout > 0 ? 'WARN' : 'SUCCESS',
          message: `信号生成完成: signals=${result.signals.length} inserted=${totalInserted} skipped=${totalSkipped} persist_errors=${totalErrors}`,
          detail: JSON.stringify({ stats: result.stats, tradeDate }),
        });

        // T26: 双口径资产快照写入（SDD §5.1 17:02 信号生成最后一步）
        // 快照失败不影响信号生成主流程（独立 try-catch）
        try {
          const snap = await insertAssetStatSnapshots(tradeDate);
          writeSystemLog({
            logType: 'signal_generate', level: 'INFO',
            message: `双口径资产快照写入成功: inserted=${snap.inserted}`,
            detail: JSON.stringify({ tradeDate }),
          });
        } catch (snapErr: any) {
          writeSystemLog({
            logType: 'signal_generate', level: 'WARN',
            message: '双口径资产快照写入失败（不影响主流程）', detail: String(snapErr),
          });
        }
      } catch (err: any) {
        writeSystemLog({
          logType: 'signal_generate', level: 'ERROR',
          message: '插件信号生成异常', detail: String(err),
        });
      }
    }),
    { id: 'signal-generate' },
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
    { id: 'dividend-import' },
  ));

  // === 17:05 双库备份 ===
  app.scheduler.addCronJob(new CronJob(
    { cronExpression: '5 17 * * 1-5' },
    new AsyncTask('backup', async () => {
      writeSystemLog({ logType: 'backup', level: 'INFO', message: '双库备份开始' });
      try {
        const result = await runFullBackup();
        const anyError = !result.sqlite.success || !result.duckdb.success;
        writeSystemLog({
          logType: 'backup',
          level: anyError ? 'ERROR' : 'SUCCESS',
          message: `备份完成: sqlite=${result.sqlite.success ? 'OK' : 'FAIL'} duckdb=${result.duckdb.success ? 'OK' : 'FAIL'} cleaned=${result.cleanedFiles}`,
          detail: JSON.stringify(result),
        });
      } catch (err: any) {
        writeSystemLog({ logType: 'backup', level: 'ERROR', message: '备份异常', detail: String(err) });
      }
    }),
    { id: 'backup' },
  ));

  writeSystemLog({
    logType: 'startup', level: 'INFO',
    message: '4 段 cron 已注册: 17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份',
  });
}
