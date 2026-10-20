import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import type { JwtPayload } from '../services/auth.js';
import { getTodaySignalStats } from '../services/todaySignals.js';
import { getTradeDate } from '../services/signalService.js';
import { ok, fail } from '../lib/envelope.js';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

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
        ok(rows, { pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) } }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * GET /api/signal/stats —— **今日信号统计**（T67 Dashboard「今日动态概览卡 · 今日信号 ▲▼·」）
   *
   * ?trade_date=2026-10-20   指定交易日（缺省 = 今天）
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
      // 缺省 = 今天（东八区，与信号落库 `getTradeDate()` 同一口径）
      const tradeDate = q.trade_date ?? getTradeDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_date 格式应为 YYYY-MM-DD'));
      }
      const stats = await getTodaySignalStats(user.sub, tradeDate);
      return reply.send(ok(stats, { trade_date: tradeDate }));
    } catch (err) {
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
