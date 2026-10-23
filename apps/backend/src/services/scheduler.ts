// src/services/scheduler.ts
// T21: Fastify @fastify/schedule cron 注册 + 4 段串行调度
// 底层是 toad-scheduler: CronJob + AsyncTask

import type { FastifyInstance } from 'fastify';
import { CronJob, AsyncTask } from 'toad-scheduler';
import { runAllChecks } from './validator.js';
import { executeAllPlugins } from './pluginEngine.js';
import { importDividendEvents } from './exDividendSync.js';
import { writeSystemLog } from './logger.js';
import { persistSignals, getTradeDate, resolveSignalSymbols, SIGNAL_USER_ID } from './signalService.js';
import { resolveTargetTradeDate, resolveLatestQuoteDate } from './marketData.js';
import { isDuckDBWriteSentinelPresent } from '../db/duckdb.js';
import { runFullBackup } from './backup.js';
import { insertAssetStatSnapshots } from './assetStat.js';
import { rerunQuoteUpdate } from './quoteRerun.js';

/**
 * G3a — WARN/ERROR 自动补跑 + 重新校验（PRD D3 自愈闭环 + SDD §5.1 Step 3）
 *
 * 判定口径（SDD §7.2 三层防线 + Requirements §6 C1-C10 处置列）：
 *   - C11/C12 外部源不可用 → 只标 SKIP，不触发补跑（补跑行情解决不了）
 *   - C1-C10 任一 ERROR → 立即补跑（数据源大概率没落全）
 *   - C1-C10 任一 WARN  → 补跑后再校验；二次仍 WARN/ERROR 才升级为 ERROR 告警
 *
 * 补跑通道不可用时返回 SKIP，不抛错、不阻塞后续 cron 段。
 */
