import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';

/**
 * 资产快照查询 API（T37）
 *
 * GET /api/asset-stat/latest        → 最新一条快照（当前总资产+双口径收益率）
 * GET /api/asset-stat/history?days=N → 近 N 天快照数组（用于收益曲线，默认 30）
 *
 * assetStat 写层已由 M2 scheduler.ts 17:02 cron 自动写入，本文件只做查询路由。
 */

export async function registerAssetStatRoutes(app: FastifyInstance) {
  /** 最新一条快照 */
  app.get('/api/asset-stat/latest', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const store = ConfigStore.getInstance();
    const row = store.db.prepare(
      `SELECT trade_date, total_assets_price_yield, total_assets_actual_yield,
              total_profit_price, total_profit_actual
       FROM user_asset_stat
       WHERE user_id = ?
       ORDER BY trade_date DESC
       LIMIT 1`
    ).get(user.sub) as {
      trade_date: string;
      total_assets_price_yield: number;
      total_assets_actual_yield: number;
      total_profit_price: number;
      total_profit_actual: number;
    } | undefined;

    return reply.send({ success: true, data: row ?? null });
  });

  /** 近 N 天历史（收益曲线数据） */
  app.get('/api/asset-stat/history', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const { days = 30 } = request.query as { days?: number };
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);

    const store = ConfigStore.getInstance();
    const rows = store.db.prepare(
      `SELECT trade_date, total_assets_price_yield, total_assets_actual_yield,
              total_profit_price, total_profit_actual
       FROM user_asset_stat
       WHERE user_id = ? AND trade_date >= date('now', '-${n} days')
       ORDER BY trade_date ASC`
    ).all(user.sub) as Array<{
      trade_date: string;
      total_assets_price_yield: number;
      total_assets_actual_yield: number;
      total_profit_price: number;
      total_profit_actual: number;
    }>;

    return reply.send({ success: true, data: rows });
  });
}

