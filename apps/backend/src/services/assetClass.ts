/**
 * T120（V3.0b）：标的资产分类（风险 / 现金）—— SDD_v3 §2 / Requirements §3.5
 *
 * 语义（SDD_v3 §2.2）：
 * - `cash`  = 现金类（逆回购 / 货币 ETF）：不参与涨跌幅 / 信号 / 集中度分母，只参与资产总额与收益
 * - `risk`  = 风险资产：默认（安全侧 —— 漏判现金类会让其混进风险指标，误判风险为现金会丢掉信号）
 *
 * 初判规则（SDD_v3 §2.3，**每条必须有可验证依据，名称只作辅助**）：
 * 1. `repo_code`        —— 证券代码属于国债逆回购品种段（**实测确认清单**，见 REPO_CODES）
 * 2. `cash_etf_near_par`—— 近 250 交易日窗口振幅 ≤5% 且最新收盘落在货币 ETF 净值带 [90,130]
 * 3. `cash_etf_name`    —— 名称含货币关键词 **且** 2 的价格带/振幅佐证成立（关键词单独不定案，
 *                           防「现金流指数 ETF」被「现金」二字误判 —— 2026-10-25 实测 512130 振幅 26%）
 *
 * 实测依据（2026-10-25，真库 /opt/invol/quotes.duckdb，close 窗口 = 最大交易日前 400 自然日取 250 根）：
 * - 货币 ETF：sh511600 4.05% / sh511880 1.14% / sh511900 0.69% / sh511960 0.29% / sh511990 0.06% / sz159001 0.01%
 * - 股票/现金流/黄金 ETF：sh510300 20.89% / sh512130 26.01% / sh518880 43.40% / sz159368 96.78%
 * ⇒ 5% 阈值对两组完全可分（最大货币 4.05% < 最小风险 20.89%，4.5 倍裕量）
 * - 逆回购 raw_kline_daily 收录：sh204001/002/003/004/007、sz131810/131811（204005/006/009、
 *   131812~131818 未收录 —— 已退市/停刊；样本若再遇到走人工修正，见 V3-B5）
 *
 * 人工修正（§2.4）：`setManualClass` 写 source='manual'，**规则重跑不得覆盖**（runInitialClassification
 * 只 INSERT OR IGNORE）；rule_hit 保留初判值 → 可回溯「当初是谁按什么规则判的」。
 */
import type Database from 'better-sqlite3';
import { queryDuckDB } from '../db/duckdb.js';

export type AssetClass = 'risk' | 'cash';

export interface ClassifyInput {
  code: string; // 带市场前缀，如 sh511990
  name?: string; // 可空（行情层 raw_symbol_name 提供）
  latestClose?: number; // 窗口统计缺失时近旁佐证用
  winLo?: number;
  winHi?: number;
  winBars?: number;
}

export interface ClassifyResult {
  code: string;
  asset_class: AssetClass;
  rule_hit: string;
}

/**
 * 逆回购品种段 —— **实测确认**（2026-10-25 raw_kline_daily）：
 * 沪 GC001-GC004/GC007（204001/002/003/004/007）+ 深 R-001/R-002（131810/131811）。
 * 204005/204006/204009 与 131812~131818 行情层无 K 线（停刊/未收录），不入规则；
 * 券商样本里若再出现，走 setManualClass 补录（V3-B5 登记）。
 */
export const REPO_CODES: ReadonlySet<string> = new Set([
  'sh204001',
  'sh204002',
  'sh204003',
  'sh204004',
  'sh204007',
  'sz131810',
  'sz131811',
]);

/** 货币 ETF 名称关键词 —— 仅作辅助，必须与价格带/振幅佐证同成立（INV-S4-15） */
export const CASH_ETF_NAME_KEYWORDS: readonly string[] = ['货币', '添益', '日利', '现金'];

/** 价格带/振幅阈值（实测依据见文件头；近 250 交易日窗口） */
export const NEAR_PAR = {
  minBars: 120, // 窗口不足 120 根时不做 near_par 判定（新上市标的无历史）
  maxAmpRel: 0.05, // (winHi − winLo) / 均值 ≤ 5%
  closeBandLo: 90,
  closeBandHi: 130,
} as const;

/** 窗口统计取样：距最大交易日 400 自然日、取 250 根（marketData 同窗口口径） */
export const WINDOW_CALENDAR_DAYS = 400;

/**
 * 纯函数：单标的初判（SDD_v3 §2.3 规则集）。
 * 判定序：repo_code > 价格带/振幅（名称命中记 cash_etf_name，否则 cash_etf_near_par）> default=risk。
 */
export function classifySymbol(input: ClassifyInput): ClassifyResult {
  const { code, name, latestClose, winLo, winHi, winBars } = input;

  if (REPO_CODES.has(code)) {
    return { code, asset_class: 'cash', rule_hit: 'repo_code' };
  }

  const bars = winBars ?? 0;
  const inBand =
    latestClose !== undefined &&
    winLo !== undefined &&
    winHi !== undefined &&
    latestClose >= NEAR_PAR.closeBandLo &&
    latestClose <= NEAR_PAR.closeBandHi &&
    bars >= NEAR_PAR.minBars &&
    (winHi - winLo) / ((winHi + winLo) / 2) <= NEAR_PAR.maxAmpRel;

  if (inBand) {
    const named = name !== undefined && CASH_ETF_NAME_KEYWORDS.some((k) => name.includes(k));
    return { code, asset_class: 'cash', rule_hit: named ? 'cash_etf_name' : 'cash_etf_near_par' };
  }

  return { code, asset_class: 'risk', rule_hit: 'default' };
}