export async function runDatacheckWithRerun(date: string): Promise<{
  summaries: Awaited<ReturnType<typeof runAllChecks>>;
  reran: boolean;
  rerunOk: boolean;
}> {
  const summaries = await runAllChecks(date);

  // 内部一致性校验（C1-C10）才触发补跑；C11/C12 是外部源，SKIP 不算
  const internal = summaries.filter((s) => s.checkId !== 'C11' && s.checkId !== 'C12');
  const errorItems = internal.filter((s) => s.result === 'ERROR');
  const warnItems = internal.filter((s) => s.result === 'WARN');

  if (errorItems.length === 0 && warnItems.length === 0) {
    return { summaries, reran: false, rerunOk: true };
  }

  const reason =
    errorItems.length > 0
      ? `C1-C10 ERROR×${errorItems.length}（${errorItems.map((s) => s.checkId).join(',')}）`
      : `C1-C10 WARN×${warnItems.length}（${warnItems.map((s) => s.checkId).join(',')}）`;

  const rerun = await rerunQuoteUpdate(reason);
  if (rerun.status !== 'SUCCESS') {
    writeSystemLog({
      logType: 'datacheck',
      level: errorItems.length > 0 ? 'ERROR' : 'WARN',
      message: `补跑未成功，保留首轮校验结果（${reason}）`,
      detail: `rerun=${rerun.status} method=${rerun.method} msg=${rerun.message}`,
    });
    return { summaries, reran: rerun.status !== 'SKIP', rerunOk: false };
  }

  // 补跑成功 → 重新校验，把最新结果作为终态
  const after = await runAllChecks(date);
  const afterInternal = after.filter((s) => s.checkId !== 'C11' && s.checkId !== 'C12');
  const afterErrors = afterInternal.filter((s) => s.result === 'ERROR');
  const afterWarns = afterInternal.filter((s) => s.result === 'WARN');

  writeSystemLog({
    logType: 'datacheck',
    level: afterErrors.length > 0 ? 'ERROR' : afterWarns.length > 0 ? 'WARN' : 'SUCCESS',
    message: `补跑后重新校验: ERROR=${afterErrors.length} WARN=${afterWarns.length}（首轮 ${reason}）`,
    detail:
      afterErrors.length > 0
        ? `二次仍 ERROR: ${afterErrors.map((s) => `${s.checkId}/${s.detail ?? '无详情'}`).join('; ')}`
        : afterWarns.length > 0
          ? `二次仍 WARN: ${afterWarns.map((s) => `${s.checkId}/${s.detail ?? '无详情'}`).join('; ')}`
          : '补跑自愈成功',
  });

  return { summaries: after, reran: true, rerunOk: true };
}

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
      logType: 'startup',
      level: 'ERROR',
      message: '@fastify/schedule 未注册，无法初始化 cron',
    });
    return;
  }

  // === 17:01 数据校验 C1-C12 ===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '1 17 * * 1-5' },
      new AsyncTask('datacheck-c1-c12', async () => {
        writeSystemLog({
          logType: 'datacheck',
          level: 'INFO',
          message: 'C1-C12 校验开始',
        });
        // 方向 A（ADR-012 §2.1）：外部写进程正在写库时，先等它写完再校验
        const SENTINEL_WAIT_MS = 120_000;
        const SENTINEL_POLL_MS = 1_000;
        const waitStart = Date.now();
        while (isDuckDBWriteSentinelPresent() && Date.now() - waitStart < SENTINEL_WAIT_MS) {
          writeSystemLog({
            logType: 'datacheck',
            level: 'INFO',
            message: '检测到 tdx2db 写窗口，等待其完成后再校验',
          });
          await new Promise((r) => setTimeout(r, SENTINEL_POLL_MS));
        }
        if (isDuckDBWriteSentinelPresent()) {
          writeSystemLog({
            logType: 'datacheck',
            level: 'WARN',
            message: '等待 tdx2db 写窗口超时（120s），跳过本轮校验',
          });
          return;
        }
        // 单一事实源（T85b ②）：日历口径的当前交易日（数据陈旧会如实暴露，不会假绿）
        const date = (await resolveTargetTradeDate()) ?? new Date().toISOString().slice(0, 10);
        try {
          const { summaries, reran, rerunOk } = await runDatacheckWithRerun(date);
          const errors = summaries.filter((s) => s.result === 'ERROR').length;
          const warns = summaries.filter((s) => s.result === 'WARN').length;
          writeSystemLog({
            logType: 'datacheck',
            level: errors > 0 ? 'ERROR' : warns > 0 ? 'WARN' : 'SUCCESS',
            message: `C1-C12 校验完成: ERROR=${errors} WARN=${warns} TOTAL=${summaries.length} 补跑=${reran ? (rerunOk ? '成功' : '失败') : '未触发'}`,
          });
        } catch (err: any) {
          writeSystemLog({
            logType: 'datacheck',
            level: 'ERROR',
            message: 'C1-C12 校验异常',
            detail: String(err),
          });
        }
      }),
      { id: 'datacheck-c1-c12', preventOverrun: true },
    ),
  );

  // === 17:02 插件信号生成 ===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '2 17 * * 1-5' },
      new AsyncTask('signal-generate', async () => {
        writeSystemLog({
          logType: 'signal_generate',
          level: 'INFO',
          message: '插件信号生成开始',
        });
        try {
          // 🔴 T85b ①（I-19）：信号只对**用户的自选 ∪ 持仓**生成（PRD M4）。
          //   修复前 executeAllPlugins() 传空参 → 插件落到硬编码 symbol:'sh600000'，
          //   用户的标的一只都跑不到。
          const signalSymbols = resolveSignalSymbols(SIGNAL_USER_ID);
          if (signalSymbols.length === 0) {
            writeSystemLog({
              logType: 'signal_generate',
              level: 'INFO',
              message: '信号生成跳过：用户无自选/持仓标的（signal 域为空）',
              detail: JSON.stringify({ userId: SIGNAL_USER_ID }),
            });
          }
          const result = await executeAllPlugins({ symbols: signalSymbols });
          // T27 补：从 result.results 里筛 SUCCESS 的，每个 plugin 单独持久化（保留 pluginId）
          // 数据口径（T85b ②）：信号要落在**确有行情**的那天（算指标必须有数据）
          const tradeDate = (await resolveLatestQuoteDate()) ?? getTradeDate();
          let totalInserted = 0;
          let totalSkipped = 0;
          let totalErrors = 0;
          for (const pluginResult of result.results) {
            if (pluginResult.status !== 'SUCCESS' || pluginResult.signals.length === 0) continue;
            const persist = persistSignals(pluginResult.signals, pluginResult.pluginId, 'monitor', tradeDate);
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
              logType: 'signal_generate',
              level: 'INFO',
              message: `双口径资产快照写入成功: inserted=${snap.inserted}`,
              detail: JSON.stringify({ tradeDate }),
            });
          } catch (snapErr: any) {
            writeSystemLog({
              logType: 'signal_generate',
              level: 'WARN',
              message: '双口径资产快照写入失败（不影响主流程）',
              detail: String(snapErr),
            });
          }
        } catch (err: any) {
          writeSystemLog({
            logType: 'signal_generate',
            level: 'ERROR',
            message: '插件信号生成异常',
            detail: String(err),
          });
        }
      }),
      { id: 'signal-generate', preventOverrun: true },
    ),
  );

  // === 17:03 除权自动导入 ===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '3 17 * * 1-5' },
      new AsyncTask('dividend-import', async () => {
        writeSystemLog({
          logType: 'dividend_import',
          level: 'INFO',
          message: '除权自动导入开始',
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
            logType: 'dividend_import',
            level: 'ERROR',
            message: '除权自动导入异常',
            detail: String(err),
          });
        }
      }),
      { id: 'dividend-import', preventOverrun: true },
    ),
  );

  // === 17:05 双库备份 ===
  app.scheduler.addCronJob(
    new CronJob(
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
      { id: 'backup', preventOverrun: true },
    ),
  );

  writeSystemLog({
    logType: 'startup',
    level: 'INFO',
    message: '4 段 cron 已注册: 17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份',
  });
}
