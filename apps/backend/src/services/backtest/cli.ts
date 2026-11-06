/**
 * M1 CLI —— `tsx` 入口：输出某个时点的「行情面板 + 时点名录」
 *
 * 用法（在仓库根执行）：
 * ```bash
 * npx tsx apps/backend/src/services/backtest/cli.ts \
 *   --as-of 2026-10-12 --pool dynamic --out ./tmp/m1-universe
 * ```
 *
 * 参数：
 *   --as-of <YYYY-MM-DD>  必填，目标时点（非交易日回退到前一个交易日）
 *   --pool fixed|dynamic|weak|all   默认 all
 *   --out <path>          输出路径：`.json` / `.md` 指定单格式；其它按「目录」写两份
 *   --divisor <n>         流动性阈值除数（默认 20000，对应 v5.2）
 *   --top-n <n>           动态池截断数量（默认 300）
 *   --panel-days <n>      面板回看的交易日数（默认 30）
 *   --no-missing-bar      关闭「缺 bar ⇒ 停牌」判定
 *   --no-zero-volume      关闭「volume=0 ⇒ 停牌」判定
 *
 * ⚠️ 只读：本 CLI 只打开 DuckDB（`access_mode: READ_ONLY`），不写任何数据库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTradingCalendar } from './calendar.js';
import { getBars, isSuspended, summarizePanel, type SymbolPanelSummary } from './marketPanel.js';
import { DEFENSIVE_ETF } from './universe/fixedPool.js';
import { resolveUniverseAt, type UniverseSnapshot, type PoolPick } from './universe/pointInTime.js';
import type { SuspensionOptions } from './types.js';

type PoolName = 'fixed' | 'dynamic' | 'weak' | 'all';

interface CliArgs {
  asOf: string;
  pool: PoolName;
  out: string | null;
  divisor: number;
  topN: number;
  panelDays: number;
  suspension: Required<SuspensionOptions>;
}

const USAGE = `用法: tsx apps/backend/src/services/backtest/cli.ts --as-of <YYYY-MM-DD> [--pool fixed|dynamic|weak|all] [--out <path>] [--divisor 20000] [--top-n 300] [--panel-days 30] [--no-missing-bar] [--no-zero-volume]`;

function parseArgs(argv: readonly string[]): CliArgs {
  const options: CliArgs = {
    asOf: '',
    pool: 'all',
    out: null,
    divisor: 20000,
    topN: 300,
    panelDays: 30,
    suspension: { missingBar: true, zeroVolume: true },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} 缺少取值\n${USAGE}`);
      i++;
      return v;
    };
    switch (arg) {
      case '--as-of':
        options.asOf = readValue();
        break;
      case '--pool': {
        const v = readValue();
        if (v !== 'fixed' && v !== 'dynamic' && v !== 'weak' && v !== 'all') {
          throw new Error(`--pool 只接受 fixed|dynamic|weak|all（收到 ${v}）`);
        }
        options.pool = v;
        break;
      }
      case '--out':
        options.out = readValue();
        break;
      case '--divisor':
        options.divisor = Number(readValue());
        break;
      case '--top-n':
        options.topN = Number(readValue());
        break;
      case '--panel-days':
        options.panelDays = Number(readValue());
        break;
      case '--no-missing-bar':
        options.suspension.missingBar = false;
        break;
      case '--no-zero-volume':
        options.suspension.zeroVolume = false;
        break;
      case '--help':
      case '-h':
        throw new Error(USAGE);
      default:
        throw new Error(`未知参数 ${arg}\n${USAGE}`);
    }
  }

  if (!options.asOf) throw new Error(`缺少必填参数 --as-of\n${USAGE}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.asOf)) {
    throw new Error(`--as-of 必须是 YYYY-MM-DD（收到 ${options.asOf}）`);
  }
  for (const [name, value] of [
    ['--divisor', options.divisor],
    ['--top-n', options.topN],
    ['--panel-days', options.panelDays],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数（收到 ${value}）`);
  }
  return options;
}

/** 名录里的一只 + 面板口径字段 */
interface PoolEntry {
  symbol: string;
  name: string | null;
  avgAmount: number;
  firstBar: string;
  lastBar: string;
  /** 该标的是否在 T 日停牌（按当前开关） */
  suspended: boolean;
  suspensionReason: 'missing-bar' | 'zero-volume' | null;
  /** 面板窗口内的 bar 数 */
  panelBarCount: number;
  /** 面板窗口内「缺 bar」天数 */
  panelMissingBarCount: number;
  /** 面板窗口内「volume=0」天数 */
  panelZeroVolumeCount: number;
}

