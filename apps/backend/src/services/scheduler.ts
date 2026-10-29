// src/services/scheduler.ts
// T21: Fastify @fastify/schedule cron 注册 + 4 段串行调度
// 底层是 toad-scheduler: CronJob + AsyncTask

import type { FastifyInstance } from 'fastify';
import { CronJob, AsyncTask } from 'toad-scheduler';
import { runAllChecks, hasQuoteDataOn } from './validator.js';
import { executeAllPlugins } from './pluginEngine.js';
import { importDividendEvents } from './exDividendSync.js';
import { writeSystemLog } from './logger.js';
import { persistSignals, getTradeDate, resolveSignalSymbols, SIGNAL_USER_ID } from './signalService.js';
import { resolveTargetTradeDate, resolveLatestQuoteDate } from './marketData.js';
import { isDuckDBWriteSentinelPresent } from '../db/duckdb.js';
import { runFullBackup } from './backup.js';
import { insertAssetStatSnapshots } from './assetStat.js';
import { rerunQuoteUpdate } from './quoteRerun.js';
import { reportTdx2dbRunOutcome, type Tdx2dbRunState } from './quoteUpdateStatus.js';
import { syncSymbolDict } from './symbolDict.js';

/**
 * 全部收盘后 cron 的时区（T108）。
 *
 * 服务器系统时区是 Etc/UTC；若 cron 不显式指定时区，`1 17 * * 1-5` 会在
 * 北京时间**次日 01:01** 触发（2026-10-23 生产实测）。这里与 systemd timer 的
 * `Asia/Shanghai` 保持一致，**不修改系统时区**（SQLite 的 localtime 默认值依赖它）。
 */
export const CRON_TIMEZONE = 'Asia/Shanghai';

/**
 * 等待 tdx2db 写窗口结束的最长时间。
 *
 * `deploy/tdx2db.service` 的 `TimeoutStartSec=1800`（30 分钟），这里再留 5 分钟余量。
 * 17:01 的校验不能只等 120s —— 2026-10-28 生产实测 tdx2db 跑了 10 分 50 秒，
 * 120s 等待必然超时，导致当天 `tdx2db_update` 成功日志缺失、信号/除权段在写窗口内报错。
 */
const DEFAULT_QUOTE_UPDATE_WAIT_MS = 35 * 60_000;

/**
 * 轮询哨兵直到 tdx2db 写窗口结束。
 * @param onWait 首次检测到写窗口时的回调（用于写「等待中」日志）
 * @returns ready=true 表示可以安全读取 DuckDB；waitMs 用于超时文案
 */
async function waitForQuoteUpdateWindow(onWait?: () => void): Promise<{ ready: boolean; waitMs: number }> {
  const waitMs = Number(process.env.TDX2DB_SENTINEL_WAIT_MS ?? DEFAULT_QUOTE_UPDATE_WAIT_MS);
  const pollMs = Number(process.env.TDX2DB_SENTINEL_POLL_MS ?? 1_000);
  if (!isDuckDBWriteSentinelPresent()) return { ready: true, waitMs };

  onWait?.();
  const start = Date.now();
  while (isDuckDBWriteSentinelPresent() && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ready: !isDuckDBWriteSentinelPresent(), waitMs };
}

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

export interface ScheduledDatacheckResult {
  date: string;
  action: 'CHECKED' | 'WAIT_TIMEOUT' | 'UPDATE_RUNNING' | 'UPDATE_FAILED' | 'NO_DATA_AFTER_RERUN';
  updateState?: Tdx2dbRunState;
  summaries?: Awaited<ReturnType<typeof runAllChecks>>;
  reran?: boolean;
  rerunOk?: boolean;
}

