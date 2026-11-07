/**
 * 除权事件装载（M2 起用；M4 sweep 复用）
 *
 * 口径对齐 `exDividendSync`：`raw_gbbq.category = 1`，`c1/10` = 每股派现、`c3/10` = 送转比例。
 * 只读 DuckDB，一次 `IN (...)` 批量查询（AGENTS.md「禁止逐标的循环查询」）。
 */
import { queryDuckDB } from '../../db/duckdb.js';
import type { CorporateAction } from './account/portfolio.js';

export async function loadCorporateActions(
  symbols: readonly string[],
  start: string,
  end: string,
): Promise<CorporateAction[]> {
  if (symbols.length === 0) return [];
  const placeholders = symbols.map(() => '?').join(', ');
  const rows = await queryDuckDB<{ date: string; symbol: string; c1: number | null; c3: number | null }>(
    `SELECT date, symbol, c1, c3
       FROM raw_gbbq
      WHERE category = 1 AND symbol IN (${placeholders}) AND date BETWEEN ? AND ?
      ORDER BY date`,
    [...symbols, start, end],
  );

  const out: CorporateAction[] = [];
  for (const r of rows) {
    const cash = (r.c1 ?? 0) / 10;
    if (cash > 0) out.push({ date: r.date, symbol: r.symbol, kind: 'dividend', cashPerShare: cash });
    const ratio = (r.c3 ?? 0) / 10;
    if (ratio > 0) out.push({ date: r.date, symbol: r.symbol, kind: 'bonus', bonusRatio: ratio });
  }
  return out;
}
