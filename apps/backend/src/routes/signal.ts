import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import type { JwtPayload } from '../services/auth.js';
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
      const count = (db.prepare(`SELECT COUNT(*) AS c FROM user_strategy_signal ${whereSql}`).get(...params) as { c: number }).c;
      const rows = db.prepare(
        `SELECT * FROM user_strategy_signal ${whereSql} ORDER BY trade_date ASC, created_at ASC, id ASC LIMIT ? OFFSET ?`
      ).all(...params, pageSize, (page - 1) * pageSize);

      reply.send(ok(rows, { pagination: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) } }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