/**
 * 17:01 校验段的完整入口（T106：更新结果 → 数据闸门 → 校验/补跑）。
 *
 * 三类「无行情数据」必须区分，不能都汇总成 `ERROR=0 WARN=0`：
 *   1. 非交易日：`resolveTargetTradeDate()` 会回退到最近交易日，通常**有数据**，
 *      因此不会走到本函数的无数据分支；
 *   2. 交易日 + 更新失败 / 未触发：行情更新日志写 ERROR，校验跳过并汇总 ERROR；
 *   3. 交易日 + 更新「成功」但无数据：先补跑一次，补跑后仍无数据 → ERROR。
 *
 * 只有「无新数据」时才跳过校验（ADR-004：数据源缺失 ≠ 校验通过），
 * 但**跳过本身必须留下 ERROR 证据**，否则管理端会误以为链路健康。
 */
export async function runScheduledDatacheck(): Promise<ScheduledDatacheckResult> {
  // 方向 A（ADR-012 §2.1）：外部写进程正在写库时，先等它写完再校验。
  // 等待窗口必须覆盖 tdx2db 的 TimeoutStartSec=1800，不能沿用旧的 120s。
  const wait = await waitForQuoteUpdateWindow(() => {
    writeSystemLog({
      logType: 'datacheck',
      level: 'INFO',
      message: '检测到 tdx2db 写窗口，等待其完成后再校验',
    });
  });
  if (!wait.ready) {
    // 即使拿不到 systemd 结果，也要让「行情更新」日志落到今天，避免管理端继续显示上一条陈旧记录。
    writeSystemLog({
      logType: 'tdx2db_update',
      level: 'WARN',
      message: `行情更新写窗口超过 ${Math.round(wait.waitMs / 1000)}s 未结束，无法判定本轮结果`,
      detail: JSON.stringify({ state: 'RUNNING', reason: 'write_window_timeout' }),
    });
    writeSystemLog({
      logType: 'datacheck',
      level: 'WARN',
      message: `等待 tdx2db 写窗口超时（${Math.round(wait.waitMs / 1000)}s），跳过本轮校验`,
    });
    return { date: '', action: 'WAIT_TIMEOUT' };
  }

  // T105：把 systemd oneshot 的真实执行结果落库，供管理端 / C8 / 本函数使用
  const update = await reportTdx2dbRunOutcome();
  const date = (await resolveTargetTradeDate()) ?? new Date().toISOString().slice(0, 10);

  if (update.state === 'RUNNING') {
    writeSystemLog({
      logType: 'datacheck',
      level: 'WARN',
      message: '行情更新仍在运行，跳过本轮 C1-C12 校验',
      detail: update.message,
    });
    return { date, action: 'UPDATE_RUNNING', updateState: update.state };
  }

  let hasData = await hasQuoteDataOn(date);
  if (!hasData && update.state !== 'SUCCESS') {
    writeSystemLog({
      logType: 'datacheck',
      level: 'ERROR',
      message: `行情更新未生效（state=${update.state}），跳过 ${date} 的 C1-C12 校验`,
      detail: update.message,
    });
    return { date, action: 'UPDATE_FAILED', updateState: update.state };
  }

  if (!hasData) {
    writeSystemLog({
      logType: 'datacheck',
      level: 'WARN',
      message: `行情更新状态为成功，但 ${date} 仍无行情数据，触发补跑`,
      detail: update.message,
    });
    const rerun = await rerunQuoteUpdate(`行情更新成功但 ${date} 无数据`);
    if (rerun.status !== 'SUCCESS') {
      writeSystemLog({
        logType: 'datacheck',
        level: 'ERROR',
        message: `行情更新成功但无数据，补跑失败，跳过 ${date} 的 C1-C12 校验`,
        detail: `rerun=${rerun.status} method=${rerun.method} msg=${rerun.message}`,
      });
      return { date, action: 'NO_DATA_AFTER_RERUN', updateState: update.state, reran: true, rerunOk: false };
    }
    hasData = await hasQuoteDataOn(date);
    if (!hasData) {
      writeSystemLog({
        logType: 'datacheck',
        level: 'ERROR',
        message: `补跑后 ${date} 仍无行情数据，跳过 C1-C12 校验`,
        detail: update.message,
      });
      return { date, action: 'NO_DATA_AFTER_RERUN', updateState: update.state, reran: true, rerunOk: true };
    }
  }

  const { summaries, reran, rerunOk } = await runDatacheckWithRerun(date);
  const errors = summaries.filter((s) => s.result === 'ERROR').length;
  const warns = summaries.filter((s) => s.result === 'WARN').length;
  writeSystemLog({
    logType: 'datacheck',
    level: errors > 0 ? 'ERROR' : warns > 0 ? 'WARN' : 'SUCCESS',
    message: `C1-C12 校验完成: ERROR=${errors} WARN=${warns} TOTAL=${summaries.length} 补跑=${reran ? (rerunOk ? '成功' : '失败') : '未触发'}`,
  });
  return { date, action: 'CHECKED', updateState: update.state, summaries, reran, rerunOk };
}

