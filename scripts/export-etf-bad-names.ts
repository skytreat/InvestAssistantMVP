/**
 * 导出 ETF 坏名（含 U+FFFD 替换符）到覆盖表 etf-name-overrides.json
 *
 * 用法：npx tsx scripts/export-etf-bad-names.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryDuckDB } from '../apps/backend/src/db/duckdb.js';

// 读现有覆盖表（不存在则为空）
const OUT_FILE = resolve(__dirname, '../apps/backend/src/data/etf-name-overrides.json');
let overrides: Record<string, string> = {};
try {
  overrides = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
} catch {
  overrides = {};
}

// 查坏名
const rows = await queryDuckDB<{ symbol: string; name: string }>(
  "SELECT symbol, name FROM raw_symbol_name WHERE class = 'etf' AND name LIKE '%' || chr(65533) || '%'",
);

// 收集：键 = 坏名（原始），值 = 人工补全
const badNames = new Map<string, { symbol: string; name: string }>();
for (const r of rows) {
  const name = r.name ?? '';
  if (!badNames.has(name)) {
    badNames.set(name, { symbol: r.symbol, name });
  }
}

// 打印到控制台，供人工补全
console.log('\n=== 待补全的 ETF 坏名（键 = 原始坏名，值 = 正确名）===');
for (const [name, info] of badNames) {
  const existing = overrides[name] ?? '';
  console.log(`${info.symbol}\t${JSON.stringify(name)}\t${existing ? JSON.stringify(existing) : '(待补全)'}`);
}

// 提示：补全后写回 OUT_FILE
console.log(`\n共 ${badNames.size} 条坏名，请人工补全后写入：\n  ${OUT_FILE}\n`);
