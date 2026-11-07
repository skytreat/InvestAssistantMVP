/**
 * M1/M2 CLI —— `tsx` 入口
 *
 * 子命令：
 * 1) **时点名录**（M1，默认）：
 *    ```bash
 *    npx tsx apps/backend/src/services/backtest/cli.ts --as-of 2026-10-12 --pool dynamic --out ./tmp/m1-universe
 *    ```
 * 2) **回测**（M2）：
 *    ```bash
 *    npx tsx apps/backend/src/services/backtest/cli.ts run \
 *      --strategy buy-and-hold --symbol sh510300 --start 2024-01-02 --end 2024-12-31 --cash 100000
 *    ```
 *
 * ⚠️ 只读 DuckDB；回测结果写**独立库** `data/backtest.db`（可用 `--db` / `--no-db` 覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadTradingCalendar } from './calendar.js';
import { getBars, isSuspended, summarizePanel, type SymbolPanelSummary } from './marketPanel.js';
import { DEFENSIVE_ETF, FIXED_ETF_POOL, GLOBAL_ETF_POOL } from './universe/fixedPool.js';
import {
  resolveUniverseAt,
  type UniverseSnapshot,
  type PoolPick,
  WEAK_PERIOD_INDEXES,
} from './universe/pointInTime.js';
import type { Bar, SuspensionOptions } from './types.js';
import { loadUniverseProvider, type UniverseResolver } from './universe/provider.js';
import { loadUniversePanel } from './universe/dynamicPanel.js';
import { runBacktest } from './engine.js';
import { buyAndHoldStrategy } from './strategies/buyAndHold.js';
import {
  createWufuRotationStrategy,
  resolveWufuRotationParams,
} from './strategies/wufuRotation/index.js';
import { momentumRawWindow } from './strategies/wufuRotation/filters.js';
import { computeAttribution, toAttributionRows } from './attribution/index.js';
import { BacktestStore, resolveBacktestDbPath } from './store/backtestDb.js';
import { loadCorporateActions } from './corporateActions.js';
import type { SweepResult } from './optimize/runner.js';
import type { CorporateAction } from './account/portfolio.js';

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

/** ───────────────────────── M2：回测子命令 ───────────────────────── */

interface RunArgs {
  strategy: string;
  symbol: string;
  weight: number;
  rebalance: boolean;
  start: string;
  end: string;
  cash: number;
  universeMode: 'fixed' | 'weak' | 'dynamic';
  /** 需要装载的指数代码（`--universe dynamic` 专用；走弱期由调用方显式传四指数） */
  indexes: string[];
  priceMode: 'open' | 'close';
  benchmark: string;
  dbPath: string | null;
  divisor: number;
  topN: number;
  /** 策略参数（JSON；缺省用策略默认值）—— M4 复现单组参数用 */
  params: Record<string, unknown>;
  suspension: Required<SuspensionOptions>;
}

const RUN_USAGE = `用法: tsx apps/backend/src/services/backtest/cli.ts run --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--strategy buy-and-hold] [--symbol sh510300] [--weight 1] [--rebalance] [--cash 100000] [--universe fixed|weak|dynamic] [--indexes sh000300,sh000510,sz399101,sz399006] [--price open|close] [--benchmark sh510300] [--db <path>|--no-db] [--divisor 20000] [--top-n 300] [--no-missing-bar] [--no-zero-volume]`;

