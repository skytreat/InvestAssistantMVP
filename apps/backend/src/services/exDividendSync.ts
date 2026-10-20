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
  duplicatesSkipped: number; // 多少条因为 UNIQUE 约束跳过（幂等）
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
 *   dividend / transfer 不影响持仓（分红不增股，转股需要独立处理，这里按简化规则）
 * trade_date < exDate 保证只用除权日前的交易记录
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
 *    a. 找持有该标的的用户（user_asset_rel WHERE asset_code=? AND rel_type='hold' AND is_deleted=0）
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

    const runImport = db.transaction((evtList: DividendEvent[]) => {
      for (const evt of evtList) {
        result.eventsProcessed++;

        // a. 找持有该标的的用户
        const holders = db
          .prepare(
            `SELECT DISTINCT user_id FROM user_asset_rel
           WHERE asset_code = ? AND rel_type = 'hold' AND is_deleted = 0`,
          )
          .all(evt.symbol) as Array<{ user_id: number }>;

        // 如果没有任何用户持有关联记录，仍然尝试扫描所有 user_trade_record 中有过该标的交易的用户
        // （防御性：user_asset_rel 可能与 trade_record 不一致）
        const userIds = new Set<number>();
        for (const h of holders) userIds.add(h.user_id);

        if (userIds.size === 0) {
          const tradeUsers = db
            .prepare(
              `SELECT DISTINCT user_id FROM user_trade_record
             WHERE asset_code = ? AND is_deleted = 0`,
            )
            .all(evt.symbol) as Array<{ user_id: number }>;
          for (const u of tradeUsers) userIds.add(u.user_id);
        }

        for (const userId of userIds) {
          // b. 计算持仓
          const holding = getHoldingBeforeDate(db, userId, evt.symbol, evt.exDate);

          // c. 持仓=0 → 跳过
          if (holding <= 0) {
            result.holdingsSkipped++;
            continue;
          }

          // d. 分红
          if (evt.cashPerShare > 0) {
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

          // e. 送转
          if (evt.stockRatio > 0) {
            const bonusQty = holding * evt.stockRatio;
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
    });

    runImport(events);

    // 5. 写完成日志
    const hasErrors = result.errors > 0;
    const level = hasErrors ? 'WARN' : 'SUCCESS';
    const detail = JSON.stringify(result);

    writeSystemLog({
      logType: 'dividend_import',
      level,
      logDate: date,
      message: hasErrors ? `除权导入完成（有 ${result.errors} 个错误）` : '除权导入完成',
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
