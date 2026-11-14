/**
 * 诊断：列出行情库中的 ETF 坏名（含 U+FFFD 替换符）标的及其当前覆盖值
 *
 * 覆盖表 etf-name-overrides.json 的键 = 标的代码（含市场前缀），值 = 官方名称，
 * 由 `npx tsx scripts/complete-etf-bad-names.ts` 从权威源重新生成。
 * 本脚本只做只读诊断：查行情库坏名行 → 与现有覆盖表对照 → 打印缺口。
 *
 * 用法：npx tsx scripts/export-etf-bad-names.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryDuckDB } from '../apps/backend/src/db/duckdb.js';

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

  process.stdout.write('\n=== 行情库 ETF 坏名（键 = 标的代码，值 = 覆盖表当前值）===\n');
  let missing = 0;
  for (const r of rows) {
    const override = overrides[r.symbol];
    if (!override) missing++;
    process.stdout.write(
      `${r.symbol}\t${JSON.stringify(r.name)}\t${override ? JSON.stringify(override) : '(覆盖表缺失)'}\n`,
    );
  }
  process.stdout.write(`\n坏名标的 ${rows.length} 个，覆盖表缺失 ${missing} 个。\n`);
  process.stdout.write('补齐请运行：npx tsx scripts/complete-etf-bad-names.ts\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
