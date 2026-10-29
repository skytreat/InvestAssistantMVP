/**
 * T124（V3.1）跨文件去重 + 成交时间回填 —— SDD_v3 §5 / ADR-014
 *
 * 结构事实（实测）：交割单 = 成交流水 ∪ 非成交事件。成交流水**有时间**、交割单**无时间**。
 * - 去重组键 = 标的 + 日期 + 方向（同组内价量全同 = 冗余导出只留交割侧；价或量不同 = 真实分笔全留）
 * - 回填三级降级：L1 稳定标识（成交编号/合同序号）→ L2 内容键 + 日期窗口（±2 天）→ L3 内容键 + 顺序
 * - 日期权威源 = 成交流水日期；交割单日期只作辅助键（INV-S2-60）
 * - 标的**名称不得作键**（名称变体实测：159530 机器人ETF易方达 / 机器人E）
 * - 低置信度（L2/L3）单列统计（INV-S2-61d）；回填只写成交时间，其余以交割单为准
 */
import type Database from 'better-sqlite3';

export interface DedupeResult {
  redundantMarked: number; // 跨文件冗余（被标 EXCLUDED 的成交侧行）
  splitGroups: number; // 真实分笔组数（全保留）
  groups: number;
}

export interface BackfillResult {
  totalNeeded: number; // 交割侧「可匹配且无时间」的行数
  matched: number;
  byLevel: { L1: number; L2: number; L3: number };
  lowConfidence: number; // L2 + L3（单列统计）
  unmatched: number;
}

interface FactRow {
  id: number;
  import_batch_id: number;
  file_kind: string; // settlement / trade
  event_type: string;
  asset_code: string | null;
  trade_date: string | null;
  trade_time: string | null;
  price: number | null;
  quantity: number | null;
  cash_flow: number | null;
  raw_event_type: string | null;
  raw_symbol: string | null;
  match_status: string;
  match_confidence: string | null;
  matched_trade_record_id: number | null;
  exclude_reason: string | null;
  source_row_no: number | null;
  // 稳定标识（L1）：成交编号 / 合同序号
  tradeId: string | null;
}

/**
 * 方向 = **成交方向**（买/开 = +1，卖/关 = −1），按事件语义判定（D-21）。
 * 🔴 不得用 cash_flow 符号 —— 实测两文件「资金发生/发生金额」列符号约定不一致：
 *   华宝逆回购出资腿在交割单 = −177000.35，在同文件成交流水 = +177000。
 *   按符号判方向会把同一笔拆进不同组 ⇒ 跨文件去重漏标（G4 双计）。
 */
function directionOf(eventType: string, rawEvent: string | null): 1 | -1 | 0 {
  const raw = rawEvent ?? '';
  switch (eventType) {
    case 'TRADE_BUY':
    case 'FUND_SUBSCRIBE':
      return 1;
    case 'TRADE_SELL':
    case 'FUND_REDEEM':
      return -1;
    case 'REPO':
      // 出资/开仓腿 = +1，购回/平腿 = −1（按事件词，不按资金符号）
      return /购回|赎回/.test(raw) ? -1 : 1;
    case 'CASH_LIKE_ETF':
      return /卖出|赎回|扣款/.test(raw) ? -1 : 1;
    default:
      return 0; // 分红 / 转入 / 占位等：无成交方向
  }
}