interface CliOutput {
  generatedAt: string;
  requestedAsOf: string;
  asOf: string;
  options: {
    pool: PoolName;
    divisor: number;
    topN: number;
    panelDays: number;
    suspension: Required<SuspensionOptions>;
  };
  liquidity: {
    dates: string[];
    totalByDate: number[];
    avgTotal: number;
    threshold: number;
    fallback: boolean;
  };
  counts: {
    marketSymbolCount: number;
    universeCount: number;
    marketLiquidityPassCount: number;
    fixedPoolSize: number;
    fixedTradableCount: number;
    fixedCoverageCount: number;
    fixedLiquidityPassCount: number;
    weakLiquidityPassCount: number;
    dynamicGroupCount: number;
    dynamicPoolSize: number;
  };
  pools: Record<string, PoolEntry[]>;
  dynamicGroups: Array<{
    groupKey: string;
    specialGroup: string | null;
    memberCount: number;
    picked: { symbol: string; name: string | null; cleanedName: string; avgAmount: number } | null;
  }>;
  panel: {
    start: string;
    end: string;
    tradingDayCount: number;
    perSymbol: SymbolPanelSummary[];
    totals: { barCount: number; missingBarCount: number; zeroVolumeCount: number; suspendedCount: number };
  };
}

function poolPicks(snapshot: UniverseSnapshot, pool: PoolName): Record<string, PoolPick[]> {
  const out: Record<string, PoolPick[]> = {};
  if (pool === 'fixed' || pool === 'all') out.fixed = snapshot.fixed;
  if (pool === 'weak' || pool === 'all') out.weak = snapshot.weak;
  if (pool === 'dynamic' || pool === 'all') {
    out.dynamic = snapshot.dynamic.pool.map((m) => ({
      symbol: m.symbol,
      name: m.name,
      firstBar: '',
      lastBar: '',
      avgAmount: m.avgAmount,
    }));
  }
  return out;
}

async function buildOutput(args: CliArgs): Promise<CliOutput> {
  const calendar = await loadTradingCalendar();
  const snapshot = await resolveUniverseAt(args.asOf, {
    divisor: args.divisor,
    topN: args.topN,
    calendar,
    suspension: args.suspension,
  });

  const picks = poolPicks(snapshot, args.pool);
  const windowDates = calendar.lastN(snapshot.asOf, args.panelDays);
  const panelStart = windowDates[0] ?? snapshot.asOf;
  const symbols = [
    ...new Set(
      Object.values(picks)
        .flat()
        .map((p) => p.symbol),
    ),
  ];
  const barsBySymbol = await getBars(symbols, panelStart, snapshot.asOf, { adjust: 'qfq' });
  const summary = summarizePanel(barsBySymbol, windowDates, args.suspension);

  const pools: Record<string, PoolEntry[]> = {};
  for (const [name, list] of Object.entries(picks)) {
    pools[name] = list.map((p) => {
      const bars = barsBySymbol.get(p.symbol);
      const verdict = isSuspended(bars, snapshot.asOf, args.suspension);
      const s = summary.get(p.symbol);
      return {
        symbol: p.symbol,
        name: p.name,
        avgAmount: p.avgAmount,
        firstBar: p.firstBar || (s?.firstDate ?? ''),
        lastBar: p.lastBar || (s?.lastDate ?? ''),
        suspended: verdict.suspended,
        suspensionReason: verdict.reason,
        panelBarCount: s?.barCount ?? 0,
        panelMissingBarCount: s?.missingBarCount ?? 0,
        panelZeroVolumeCount: s?.zeroVolumeCount ?? 0,
      };
    });
  }

  const perSymbol = [...summary.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    generatedAt: new Date().toISOString(),
    requestedAsOf: snapshot.requestedAsOf,
    asOf: snapshot.asOf,
    options: {
      pool: args.pool,
      divisor: args.divisor,
      topN: args.topN,
      panelDays: args.panelDays,
      suspension: args.suspension,
    },
    liquidity: {
      dates: snapshot.liquidity.dates,
      totalByDate: snapshot.liquidity.totalByDate,
      avgTotal: snapshot.liquidity.avgTotal,
      threshold: snapshot.liquidity.threshold,
      fallback: snapshot.liquidity.fallback,
    },
    counts: {
      marketSymbolCount: snapshot.marketSymbolCount,
      universeCount: snapshot.universeCount,
      marketLiquidityPassCount: snapshot.marketLiquidityPassCount,
      fixedPoolSize: snapshot.fixedPoolSize,
      fixedTradableCount: snapshot.fixedTradableCount,
      fixedCoverageCount: snapshot.fixedCoverageCount,
      fixedLiquidityPassCount: snapshot.fixed.length,
      weakLiquidityPassCount: snapshot.weak.length,
      dynamicGroupCount: snapshot.dynamic.groups.length,
      dynamicPoolSize: snapshot.dynamic.pool.length,
    },
    pools,
    dynamicGroups: snapshot.dynamic.groups.map((g) => ({
      groupKey: g.groupKey,
      specialGroup: g.specialGroup,
      memberCount: g.members.length,
      picked: g.picked
        ? {
            symbol: g.picked.symbol,
            name: g.picked.name,
            cleanedName: g.picked.cleanedName,
            avgAmount: g.picked.avgAmount,
          }
        : null,
    })),
    panel: {
      start: panelStart,
      end: snapshot.asOf,
      tradingDayCount: windowDates.length,
      perSymbol,
      totals: {
        barCount: perSymbol.reduce((a, s) => a + s.barCount, 0),
        missingBarCount: perSymbol.reduce((a, s) => a + s.missingBarCount, 0),
        zeroVolumeCount: perSymbol.reduce((a, s) => a + s.zeroVolumeCount, 0),
        suspendedCount: perSymbol.reduce((a, s) => a + s.suspendedCount, 0),
      },
    },
  };
}

