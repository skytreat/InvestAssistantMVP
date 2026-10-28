/**
 * T136（V3.4）标的字典快照 —— SDD_v3 §9.4 / §11.1.4 / Requirements INV-S1-1~7
 *
 * 由行情层 raw_symbol_name **只读**同步而来；pinyin 首字母预计算存储；
 * 联想走业务层快照，不扫行情层（SDD §9.4 硬约束）。
 */
import { ConfigStore } from '../config/configStore.js';
import { queryDuckDB } from '../db/duckdb.js';
import { pinyin } from 'pinyin-pro';

export interface SymbolDictRow {
  symbol: string;
  code6: string;
  name: string;
  pinyin: string;
  market: string;
  class: string;
  asset_class: string;
}

/** 拼音首字母：gzzq（贵州茅台） */
export function toPinyinInitials(name: string): string {
  if (!name) return '';
  try {
    const arr = pinyin(name, { pattern: 'first', type: 'array' }) as string[];
    return arr.join('').toLowerCase();
  } catch {
    return '';
  }
}

/** 从行情层同步标的名字到 symbol_dict（幂等 upsert） */
export async function syncSymbolDict(): Promise<number> {
  const db = ConfigStore.getInstance().db;
  let rows: Array<{ symbol: string; name: string }> = [];
  try {
    rows = await queryDuckDB<{ symbol: string; name: string }>(`SELECT symbol, name FROM raw_symbol_name`);
  } catch {
    return 0;
  }
  const upsert = db.prepare(
    `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, class, asset_class)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       name = excluded.name,
       pinyin = excluded.pinyin,
       market = excluded.market,
       class = excluded.class`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const symbol = r.symbol;
      const code6 = symbol.replace(/^[a-z]+/i, '');
      const market = symbol.slice(0, 2);
      upsert.run(symbol, code6, r.name ?? '', toPinyinInitials(r.name ?? ''), market, 'unknown', 'risk');
      n++;
    }
  });
  tx();
  return n;
}

/** 确保快照非空（空则尝试同步；失败静默）。返回同步后的快照行数。 */
export async function ensureSymbolDict(): Promise<number> {
  const db = ConfigStore.getInstance().db;
  const count = (): number => (db.prepare('SELECT COUNT(*) c FROM symbol_dict').get() as { c: number }).c;
  let cnt = count();
  if (cnt === 0) {
    try {
      await syncSymbolDict();
    } catch {
      /* ignore */
    }
    cnt = count();
  }
  return cnt;
}

/** 联想查询（业务层快照，不扫行情层） */
export function searchSymbolDict(
  db: ReturnType<typeof ConfigStore.getInstance>['db'],
  q: string,
  limit = 20,
): SymbolDictRow[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return [];
  // 裸 6 位 → 自动补前缀：唯一命中直接返回
  if (/^\d{6}$/.test(kw)) {
    const rows = db
      .prepare(
        `SELECT symbol, code6, name, pinyin, market, class, asset_class FROM symbol_dict WHERE code6 = ?`,
      )
      .all(kw) as SymbolDictRow[];
    if (rows.length === 1) return rows;
    if (rows.length > 1) return rows.slice(0, limit);
  }
  const like = `%${kw}%`;
  const rows = db
    .prepare(
      `SELECT symbol, code6, name, pinyin, market, class, asset_class FROM symbol_dict
        WHERE lower(symbol) LIKE ? OR lower(name) LIKE ? OR lower(pinyin) LIKE ?
        ORDER BY symbol LIMIT ?`,
    )
    .all(like, like, like, limit) as SymbolDictRow[];
  return rows;
}
