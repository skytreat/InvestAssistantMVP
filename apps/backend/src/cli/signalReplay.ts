/**
 * 信号区间回放 CLI（默认 **dry-run**，必须显式 `--execute` 才落库）
 *
 * 用法（在 `apps/backend` 下）：
 *   npx tsx --env-file=../../.env.local src/cli/signalReplay.ts
 *   npx tsx --env-file=../../.env.local src/cli/signalReplay.ts --from 2026-10-15 --to 2026-11-04
 *   npx tsx --env-file=../../.env.local src/cli/signalReplay.ts --execute
 *   npx tsx --env-file=../../.env.local src/cli/signalReplay.ts --symbols sh600000,sz000001 --execute
 *
 * 可选参数：
 *   --from YYYY-MM-DD   显式起点（缺省 = `user_strategy_signal` 的 `MAX(trade_date)` 次一交易日）
 *   --to YYYY-MM-DD     显式终点（缺省 = 最近行情日，再退化到自然日今天）
 *   --symbols a,b       标的域（缺省 = 用户的自选 ∪ 持仓）
 *   --prefetch-days N   预取窗口（默认 120，与插件默认参数一致）
 *   --execute           真落库（`origin = 'replay'`，INSERT OR IGNORE 幂等）
 *
 * 🔴 dry-run 语义：**不写任何信号行**；但首次运行会在业务库执行幂等补列（`origin`），
 *    这属于 schema 迁移而非业务写入；同时会写一条 `signal_generate` 审计日志（dry_run=true）。
 */
import { replaySignals, ReplayRangeTooLargeError } from '../services/signalReplay.js';

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const fromDate = argOf(argv, '--from');
  const toDate = argOf(argv, '--to');
  const symbolsArg = argOf(argv, '--symbols');
  const prefetchArg = argOf(argv, '--prefetch-days');
  const prefetchDays = prefetchArg ? Number(prefetchArg) : undefined;
  if (prefetchArg && (!Number.isFinite(prefetchDays) || (prefetchDays as number) <= 0)) {
    console.error(`--prefetch-days 必须为正整数，收到「${prefetchArg}」`);
    process.exit(1);
  }

  const result = await replaySignals({
    fromDate,
    toDate,
    symbols: symbolsArg
      ? symbolsArg
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    dryRun: !execute,
    prefetchDays,
  });

  const title = execute ? 'EXECUTE' : 'DRY-RUN';
  console.log(`\n[${title}] 信号区间回放`);
  console.log(
    `  起点口径: ${result.startSource}${result.startAnchor ? `（锚点 ${result.startAnchor}）` : ''}`,
  );
  console.log(
    `  区间: ${result.fromDate ?? '(空)'} → ${result.toDate} 共 ${result.dayCount} 个交易日${result.truncated ? '（已按 60 日默认上限截断）' : ''}`,
  );
  console.log(`  标的: ${result.symbols.length} 只 ${result.symbols.join(',') || '(空)'}`);
  console.log(`  耗时: ${result.elapsedMs}ms`);
  for (const d of result.days) {
    const counts = execute
      ? `inserted=${d.inserted} skipped=${d.skipped} errors=${d.errors}`
      : `wouldInsert=${d.wouldInsert ?? 0} wouldSkip=${d.wouldSkip ?? 0}`;
    console.log(
      `  ${d.trade_date}  signals=${d.signals}  ${counts}` +
        `  (exec=${d.stats.total} success=${d.stats.success} skip=${d.stats.skip} noData=${d.stats.noData} timeout=${d.stats.timeout} error=${d.stats.error})` +
        (d.error ? `  ERROR=${d.error}` : ''),
    );
  }
  console.log(
    `  合计: signals=${result.totals.signals} inserted=${result.totals.inserted} skipped=${result.totals.skipped} errors=${result.totals.errors}` +
      `  exec=${result.totals.total} success=${result.totals.success} skip=${result.totals.skip} noData=${result.totals.noData}`,
  );
  for (const n of result.notes) console.log(`  note: ${n}`);
  if (!execute) console.log('\n（dry-run 未写库；确认无误后加 --execute 重跑）');

  const failed = result.days.some((d) => d.error);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  if (err instanceof ReplayRangeTooLargeError) {
    console.error(err.message);
  } else {
    console.error('[signal-replay] 失败:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
