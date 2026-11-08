/**
 * 形态识别敏感性扫描 CLI（**只读行情库，不写任何库**）
 *
 * 用途：为 `deviation` 默认值（2.5%）提供实测依据。
 * 口径见 `docs/client/pattern_recognition_design.md` §11.1。
 *
 * 用法（在 `apps/backend` 下）：
 *   npx tsx --env-file=../../.env.local src/cli/patternScan.ts
 *   npx tsx --env-file=../../.env.local src/cli/patternScan.ts --class etf --from 2023-01-01
 *   npx tsx --env-file=../../.env.local src/cli/patternScan.ts --dev 1.5,2,2.5,3,5 --json
 *
 * 参数：
 *   --class stock|etf|all  标的域（默认 etf）
 *   --from  YYYY-MM-DD     起始日期（默认 2023-01-01）
 *   --to    YYYY-MM-DD     结束日期（默认行情库最新交易日）
 *   --dev   逗号分隔        待扫描的 deviation（默认 1.5,2,2.5,3,5）
 *   --json                只输出 JSON
 */

import { closeDuckDBInstance, queryDuckDB } from '../db/duckdb.js';
import { batchGetDailyRangeByView, resolveLatestQuoteDate } from '../services/marketData.js';
import { buildZigZag, detectDoubleTopBottom } from '../services/patterns/index.js';
import type { DailyKline } from '@invest/core';

interface ScanBucket {
  deviationPct: number;
  doubleTop: number;
  doubleBottom: number;
  symbolsWithPattern: number;
  zigzagPivots: number;
  symbolsScanned: number;
}

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const VIEW_BY_CLASS: Record<string, string> = {
  stock: 'v_stock_qfq',
  etf: 'v_etf_qfq',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cls = (argOf(argv, '--class') ?? 'etf').toLowerCase();
  const from = argOf(argv, '--from') ?? '2023-01-01';
  const toArg = argOf(argv, '--to');
  const devArg = argOf(argv, '--dev') ?? '1.5,2,2.5,3,5';
  const jsonOnly = argv.includes('--json');

  if (cls !== 'stock' && cls !== 'etf' && cls !== 'all') {
    console.error(`--class 只支持 stock / etf / all，收到「${cls}」`);
    process.exit(1);
  }

  const deviations = devArg
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (deviations.length === 0) {
    console.error(`--dev 必须是正数列表，收到「${devArg}」`);
    process.exit(1);
  }

  const to = toArg ?? (await resolveLatestQuoteDate());
  if (!to) {
    console.error('无法确定行情库最新交易日（--to 未指定且库内无数据）');
    process.exit(1);
  }

  const classes = cls === 'all' ? ['stock', 'etf'] : [cls];
  const barsBySymbol = new Map<string, DailyKline[]>();

  for (const c of classes) {
    const rows = await queryDuckDB<{ symbol: string }>(
      'SELECT DISTINCT symbol FROM raw_symbol_class WHERE "class" = ? ORDER BY symbol',
      [c],
    );
    const symbols = rows.map((r) => r.symbol).filter((s) => typeof s === 'string' && s.length > 0);
    if (symbols.length === 0) continue;

    const fetched = await batchGetDailyRangeByView(new Map([[VIEW_BY_CLASS[c], symbols]]), from, to);
    for (const [symbol, bars] of fetched) {
      const existing = barsBySymbol.get(symbol);
      if (existing) existing.push(...bars);
      else barsBySymbol.set(symbol, bars);
    }
  }

  // 预热不足的标的不参与（保证 ATR14 + 双侧枢轴可算）
  const MIN_BARS = 120;
  const usable: Array<{ symbol: string; bars: DailyKline[] }> = [];
  for (const [symbol, bars] of barsBySymbol) {
    if (bars.length >= MIN_BARS) usable.push({ symbol, bars });
  }

  const buckets: ScanBucket[] = deviations.map((deviationPct) => ({
    deviationPct,
    doubleTop: 0,
    doubleBottom: 0,
    symbolsWithPattern: 0,
    zigzagPivots: 0,
    symbolsScanned: usable.length,
  }));

  const startedAt = Date.now();
  for (let bi = 0; bi < buckets.length; bi++) {
    const bucket = buckets[bi];
    for (const { bars } of usable) {
      bucket.zigzagPivots += buildZigZag(bars, { deviationPct: bucket.deviationPct }).length;
      const patterns = detectDoubleTopBottom(bars, { deviationPct: bucket.deviationPct });
      if (patterns.length > 0) bucket.symbolsWithPattern += 1;
      for (const p of patterns) {
        if (p.kind === 'double_top') bucket.doubleTop += 1;
        else bucket.doubleBottom += 1;
      }
    }
  }
  const elapsedMs = Date.now() - startedAt;

  const report = {
    class: cls,
    from,
    to,
    minBars: MIN_BARS,
    symbolsScanned: usable.length,
    elapsedMs,
    buckets: buckets.map((b) => ({
      deviationPct: b.deviationPct,
      doubleTop: b.doubleTop,
      doubleBottom: b.doubleBottom,
      total: b.doubleTop + b.doubleBottom,
      symbolsWithPattern: b.symbolsWithPattern,
      zigzagPivots: b.zigzagPivots,
    })),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`形态识别敏感性扫描（只读）`);
  console.log(
    `  标的域: ${cls} | 区间: ${from} ~ ${to} | 可用标的: ${usable.length} | 耗时: ${elapsedMs} ms`,
  );
  console.log('');
  console.log('deviation%    双顶    双底    合计    有形态标的    ZigZag枢轴');
  for (const b of report.buckets) {
    const line = [
      b.deviationPct.toFixed(1).padStart(9),
      String(b.doubleTop).padStart(7),
      String(b.doubleBottom).padStart(7),
      String(b.total).padStart(7),
      String(b.symbolsWithPattern).padStart(11),
      String(b.zigzagPivots).padStart(12),
    ].join('');
    console.log(line);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDuckDBInstance();
  });
