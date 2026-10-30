/**
 * T136（V3.4）标的字典快照 —— SDD_v3 §9.4 / §11.1.4 / Requirements INV-S1-1~7
 *
 * 由行情层 **raw_symbol_name** 只读同步而来；pinyin 首字母预计算存储；
 * 联想走业务层快照，不扫行情层（SDD §9.4 硬约束）。
 *
 * 定位（2026-10-29 收窄）：字典只做**名称联想搜索 + code6 歧义消解**。
 * 存在性判定源 = DuckDB raw_symbol_class（100% 覆盖 raw_kline_daily）；
 * 孤儿判定也走 raw_symbol_class（见 listOrphanUserTradeRecords）。
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
 * - 源 = raw_symbol_name（有名称的标的）；
 * - 供每日收盘后 cron 调用，也供 admin 手动刷新；
 * - DuckDB 不可读时**抛出**，由调用方记录 ERROR/WARN（不能把失败伪装成 0 行）；
 * - 只 upsert，不删除退市标的，避免历史交易变成孤儿。
 */
export async function syncSymbolDict(): Promise<number> {
  const db = ConfigStore.getInstance().db;
  const rows = await queryDuckDB<{ symbol: string; name: string | null }>(
    `SELECT symbol, name FROM raw_symbol_name`,
  );
  const upsert = db.prepare(
    `INSERT INTO symbol_dict (symbol, code6, name, pinyin, market, asset_class)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       name = excluded.name,
       pinyin = excluded.pinyin,
       market = excluded.market`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const symbol = r.symbol;
      const code6 = symbol.replace(/^[a-z]+/i, '');
      const market = symbol.slice(0, 2);
      const name = r.name ?? '';
      upsert.run(symbol, code6, name, toPinyinInitials(name), market, 'risk');
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
  // 字典只覆盖 raw_symbol_name（有名称的标的）；
  // 自动清理会误删退市、新上市、裸码、大写码等合法历史交易，
  // 故改为 admin 手动维护（见下方函数，判定源 = raw_symbol_class）。
  return cnt;
}

/**
 * 强制全量刷新标的字典：先清表再同步。
 * 用于部署后手动补刷（ensureSymbolDict 只在表为空时才懒加载，非空时不重拉）。
 */
export async function forceRefreshSymbolDict(): Promise<number> {
  const db = ConfigStore.getInstance().db;
  db.prepare('DELETE FROM symbol_dict').run();
  return syncSymbolDict();
}

/**
 * 行情层「已知标的」全集（raw_symbol_class，排除 block；覆盖 raw_kline_daily 全部标的）。
 * 行情库不可读时返回 null（调用方据此保持「无法判定 → 禁止批量清理」语义）。
 */
export async function loadMarketSymbols(): Promise<Set<string> | null> {
  try {
    const rows = await queryDuckDB<{ symbol: string }>(
      `SELECT symbol FROM raw_symbol_class WHERE class <> 'block'`,
    );
    return new Set(rows.map((r) => r.symbol));
  } catch {
    return null;
  }
}

/**
 * 列出「asset_code 不在行情层 raw_symbol_class 中」的活交易记录，供 admin 手动工具预览。
 * 行情库不可读（无法判定）或无数据时返回 []（禁止批量清理）。
 */
export async function listOrphanUserTradeRecords(
  userId?: number,
): Promise<Array<{ id: number; user_id: number; asset_code: string }>> {
  const marketSymbols = await loadMarketSymbols();
  if (marketSymbols === null || marketSymbols.size === 0) return [];
  const db = ConfigStore.getInstance().db;
  const userFilter = userId === undefined ? '' : 'AND user_id = ?';
  const stmt = db.prepare(
    `SELECT id, user_id, asset_code FROM user_trade_record
      WHERE is_deleted = 0
        ${userFilter}
      ORDER BY user_id, id`,
  );
  const rows = (userId === undefined ? stmt.all() : stmt.all(userId)) as Array<{
    id: number;
    user_id: number;
    asset_code: string;
  }>;
  return rows.filter((r) => r.asset_code && !marketSymbols.has(r.asset_code));
}

/**
 * 手动软删 user_trade_record 中**在行情层 raw_symbol_class 里不存在的标的**对应记录。
 *
 * 🔴 **仅供 admin 手动维护；禁止在请求路径 / cron / ensureSymbolDict 中调用。**
 *    原因：raw_symbol_class 只覆盖当前市场的可交易证券；
 *    退市、新上市、裸码、大写码等合法历史交易不在其中，
 *    故软删必须由 admin 人工判定（详见 2026-10-29 审计）。
 *
 * 前提：行情库可读且 raw_symbol_class 非空（否则返回 0，防止误删）。
 * `options.userId` 可限定单用户；不传 = 全用户（admin 全局维护）。
 * 幂等：只 UPDATE `is_deleted = 0` 的行；软删后唯一键释放。
 * 返回被软删的记录数（0 = 无需处理 / 无法判定）。软删不物理删除（AGENTS 铁律）。
 */
export async function softDeleteOrphanUserTradeRecords(options: { userId?: number } = {}): Promise<number> {
  const marketSymbols = await loadMarketSymbols();
  if (marketSymbols === null || marketSymbols.size === 0) return 0;
  const db = ConfigStore.getInstance().db;
  const userFilter = options.userId === undefined ? '' : 'AND user_id = ?';
  const stmt = db.prepare(`SELECT id, asset_code FROM user_trade_record WHERE is_deleted = 0 ${userFilter}`);
  const rows = (options.userId === undefined ? stmt.all() : stmt.all(options.userId)) as Array<{
    id: number;
    asset_code: string | null;
  }>;
  // 逐行过滤：只软删「asset_code 不在行情层」的行，合法标的不受影响
  const targetIds = rows.filter((r) => r.asset_code && !marketSymbols.has(r.asset_code)).map((r) => r.id);
  if (targetIds.length === 0) return 0;
  // 分批 IN 更新（better-sqlite3 单语句参数上限保护）
  const BATCH = 500;
  let changed = 0;
  for (let i = 0; i < targetIds.length; i += BATCH) {
    const chunk = targetIds.slice(i, i + BATCH);
    const update = db.prepare(
      `UPDATE user_trade_record SET is_deleted = 1 WHERE id IN (${chunk.map(() => '?').join(',')})`,
    );
    changed += Number(update.run(...chunk).changes);
  }
  return changed;
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
      .prepare(`SELECT symbol, code6, name, pinyin, market, asset_class FROM symbol_dict WHERE code6 = ?`)
      .all(kw) as SymbolDictRow[];
    if (rows.length === 1) return rows;
    if (rows.length > 1) return rows.slice(0, limit);
  }
  const like = `%${kw}%`;
  const rows = db
    .prepare(
      `SELECT symbol, code6, name, pinyin, market, asset_class FROM symbol_dict
        WHERE lower(symbol) LIKE ? OR lower(name) LIKE ? OR lower(pinyin) LIKE ?
        ORDER BY symbol LIMIT ?`,
    )
    .all(like, like, like, limit) as SymbolDictRow[];
  return rows;
}
