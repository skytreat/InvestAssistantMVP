import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { calcClosedTradePnLs } from '../services/positionCalculator.js';
import { ok, fail } from '../lib/envelope.js';

/**
 * 复盘统计 API（T38）
 *
 * GET /api/review/stats              → 胜率、盈亏比、总交易数、已复盘数
 * GET /api/review/trades?trade_type= → 带复盘字段的交易列表（筛选+分页）
 *
 * 统计口径（PRD §5.5）：
 * - 胜率 = 盈利的平仓笔数 / 全部平仓笔数
 * - 盈亏比 = 平均盈利金额 / 平均亏损金额（绝对值）
 * 平仓 = sell / reduce / clear 三种交易类型，按移动加权成本算已实现盈亏
 */

/** 复盘统计只认这 4 类主动交易（除权类由 C1-C12 校验，不进胜率） */
const ACTIVE_TRADE_TYPES = "('buy','sell','reduce','clear')";

export async function registerReviewRoutes(app: FastifyInstance) {
  // 复盘统计卡片数据
  app.get('/api/review/yield', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const db = ConfigStore.getInstance().db;

    // 总交易数（排除除权类，只看买入卖出减仓清仓）
    const totalRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ${ACTIVE_TRADE_TYPES}`
    ).get(user.sub) as { cnt: number };

    // 已复盘数（4 复盘字段任一有值即算已复盘，Requirements §5.2）
    const reviewedRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ${ACTIVE_TRADE_TYPES}
         AND ((review_summary IS NOT NULL AND review_summary != '')
              OR strategy_match IS NOT NULL
              OR is_stop_loss IS NOT NULL
              OR (remark IS NOT NULL AND remark != ''))`
    ).get(user.sub) as { cnt: number };

    // 胜率 + 盈亏比：回放全部平仓交易的已实现盈亏
    const closed = calcClosedTradePnLs(user.sub);
    const wins = closed.filter(c => c.realized_pnl > 0);
    const losses = closed.filter(c => c.realized_pnl < 0);
    const closedCount = closed.length;

    const winRate = closedCount > 0
      ? parseFloat((wins.length / closedCount * 100).toFixed(1))
      : null;

    const avgWin = wins.length > 0
      ? wins.reduce((s, c) => s + c.realized_pnl, 0) / wins.length
      : null;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, c) => s + c.realized_pnl, 0) / losses.length)
      : null;
    // 全盈利无亏损 → null（前端显示"—"，不用 Infinity）
    const profitLossRatio = avgWin !== null && avgLoss !== null && avgLoss > 0
      ? parseFloat((avgWin / avgLoss).toFixed(2))
      : null;

    const totalRealizedPnl = closed.reduce((s, c) => s + c.realized_pnl, 0);

    reply.send(ok({
        totalTrades: totalRow.cnt,
        reviewedCount: reviewedRow.cnt,
        closedCount,
        winCount: wins.length,
        lossCount: losses.length,
        winRate,
        avgWin,
        avgLoss,
        profitLossRatio,
        totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(2)),
      }));
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
    const strategyMatch = q.strategy_match as string | undefined;
    const isStopLoss = q.is_stop_loss as string | undefined;
    const startDate = q.start_date as string | undefined;
    const endDate = q.end_date as string | undefined;

    const conditions: string[] = ['user_id = ?'];
    const params: any[] = [user.sub];

    if (tradeType) { conditions.push('trade_type = ?'); params.push(tradeType); }
    if (systemFollowed !== undefined) { conditions.push('system_followed = ?'); params.push(Number(systemFollowed)); }
    if (strategyMatch !== undefined) { conditions.push('strategy_match = ?'); params.push(Number(strategyMatch)); }
    if (isStopLoss !== undefined) { conditions.push('is_stop_loss = ?'); params.push(Number(isStopLoss)); }
    if (startDate) { conditions.push('trade_date >= ?'); params.push(startDate); }
    if (endDate) { conditions.push('trade_date <= ?'); params.push(endDate); }

    const where = conditions.join(' AND ');
    const db = ConfigStore.getInstance().db;

    const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM user_trade_record WHERE ${where} AND is_deleted = 0`).get(...params) as { cnt: number };
    const rows = db.prepare(
      `SELECT id, asset_code, trade_type, trade_date, quantity, price, fee,
              trade_reason, is_auto_import, system_followed, strategy_match, is_stop_loss,
              review_summary, remark, created_at
       FROM user_trade_record WHERE ${where} AND is_deleted = 0
       ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    reply.send(ok(rows, { pagination: { page, limit, total: countRow.cnt, totalPages: Math.ceil(countRow.cnt / limit) } }));
  });
}