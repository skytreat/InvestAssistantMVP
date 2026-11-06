/**
 * asset_class 初判接线（T120 补充；SDD_v3 §2.3「初判在导入时或分类表为空时按需触发」）
 *
 * 背景（2026-11-06 实测）：`runInitialClassification()` 在 assetClass.ts 里定义完整，
 * 但**全仓没有任何调用点**（grep 仅命中定义与注释）⇒ 真实业务库 `asset_class` 表 **0 行**
 * ⇒ `getAssetClass()` 对全部标的回落 default=`risk` ⇒ 逆回购 / 货币 ETF 也被计进风险资产
 * 分母（收益页 `-232.12%` 的分母来源之一）。本文件提供「接线 + 安全默认」：
 *
 * 三档开关（env `ASSET_CLASS_SYNC_MODE`）：
 * - `off`     —— 不触发（连行情层窗口统计都不查）
 * - `dry-run` —— **默认**：只算 + 只记日志，**一行不写**（保证真实库启动/运行不会自动落库）
 * - `execute` —— 真正 `INSERT OR IGNORE`（幂等：已有 rule/manual 记录一律不覆盖）
 *
 * 判定规则本体仍在 assetClass.ts `classifySymbol`（repo_code > 近面值/振幅 > default=risk），
 * 本文件**不复制规则**，只负责「取标的 → 取行情窗口 → 出预览 → 按模式落库/只报」。
 */
import type Database from 'better-sqlite3';
import {
  classifySymbol,
  collectClassifyInputs,
  runInitialClassification,
  type AssetClass,
  type ClassifyInput,
} from './assetClass.js';

export const ASSET_CLASS_SYNC_ENV = 'ASSET_CLASS_SYNC_MODE';

export type AssetClassSyncMode = 'off' | 'dry-run' | 'execute';

/**
 * 解析模式：**只认 `off` / `execute` 两个显式值**，其余（未设置/空串/拼错/未知）一律回落 `dry-run`。
 * 安全侧设计 —— 拼错 `exectue` 不会误落库。
 */
export function resolveSyncMode(
  raw: string | undefined | null = process.env[ASSET_CLASS_SYNC_ENV],
): AssetClassSyncMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'execute') return 'execute';
  return 'dry-run';
}

/** 业务层出现过的标的统计（报告列「是否已在业务层出现」用） */
export interface BusinessSymbolUsage {
  symbol: string;
  trades: number; // user_trade_record 活记录数
  rels: number; // user_asset_rel 活关联数（watch/hold/candidate）
}

/** 业务层全部标的（跨用户去重 —— asset_class 表主键是 symbol，全局唯一） */
export function collectBusinessSymbols(db: Database.Database): BusinessSymbolUsage[] {
  return db
    .prepare(
      `SELECT asset_code AS symbol,
              SUM(CASE WHEN src = 'trade' THEN 1 ELSE 0 END) AS trades,
              SUM(CASE WHEN src = 'rel' THEN 1 ELSE 0 END) AS rels
         FROM (SELECT asset_code, 'trade' AS src FROM user_trade_record WHERE is_deleted = 0
               UNION ALL
               SELECT asset_code, 'rel' AS src FROM user_asset_rel WHERE is_deleted = 0)
        GROUP BY asset_code
        ORDER BY symbol`,
    )
    .all() as BusinessSymbolUsage[];
}

export interface ClassifyPreviewRow {
  symbol: string;
  name: string | null;
  /** 表中当前值；null = 未分类（运行期按 default risk 处理） */
  currentClass: AssetClass | null;
  currentSource: string | null;
  currentRuleHit: string | null;
  /** 规则重跑得到的判定（不受表中现值影响，便于对照「会改成什么」） */
  nextClass: AssetClass;
  nextRuleHit: string;
  /** 判定依据（人可读，含命中关键词/振幅/价格带实测值） */
  basis: string;
  trades: number;
  rels: number;
  /** dry-run 下的写库预演：当前无记录 ⇒ 本次会插入 */
  willWrite: boolean;
}

export interface AssetClassSyncResult {
  mode: AssetClassSyncMode;
  rows: ClassifyPreviewRow[];
  /** execute 模式实际写入条数（dry-run 恒为 0） */
  writtenCount: number;
  /** 表中已有、按幂等规则被跳过的 symbol（dry-run 下 = 已有记录的一律跳过） */
  skippedExisting: string[];
  /** 无行情窗口统计 ⇒ 按 default risk 且报告须列出（SDD §2.4 不得静默） */
  unclassifiable: string[];
  /** 分类分布（按 nextClass + nextRuleHit 聚合） */
  distribution: Array<{ assetClass: AssetClass; ruleHit: string; count: number }>;
}

const EMPTY_RESULT: AssetClassSyncResult = {
  mode: 'off',
  rows: [],
  writtenCount: 0,
  skippedExisting: [],
  unclassifiable: [],
  distribution: [],
};

