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

/**
 * 从行情层全量刷新标的名字到 symbol_dict（幂等 upsert）。
 *
 * - 供每日收盘后 cron 调用，也供 admin 手动刷新；
 * - DuckDB 不可读时**抛出**，由调用方记录 ERROR/WARN（不能把失败伪装成 0 行）；
 * - 只 upsert，不删除退市标的，避免历史交易变成孤儿。
 */
export async function syncSymbolDict(): Promise<number> {
  const db = ConfigStore.getInstance().db;
  const rows = await queryDuckDB<{ symbol: string; name: string }>(
    `SELECT symbol, name FROM raw_symbol_name`,
  );
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
  // 🔴 只读：不得在此自动软删 user_trade_record。
  // 字典只覆盖当前 raw_symbol_name，可能缺退市/新上市/裸码/大写码；
  // 自动清理会误删合法历史交易，故改为 admin 手动维护（见下方函数）。
  return cnt;
}

/**
 * 列出「asset_code 不在 symbol_dict 中」的活交易记录，供 admin 手动工具预览。
 * 字典为空时返回 []（无法判定，禁止批量清理）。
 */
export function listOrphanUserTradeRecords(userId?: number): Array<{
  id: number;
  user_id: number;
  asset_code: string;
}> {
  const db = ConfigStore.getInstance().db;
  const dictCount = (db.prepare('SELECT COUNT(*) c FROM symbol_dict').get() as { c: number }).c;
  if (dictCount === 0) return [];
  const userFilter = userId === undefined ? '' : 'AND user_id = ?';
  const stmt = db.prepare(
    `SELECT id, user_id, asset_code FROM user_trade_record
      WHERE is_deleted = 0
        AND asset_code NOT IN (SELECT symbol FROM symbol_dict)
        ${userFilter}
      ORDER BY user_id, id`,
  );
  return (userId === undefined ? stmt.all() : stmt.all(userId)) as Array<{
    id: number;
    user_id: number;
    asset_code: string;
  }>;
}

/**
 * 手动软删 user_trade_record 中**在 symbol_dict 里不存在的标的**对应记录。
 *
 * 🔴 **仅供 admin 手动维护；禁止在请求路径 / cron / ensureSymbolDict 中调用。**
 *    原因：字典只覆盖当前 raw_symbol_name，自动清理会误删退市、新上市、裸码、
 *    大写码等合法历史交易（详见 2026-10-29 审计）。
 *
 * 前提：symbol_dict 非空（否则返回 0，防止空字典误删）。
 * `options.userId` 可限定单用户；不传 = 全用户（admin 全局维护）。
 * 幂等：只 UPDATE `is_deleted = 0` 的行；软删后唯一键释放。
 * 返回被软删的记录数（0 = 无需处理）。软删不物理删除（AGENTS 铁律）。
 */
export function softDeleteOrphanUserTradeRecords(options: { userId?: number } = {}): number {
  const db = ConfigStore.getInstance().db;
  const dictCount = (db.prepare('SELECT COUNT(*) c FROM symbol_dict').get() as { c: number }).c;
  if (dictCount === 0) return 0; // 字典未同步 → 不软删，防止空字典误删
  const userFilter = options.userId === undefined ? '' : 'AND user_id = ?';
  const stmt = db.prepare(
    `UPDATE user_trade_record
        SET is_deleted = 1
      WHERE is_deleted = 0
        AND asset_code NOT IN (SELECT symbol FROM symbol_dict)
        ${userFilter}`,
  );
  const info = options.userId === undefined ? stmt.run() : stmt.run(options.userId);
  return Number(info.changes);
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
