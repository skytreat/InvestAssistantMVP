import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import type { JwtPayload } from '../services/auth.js';
import { getTodaySignalStats } from '../services/todaySignals.js';
import { getTradeDate, resolveDefaultSignalTradeDate } from '../services/signalService.js';
import { ok, fail } from '../lib/envelope.js';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

/** F3：今日 Top 5 摘要的固定条数（PRD_v3 §4.2「今日 Top 5 摘要」） */
const TOP_SIGNALS_LIMIT = 5;

/**
 * 策略信号查询 API（T28 + T54）
 *
 * GET /api/signals
 *   ?trade_date=2026-10-15        单日过滤
 *   &start_date=2026-10-01       日期范围下界（含，>=）
 *   &end_date=2026-10-15          日期范围上界（含，<=）
 *   &asset_code=sh600000          单标的过滤
 *   &plugin_id=rsi_oversold
 *   &direction=buy
 *   &page=1&page_size=20
 *
 * T54：所有筛选值一律走预编译参数化绑定（`?` 占位），禁止把入参拼进 SQL 文本；
 *      WHERE 子句按固定顺序 append，参数数组与占位符顺序严格一一对应。
 *      排序 `ORDER BY trade_date ASC`（T53/T54 要求升序），`created_at / id`
 *      作为同日同刻的确定性 tie-break，避免分页抖动。
 *
 * 🔴 **窗口口径（P2-2）**：分页窗口取**最近 N 条**（内层 DESC），
 *    输出再**升序**排回（外层 ASC）⇒ 页内升序不变，但第 1 页是**最新**的一页。
 *    与 K 线路由（`routes/kline.ts`）的「近 20 条信号」口径统一。
 */