function ampPercent(input: ClassifyInput): number | null {
  if (input.winLo === undefined || input.winHi === undefined) return null;
  const mid = (input.winHi + input.winLo) / 2;
  if (mid === 0) return null;
  return ((input.winHi - input.winLo) / mid) * 100;
}

function basisOf(input: ClassifyInput, ruleHit: string): string {
  if (ruleHit === 'repo_code') return '逆回购品种段（REPO_CODES 实测清单命中）';
  const bars = input.winBars ?? 0;
  if (ruleHit === 'cash_etf_near_par' || ruleHit === 'cash_etf_name') {
    const amp = ampPercent(input);
    const parts = [
      ruleHit === 'cash_etf_name'
        ? `名称命中货币关键词（${input.name ?? ''}）`
        : '名称未命中货币关键词，仅靠价格带/振幅',
      `近窗口振幅 ${amp === null ? 'n/a' : amp.toFixed(2)}%（≤5%）`,
      `最新收盘 ${input.latestClose ?? 'n/a'} ∈ [90,130]`,
      `窗口 ${bars} 根（≥120）`,
    ];
    return parts.join('；');
  }
  return bars === 0
    ? '行情层无窗口统计 ⇒ 规则无法佐证，安全侧回落 risk（unclassifiable）'
    : `repo/近面值均不成立（窗口 ${bars} 根，振幅 ${ampPercent(input)?.toFixed(2) ?? 'n/a'}%）⇒ 安全侧 risk`;
}

/**
 * 只算不写的预览（dry-run 核心）。`provider` 可注入 ⇒ 单测不碰 DuckDB。
 */
export async function previewAssetClassSync(
  db: Database.Database,
  provider: (codes: string[]) => Promise<ClassifyInput[]> = collectClassifyInputs,
): Promise<AssetClassSyncResult> {
  return (await computePreview(db, provider)).result;
}

/** 内部：一次取数同时产出「预览」与「已取到的窗口统计」（execute 复用，不重复扫行情层） */
async function computePreview(
  db: Database.Database,
  provider: (codes: string[]) => Promise<ClassifyInput[]>,
): Promise<{ result: AssetClassSyncResult; inputs: ClassifyInput[] }> {
  const usage = collectBusinessSymbols(db);
  if (usage.length === 0) return { result: { ...EMPTY_RESULT, mode: 'dry-run' }, inputs: [] };

  const codes = usage.map((u) => u.symbol);
  const inputs = await provider(codes);
  const inputByCode = new Map(inputs.map((i) => [i.code, i]));

  const ph = codes.map(() => '?').join(',');
  const existing = db
    .prepare(`SELECT symbol, asset_class, rule_hit, source FROM asset_class WHERE symbol IN (${ph})`)
    .all(...codes) as Array<{
    symbol: string;
    asset_class: AssetClass;
    rule_hit: string | null;
    source: string;
  }>;
  const existingBy = new Map(existing.map((r) => [r.symbol, r]));

  const rows: ClassifyPreviewRow[] = [];
  const unclassifiable: string[] = [];
  const skippedExisting: string[] = [];
  const dist = new Map<string, { assetClass: AssetClass; ruleHit: string; count: number }>();

  for (const u of usage) {
    const input = inputByCode.get(u.symbol) ?? { code: u.symbol };
    const r = classifySymbol(input);
    const cur = existingBy.get(u.symbol);
    if (cur) skippedExisting.push(u.symbol);
    if (r.rule_hit === 'default' && (input.winBars ?? 0) === 0) unclassifiable.push(u.symbol);

    rows.push({
      symbol: u.symbol,
      name: input.name ?? null,
      currentClass: cur ? cur.asset_class : null,
      currentSource: cur ? cur.source : null,
      currentRuleHit: cur ? cur.rule_hit : null,
      nextClass: r.asset_class,
      nextRuleHit: r.rule_hit,
      basis: basisOf(input, r.rule_hit),
      trades: u.trades,
      rels: u.rels,
      willWrite: cur === undefined,
    });

    const key = `${r.asset_class}|${r.rule_hit}`;
    const slot = dist.get(key);
    if (slot) slot.count++;
    else dist.set(key, { assetClass: r.asset_class, ruleHit: r.rule_hit, count: 1 });
  }

  return {
    result: {
      mode: 'dry-run',
      rows,
      writtenCount: 0,
      skippedExisting,
      unclassifiable,
      distribution: [...dist.values()].sort(
        (a, b) => a.assetClass.localeCompare(b.assetClass) || a.ruleHit.localeCompare(b.ruleHit),
      ),
    },
    inputs,
  };
}

/**
 * 按模式同步：`off` 直接返回；`dry-run` 只出预览；`execute` 走 `runInitialClassification`
 * （INSERT OR IGNORE ⇒ 幂等，已有 rule/manual 记录不覆盖）。
 */
