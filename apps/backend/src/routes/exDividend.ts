/**
 * exDividend.ts —— 除权自动导入的**读取侧** HTTP 路由（T67 Dashboard 配套）
 *
 * 背景：
 *   `services/exDividendSync.ts` 只有**写入**能力（17:03 cron 调 `importDividendEvents`），
 *   全仓 grep **没有任何除权导入的读取端点** ——
 *   唯一的痕迹是 `system_log` 里 `log_type='dividend_import'` 的运行摘要，
 *   而 `GET /api/admin/system-log` 是 **admin 专属** → 普通用户在 Dashboard 上读不到。
 *   ⇒ 按 T67 ⑦「今日动态概览卡 · 今日除权导入」的要求，新增**普通用户可读**的只读端点。
 *
 * 口径（L1 业务规则见 Requirements_simplified.md §5.1 除权）：
 *   - 数据落点是 `user_trade_record` 里 `is_auto_import = 1` 且
 *     `trade_type IN ('dividend','bonus')` 的记录（`exDividendSync.ts` 的 INSERT）。
 *   - `trade_date` = **除权除息日**（`exDividendSync.ts:181` 写入的是 `evt.exDate`，
 *     而 `exDate` 由导入任务按当日交易日取）→ 故按 `trade_date` 过滤即「哪一天除权」。
 *     ⚠️ 严格说是「除权除息日」而非「记录落库时刻」；两者在正常调度下同天，
 *        落库时刻见 `created_at`（本端点一并返回，供前端需要时区分）。
 *   - **按用户隔离**：只返回当前登录用户自己的记录（`user_id = ?`）。
 *
 * 参数：
 *   - `date`（可选）：精确日期 YYYY-MM-DD。给了就只查这一天。
 *   - `days`（可选）：近 N 天（含「今天」），默认 1；`date` 存在时本参数被忽略。
 *   - `limit`（可选）：返回条数上限，默认 50，上限 200。
 *
 * ⚠️ 只读端点：不写任何表，不触发任何导入。
 */

import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { getTradeDate } from '../services/signalService.js';
import { resolveTargetTradeDate } from '../services/marketData.js';
import { ok, fail } from '../lib/envelope.js';

/** 除权导入会写入的交易类型（`exDividendSync.ts` 的两个 INSERT） */
const IMPORTED_TRADE_TYPES = ['dividend', 'bonus'] as const;

/** 返回的除权导入记录（只挑前端展示需要的字段） */
export interface ExDividendImportRow {
  id: number;
  asset_code: string;
  trade_type: string;
  trade_date: string;
  trade_time: string;
  quantity: number;
  price: number;
  fee: number;
  trade_reason: string | null;
  /** 记录落库时间（导入发生时刻，DB 本地时区） */
  created_at: string;
}

/** 在 YYYY-MM-DD 上做天数偏移（UTC 构造，避免本地时区把日期挪一天） */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function registerExDividendRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/ex-dividend/imports —— 当前用户的除权自动导入记录 ──
  app.get('/api/ex-dividend/imports', async (request, reply) => {
    try {
      const user = (request as any).user as { sub: number };
      const q = request.query as { date?: string; days?: string; limit?: string };

      // ── 参数校验 ──
      //
      // ⚠️ 缺省「今天」的口径 = **导入任务用的那一天**（`scheduler.ts:222` 调
      //   `importDividendEvents(resolveTargetTradeDate())`）→ 日历口径的最近交易日。
      //   ⇒ 周末/节假日打开 Dashboard 时，「今日除权导入」仍能看到**上一个交易日**的导入，
      //   而不会因为「今天不是交易日」而恒为空。
      //   DuckDB 不可用 → `resolveTargetTradeDate()` 返回 null → 回退到东八区今天。
      let to = (await resolveTargetTradeDate()) ?? getTradeDate();
      let from = to;

      if (q.date !== undefined && q.date !== null && q.date !== '') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
          return reply.code(400).send(fail(400, 'PARAM_INVALID', 'date 格式应为 YYYY-MM-DD'));
        }
        from = q.date;
        to = q.date;
      } else {
        const days = Math.min(30, Math.max(1, Number(q.days) || 1));
        from = shiftDate(to, -(days - 1));
      }

      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const db = ConfigStore.getInstance().db;

      // ⚠️ `trade_type IN (?, ?)` —— 即便是固定字面量也走绑定参数，保持「全部预编译」一致
      const items = db
        .prepare(
          `SELECT id, asset_code, trade_type, trade_date, trade_time,
                  quantity, price, fee, trade_reason, created_at
             FROM user_trade_record
            WHERE user_id = ? AND is_deleted = 0 AND is_auto_import = 1
              AND trade_type IN (?, ?)
              AND trade_date BETWEEN ? AND ?
            ORDER BY trade_date DESC, asset_code ASC, id ASC
            LIMIT ?`,
        )
        .all(
          user.sub,
          IMPORTED_TRADE_TYPES[0],
          IMPORTED_TRADE_TYPES[1],
          from,
          to,
          limit,
        ) as ExDividendImportRow[];

      const countRows = db
        .prepare(
          `SELECT trade_type, COUNT(*) AS cnt
             FROM user_trade_record
            WHERE user_id = ? AND is_deleted = 0 AND is_auto_import = 1
              AND trade_type IN (?, ?)
              AND trade_date BETWEEN ? AND ?
            GROUP BY trade_type`,
        )
        .all(user.sub, IMPORTED_TRADE_TYPES[0], IMPORTED_TRADE_TYPES[1], from, to) as Array<{
        trade_type: string;
        cnt: number;
      }>;

      const summary = { total: 0, dividendCount: 0, bonusCount: 0 };
      for (const row of countRows) {
        const cnt = Number(row.cnt) || 0;
        summary.total += cnt;
        if (row.trade_type === 'dividend') summary.dividendCount += cnt;
        else if (row.trade_type === 'bonus') summary.bonusCount += cnt;
      }

      return reply.send(
        ok({
          from,
          to,
          items,
          summary,
        }),
      );
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
