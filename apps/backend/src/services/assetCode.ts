/**
 * 标的代码归一化（跨 broker 导入 / 手工录入 / 校验共用）。
 *
 * 字典权威：先查 symbol_dict 的 code6 → symbol 唯一映射（如 920001 → bj920001；
 * 北交所代码首位同为 9，按首位推断会把 920xxx 错标成 sh）。
 * 字典多命中（同 code6 两市并存）→ 保留裸码不猜。
 * 字典未命中才走启发式兜底（兜底规则按 raw_symbol_name 实测分布修正）。
 */
import type Database from 'better-sqlite3';

/** code6 → symbol 唯一映射（同 code6 出现多个 symbol ⇒ 值置 null = 歧义，不猜）。 */
export function buildCode6Dict(db: Database.Database): Map<string, string | null> {
  const dict = new Map<string, string | null>();
  try {
    const rows = db.prepare(`SELECT code6, symbol FROM symbol_dict`).all() as Array<{
      code6: string;
      symbol: string;
    }>;
    for (const r of rows) {
      const prev = dict.get(r.code6);
      dict.set(r.code6, prev === undefined ? r.symbol : null);
    }
  } catch {
    /* symbol_dict 不可用（理论不会：ConfigStore 保证 DDL）→ 启发式兜底 */
  }
  return dict;
}

export function normalizeAssetCode(
  raw: string | null,
  code6Dict?: Map<string, string | null>,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 已有前缀（sh/sz/bj 开头 + 6 位数字）→ 原样
  if (/^(sh|sz|bj)\d{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  // 纯 6 位数字 → 字典权威，未命中再按首位启发式
  if (/^\d{6}$/.test(trimmed)) {
    const hit = code6Dict?.get(trimmed);
    if (hit) return hit; // 字典唯一命中 → 直接采用
    if (hit === null) return trimmed; // 字典歧义（同 code6 多市场）→ 不猜
    const first = trimmed[0];
    // 启发式兜底（依据 raw_symbol_name 实测分布 2026-10-28，2026-10-29 修正 204xxx）：
    //   d1=9：92xxxx=北交所（354 只）、900xxx=沪 B（41 只）⇒ 按 d2 区分；
    //   d1=2：204xxx=上交所逆回购（GC001/GC002/...），其余 2xxxxx=深市；
    //   d1=1：15/16/18=深基金（1170 行）、10/11=沪转债/基金、12/13=深转债；
    //         14/17/19 无数据 ⇒ 不猜
    if (first === '6' || first === '5' || first === '7') return `sh${trimmed}`;
    if (first === '0' || first === '3') return `sz${trimmed}`;
    // 204xxx = 上交所国债逆回购（GC001/GC002/...），不是深市
    if (first === '2') return trimmed.startsWith('204') ? `sh${trimmed}` : `sz${trimmed}`;
    if (first === '4' || first === '8') return `bj${trimmed}`;
    if (first === '9') return trimmed[1] === '2' ? `bj${trimmed}` : `sh${trimmed}`;
    if (first === '1') {
      const second = trimmed[1];
      if (second === '0' || second === '1') return `sh${trimmed}`;
      if (second === '2' || second === '3' || second === '5' || second === '6' || second === '8')
        return `sz${trimmed}`;
      return trimmed; // 14/17/19 未知段 → 原样
    }
    return trimmed; // 未知前缀，原样返回
  }
  // 其他格式（含字母、短码等）原样返回
  return trimmed;
}