function parseRunArgs(argv: readonly string[]): RunArgs {
  const options: RunArgs = {
    strategy: 'buy-and-hold',
    symbol: 'sh510300',
    weight: 1,
    rebalance: false,
    start: '',
    end: '',
    cash: 100_000,
    universeMode: 'fixed',
    indexes: [],
    priceMode: 'open',
    benchmark: 'sh510300',
    dbPath: resolveBacktestDbPath(),
    divisor: 20000,
    topN: 300,
    params: {},
    suspension: { missingBar: true, zeroVolume: true },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} 缺少取值\n${RUN_USAGE}`);
      i++;
      return v;
    };
    switch (arg) {
      case '--strategy': {
        const v = readValue();
        if (v !== 'buy-and-hold' && v !== 'wufu-rotation') {
          throw new Error(`--strategy 只接受 buy-and-hold|wufu-rotation（收到 ${v}）`);
        }
        options.strategy = v;
        break;
      }
      case '--symbol':
        options.symbol = readValue();
        break;
      case '--weight':
        options.weight = Number(readValue());
        break;
      case '--rebalance':
        options.rebalance = true;
        break;
      case '--start':
        options.start = readValue();
        break;
      case '--end':
        options.end = readValue();
        break;
      case '--cash':
        options.cash = Number(readValue());
        break;
      case '--universe': {
        const v = readValue();
        if (v !== 'fixed' && v !== 'weak' && v !== 'dynamic') {
          throw new Error(`--universe 只接受 fixed|weak|dynamic（收到 ${v}）`);
        }
        options.universeMode = v;
        break;
      }
      case '--indexes': {
        const parts = readValue()
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (parts.length === 0) throw new Error(`--indexes 至少要给一个代码（如 sh000300,sz399006）`);
        for (const code of parts) {
          if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
            throw new Error(`--indexes 里的代码格式不对：${code}（应形如 sh000300）`);
          }
        }
        options.indexes = parts;
        break;
      }
      case '--price': {
        const v = readValue();
        if (v !== 'open' && v !== 'close') throw new Error(`--price 只接受 open|close（收到 ${v}）`);
        options.priceMode = v;
        break;
      }
      case '--benchmark':
        options.benchmark = readValue();
        break;
      case '--db':
        options.dbPath = readValue();
        break;
      case '--no-db':
        options.dbPath = null;
        break;
      case '--divisor':
        options.divisor = Number(readValue());
        break;
      case '--top-n':
        options.topN = Number(readValue());
        break;
      case '--params': {
        const raw = readValue();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`--params 必须是 JSON 对象（收到 ${raw}）`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`--params 必须是 JSON 对象`);
        }
        options.params = parsed as Record<string, unknown>;
        break;
      }
      case '--no-missing-bar':
        options.suspension.missingBar = false;
        break;
      case '--no-zero-volume':
        options.suspension.zeroVolume = false;
        break;
      case '--help':
      case '-h':
        throw new Error(RUN_USAGE);
      default:
        throw new Error(`未知参数 ${arg}\n${RUN_USAGE}`);
    }
  }

  if (!options.start || !options.end) throw new Error(`缺少 --start / --end\n${RUN_USAGE}`);
  for (const [name, value] of [
    ['--start', options.start],
    ['--end', options.end],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} 必须是 YYYY-MM-DD（收到 ${value}）`);
  }
  if (options.start > options.end)
    throw new Error(`--start 不能晚于 --end（${options.start} > ${options.end}）`);
  if (
    options.strategy !== 'buy-and-hold' &&
    options.strategy !== 'ref-buy-and-hold' &&
    options.strategy !== 'wufu-rotation'
  ) {
    throw new Error(`--strategy 只接受 buy-and-hold|wufu-rotation；收到 ${options.strategy}`);
  }
  if (!(options.cash > 0)) throw new Error(`--cash 必须 > 0（收到 ${options.cash}）`);
  if (!Number.isFinite(options.weight) || options.weight < 0 || options.weight > 1) {
    throw new Error(`--weight 必须在 [0,1]（收到 ${options.weight}）`);
  }
  if (options.universeMode !== 'dynamic' && options.indexes.length > 0) {
    throw new Error(`--indexes 只在 --universe dynamic 下生效（当前 --universe ${options.universeMode}）`);
  }
  return options;
}

