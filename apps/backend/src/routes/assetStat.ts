import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { backfillAssetStatSnapshots } from '../services/assetStat.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 资产快照查询 API（T37）
 *
 * GET  /api/asset-stat/latest        → 最新一条快照（当前总资产+双口径收益率）
 * GET  /api/asset-stat/history?days=N → 近 N 天快照数组（用于收益曲线，默认 30）
 * POST /api/asset-stat/backfill      → 回补缺失日期的历史快照（body: { days }，默认 365）
 *
 * 快照写层：平时由 M2 scheduler.ts 17:02 cron 自动写入；
 * 后端没在跑的日子没有快照 ⇒ 收益曲线空白，用 backfill 按「as-of 当日」口径补洞。
 */

export async function registerAssetStatRoutes(app: FastifyInstance) {
  /** 最新一条快照 */
  app.get('/api/asset-stat/latest', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const store = ConfigStore.getInstance();
    const row = store.db
      .prepare(
        `SELECT trade_date, total_assets_price_yield, total_assets_actual_yield,
              total_profit_price, total_profit_actual
       FROM user_asset_stat
       WHERE user_id = ?
       ORDER BY trade_date DESC
       LIMIT 1`,
      )
      .get(user.sub) as
      | {
          trade_date: string;
          total_assets_price_yield: number;
          total_assets_actual_yield: number;
          total_profit_price: number;
          total_profit_actual: number;
        }
      | undefined;

    return reply.send(ok(row ?? null));
  });

  /** 近 N 天历史（收益曲线数据） */
  app.get('/api/asset-stat/history', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const { days = 30 } = request.query as { days?: number };
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);

    const store = ConfigStore.getInstance();
    const rows = store.db
      .prepare(
        `SELECT trade_date, total_assets_price_yield, total_assets_actual_yield,
              total_profit_price, total_profit_actual
       FROM user_asset_stat
       WHERE user_id = ? AND trade_date >= date('now', '-${n} days')
       ORDER BY trade_date ASC`,
      )
      .all(user.sub) as Array<{
      trade_date: string;
      total_assets_price_yield: number;
      total_assets_actual_yield: number;
      total_profit_price: number;
      total_profit_actual: number;
    }>;

    return reply.send(ok(rows));
  });

  /**
   * 回补缺失日期的历史快照（近 N 天，默认 365）
   *
   * ⚠️ 需要行情库可用（K 线区间查询）—— DuckDB 不可用 → 503，不静默返回 0。
   * 幂等：已存在的 (user_id, trade_date) 快照**不被覆盖**。
   */
  app.post('/api/asset-stat/backfill', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const { days = 365 } = (request.body ?? {}) as { days?: number };
    const n = Math.min(Math.max(Math.trunc(Number(days)) || 365, 1), 365);
    try {
      const result = await backfillAssetStatSnapshots(user.sub, n);
      return reply.send(ok(result));
    } catch (err) {
      app.log.warn({ err }, '资产快照回补失败');
      return reply.code(503).send(fail(503, 'MARKET_DATA_UNAVAILABLE', '行情数据不可用，无法回补历史快照'));
    }
  });
}
