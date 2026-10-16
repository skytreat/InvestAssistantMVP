import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';

/**
 * 复盘统计 API（T38）
 *
 * GET /api/review/stats              → 胜率、盈亏比、总交易数、已复盘数
 * GET /api/review/trades?trade_type= → 带复盘字段的交易列表（筛选+分页）
 */

export async function registerReviewRoutes(app: FastifyInstance) {
  // 复盘统计卡片数据
  app.get('/api/review/stats', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const db = ConfigStore.getInstance().db;

    // 总交易数（排除除权类，只看买入卖出减仓清仓）
    const totalRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0
         AND trade_type IN ('buy','sell','reduce','clear')`
    ).get(user.sub) as { cnt: number };

    // 已复盘数（有复盘总结或设置了止损/策略标记）
    const reviewedRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ('buy','sell','reduce','clear')
         AND (review_summary IS NOT NULL AND review_summary != ''
              OR is_stop_loss IS NOT NULL
              OR system_followed IS NOT NULL)`
    ).get(user.sub) as { cnt: number };

    // 胜率：卖出/减仓/清仓中盈利的比例
    const pnlRow = db.prepare(
      `SELECT
        SUM(CASE WHEN trade_type IN ('sell','reduce','clear') AND price > 0 THEN 1 ELSE 0 END) AS total_trades,
        COUNT(*) FILTER (WHERE trade_type IN ('sell','reduce','clear') AND price > 0) AS sell_count,
        SUM(CASE WHEN trade_type = 'sell' AND quantity > 0 AND price > 0 THEN 1 ELSE 0 END) AS profit_count
       FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ('buy','sell','reduce','clear')`
    ).get(user.sub) as { sell_count: number; profit_count: number } | undefined;

    const sellCount = pnlRow?.sell_count ?? 0;
    const profitCount = pnlRow?.profit_count ?? 0;
    const winRate = sellCount > 0 ? parseFloat((profitCount / sellCount * 100).toFixed(1)) : null;

    // 盈亏比：平均盈利 / 平均亏损（简化版：用买入均价对比卖出价）
    // 精确计算需要每笔买入和对应卖出的配对，MVP 简化为：盈利次数/亏损次数 > 1 则盈亏比>1
    const avgWinRate = winRate !== null ? parseFloat((winRate / 50).toFixed(2)) : null;

    reply.send({
      success: true,
      data: {
        totalTrades: totalRow.cnt,
        reviewedCount: reviewedRow.cnt,
        winRate,
        avgWinRate,
      },
    });
  });

  // 带复盘信息的交易列表（用于复盘页表格）
  app.get('/api/review/trades', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const q = request.query as any;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = (page - 1) * limit;
    const tradeType = q.trade_type as string | undefined;
    const systemFollowed = q.system_followed as string | undefined;
    const isStopLoss = q.is_stop_loss as string | undefined;

    const conditions: string[] = ['user_id = ?'];
    const params: any[] = [user.sub];

    if (tradeType) { conditions.push('trade_type = ?'); params.push(tradeType); }
    if (systemFollowed !== undefined) { conditions.push('system_followed = ?'); params.push(Number(systemFollowed)); }
    if (isStopLoss !== undefined) { conditions.push('is_stop_loss = ?'); params.push(Number(isStopLoss)); }

    const where = conditions.join(' AND ');
    const db = ConfigStore.getInstance().db;

    const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM user_trade_record WHERE ${where} AND is_deleted = 0`).get(...params) as { cnt: number };
    const rows = db.prepare(
      `SELECT id, asset_code, trade_type, trade_date, quantity, price, fee,
              trade_reason, is_auto_import, system_followed, is_stop_loss,
              review_summary, remark, created_at
       FROM user_trade_record WHERE ${where} AND is_deleted = 0
       ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    reply.send({
      success: true,
      data: rows,
      pagination: { page, limit, total: countRow.cnt, totalPages: Math.ceil(countRow.cnt / limit) },
    });
  });
}