/** 回测子命令（M2）：装载行情 + 跑引擎 + 落库 + 打印指标 */
async function runCommand(argv: readonly string[]): Promise<void> {
  const startedAt = new Date().toISOString();
  const args = parseRunArgs(argv);

  const strategy = args.strategy === 'wufu-rotation' ? createWufuRotationStrategy() : buyAndHoldStrategy;
  if (args.strategy === 'wufu-rotation' && args.universeMode !== 'dynamic') {
    throw new Error(
      'wufu-rotation 必须配 --universe dynamic：动态池候选来自全市场 ETF，固定池面板里没有它们',
    );
  }
  const indexCodes =
    args.indexes.length > 0
      ? args.indexes
      : args.strategy === 'wufu-rotation'
        ? [...WEAK_PERIOD_INDEXES]
        : [];

  // 装载区间：向前多取几根 bar，保证决策上下文/估值在起点前有价可依。
  // warmup 必须按**本次实际参数**推导（`--params` 的 lookbackDays 可能大于默认 25），
  // 否则停牌密集标的在起点附近的有效点会不够，整片算不出来。
  const calendar = await loadTradingCalendar();
  const strategyWarmup =
    args.strategy === 'wufu-rotation'
      ? momentumRawWindow(resolveWufuRotationParams(args.params))
      : strategy.warmupDays;
  const warmup = Math.max(5, strategyWarmup + 1);
  const loadStart = calendar.lastN(args.start, warmup)[0] ?? args.start;

  // 固定池 / 防御 ETF / 用户标的 / 基准 —— 动态模式下必须仍在面板里（见 dynamicPanel 的 extraSymbols）
  const extraSymbols = [
    ...new Set([...FIXED_ETF_POOL, ...GLOBAL_ETF_POOL, DEFENSIVE_ETF, args.symbol, args.benchmark]),
  ];
  const symbols = [...new Set([...extraSymbols, ...WEAK_PERIOD_INDEXES])];

  const providerPromise = loadUniverseProvider(args.start, args.end, {
    calendar,
    divisor: args.divisor,
    topN: args.topN,
  });

  let signalBars: Map<string, Bar[]>;
  let execBars: Map<string, Bar[]>;
  let indexBars: Map<string, Bar[]>;
  let corporateActions: CorporateAction[];
  let provider: Awaited<typeof providerPromise>;

  if (args.universeMode === 'dynamic') {
    // M3：动态时点池的候选是**全市场 ETF** ⇒ 一次性装载全市场面板（不再只装固定池）
    const [panel, p] = await Promise.all([
      loadUniversePanel({
        start: loadStart,
        end: args.end,
        extraSymbols,
        indexCodes,
      }),
      providerPromise,
    ]);
    signalBars = panel.signalBars;
    execBars = panel.execBars;
    indexBars = panel.indexBars;
    provider = p;
    // 用户指定的标的 / 基准必须真的在面板里（`v_etf_*` 只放行 class='etf'，非 ETF 代码会被静默丢掉）
    for (const code of [args.symbol, args.benchmark]) {
      if (!panel.signalBars.has(code)) {
        throw new Error(
          `dynamic 面板里没有 ${code}：该代码必须是 class='etf' 且 ${loadStart}~${args.end} 有行情`,
        );
      }
    }
    // 动态池可能持有任意 ETF ⇒ 除权事件按面板全部标的取（M2 只取固定池）
    corporateActions = await loadCorporateActions(panel.symbols, loadStart, args.end);
    console.log(
      `面板（dynamic）：${panel.symbols.length} 只 / ${panel.barCount} 根 bar / 指数 ${panel.indexBars.size} 只`,
    );
  } else {
    const [sig, exe, p, ca] = await Promise.all([
      getBars(symbols, loadStart, args.end, { adjust: 'qfq' }),
      getBars(symbols, loadStart, args.end, { adjust: 'bfq' }),
      providerPromise,
      loadCorporateActions(symbols, loadStart, args.end),
    ]);
    signalBars = sig;
    execBars = exe;
    provider = p;
    corporateActions = ca;
    // ⚠️ 逐字节保持 M2 口径：指数轨取自信号轨（`v_etf_*` 不含指数 ⇒ 实际为空 Map 值）
    indexBars = new Map(WEAK_PERIOD_INDEXES.map((code) => [code, sig.get(code) ?? []]));
  }

  const universe: UniverseResolver = (asOf) => provider.snapshotAt(asOf);

  const result = runBacktest(
    {
      calendar,
      signalBars,
      execBars,
      benchmarkBars: execBars.get(args.benchmark) ?? [],
      indexBars,
      universe,
      corporateActions,
    },
    {
      strategy,
      params:
        args.strategy === 'wufu-rotation'
          ? args.params
          : { symbol: args.symbol, weight: args.weight, rebalance: args.rebalance },
      start: args.start,
      end: args.end,
      initialCash: args.cash,
      universeMode: args.universeMode,
      priceMode: args.priceMode,
      suspension: args.suspension,
      universeParams: { divisor: args.divisor, topN: args.topN },
    },
  );

  const attribution = computeAttribution(result, { initialCash: args.cash });

  let runId: string | null = null;
  if (args.dbPath) {
    const store = new BacktestStore(args.dbPath);
    try {
      runId = store.writeRun(result, {
        startedAt,
        finishedAt: new Date().toISOString(),
        attribution: toAttributionRows(attribution),
      });
    } finally {
      store.close();
    }
  }

  const m = result.metrics;
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
  console.log(
    `策略=${result.meta.strategyId}@${result.meta.strategyVersion} 区间 ${m.startDate} ~ ${m.endDate}（${m.tradingDays} 个交易日）`,
  );
  console.log(
    `初始 ${args.cash.toFixed(2)} → 期末 ${m.finalEquity.toFixed(2)}（累计 ${pct(m.cumulativeReturn)} / 年化 ${pct(m.cagr)}）`,
  );
  console.log(
    `最大回撤（比率）=${pct(m.maxDrawdownRatio)}（${m.peakDate ?? '—'} → ${m.troughDate ?? '—'}，金额 ${m.maxDrawdownAmount.toFixed(2)}）`,
  );
  console.log(
    `成交 ${result.trades.length} 笔 / 跳过 ${result.skipped.length} 笔 / 平仓回合 ${m.closedRoundTrips} 笔（胜率 ${pct(m.winRate)}）`,
  );
  console.log(`换手（年化）=${m.turnoverAnnualized.toFixed(2)} / 平均风险暴露=${pct(m.averageExposure)}`);

  // 数据缺陷事件（不改变成交结果）：`preclose` 缺失时涨跌停判定被跳过，这里显式提示
  const precloseMissing = result.warnings.filter((w) => w.code === 'PRECLOSE_MISSING');
  if (precloseMissing.length > 0) {
    const symbols = [...new Set(precloseMissing.map((w) => w.symbol))];
    const shown = symbols.slice(0, 5).join(', ');
    console.log(
      `⚠️ PRECLOSE_MISSING ${precloseMissing.length} 次（${symbols.length} 只：${shown}${
        symbols.length > 5 ? ' …' : ''
      }）；涨跌停判定已跳过，成交未受影响`,
    );
  }

  // 归因（§6.3 输出纪律：毛额恒等式 + 分年/分段 + 跨维 Top10 + 「其它」告警）
  const money = (x: number): string => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2));
  console.log(
    `归因：total=${money(attribution.totalPnl)} = risk ${money(attribution.riskPnl)} + cash ${money(
      attribution.cashPnl,
    )} − fees ${attribution.fees.toFixed(2)}（残差 ${attribution.identity.residual.toExponential(2)}）`,
  );
  for (const dim of ['year', 'branch_tag', 'exit_reason'] as const) {
    const d = attribution.dimensions.find((x) => x.dimension === dim);
    if (!d) continue;
    console.log(
      `  ${dim}: ${d.buckets.map((b) => `${b.key}=${money(b.pnl)}(${pct(b.contributionPct)})`).join(' / ')}`,
    );
  }
  console.log(
    `  Top10: ${attribution.top10
      .slice(0, 10)
      .map((t) => `${t.dimension}/${t.key}=${money(t.pnl)}`)
      .join(' / ')}`,
  );
  for (const w of attribution.warnings) console.log(`⚠️ ${w}`);
  if (runId) console.log(`已写入回测库：${args.dbPath}（run_id=${runId}）`);
}