/**
 * 批量初判落库：对每个标的取行情层窗口统计 + 名称（inputProvider 可注入，单测不碰 DuckDB），
 * 逐一走 classifySymbol，**只 INSERT OR IGNORE** —— 已有记录（无论 rule / manual）一律不覆盖。
 * 返回：本次新写入的 + 被跳过的 + 未分类可列出的（无行情窗口统计 ⇒ 报告须列出）。
 */
export async function runInitialClassification(
  db: Database.Database,
  codes: string[],
  inputProvider: (codes: string[]) => Promise<ClassifyInput[]> = collectClassifyInputs,
): Promise<{
  written: ClassifyResult[];
  skippedExisting: string[];
  unclassifiable: string[];
}> {
  const inputs = await inputProvider(codes);
  const inputByCode = new Map(inputs.map((i) => [i.code, i]));
  const written: ClassifyResult[] = [];
  const skippedExisting: string[] = [];
  const unclassifiable: string[] = [];

  const ph = codes.map(() => '?').join(',');
  const existingSet = new Set(
    (
      db.prepare(`SELECT symbol FROM asset_class WHERE symbol IN (${ph})`).all(...codes) as Array<{
        symbol: string;
      }>
    ).map((r) => r.symbol),
  );

  const upsert = db.prepare(
    `INSERT OR IGNORE INTO asset_class (symbol, asset_class, rule_hit, source, updated_by)
     VALUES (?, ?, ?, 'rule', NULL)`,
  );

  for (const code of codes) {
    if (existingSet.has(code)) {
      skippedExisting.push(code); // 已有记录（rule / manual）一律不覆盖
      continue;
    }
    const input = inputByCode.get(code) ?? { code };
    const r = classifySymbol(input);
    upsert.run(code, r.asset_class, r.rule_hit);
    written.push(r);
    if (r.rule_hit === 'default' && !(input.winBars ?? 0) && !REPO_CODES.has(code)) {
      unclassifiable.push(code); // 无行情窗口统计 ⇒ 报告须列出
    }
  }
  return { written, skippedExisting, unclassifiable };
}

/** 窗口统计 + 名称（各 1 次 IN 查询，行情层只读，符合 SDD §5.3 批量约束） */
export async function collectClassifyInputs(codes: string[]): Promise<ClassifyInput[]> {
  if (codes.length === 0) return [];
  const ph = codes.map(() => '?').join(',');
  const win = await queryDuckDB<{ symbol: string; lo: number; hi: number; bars: number; latest: number }>(
    `WITH win AS (
       SELECT symbol, "close",
              ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
         FROM raw_kline_daily
        WHERE symbol IN (${ph})
          AND date >= (SELECT MAX(date) FROM raw_kline_daily) - INTERVAL ${WINDOW_CALENDAR_DAYS} DAY
     )
     SELECT symbol, MIN("close") AS lo, MAX("close") AS hi, COUNT(*) AS bars,
            MAX(CASE WHEN rn = 1 THEN "close" END) AS latest
       FROM win GROUP BY symbol`,
    codes,
  );
  const winBy = new Map(win.map((r) => [r.symbol, r]));

  const names = await queryDuckDB<{ symbol: string; name: string }>(
    `SELECT symbol, name FROM raw_symbol_name WHERE symbol IN (${ph})`,
    codes,
  );
  const nameBy = new Map(names.map((r) => [r.symbol, r.name]));

  return codes.map((code) => {
    const w = winBy.get(code);
    return {
      code,
      name: nameBy.get(code),
      latestClose: w?.latest,
      winLo: w?.lo,
      winHi: w?.hi,
      winBars: w?.bars,
    };
  });
}

/** 人工修正：source='manual'，保留初判 rule_hit（可回溯）；规则重跑（INSERT OR IGNORE）不会覆盖它 */
export function setManualClass(db: Database.Database, userId: number, code: string, cls: AssetClass): void {
  const cur = db.prepare(`SELECT rule_hit FROM asset_class WHERE symbol = ?`).get(code) as
    { rule_hit: string | null } | undefined;
  const ruleHit = cur?.rule_hit && cur.rule_hit !== 'manual' ? cur.rule_hit : 'manual';
  db.prepare(
    `INSERT INTO asset_class (symbol, asset_class, rule_hit, source, updated_by, updated_at)
     VALUES (?, ?, ?, 'manual', ?, datetime('now','localtime'))
     ON CONFLICT(symbol) DO UPDATE SET
       asset_class = excluded.asset_class,
       rule_hit = excluded.rule_hit,
       source = 'manual',
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(code, cls, ruleHit, userId);
}

/** 取单标的分类：无记录 = default risk（调用方须用 listUnclassified 在报告里列出，不得静默） */
export function getAssetClass(db: Database.Database, code: string): AssetClass {
  const row = db.prepare(`SELECT asset_class FROM asset_class WHERE symbol = ?`).get(code) as
    { asset_class: AssetClass } | undefined;
  return row ? row.asset_class : 'risk';
}

/** 本次对账期间无分类记录的标的（报告须列出，SDD §2.4 —— 不得静默按 risk 处理） */
export function listUnclassified(db: Database.Database, codes: string[]): string[] {
  if (codes.length === 0) return [];
  const ph = codes.map(() => '?').join(',');
  const known = new Set(
    (
      db.prepare(`SELECT symbol FROM asset_class WHERE symbol IN (${ph})`).all(...codes) as Array<{
        symbol: string;
      }>
    ).map((r) => r.symbol),
  );
  return codes.filter((c) => !known.has(c));
}
