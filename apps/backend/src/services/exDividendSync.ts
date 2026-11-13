// src/services/exDividendSync.ts
// T20: 除权自动导入（SDD §5.8）
// Fastify cron 17:03 触发，从 DuckDB raw_gbbq 取除权事件，
// 遍历用户持仓，自动生成 dividend/bonus 交易记录
import Database from 'better-sqlite3';
import { queryDuckDB } from '../db/duckdb.js';
import { ConfigStore } from '../config/configStore.js';
import { writeSystemLog } from './logger.js';

export interface DividendEvent {
  symbol: string;
  exDate: string; // 除权除息日 YYYY-MM-DD
  cashPerShare: number; // 每股分红 = c1/10
  stockRatio: number; // 每股送转 = c3/10
}

export interface ImportResult {
  symbol: string; // 空串（结果级别不针对单个 symbol，留空）
  eventsProcessed: number; // 实际处理了多少条除权事件
  holdingsSkipped: number; // 多少用户因为持仓=0 跳过
  duplicatesSkipped: number; // 多少条因已有活记录（±3 天窗口）或 UNIQUE 约束跳过（幂等）
  importedDividend: number; // 实际 INSERT 的 dividend 条数
  importedBonus: number; // 实际 INSERT 的 bonus 条数
  errors: number; // 总错误数
}

/**
 * 从 DuckDB raw_gbbq 取某天的除权事件
 * category=1（除权除息），c1/10=每股分红，c3/10=每股送转
 */
export async function fetchDividendEvents(exDate: string): Promise<DividendEvent[]> {
  const rows = await queryDuckDB<{ symbol: string; c1: number; c3: number }>(
    `SELECT symbol, c1, c3 FROM raw_gbbq
     WHERE date = ? AND category = 1
       AND (c1 != 0 OR c3 != 0)`,
    [exDate],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    exDate,
    cashPerShare: Number(r.c1) / 10,
    stockRatio: Number(r.c3) / 10,
  }));
}

/**
 * 获取用户在除权日之前的持仓股数
 * 计算口径：
 *   增加类型：buy / add / bonus → +quantity
 *   减少类型：reduce / clear → -quantity
 *   dividend 不影响持仓；transfer（转入）理论上应计入基数，但本 CASE 未纳入。
 *   ⚠️ 已知限制（owner 2026-11-06 裁决「另案处理」，本轮不改逻辑）：实测真实库 4 条
 *   transfer 的标的自 2026-01-01 起无 raw_gbbq category=1 除权事件 ⇒ 量化影响 0 股/0 元。
 *   如需纳入基数，须另开任务并同步 PRD/SDD 口径，勿顺手修改此处。
 * trade_date < exDate 保证只用除权日前的交易记录
 *
 * T119 口径对齐（SDD_v3 §8.5）：本 SQL 的「bonus → +quantity」与 core
 * `calculateMovingWeightedCost` 的 bonus 分支（股数 +n、成本基不变）**净效果一致**，
 * 两处不再相反 —— 上层 mapToCoreTrade 已把 bonus/dividend 映射进 core。
 * 此处的 CASE 是「除权前股数基数」的独立快路径（只取净股数，不算成本），
 * 保留 SQL 形式（O(1) 聚合），语义跟随 T119；SDD_v3 §8.5 原文「删除该分支」
 * 系按 T119 前的假设状态撰写，见 docs/audit/v3-pending-decisions.md D-11。
 */