/** ───────────────────────── M4：寻优子命令 ───────────────────────── */

interface SweepArgs {
  sweepId: string;
  seed: number;
  mode: 'pilot' | 'coarse' | 'full';
  coarseCount: number;
  fineCount: number;
  maxMinutes: number | undefined;
  maxHeapMb: number;
  initialCash: number;
  dbPath: string;
  reportPath: string | null;
}

const SWEEP_USAGE = `用法: tsx apps/backend/src/services/backtest/cli.ts sweep --sweep-id <id> [--seed 20261107] [--mode pilot|coarse|full] [--coarse 200] [--fine 120] [--max-minutes N] [--max-heap-mb 2500] [--cash 100000] [--db <path>] [--report <path>]`;

function parseSweepArgs(argv: readonly string[]): SweepArgs {
  const options: SweepArgs = {
    sweepId: '',
    seed: 20261107,
    mode: 'full',
    coarseCount: 200,
    fineCount: 120,
    maxMinutes: undefined,
    maxHeapMb: 2500,
    initialCash: 100_000,
    dbPath: resolveBacktestDbPath(),
    reportPath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} 缺少取值\n${SWEEP_USAGE}`);
      i++;
      return v;
    };
    switch (arg) {
      case '--sweep-id':
        options.sweepId = readValue();
        break;
      case '--seed':
        options.seed = Number(readValue());
        break;
      case '--mode': {
        const v = readValue();
        if (v !== 'pilot' && v !== 'coarse' && v !== 'full') {
          throw new Error(`--mode 只接受 pilot|coarse|full（收到 ${v}）`);
        }
        options.mode = v;
        break;
      }
      case '--coarse':
        options.coarseCount = Number(readValue());
        break;
      case '--fine':
        options.fineCount = Number(readValue());
        break;
      case '--max-minutes':
        options.maxMinutes = Number(readValue());
        break;
      case '--max-heap-mb':
        options.maxHeapMb = Number(readValue());
        break;
      case '--cash':
        options.initialCash = Number(readValue());
        break;
      case '--db':
        options.dbPath = readValue();
        break;
      case '--report':
        options.reportPath = readValue();
        break;
      case '--help':
      case '-h':
        throw new Error(SWEEP_USAGE);
      default:
        throw new Error(`未知参数 ${arg}\n${SWEEP_USAGE}`);
    }
  }

  if (!options.sweepId) throw new Error(`缺少 --sweep-id\n${SWEEP_USAGE}`);
  if (!Number.isInteger(options.seed)) throw new Error(`--seed 必须是整数（收到 ${options.seed}）`);
  for (const [name, value, min] of [
    ['--coarse', options.coarseCount, 1],
    ['--fine', options.fineCount, 0],
    ['--max-heap-mb', options.maxHeapMb, 512],
    ['--cash', options.initialCash, 1],
  ] as const) {
    if (!Number.isFinite(value) || value < min) throw new Error(`${name} 必须 ≥ ${min}（收到 ${value}）`);
  }
  if (options.mode === 'pilot' && options.coarseCount > 50) {
    throw new Error(`--mode pilot 的 --coarse 不应该 > 50（收到 ${options.coarseCount}）：pilot 只验证通路`);
  }
  return options;
}

/** 打印 sweep 汇总（样本外主指标 + 分年度 + 稳定性 + 多重检验披露） */
function printSweepSummary(result: SweepResult): void {
  const s = result.summary;
  const pct = (x: number | null | undefined): string =>
    x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(2)}%`;

  console.log('');
  console.log('═══ M4 sweep 汇总 ═══');
  console.log(
    `试次 ${s.totalTrials}（合格 ${s.eligibleTrials}）/ 用时 ${(result.elapsedSeconds / 60).toFixed(1)} 分钟 / heap 峰值 ${result.heapPeakMb} MB` +
      (result.stoppedReason ? ` / ⛔ 提前停止：${result.stoppedReason}` : ''),
  );
  console.log(
    `样本外 CAGR 分布：min ${pct(s.oosDistribution.min)} / q1 ${pct(s.oosDistribution.q1)} / median ${pct(
      s.oosDistribution.median,
    )} / q3 ${pct(s.oosDistribution.q3)} / max ${pct(s.oosDistribution.max)}`,
  );
  console.log(`基准（默认参数）：样本外 CAGR 均值 ${pct(result.baseline.evaluation.oosMeanCagr)}`);

  if (s.bestBySelection) {
    const b = s.bestBySelection;
    console.log('');
    console.log(`训练段最优试次：${b.trialId}`);
    console.log(
      `  ${Object.entries(b.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );
    console.log(
      `  训练段均值 CAGR ${pct(b.trainMeanCagr)} → **样本外均值 CAGR ${pct(b.oosMeanCagr)}** / Sharpe ${pct(
        b.oosMeanSharpe,
      )} / 样本外回合 ${b.oosRoundTrips}`,
    );
    console.log(
      `  各折：${b.foldCagrs.map((f) => `${f.foldId} train ${pct(f.train)} → test ${pct(f.test)}`).join(' | ')}`,
    );
    console.log(`  每折样本外均跑赢基线：${b.beatsBaselineEachFold ? '是' : '否'}`);
    console.log(
      `  分年度：${Object.entries(s.yearlyConsistency)
        .map(([y, v]) => `${y} 基线 ${pct(v.baseline)} / 最优 ${pct(v.best)}（Δ${pct(v.delta)}）`)
        .join(' | ')}`,
    );
  }
  if (s.bestByOos) {
    console.log(
      `样本外最优（仅披露，不作结论）：${s.bestByOos.trialId} oosCAGR=${pct(s.bestByOos.oosMeanCagr)}（其训练段 ${pct(
        s.bestByOos.selectionScore,
      )}）`,
    );
  }

  console.log('');
  console.log('稳定性曲面（核心参数 ±1 档，样本外 CAGR）：');
  if (result.stability.length === 0) console.log('  （未执行/无邻居）');
  for (const cell of result.stability) {
    console.log(
      `  ${cell.param}=${cell.centerValue} [${cell.verdict}] 中心 ${pct(cell.centerOosCagr)} / 邻域中位 ${pct(
        cell.neighborMedian,
      )}` +
        ` / 下侧跌幅 ${pct(cell.lowerDropPct)} / 上侧跌幅 ${pct(cell.upperDropPct)}:` +
        ` ${cell.neighbors.map((n) => `${n.value}=${pct(n.oosCagr)}`).join(' ')}`,
    );
  }

  console.log('');
  console.log('披露：');
  for (const d of s.disclosure) console.log(`  - ${d}`);
  if (s.topCandidates.length > 0) {
    console.log('训练段 Top10：');
    for (const t of s.topCandidates) {
      console.log(`  ${t.trialId} train=${pct(t.trainMeanCagr)} oos=${pct(t.oosMeanCagr)}`);
    }
  }
}

async function sweepCommand(argv: readonly string[]): Promise<void> {
  const args = parseSweepArgs(argv);
  const { runSweep } = await import('./optimize/runner.js');
  const store = new BacktestStore(args.dbPath);
  try {
    const result = await runSweep(
      {
        sweepId: args.sweepId,
        seed: args.seed,
        mode: args.mode,
        coarseCount: args.coarseCount,
        fineCount: args.fineCount,
        initialCash: args.initialCash,
        maxMinutes: args.maxMinutes,
        maxHeapMb: args.maxHeapMb,
        reportPath: args.reportPath ?? undefined,
      },
      store,
    );
    printSweepSummary(result);
    if (result.stoppedReason === 'max-heap') process.exitCode = 2;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    await runCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'sweep') {
    await sweepCommand(argv.slice(1));
    return;
  }
  const args = parseArgs(argv);
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