export async function registerSignalRoutes(app: FastifyInstance) {
  app.get('/api/signal', async (request, reply) => {
    try {
      const user = (request as AuthedRequest).user;
      const q = request.query as Record<string, string | undefined>;
      const page = Math.max(1, parseInt(q.page ?? '1', 10));
      const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? '20', 10)));

      const db = ConfigStore.getInstance().db;
      const where: string[] = ['user_id = ?', 'is_deleted = 0'];
      const params: Array<string | number> = [user.sub];

      /**
       * 🔴 **默认交易日口径（F 域 P0-1）**
       *
       * 修复前：前端硬编码 `trade_date=todayStr()` ⇒ 周末/节假日/行情未跑的日子进页**永远为空**，
       *   用户误以为「没有信号」。`/api/signal/stats` 更是在缺省时直接落到自然日今天。
       *
       * 修复后：调用方**完全没传日期条件**（`trade_date` / `start_date` / `end_date` 都没有）时，
       *   由 `resolveDefaultSignalTradeDate()` 解析口径（最近有信号日 → 最近行情日 → 今天），
       *   并随响应下发 `trade_date` / `trade_date_source` / `latest_quote_date`，**前端不再自己猜今天**。
       *
       * ⚠️ 这里**故意不注入 `trade_date` 过滤**：本接口的既有契约是
       *   「无筛选 = 最近 N 条（跨交易日窗口）」，与 K 线标记（`kline-signal-isolation`）
       *   共享同一行集合口径。默认口径只体现在响应元信息与前端展示上，不改变取数窗口。
       */
      const hasDateFilter = Boolean(q.trade_date || q.start_date || q.end_date);
      let effectiveTradeDate: string | null = q.trade_date ?? null;
      let dateSource: 'explicit' | 'signal' | 'quote' | 'today' = 'explicit';
      let latestQuoteDate: string | null = null;
      if (!hasDateFilter) {
        const resolved = await resolveDefaultSignalTradeDate(user.sub);
        effectiveTradeDate = resolved.tradeDate;
        dateSource = resolved.source;
        latestQuoteDate = resolved.latestQuoteDate;
      }

      if (q.asset_code) {
        where.push('asset_code = ?');
        params.push(q.asset_code);
      }
      if (q.trade_date) {
        where.push('trade_date = ?');
        params.push(q.trade_date);
      }
      // T54：日期范围闭区间 —— start_date 与 end_date 当天都算命中
      if (q.start_date) {
        where.push('trade_date >= ?');
        params.push(q.start_date);
      }
      if (q.end_date) {
        where.push('trade_date <= ?');
        params.push(q.end_date);
      }
      if (q.plugin_id) {
        where.push('plugin_id = ?');
        params.push(q.plugin_id);
      }
      if (q.direction) {
        where.push('direction = ?');
        params.push(q.direction);
      }
      /**
       * F1：分级筛选（PRD_v3 §4.2 顶部 tab：全部 / 强 / 中 / 弱 / 已过期）
       *
       * - `grade=strong|medium|weak` → 只看该档，并**排除已过期**（过期在「已过期」tab 单独展示）
       * - `grade=expired` → `expires_at < 今天`（未写过 expires_at 的历史行不算过期）
       * - 不传 → 保持既有「全部」语义（含过期），供 Dashboard / 其他调用方兼容
       */
      if (q.grade) {
        if (q.grade === 'expired') {
          where.push('(expires_at IS NOT NULL AND expires_at < ?)');
          params.push(getTradeDate());
        } else if (q.grade === 'strong' || q.grade === 'medium' || q.grade === 'weak') {
          where.push('grade = ?');
          params.push(q.grade);
          where.push('(expires_at IS NULL OR expires_at >= ?)');
          params.push(getTradeDate());
        } else {
          return reply
            .code(400)
            .send(fail(400, 'PARAM_INVALID', 'grade 只能是 strong / medium / weak / expired'));
        }
      }

      const whereSql = 'WHERE ' + where.join(' AND ');
      const count = (
        db.prepare(`SELECT COUNT(*) AS c FROM user_strategy_signal ${whereSql}`).get(...params) as {
          c: number;
        }
      ).c;
      /**
       * 🔴 **窗口口径 = 「最近 N 条，输出升序」**（P2-2 口径统一）
       *
       * 形状：内层 `ORDER BY trade_date DESC ... LIMIT ? OFFSET ?` 取**最近**一页，
       * 外层再 `ORDER BY trade_date ASC` 把这一页**升序**排回去。
       * ⇒ ① **每一页内部仍然是升序**（G5.5「signals 升序」不受影响）
       *   ② **第 1 页 = 最近 N 条**（此前 = 最早 N 条）
       *   ③ `created_at / id` 作确定性 tie-break ⇒ 同日同刻不抖动
       *
       * ⚠️ **为何改**：K 线路由（`routes/kline.ts`）下发的是该标的**最近 20 条**信号
       *   （图上标记画的就是最近的），而本端点此前给的是**最早 20 条** ⇒
       *   信号总数 >20 时，「图上标记」与「信号列表」**对不上**。
       *   统一为「最近 N 条 + 升序」后，两个端点**同一用户 + 同一标的 + 同一条数**
       *   返回**完全相同的行集合**。
       *
       * ⚠️ **对前端的影响**：`Signals.tsx` 默认筛「今日」+ 不重排 ⇒ 显示顺序不变；
       *   取消日期筛选后，第 1 页由「最早 20 条」变为「最近 20 条」（页内仍升序）；
       *   `Dashboard.tsx` 的「最新信号」卡片此前因本口径**显示的是最早的 5 条**（与卡片标题矛盾），
       *   改后与标题一致。
       */
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM user_strategy_signal ${whereSql}
             ORDER BY trade_date DESC, created_at DESC, id DESC
             LIMIT ? OFFSET ?
           )
           ORDER BY trade_date ASC, created_at ASC, id ASC`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);

      reply.send(
        ok(rows, {
          pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) },
          // F 域 P0-1：把「实际生效的交易日 + 来源 + 行情最新日」下发，前端不再自己猜今天
          trade_date: effectiveTradeDate,
          trade_date_source: dateSource,
          latest_quote_date: latestQuoteDate,
        }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * GET /api/signal/stats —— **今日信号统计**（T67 Dashboard「今日动态概览卡 · 今日信号 ▲▼·」）
   *
   * ?trade_date=2026-10-20   指定交易日
   *   缺省（F 域 P0-1 修复后）= **最近有信号日** → **最近行情日** → 东八区今天，
   *   不再直接落到自然日今天（周末/节假日会误导成「今日 0 条」）。
   *
   * 响应：`{ total, up, down, hold }`（buy→up / sell→down / hold→hold）
   *
   * ── 为什么不复用 `GET /api/signal` 自己在前端数 ──
   *   `/api/signal` 是**分页**接口（`page_size` 上限 200）。信号条数超过 1 页时，
   *   前端拿到的只是第 1 页 → ▲▼· 计数会**静默偏小**（而 `pagination.total` 只是总数，
   *   拆不出方向分布）。本端点用 **1 次 GROUP BY** 在服务端算准，
   *   既不多一次往返，也不受分页影响。
   */
  app.get('/api/signal/stats', async (request, reply) => {
    try {
      const user = (request as AuthedRequest).user;
      const q = request.query as Record<string, string | undefined>;
      let tradeDate: string;
      let dateSource: 'explicit' | 'signal' | 'quote' | 'today' = 'explicit';
      let latestQuoteDate: string | null = null;
      if (q.trade_date) {
        tradeDate = q.trade_date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
          return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_date 格式应为 YYYY-MM-DD'));
        }
      } else {
        const resolved = await resolveDefaultSignalTradeDate(user.sub);
        tradeDate = resolved.tradeDate;
        dateSource = resolved.source;
        latestQuoteDate = resolved.latestQuoteDate;
      }
      const stats = await getTodaySignalStats(user.sub, tradeDate);
      return reply.send(
        ok(stats, {
          trade_date: tradeDate,
          trade_date_source: dateSource,
          latest_quote_date: latestQuoteDate,
        }),
      );
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
  /**
   * GET /api/signal/top5 —— **今日 Top 5 摘要与优先级**（F3，PRD_v3 §4.2）
   *
   * ?trade_date=2026-11-06   指定交易日；缺省 = 最近有信号日 → 最近行情日 → 今天
   *
   * 与 `GET /api/signal` 的区别：
   *   - **强制单日**：只取一个交易日（默认日由后端解析），不跨交易日；
   *   - **按优先级排序**：`grade` 强 > 中 > 弱 > 未分级，同档 `strength` 降序
   *     （`strength` 为空排在同档末尾），最后按 `id` 倒序保证确定性；
   *   - 固定 `LIMIT 5`，供 Dashboard 摘要卡与 Signals 页摘要区共用。
   *
   * ⚠️ 未分级行（F1 尚未回填 `grade` 的存量数据）按 strength 排序，
   *    因此本端点**不依赖 F1 是否已落地**即可工作。
   */
  app.get('/api/signal/top5', async (request, reply) => {
    try {
      const user = (request as AuthedRequest).user;
      const q = request.query as Record<string, string | undefined>;
      let tradeDate: string;
      let dateSource: 'explicit' | 'signal' | 'quote' | 'today' = 'explicit';
      let latestQuoteDate: string | null = null;
      if (q.trade_date) {
        tradeDate = q.trade_date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
          return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_date 格式应为 YYYY-MM-DD'));
        }
      } else {
        const resolved = await resolveDefaultSignalTradeDate(user.sub);
        tradeDate = resolved.tradeDate;
        dateSource = resolved.source;
        latestQuoteDate = resolved.latestQuoteDate;
      }

      const rows = ConfigStore.getInstance()
        .db.prepare(
          `SELECT * FROM user_strategy_signal
            WHERE user_id = ? AND is_deleted = 0 AND trade_date = ?
            ORDER BY CASE grade
                       WHEN 'strong' THEN 0
                       WHEN 'medium' THEN 1
                       WHEN 'weak' THEN 2
                       ELSE 3
                     END,
                     strength IS NULL,
                     strength DESC,
                     id DESC
            LIMIT ?`,
        )
        .all(user.sub, tradeDate, TOP_SIGNALS_LIMIT);

      return reply.send(
        ok(rows, {
          trade_date: tradeDate,
          trade_date_source: dateSource,
          latest_quote_date: latestQuoteDate,
          limit: TOP_SIGNALS_LIMIT,
        }),
      );
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T134（V3.4）信号采纳/忽略标注
  app.patch('/api/signal/:id/adopt', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const db = ConfigStore.getInstance().db;
    const info = db
      .prepare(
        `UPDATE user_strategy_signal SET adopted = 1, adopted_at = datetime('now','localtime') WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      )
      .run(id, user.sub);
    if (info.changes === 0) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));
    return reply.send(ok({ id, adopted: 1 }));
  });

  app.patch('/api/signal/:id/ignore', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const db = ConfigStore.getInstance().db;
    const info = db
      .prepare(`UPDATE user_strategy_signal SET ignored = 1 WHERE id = ? AND user_id = ? AND is_deleted = 0`)
      .run(id, user.sub);
    if (info.changes === 0) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));
    return reply.send(ok({ id, ignored: 1 }));
  });
  // T141（V3.7）信号↔交易手动关联（INV-S3-15/16、INV-S6-4）
  app.patch('/api/signal/:id/link-trade', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send(fail(400, 'INVALID_ID', 'id 非法'));
    const body = (request.body ?? {}) as { tradeRecordId?: number | null };
    const tradeId = body.tradeRecordId == null ? null : Number(body.tradeRecordId);
    if (tradeId != null && (!Number.isFinite(tradeId) || tradeId <= 0)) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', 'tradeRecordId 非法'));
    }
    const db = ConfigStore.getInstance().db;
    const sig = db
      .prepare(
        'SELECT id, asset_code FROM user_strategy_signal WHERE id = ? AND user_id = ? AND is_deleted = 0',
      )
      .get(id, user.sub) as { id: number; asset_code: string } | undefined;
    if (!sig) return reply.code(404).send(fail(404, 'NOT_FOUND', '信号不存在'));
    if (tradeId != null) {
      const rec = db
        .prepare(
          'SELECT id, asset_code FROM user_trade_record WHERE id = ? AND user_id = ? AND is_deleted = 0',
        )
        .get(tradeId, user.sub) as { id: number; asset_code: string } | undefined;
      if (!rec) return reply.code(404).send(fail(404, 'NOT_FOUND', '交易记录不存在'));
      if (rec.asset_code !== sig.asset_code) {
        return reply.code(400).send(fail(400, 'ASSET_MISMATCH', '信号与交易标的不一致'));
      }
    }
    db.prepare('UPDATE user_strategy_signal SET linked_trade_id = ? WHERE id = ? AND user_id = ?').run(
      tradeId,
      id,
      user.sub,
    );
    return reply.send(ok({ id, linked_trade_id: tradeId }));
  });
}