/** 元 → 亿元/万元 的可读格式 */
function yi(amount: number): string {
  return `${(amount / 1e8).toFixed(2)} 亿`;
}

function wan(amount: number): string {
  return `${(amount / 1e4).toFixed(1)} 万`;
}

function renderMarkdown(out: CliOutput): string {
  const lines: string[] = [];
  lines.push(`# 时点名录与行情面板（M1）`, '');
  lines.push(`- 生成时间：${out.generatedAt}`);
  lines.push(`- 请求时点：${out.requestedAsOf} → 对齐交易日：**${out.asOf}**`);
  lines.push(
    `- 参数：pool=\`${out.options.pool}\` / divisor=${out.options.divisor} / topN=${out.options.topN} / panelDays=${out.options.panelDays}`,
  );
  lines.push(
    `- 停牌开关：缺 bar=${out.options.suspension.missingBar ? '开' : '关'} / volume=0=${out.options.suspension.zeroVolume ? '开' : '关'}`,
  );
  lines.push('');
  lines.push('## 流动性阈值', '');
  lines.push('| 交易日 | 全市场 ETF 总成交额 |');
  lines.push('|---|---|');
  for (let i = 0; i < out.liquidity.dates.length; i++) {
    lines.push(`| ${out.liquidity.dates[i]} | ${yi(out.liquidity.totalByDate[i])} |`);
  }
  lines.push('');
  lines.push(
    `- 日均总成交额：**${yi(out.liquidity.avgTotal)}** → 阈值 = ${yi(out.liquidity.avgTotal)} / ${out.options.divisor} = **${wan(out.liquidity.threshold)}/日**（${out.liquidity.threshold.toFixed(2)} 元）${out.liquidity.fallback ? ' ⚠️ 走了 1000 万回退' : ''}`,
  );
  lines.push('');
  lines.push('## 计数', '');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 全市场 ETF（class=etf） | ${out.counts.marketSymbolCount} |`);
  lines.push(`| Universe(T)（首末 bar 区间内） | ${out.counts.universeCount} |`);
  lines.push(`| 全市场通过流动性阈值 | ${out.counts.marketLiquidityPassCount} |`);
  lines.push(`| 固定池规模 | ${out.counts.fixedPoolSize} |`);
  lines.push(`| 固定池 ∩ Universe(T) | ${out.counts.fixedTradableCount} |`);
  lines.push(`| 固定池（含防御 ${DEFENSIVE_ETF}）在库命中 | ${out.counts.fixedCoverageCount} |`);
  lines.push(`| 固定池 ∩ 流动性 | ${out.counts.fixedLiquidityPassCount} |`);
  lines.push(`| 走弱期池（全球池 ∩ 流动性） | ${out.counts.weakLiquidityPassCount} |`);
  lines.push(`| 动态池组数（未截断） | ${out.counts.dynamicGroupCount} |`);
  lines.push(`| 动态池规模（top ${out.options.topN}） | ${out.counts.dynamicPoolSize} |`);
  lines.push('');
  lines.push('## 名录', '');
  for (const [name, entries] of Object.entries(out.pools)) {
    lines.push(`### ${name}（${entries.length} 只）`, '');
    lines.push('| # | symbol | name | 近3日均额 | firstBar | lastBar | T日停牌 | 面板bar |');
    lines.push('|---|---|---|---|---|---|---|---|');
    entries.forEach((e, idx) => {
      lines.push(
        `| ${idx + 1} | ${e.symbol} | ${e.name ?? '—'} | ${wan(e.avgAmount)} | ${e.firstBar} | ${e.lastBar} | ${
          e.suspended ? `是（${e.suspensionReason}）` : '否'
        } | ${e.panelBarCount} |`,
      );
    });
    lines.push('');
  }
  if (out.options.pool === 'dynamic' || out.options.pool === 'all') {
    lines.push('### 动态池分组（组 → 组内第一）', '');
    lines.push('| 组键 | 特别组 | 成员数 | 选中 | 清洗名 | 近3日均额 |');
    lines.push('|---|---|---|---|---|---|');
    for (const g of out.dynamicGroups) {
      lines.push(
        `| ${g.groupKey} | ${g.specialGroup ?? '普通'} | ${g.memberCount} | ${g.picked?.symbol ?? '—'} | ${
          g.picked?.cleanedName ?? '—'
        } | ${g.picked ? wan(g.picked.avgAmount) : '—'} |`,
      );
    }
    lines.push('');
  }
  lines.push('## 行情面板摘要', '');
  lines.push(`- 窗口：${out.panel.start} ~ ${out.panel.end}（${out.panel.tradingDayCount} 个交易日）`);
  lines.push(
    `- 合计：bar=${out.panel.totals.barCount} / 缺 bar=${out.panel.totals.missingBarCount} / 零量=${out.panel.totals.zeroVolumeCount} / 停牌=${out.panel.totals.suspendedCount}`,
  );
  lines.push('');
  lines.push('| symbol | bar | 缺 bar | 零量 | 停牌 | first | last |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of out.panel.perSymbol) {
    lines.push(
      `| ${s.symbol} | ${s.barCount} | ${s.missingBarCount} | ${s.zeroVolumeCount} | ${s.suspendedCount} | ${s.firstDate ?? '—'} | ${s.lastDate ?? '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function writeOutput(out: CliOutput, target: string | null): string[] {
  const json = JSON.stringify(out, null, 2);
  const md = renderMarkdown(out);
  const written: string[] = [];

  if (!target) return written;

  const lower = target.toLowerCase();
  if (lower.endsWith('.json')) {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, json, 'utf8');
    written.push(target);
    return written;
  }
  if (lower.endsWith('.md')) {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, md, 'utf8');
    written.push(target);
    return written;
  }
  // 视为目录：写两份
  const dir = target;
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  const base = `m1-${out.asOf}-${out.options.pool}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const mdPath = path.join(dir, `${base}.md`);
  fs.writeFileSync(jsonPath, json, 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  written.push(jsonPath, mdPath);
  return written;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = await buildOutput(args);
  const written = writeOutput(out, args.out);

  console.log(`asOf=${out.asOf}（请求 ${out.requestedAsOf}）`);
  console.log(
    `阈值=${wan(out.liquidity.threshold)}/日（日均总额 ${yi(out.liquidity.avgTotal)}，除数 ${out.options.divisor}）${
      out.liquidity.fallback ? ' [fallback 1000万]' : ''
    }`,
  );
  console.log(`全市场通过=${out.counts.marketLiquidityPassCount} / Universe=${out.counts.universeCount}`);
  console.log(
    `固定池=${out.counts.fixedTradableCount}/${out.counts.fixedPoolSize}（在册命中 ${out.counts.fixedCoverageCount}） / 固定池流动性=${out.counts.fixedLiquidityPassCount} / 走弱期池=${out.counts.weakLiquidityPassCount}`,
  );
  console.log(`动态池组数=${out.counts.dynamicGroupCount} / 动态池规模=${out.counts.dynamicPoolSize}`);
  if (written.length > 0) console.log(`已写出：${written.join(', ')}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