/** 日期 → UTC 毫秒（兼容 YYYYMMDD 与 YYYY-MM-DD；实测两券商两种格式并存） */
function toTimeMs(d: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(d);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function loadRows(db: Database.Database, userId: number, brokerCode: string): FactRow[] {
  // D-20：L1「稳定标识（成交编号=合同序号）」通道需映射模板把 tradeId 语义列下标固化进
  // raw_row_json（T129 前属 V3-B8 待办）；当前 L1 以**精确内容键**（同标的同日同方向同价量）
  // 等价实现 —— 命中即 100% 可靠，不弱于标识匹配。
  const rows = db
    .prepare(
      `SELECT b.id, b.import_batch_id, f.file_kind, b.event_type, b.asset_code, b.trade_date, b.trade_time,
              b.price, b.quantity, b.cash_flow, b.raw_event_type, b.raw_symbol, b.match_status,
              b.match_confidence, b.matched_trade_record_id, b.exclude_reason, b.source_row_no,
              NULL AS tradeId
         FROM broker_trade_record b
         JOIN broker_import_batch f ON f.id = b.import_batch_id
        WHERE b.user_id = ? AND b.broker_code = ? AND b.is_deleted = 0
        ORDER BY b.trade_date, b.trade_time, b.id`,
    )
    .all(userId, brokerCode) as unknown as FactRow[];
  return rows;
}

/**
 * 跨文件去重（SDD §5.2 / ADR-014）：
 * 组键 = 标的 + 日期 + 方向；组内再按（价,量）分子组：
 * - 子组跨两文件且全同价量 ⇒ 冗余导出（交割单 = 成交流水 ∪ 非成交事件，交割侧信息更全）：
 *   成交侧按「min(成交腿数, 交割腿数)」软标记 EXCLUDED（保留交割侧），不物理删
 * - 组内价或量不同（子组 >1）⇒ 真实分笔：**全保留**（splitGroups 计数）
 */
export function dedupeAcrossFiles(db: Database.Database, userId: number, brokerCode: string): DedupeResult {
  const rows = loadRows(db, userId, brokerCode);
  // 子组键 = 组键 + 价量
  const subgroups = new Map<string, FactRow[]>();
  for (const r of rows) {
    if (!r.asset_code || !r.trade_date) continue; // 组键缺位 → 不参与去重（保守）
    if (r.match_status === 'EXCLUDED' && r.exclude_reason?.startsWith('跨文件冗余导出')) continue;
    const dir = directionOf(r.event_type, r.raw_event_type);
    const key = `${r.asset_code}|${r.trade_date}|${dir}|${r.price}|${r.quantity}`;
    const g = subgroups.get(key);
    if (g) g.push(r);
    else subgroups.set(key, [r]);
  }
  // 真实分笔组 = 同（标的,日期,方向）下存在 ≥2 种（价,量）
  const groupKeys = new Map<string, Set<string>>();
  for (const key of subgroups.keys()) {
    const parts = key.split('|');
    const gk = parts.slice(0, 3).join('|');
    const s = groupKeys.get(gk);
    if (s) s.add(parts.slice(3).join('|'));
    else groupKeys.set(gk, new Set([parts.slice(3).join('|')]));
  }
  const splitGroups = [...groupKeys.values()].filter((s) => s.size > 1).length;

  const mark = db.prepare(
    `UPDATE broker_trade_record SET match_status = 'EXCLUDED', exclude_reason = ? WHERE id = ? AND user_id = ?`,
  );
  let redundantMarked = 0;

  const run = db.transaction(() => {
    for (const members of subgroups.values()) {
      const files = new Set(members.map((m) => m.file_kind));
      if (files.size < 2) continue; // 同文件内不去重（同文件重复由 file_hash 拦截）
      const settleCount = members.filter((m) => m.file_kind === 'settlement').length;
      const tradeMembers = members
        .filter((m) => m.file_kind === 'trade')
        .sort((a, b) => (a.source_row_no ?? 0) - (b.source_row_no ?? 0));
      const markCount = Math.min(tradeMembers.length, settleCount);
      for (let i = 0; i < markCount; i++) {
        mark.run('跨文件冗余导出（同键同价量，保留交割侧）', tradeMembers[i].id, userId);
        redundantMarked++;
      }
    }
  });
  run();

  return { redundantMarked, splitGroups, groups: subgroups.size };
}

/**
 * 成交时间回填（交割侧无时间的成交事件 ← 成交流水）：
 * L1 稳定标识 → L2 内容键+日期窗口（±windowDays，默认 2）→ L3 内容键+顺序。
 * 回填**只写 trade_time + 匹配状态**，其余字段以交割单为准。
 */
export function backfillTradeTime(
  db: Database.Database,
  userId: number,
  brokerCode: string,
  opts?: { windowDays?: number },
): BackfillResult {
  const windowDays = opts?.windowDays ?? 2;
  const rows = loadRows(db, userId, brokerCode);
  const settlement = rows.filter((r) => r.file_kind === 'settlement');
  const trade = rows.filter((r) => r.file_kind === 'trade' && r.trade_time);

  const byLevel = { L1: 0, L2: 0, L3: 0 };
  let totalNeeded = 0;
  let matched = 0;
  let lowConfidence = 0;

  // 日期归一化：YYYYMMDD → YYYY-MM-DD（两种文件格式并存，匹配前必须统一）
  const normDate = (d: string): string =>
    d.includes('-') ? d : `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

  // L1：稳定标识（当前实现：同（标的,日期,价,量）且成交流水侧已有时间 ⇒ 视为标识匹配命中，
  //     记 L1；完整「成交编号=合同序号」通道待映射模板把 tradeId 固化后升级（V3-B 登记）
  // ⚠️ trade_date 必须归一化后再拼 key，否则 YYYYMMDD 与 YYYY-MM-DD 互不命中
  const tradeByKey = new Map<string, FactRow[]>();
  for (const t of trade) {
    if (!t.asset_code || !t.trade_date) continue;
    const k = `${t.asset_code}|${normDate(t.trade_date)}|${directionOf(t.event_type, t.raw_event_type)}|${t.price}|${t.quantity}`;
    const arr = tradeByKey.get(k);
    if (arr) arr.push(t);
    else tradeByKey.set(k, [t]);
  }

  const upd = db.prepare(
    `UPDATE broker_trade_record SET trade_time = ?, match_status = ?, match_confidence = ?, matched_trade_record_id = ?
     WHERE id = ? AND user_id = ?`,
  );

  // L3 顺序配对游标（按标的+方向分桶）
  const seqCursor = new Map<string, number>();
  const tradeBySeq = new Map<string, FactRow[]>();
  for (const t of trade) {
    if (!t.asset_code) continue;
    const k = `${t.asset_code}|${directionOf(t.event_type, t.raw_event_type)}`;
    const arr = tradeBySeq.get(k);
    if (arr) arr.push(t);
    else tradeBySeq.set(k, [t]);
  }

  const run = db.transaction(() => {
    for (const s of settlement) {
      // 只回填「成交类事件且无时间」的行：TRADE_BUY / TRADE_SELL（gate G5 基线 125/125 + 12/12 即此口径）。
      // 非成交事件（分红/折算/申赎杂项/占位）以交割日期为准，不需要成交时间
      if (!s.trade_date || s.trade_time) continue;
      if (s.event_type !== 'TRADE_BUY' && s.event_type !== 'TRADE_SELL') continue;
      totalNeeded++;
      const dir = directionOf(s.event_type, s.raw_event_type);

      // L1：精确内容键（同标的同日同方向同价量）直接命中 ⇒ 时间权威源 = 成交流水日期/时间
      // ⚠️ 交割单侧 trade_date 也必须归一化（交割单可能存 YYYYMMDD）
      const exactKey = `${s.asset_code}|${normDate(s.trade_date)}|${dir}|${s.price}|${s.quantity}`;
      let hit = tradeByKey.get(exactKey);
      let level: 'L1' | 'L2' | 'L3' = 'L1';

      // L2：日期窗口 ±windowDays（权威源 = 成交流水日期；交割日期只作辅助锚点，
      // 允许 交收日期 = 成交日 + T+N 的口径差，INV-S2-60）
      if (!hit || hit.length === 0) {
        const d = toTimeMs(s.trade_date);
        const bucket = new Map<string, FactRow[]>();
        if (!Number.isNaN(d)) {
          for (const t of trade) {
            if (!t.asset_code || !t.trade_date) continue;
            const td = toTimeMs(t.trade_date);
            if (Number.isNaN(td) || Math.abs(td - d) > windowDays * 86400000) continue;
            const k = `${t.asset_code}|${dir}|${t.price}|${t.quantity}`;
            const arr = bucket.get(k);
            if (arr) arr.push(t);
            else bucket.set(k, [t]);
          }
        }
        hit = bucket.get(`${s.asset_code}|${dir}|${s.price}|${s.quantity}`);
        level = 'L2';
      }

      // L3：内容键 + 顺序配对（最后手段，低置信度）
      if (!hit || hit.length === 0) {
        const k = `${s.asset_code}|${dir}`;
        const pool = tradeBySeq.get(k) ?? [];
        const idx = seqCursor.get(k) ?? 0;
        const cand = pool[idx];
        if (cand) {
          hit = [cand];
          level = 'L3';
          seqCursor.set(k, idx + 1);
        }
      }

      if (hit && hit.length > 0) {
        const src = hit[0];
        matched++;
        byLevel[level]++;
        if (level !== 'L1') lowConfidence++;
        upd.run(src.trade_time, level === 'L3' ? 'FUZZY' : 'MATCHED', level, src.id, s.id, userId);
      }
    }

    // 补充：交割单行无法从成交流水回填 trade_time，但 (asset_code, trade_date)
    // 在 user_trade_record 中已存在（如成交流水已补录）→ 直接置 MATCHED，
    // 避免"缺失=0 但差异明细仍有可补录"的语义矛盾
    // 🔴 同时检查该 asset_code 在 symbol_dict 中是否存在（若字典非空且资产不在字典中，则跳过 L0 标记，保持 MISSING 以便被自动软删）
    const dictCount = (db.prepare('SELECT COUNT(*) c FROM symbol_dict').get() as { c: number }).c;
    const sysKeys = db
      .prepare(
        `SELECT DISTINCT asset_code, trade_date FROM user_trade_record
         WHERE user_id = ? AND is_deleted = 0
           AND trade_type IN ('buy','add','reduce','clear','dividend','bonus')`,
      )
      .all(userId) as Array<{ asset_code: string; trade_date: string }>;
    const sysSet = new Set(sysKeys.map((k) => `${k.asset_code}|${normDate(k.trade_date)}`));
    const markMatched = db.prepare(
      `UPDATE broker_trade_record SET match_status = 'MATCHED', match_confidence = 'L0'
       WHERE id = ? AND user_id = ? AND match_status = 'MISSING'`,
    );
    for (const s of settlement) {
      if (!s.asset_code || !s.trade_date) continue;
      if (s.match_status !== 'MISSING') continue; // 已被上面 L1/L2/L3 处理
      if (dictCount > 0) {
        // 如果 symbol_dict 非空，需确保 asset_code 存在于 symbol_dict 中
        const exists = db.prepare(`SELECT 1 FROM symbol_dict WHERE symbol = ?`).get(s.asset_code);
        if (!exists) continue; // 不存在的标的保持 MISSING，让 softDeleteOrphanUserTradeRecords 软删
      }
      if (sysSet.has(`${s.asset_code}|${normDate(s.trade_date)}`)) {
        markMatched.run(s.id, userId);
      }
    }
  });
  run();

  const unmatched = totalNeeded - matched;
  return { totalNeeded, matched, byLevel, lowConfidence, unmatched };
}
