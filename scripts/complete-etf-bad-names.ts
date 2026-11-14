/**
 * 生成 ETF 坏名覆盖表（含 U+FFFD 替换符）
 *
 * 原理：`raw_symbol_name` 中 ETF 名称末字节被截断后，DuckDB 解出 U+FFFD。
 * 本脚本把每个坏名映射为「去掉 FFFD、并尽量去掉 ETF 后可见的基金公司片段」后的安全值：
 *   - 不会写入 FFFD；
 *   - 不会瞎补完整基金公司全名（无法从截断字节唯一恢复）；
 *   - 动态池分组仍取前 2 字，业务逻辑不受影响。
 *
 * 用法：npx tsx scripts/complete-etf-bad-names.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryDuckDB } from '../apps/backend/src/db/duckdb.js';

const FFFD = '\uFFFD';

const FUND_COMPANIES = [
  '华泰柏瑞',
  '华夏基金',
  '华安基金',
  '华鑫基金',
  '华宝基金',
  '汇添富',
  '易方达',
  '嘉实基金',
  '广发基金',
  '富国基金',
  '景顺长城',
  '国泰基金',
  '鹏华基金',
  '招商基金',
  '南方基金',
  '博时基金',
  '博道基金',
  '海富通',
  '方正富邦',
  '民生加银',
  '中欧基金',
  '工银瑞信',
  '建信基金',
  '兴业基金',
  '兴业全球',
  '兴证全球',
  '申万菱信',
  '创金合信',
  '万家基金',
  '泰康基金',
  '银华基金',
  '大成基金',
  '国联安',
  '国投瑞银',
  '前海开源',
  '永赢基金',
  '西部利得',
  '天弘基金',
  '中银证券',
  '东方基金',
  '平安基金',
  '长城基金',
  '长信基金',
  '长盛基金',
  '信达澳银',
  '信达基金',
  '信达澳亚',
] as const;

function looksLikeFundFragment(suffix: string): boolean {
  if (!suffix) return false;
  return FUND_COMPANIES.some((company) => company.startsWith(suffix) || suffix.startsWith(company));
}

/** 去掉末位 FFFD；若 ETF 后面只剩基金公司片段，也一并去掉，留下可读的产品名。 */
function cleanBadName(badName: string): string {
  let s = badName.replace(FFFD, '');
  const idx = s.lastIndexOf('ETF');
  if (idx >= 0) {
    const prefix = s.slice(0, idx + 3);
    const suffix = s.slice(idx + 3);
    if (looksLikeFundFragment(suffix)) s = prefix;
  }
  return s || badName.replace(FFFD, '');
}

async function main() {
  const OUT_FILE = resolve(__dirname, '../apps/backend/src/data/etf-name-overrides.json');
  let overrides: Record<string, string> = {};
  try {
    overrides = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    overrides = {};
  }

  const rows = await queryDuckDB<{ symbol: string; name: string }>(
    "SELECT symbol, name FROM raw_symbol_name WHERE class = 'etf' AND name LIKE '%' || chr(65533) || '%'",
  );

  const badNames = new Map<string, string>();
  for (const r of rows) {
    const name = r.name ?? '';
    if (name.includes(FFFD) && !badNames.has(name)) badNames.set(name, r.symbol);
  }

  let written = 0;
  for (const [badName] of badNames) {
    const existing = overrides[badName];
    // 已有「不含 FFFD」的人工值优先保留
    if (existing && !existing.includes(FFFD)) {
      written++;
      continue;
    }
    overrides[badName] = cleanBadName(badName);
    written++;
  }

  writeFileSync(OUT_FILE, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
  process.stdout.write(`生成 ${written} 条覆盖，写入 ${OUT_FILE}\n`);
  process.stdout.write(`其中 DuckDB 当前坏名 ${badNames.size} 条；如现有表里还有历史人工条目，一并保留。\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