export function getHoldingBeforeDate(
  db: Database.Database,
  userId: number,
  symbol: string,
  exDate: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
        WHEN trade_type IN ('buy','add','bonus') THEN quantity
        WHEN trade_type IN ('reduce','clear') THEN -quantity
        ELSE 0
      END), 0) AS holding
     FROM user_trade_record
     WHERE user_id = ? AND asset_code = ? AND trade_date < ? AND is_deleted = 0`,
    )
    .get(userId, symbol, exDate) as { holding: number };
  return row?.holding ?? 0;
}

/**
 * 执行除权自动导入（Fastify cron 17:03 调用）
 *
 * 主流程：
 * 1. fetchDividendEvents(exDate) — 拿当天所有除权事件
 * 2. 空 → 写 system_log level='SKIP' reason='无除权事件' → 返回空结果
 * 3. 遍历每个 event：
 *    a. 找有过该标的交易的用户（user_trade_record WHERE asset_code=? AND is_deleted=0，ADR-028：不再读 hold 派生）
 *    b. 对每个用户：getHoldingBeforeDate(db, userId, symbol, exDate)
 *    c. 持仓=0 → holdingsSkipped++，continue
 *    d. cashPerShare > 0 → INSERT dividend（UNIQUE 冲突 → duplicatesSkipped++）
 *    e. stockRatio > 0 → INSERT bonus（UNIQUE 冲突 → duplicatesSkipped++）
 * 4. 所有 INSERT 在一个 db.transaction 闭包里（better-sqlite3 同步，内部无 await）
 * 5. 写 system_log level='SUCCESS' / 'WARN'（有 errors）
 *
 * 异常处理：整个 importDividendEvents 包 try-catch → 写 system_log level='ERROR'
 */
export async function importDividendEvents(exDate?: string): Promise<ImportResult> {
  const date = exDate ?? new Date().toISOString().slice(0, 10);
  const result: ImportResult = {
    symbol: '',
    eventsProcessed: 0,
    holdingsSkipped: 0,
    duplicatesSkipped: 0,
    importedDividend: 0,
    importedBonus: 0,
    errors: 0,
  };

  try {
    // 1. 从 DuckDB 拿当天除权事件
    const events = await fetchDividendEvents(date);

    // 2. 空 → SKIP
    if (events.length === 0) {
      writeSystemLog({
        logType: 'dividend_import',
        level: 'SKIP',
        logDate: date,
        message: '无除权事件',
      });
      return result;
    }

    const config = ConfigStore.getInstance();
    const db = config.db;

    // 3-4. 主流程 + 事务（better-sqlite3 同步事务，内部无 await）
    // T87：trade_time 必填。除权事件是「按日」的批量导入，同日同一标的只应有一条，
    // 因此统一用固定值 '00:00:00' —— 依赖 UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time)
    // 保证同一天重复导入被忽略（INSERT OR IGNORE），与既有防重语义一致。
    const insertDividendStmt = db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
  (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
  trade_reason, is_auto_import, is_deleted)
  VALUES (?, ?, 'dividend', ?, '00:00:00', ?, ?, 0, ?, 1, 0)`,
    );

    const insertBonusStmt = db.prepare(
      `INSERT OR IGNORE INTO user_trade_record
  (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
  trade_reason, is_auto_import, is_deleted)
  VALUES (?, ?, 'bonus', ?, '00:00:00', ?, 0, 0, ?, 1, 0)`,
    );

    // 防重复计账（owner 口径：手动优先，±3 天窗口）
    // 背景：手动补录行 broker_code 非空、自动行 broker_code 为空，而两条部分唯一索引
    //   A（broker_code IS NULL）与 C（broker_code IS NOT NULL）的 WHERE 互斥，
    //   同一事件（同 user + 标的 + 类型）可各落一行 ⇒ 股数/分红重复计账。
    // 本条只做「插入前预检」：窗口内已有活记录（不论 broker_code）即跳过，绝不改动既有行。
    // 窗口取 ±3 天（含端点）：手动行 trade_date 取自券商事实表，实测与 raw_gbbq 除权日
    //   偏移 −1~+2 天（如 sh512400 09-11 vs 09-09，sz002837 05-29 vs 06-01），
    //   故以除权日为中心取 ±3 天覆盖全部实测偏移并留余量；精确同日是它的子集，统一走窗口。
    const findExistingStmt = db.prepare(
      `SELECT id, trade_date, broker_code FROM user_trade_record
        WHERE user_id = ? AND asset_code = ? AND trade_type = ? AND is_deleted = 0
          AND ABS(julianday(trade_date) - julianday(?)) <= 3
        ORDER BY ABS(julianday(trade_date) - julianday(?)) ASC, trade_date DESC
        LIMIT 1`,
    );

    // 命中明细进 system_log.detail，便于事后审计「除权日 / 命中人工行日期 / 偏移天数」
    const dedupeHits: Array<{
      assetCode: string;
      tradeType: 'dividend' | 'bonus';
      exDate: string;
      matchedDate: string;
      offsetDays: number;
      brokerCode: string | null;
    }> = [];
    const findExisting = (
      userId: number,
      symbol: string,
      type: 'dividend' | 'bonus',
      exDate: string,
    ): { id: number; trade_date: string; broker_code: string | null } | null => {
      const hit = findExistingStmt.get(userId, symbol, type, exDate, exDate) as
        { id: number; trade_date: string; broker_code: string | null } | undefined;
      if (!hit) return null;
      const offsetDays = Math.round((Date.parse(hit.trade_date) - Date.parse(exDate)) / 86400000);
      dedupeHits.push({
        assetCode: symbol,
        tradeType: type,
        exDate,
        matchedDate: hit.trade_date,
        offsetDays,
        brokerCode: hit.broker_code,
      });
      return hit;
    };

    const runImport = db.transaction((evtList: DividendEvent[]) => {
      for (const evt of evtList) {
        result.eventsProcessed++;

        // a. 找有过该标的交易的用户（直接由 user_trade_record 决定）
        const tradeUsers = db
          .prepare(
            `SELECT DISTINCT user_id FROM user_trade_record
             WHERE asset_code = ? AND is_deleted = 0`,
          )
          .all(evt.symbol) as Array<{ user_id: number }>;
        const userIds = new Set<number>();
        for (const u of tradeUsers) userIds.add(u.user_id);

        for (const userId of userIds) {
          // b. 计算持仓
          const holding = getHoldingBeforeDate(db, userId, evt.symbol, evt.exDate);

          // c. 持仓=0 → 跳过
          if (holding <= 0) {
            result.holdingsSkipped++;
            continue;
          }

          // d. 分红（手动优先：±3 天窗口内已有活记录 → 跳过）
          if (evt.cashPerShare > 0) {
            if (findExisting(userId, evt.symbol, 'dividend', evt.exDate)) {
              result.duplicatesSkipped++;
            } else {
              const info = insertDividendStmt.run(
                userId,
                evt.symbol,
                evt.exDate,
                holding,
                evt.cashPerShare,
                `自动导入-分红-${evt.exDate}`,
              );
              if (info.changes === 0) {
                result.duplicatesSkipped++;
              } else {
                result.importedDividend++;
              }
            }
          }

          // e. 送转（手动优先：±3 天窗口内已有活记录 → 跳过）
          if (evt.stockRatio > 0) {
            const bonusQty = holding * evt.stockRatio;
            if (findExisting(userId, evt.symbol, 'bonus', evt.exDate)) {
              result.duplicatesSkipped++;
            } else {
              // 送转股数取整（A股送转都是整数），但保留小数让 CHECK 约束判断
              const info = insertBonusStmt.run(
                userId,
                evt.symbol,
                evt.exDate,
                bonusQty,
                `自动导入-送转-${evt.exDate}`,
              );
              if (info.changes === 0) {
                result.duplicatesSkipped++;
              } else {
                result.importedBonus++;
              }
            }
          }
        }
      }
    });

    runImport(events);

    // 5. 写完成日志
    const hasErrors = result.errors > 0;
    const level = hasErrors ? 'WARN' : 'SUCCESS';
    const detail = JSON.stringify({ ...result, dedupeHits });
    // 跳过量进日志正文，便于事后核对「手动优先」是否生效（detail 里也有结构化数字）
    const dupMsg = result.duplicatesSkipped > 0 ? `，跳过 ${result.duplicatesSkipped} 条已存在` : '';

    writeSystemLog({
      logType: 'dividend_import',
      level,
      logDate: date,
      message: hasErrors ? `除权导入完成（有 ${result.errors} 个错误${dupMsg}）` : `除权导入完成${dupMsg}`,
      detail,
    });

    return result;
  } catch (err) {
    result.errors++;

    writeSystemLog({
      logType: 'dividend_import',
      level: 'ERROR',
      logDate: date,
      message: '除权导入异常',
      detail: String(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err),
    });

    return result;
  }
}