export async function syncAssetClass(
  db: Database.Database,
  mode: AssetClassSyncMode,
  provider: (codes: string[]) => Promise<ClassifyInput[]> = collectClassifyInputs,
): Promise<AssetClassSyncResult> {
  if (mode === 'off') return EMPTY_RESULT;

  const { result: preview, inputs } = await computePreview(db, provider);
  if (mode === 'dry-run') return preview;

  const codes = preview.rows.map((r) => r.symbol);
  // 复用已取到的窗口统计，避免 execute 再扫一次行情层
  const written = await runInitialClassification(db, codes, async () => inputs);
  return {
    ...preview,
    mode: 'execute',
    writtenCount: written.written.length,
  };
}

/** 报告渲染（Markdown；dry-run / execute 共用，execute 时多一段「实际写入」） */
export function renderSyncReport(
  result: AssetClassSyncResult,
  meta: { dbPath: string; duckdbPath: string; generatedAt: string },
): string {
  const cash = result.rows.filter((r) => r.nextClass === 'cash');
  const unclassifiedNow = result.rows.filter((r) => r.currentClass === null).length;
  const lines: string[] = [];

  lines.push('# asset_class 初判报告');
  lines.push('');
  lines.push(`- 模式：**${result.mode}**${result.mode === 'dry-run' ? '（只读，未写库）' : ''}`);
  lines.push(`- 业务库：${meta.dbPath}`);
  lines.push(`- 行情库：${meta.duckdbPath}`);
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 业务层标的数：**${result.rows.length}**（其中当前未分类 ${unclassifiedNow}）`);
  lines.push(`- 规则判为 cash：**${cash.length}**`);
  lines.push(`- 规则判为 risk：**${result.rows.length - cash.length}**`);
  lines.push(`- 已有记录（幂等跳过）：**${result.skippedExisting.length}**`);
  lines.push(`- 无行情窗口统计（unclassifiable）：**${result.unclassifiable.length}**`);
  lines.push(`- 本次实际写入：**${result.writtenCount}** 条`);
  lines.push('');
  lines.push('## 分类分布（规则判定）');
  lines.push('');
  lines.push('| asset_class | rule_hit | 数量 |');
  lines.push('|---|---|---|');
  for (const d of result.distribution) lines.push(`| ${d.assetClass} | ${d.ruleHit} | ${d.count} |`);
  lines.push('');
  lines.push(`## 会被判成 cash 的标的（${cash.length} 个）`);
  lines.push('');
  if (cash.length === 0) {
    lines.push('（无）');
  } else {
    lines.push(
      '| symbol | 名称 | 当前 class | 判定 class | rule_hit | 判定依据 | 业务层（成交/关联） | 本次会写入 |',
    );
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of cash) {
      lines.push(
        `| ${r.symbol} | ${r.name ?? '-'} | ${r.currentClass ?? '未分类'} | ${r.nextClass} | ${r.nextRuleHit} | ${r.basis} | ${r.trades} / ${r.rels} | ${r.willWrite ? '是' : '否（已有记录，幂等跳过）'} |`,
      );
    }
  }
  lines.push('');
  lines.push(`## 未分类且无行情佐证（unclassifiable，${result.unclassifiable.length} 个）`);
  lines.push('');
  lines.push(result.unclassifiable.length === 0 ? '（无）' : result.unclassifiable.join(', '));
  lines.push('');
  lines.push(`## 全量明细（${result.rows.length} 行）`);
  lines.push('');
  lines.push('| symbol | 名称 | 当前 class | 判定 class | rule_hit | 成交 | 关联 | 会写入 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of result.rows) {
    lines.push(
      `| ${r.symbol} | ${r.name ?? '-'} | ${r.currentClass ?? '未分类'} | ${r.nextClass} | ${r.nextRuleHit} | ${r.trades} | ${r.rels} | ${r.willWrite ? '是' : '否'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 供「导入后 / 启动时（分类表为空）」两个调用点使用：
 * 1. `mode=off` ⇒ 直接返回；
 * 2. 表内已有记录 ⇒ 也返回（避免每次导入都扫行情层 —— INSERT OR IGNORE 的结果也不会变）；
 * 3. 否则按 mode 执行（默认 dry-run ⇒ 只记日志，一行不写）。
 */
export async function runAssetClassSyncIfNeeded(
  db: Database.Database,
  log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void },
  opts: { provider?: (codes: string[]) => Promise<ClassifyInput[]> } = {},
): Promise<AssetClassSyncResult | null> {
  const mode = resolveSyncMode();
  if (mode === 'off') return null;

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM asset_class`).get() as { n: number }).n;
  if (total > 0) return null;

  try {
    const result = await syncAssetClass(db, mode, opts.provider);
    const cash = result.rows.filter((r) => r.nextClass === 'cash');
    log.info(
      {
        mode,
        symbols: result.rows.length,
        cashCount: cash.length,
        cashSymbols: cash.map((r) => r.symbol),
        written: result.writtenCount,
      },
      mode === 'dry-run'
        ? 'asset_class 初判 dry-run：仅计算未写库（设 ASSET_CLASS_SYNC_MODE=execute 才落库）'
        : 'asset_class 初判已落库',
    );
    return result;
  } catch (err) {
    log.warn({ err }, 'asset_class 初判同步失败（不影响主流程）');
    return null;
  }
}
