/**
 * 重新生成 ETF 坏名覆盖表 etf-name-overrides.json
 *
 * 背景：tdx2db 写 raw_symbol_name 时部分 ETF 名称末字节被截断，DuckDB 解出 U+FFFD。
 * 覆盖表**按标的代码（含市场前缀，如 sh510900）作键**，值 = 官方名称：
 *   - 键不用坏名 —— 坏名本身是损坏数据，且同一坏名可能对应多个标的代码
 *     （实测 395 个坏名标的中 23 个坏名各有 2+ 代码，按坏名键会丢失映射）；
 *   - 值不用截断坏名清洗 —— 无法唯一恢复基金公司全名，改用权威源：
 *     天天基金（fund.eastmoney.com）基金代码全量列表。
 *
 * 前置：
 *   - DuckDB 行情库可读（env DUCKDB_PATH 或 data/quotes.duckdb），且**后端进程未占用**；
 *   - 可访问 https://fund.eastmoney.com/js/fundcode_search.js
 *
 * 用法：npx tsx scripts/complete-etf-bad-names.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryDuckDB } from '../apps/backend/src/db/duckdb.js';

const FFFD = '\uFFFD';
const OUT_FILE = resolve(__dirname, '../apps/backend/src/data/etf-name-overrides.json');
const SOURCE_URL = 'https://fund.eastmoney.com/js/fundcode_search.js';

/** 拉取 基金代码(6位) → 官方名称（权威源：天天基金代码全量列表） */
async function fetchOfficialNames(): Promise<Map<string, string>> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`拉取权威名称源失败：${SOURCE_URL} → HTTP ${res.status}`);
  const text = await res.text();
  const map = new Map<string, string>();
  // 条目形态：["510900","HSZGQYETFPA","恒生中国企业ETF平安","指数型-股票","HENGSHENG..."]
  // 取 第1段=代码, 第3段=官方名称
  const re = /"(\d{6})","[^"]*","([^"]*)","/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[2]) map.set(m[1], m[2]);
  }
  if (map.size < 1000) throw new Error(`权威名称源解析结果异常（${map.size} 条），请检查 ${SOURCE_URL} 格式`);
  return map;
}

/** 坏名去掉 FFFD 与 TDX 新股 N 前缀，用于一致性校验（不是最终值） */
function cleanedBadName(badName: string): string {
  let s = badName.replace(FFFD, '').trim();
  if (s.startsWith('N') && s.length > 1 && /ETF|REIT/i.test(s)) s = s.slice(1);
  return s;
}

/** 基金公司名（官方名可能前缀公司名，TDX 名可能后缀公司名，比对时容忍该位置差异） */
const FUND_COMPANIES = [
  '华泰柏瑞',
  '华夏',
  '华安',
  '华鑫',
  '华宝',
  '汇添富',
  '易方达',
  '嘉实',
  '广发',
  '富国',
  '景顺长城',
  '国泰',
  '鹏华',
  '招商',
  '南方',
  '博时',
  '博道',
  '海富通',
  '方正富邦',
  '民生加银',
  '中欧',
  '工银瑞信',
  '建信',
  '兴业',
  '兴证全球',
  '申万菱信',
  '创金合信',
  '万家',
  '泰康',
  '银华',
  '大成',
  '国联安',
  '国投瑞银',
  '前海开源',
  '永赢',
  '西部利得',
  '天弘',
  '中银证券',
  '东方红',
  '平安',
  '长城',
  '长信',
  '长盛',
  '信达澳银',
  '信达',
  '摩根',
];

/** 一致性校验：坏名清洗后应与官方名同源。
 *  - 官方名直接以坏名清洗值开头 → 一致；
 *  - 官方名前缀是公司名（位置差异：TDX 名常把公司名放后缀且截断）→ 去掉公司名前缀后互相包含即视为一致；
 *  - 其余 → 报出，通常 TDX 名已过时（基金改名），值仍取官方名。 */
function consistent(cleaned: string, official: string): boolean {
  if (official.startsWith(cleaned)) return true;
  for (const c of FUND_COMPANIES) {
    if (official.startsWith(c)) {
      const rest = official.slice(c.length);
      return cleaned.includes(rest) || rest.includes(cleaned);
    }
  }
  return false;
}

async function main() {
  const rows = await queryDuckDB<{ symbol: string; name: string }>(
    "SELECT symbol, name FROM raw_symbol_name WHERE class = 'etf' AND name LIKE '%' || chr(65533) || '%'",
  );
  const official = await fetchOfficialNames();

  const out: Record<string, string> = {};
  const issues: string[] = [];
  for (const r of rows) {
    const symbol = r.symbol;
    const code6 = symbol.replace(/^[a-z]+/i, '');
    const bad = r.name ?? '';
    const cleaned = cleanedBadName(bad);
    const name = official.get(code6);
    if (!name) {
      // 权威源查不到：保留清洗后的坏名兜底，并登记人工复核
      out[symbol] = cleaned;
      issues.push(`MISSING ${symbol}（${bad}）：权威源无此代码，值 = 清洗坏名「${cleaned}」，请人工补正`);
      continue;
    }
    out[symbol] = name;
    // 一致性校验：坏名（去 FFFD / N 前缀）应为官方名前缀（容忍公司名位置差异）；
    // 不通过通常是 TDX 旧名 vs 官方现名（基金改名）⇒ 保留官方名，登记人工确认
    if (!consistent(cleaned, name)) {
      issues.push(`MISMATCH ${symbol}：坏名≈「${cleaned}」 vs 官方名「${name}」（已取官方名，请人工确认）`);
    }
  }

  const sorted: Record<string, string> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  process.stdout.write(`生成 ${Object.keys(sorted).length} 条（键 = 标的代码）→ ${OUT_FILE}\n`);
  if (issues.length > 0) {
    process.stdout.write(`\n⚠ 需人工复核 ${issues.length} 条：\n`);
    for (const i of issues) process.stdout.write(`  ${i}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