/**
 * 收盘后刷新 symbol_dict（17:01 校验段末尾调用）。
 *
 * tdx2db 在 17:00 更新 `raw_symbol_name`，此前的 `ensureSymbolDict()` 只在表为空时
 * 同步一次 → 新增/改名标的永远进不了字典。这里做**全量 upsert**，不删除退市标的
 * （历史交易仍可识别），失败只记日志、不阻塞 17:02 信号段。
 *
 * @returns 同步行数；DuckDB 不可读时返回 null（已写 ERROR 日志）
 */
export async function refreshSymbolDictSnapshot(
  sync: () => Promise<number> = syncSymbolDict,
): Promise<number | null> {
  try {
    const rows = await sync();
    writeSystemLog({
      logType: 'datacheck',
      level: rows > 0 ? 'SUCCESS' : 'WARN',
      checkItem: 'symbol_dict',
      message: rows > 0 ? `标的字典刷新完成: ${rows} 行` : '标的字典刷新跳过: 行情层 raw_symbol_name 无数据',
    });
    return rows;
  } catch (err: any) {
    writeSystemLog({
      logType: 'datacheck',
      level: 'ERROR',
      checkItem: 'symbol_dict',
      message: '标的字典刷新失败（不影响后续信号/除权/备份）',
      detail: String(err),
    });
    return null;
  }
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

  /**
   * 四段任务串行队列。
   *
   * cron 仍按 17:01/17:02/17:03/17:05 触发，但任务体要排队：
   *   - 第一段（校验）内部等待 tdx2db 写窗口结束；
   *   - 后三段 await 前一段的 Promise，避免「校验还在等 tdx2db，17:02 信号先跑」；
   *   - 后三段执行前再检查一次哨兵（防进程在 17:01 后重启 / 管理员手动补跑）。
   *
   * `pipelineBlocked` 表示当天写窗口未在等待上限内结束；一旦置位，当天剩余段全部跳过，
   * 避免四段各等 35 分钟。次日的校验段开始时重置。
   */
  let pipelineTail: Promise<void> = Promise.resolve();
  let pipelineBlocked = false;

  const enqueueStage = (
    label: string,
    logType: string,
    run: () => Promise<void>,
    waitForQuoteUpdate: boolean,
  ): Promise<void> => {
    const execute = async (): Promise<void> => {
      if (waitForQuoteUpdate) {
        if (pipelineBlocked) {
          writeSystemLog({
            logType,
            level: 'WARN',
            message: `行情更新写窗口未结束，跳过${label}`,
          });
          return;
        }
        const wait = await waitForQuoteUpdateWindow();
        if (!wait.ready) {
          pipelineBlocked = true;
          writeSystemLog({
            logType,
            level: 'WARN',
            message: `${label}等待 tdx2db 写窗口超时（${Math.round(wait.waitMs / 1000)}s），跳过当日剩余任务`,
          });
          return;
        }
      }
      await run();
    };
    const next = pipelineTail.then(execute, execute);
    pipelineTail = next.catch(() => undefined);
    return next;
  };

  // === 17:01 数据校验 C1-C12 ===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '1 17 * * 1-5', timezone: CRON_TIMEZONE },
      new AsyncTask('datacheck-c1-c12', async () => {
        await enqueueStage(
          'C1-C12 校验',
          'datacheck',
          async () => {
            pipelineBlocked = false;
            writeSystemLog({
              logType: 'datacheck',
              level: 'INFO',
              message: 'C1-C12 校验开始',
            });
            // 方向 A 等待 + T105 更新结果 + T106 数据闸门/补跑全部在 runScheduledDatacheck 内
            try {
              const result = await runScheduledDatacheck();
              if (result.action === 'WAIT_TIMEOUT' || result.action === 'UPDATE_RUNNING') {
                pipelineBlocked = true;
              }
            } catch (err: any) {
              writeSystemLog({
                logType: 'datacheck',
                level: 'ERROR',
                message: 'C1-C12 校验异常',
                detail: String(err),
              });
            }
            // 写窗口已结束（或校验已完成）→ 全量刷新标的字典，供后续搜索/导入/录入使用
            if (!pipelineBlocked) {
              await refreshSymbolDictSnapshot();
            }
          },
          false,
        );
      }),
      { id: 'datacheck-c1-c12', preventOverrun: true },
    ),
  );

  // === 17:02 插件信号生成 ===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '2 17 * * 1-5', timezone: CRON_TIMEZONE },
      new AsyncTask('signal-generate', async () => {
        await enqueueStage(
          '插件信号生成',
          'signal_generate',
          async () => {
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
                level:
                  totalErrors > 0 || result.stats.error > 0 || result.stats.timeout > 0 ? 'WARN' : 'SUCCESS',
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
          },
          true,
        );
      }),
      { id: 'signal-generate', preventOverrun: true },
    ),
  );

  // === 17:03 除权自动导入 ===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '3 17 * * 1-5', timezone: CRON_TIMEZONE },
      new AsyncTask('dividend-import', async () => {
        await enqueueStage(
          '除权自动导入',
          'dividend_import',
          async () => {
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
          },
          true,
        );
      }),
      { id: 'dividend-import', preventOverrun: true },
    ),
  );

  // === 17:05 备份（SQLite 恒常；DuckDB 受 ENABLE_QUOTE_BACKUP 控制）===
  app.scheduler.addCronJob(
    new CronJob(
      { cronExpression: '5 17 * * 1-5', timezone: CRON_TIMEZONE },
      new AsyncTask('backup', async () => {
        await enqueueStage(
          '备份',
          'backup',
          async () => {
            writeSystemLog({
              logType: 'backup',
              level: 'INFO',
              message: '备份开始（SQLite 恒常；DuckDB 受 ENABLE_QUOTE_BACKUP 控制）',
            });
            try {
              const result = await runFullBackup();
              // 行情库开关关闭时 duckdb.success=true 且 skipped=true —— 这是配置生效，不是失败。
              const duckdbState = result.duckdb.skipped ? 'SKIP' : result.duckdb.success ? 'OK' : 'FAIL';
              const anyError = !result.sqlite.success || (!result.duckdb.skipped && !result.duckdb.success);
              writeSystemLog({
                logType: 'backup',
                level: anyError ? 'ERROR' : 'SUCCESS',
                message: `备份完成: sqlite=${result.sqlite.success ? 'OK' : 'FAIL'} duckdb=${duckdbState} cleaned=${result.cleanedFiles}`,
                detail: JSON.stringify(result),
              });
            } catch (err: any) {
              writeSystemLog({ logType: 'backup', level: 'ERROR', message: '备份异常', detail: String(err) });
            }
          },
          true,
        );
      }),
      { id: 'backup', preventOverrun: true },
    ),
  );

  writeSystemLog({
    logType: 'startup',
    level: 'INFO',
    message:
      '4 段 cron 已注册: 17:01 校验+字典刷新 / 17:02 信号 / 17:03 除权 / 17:05 备份（等待 tdx2db 写窗口结束后串行执行）',
  });
}
