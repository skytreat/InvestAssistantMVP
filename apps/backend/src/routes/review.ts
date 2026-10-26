import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { calcClosedTradePnLs } from '../services/positionCalculator.js';
import { buildReviewPairs } from '../services/reviewPairs.js';
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
/**
 * 复盘页纳入统计的交易类型。
 *
 * 🔴 **必须与 `routes/trade.ts` 的 `TRADE_TYPES` + DDL CHECK 对齐**（2026-10-20 修正）：
 *   原值含 DDL 不认的 `'sell'`，且**漏了 `'add'`** ⇒ 加仓交易不计入复盘页「总交易数 / 已复盘数」，
 *   也不出现在带复盘字段的交易列表里。
 *   `'add'` 修好后（`trade.ts` 白名单已对齐 DDL）本项**从「不可达」变「可达」** ⇒ 必须同步。
 *
 * ⚠️ `'sell'` 已从全仓移除（DEC-2 裁决：7 种类型里没有「卖出」，部分卖出=reduce、全部卖出=clear）
 */
const ACTIVE_TRADE_TYPES = "('buy','add','reduce','clear')";

export async function registerReviewRoutes(app: FastifyInstance) {
  // 复盘统计卡片数据
  app.get('/api/review/yield', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const db = ConfigStore.getInstance().db;

    // 总交易数（排除除权类，只看买入卖出减仓清仓）
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ${ACTIVE_TRADE_TYPES}`,
      )
      .get(user.sub) as { cnt: number };

    // 已复盘数（4 复盘字段任一有值即算已复盘，Requirements §5.2）
    const reviewedRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM user_trade_record
       WHERE user_id = ? AND is_deleted = 0 AND trade_type IN ${ACTIVE_TRADE_TYPES}
         AND ((review_summary IS NOT NULL AND review_summary != '')
              OR strategy_match IS NOT NULL
              OR is_stop_loss IS NOT NULL
              OR (remark IS NOT NULL AND remark != ''))`,
      )
      .get(user.sub) as { cnt: number };

    // 胜率 + 盈亏比：回放全部平仓交易的已实现盈亏
    const closed = calcClosedTradePnLs(user.sub);
    const wins = closed.filter((c) => c.realized_pnl > 0);
    const losses = closed.filter((c) => c.realized_pnl < 0);
    const closedCount = closed.length;

    const winRate = closedCount > 0 ? parseFloat(((wins.length / closedCount) * 100).toFixed(1)) : null;

    const avgWin = wins.length > 0 ? wins.reduce((s, c) => s + c.realized_pnl, 0) / wins.length : null;
    const avgLoss =
      losses.length > 0 ? Math.abs(losses.reduce((s, c) => s + c.realized_pnl, 0) / losses.length) : null;
    // 全盈利无亏损 → null（前端显示"—"，不用 Infinity）
    const profitLossRatio =
      avgWin !== null && avgLoss !== null && avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : null;

    const totalRealizedPnl = closed.reduce((s, c) => s + c.realized_pnl, 0);

    reply.send(
      ok({
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
      }),
    );
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

    if (tradeType) {
      conditions.push('trade_type = ?');
      params.push(tradeType);
    }
    if (systemFollowed !== undefined) {
      conditions.push('system_followed = ?');
      params.push(Number(systemFollowed));
    }
    if (strategyMatch !== undefined) {
      conditions.push('strategy_match = ?');
      params.push(Number(strategyMatch));
    }
    if (isStopLoss !== undefined) {
      conditions.push('is_stop_loss = ?');
      params.push(Number(isStopLoss));
    }
    if (startDate) {
      conditions.push('trade_date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('trade_date <= ?');
      params.push(endDate);
    }

    const where = conditions.join(' AND ');
    const db = ConfigStore.getInstance().db;

    const countRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM user_trade_record WHERE ${where} AND is_deleted = 0`)
      .get(...params) as { cnt: number };
    const rows = db
      .prepare(
        `SELECT id, asset_code, trade_type, trade_date, quantity, price, fee,
              trade_reason, is_auto_import, system_followed, strategy_match, is_stop_loss,
              review_summary, remark, created_at
       FROM user_trade_record WHERE ${where} AND is_deleted = 0
       ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as any[];

    reply.send(
      ok(rows, {
        pagination: { page, limit, total: countRow.cnt, totalPages: Math.ceil(countRow.cnt / limit) },
      }),
    );
  });
  // 交易对视图（T130）：开仓→平仓配对，未平仓单独成组
  app.get('/api/review/pairs', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const pairs = buildReviewPairs(user.sub);
    return reply.send(ok(pairs));
  });

  // 复盘字段更新（T131）：买入/卖出逻辑独立 + 情绪状态 5 档枚举
  app.patch('/api/review/pairs/:id', async (request, reply) => {
    const user = (request as any).user as { sub: number };
    const id = Number((request.params as { id: string }).id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send(fail(400, 'INVALID_ID', 'pair id 非法'));
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const db = ConfigStore.getInstance().db;

    const EMOTIONS = ['极度兴奋', '兴奋', '平静', '焦虑', '恐慌'];
    if (body.emotion_status != null && !EMOTIONS.includes(String(body.emotion_status))) {
      return reply.code(400).send(fail(400, 'INVALID_EMOTION', `emotion_status 须为 ${EMOTIONS.join('/')}`));
    }

    // id 可能是平仓交易 id 或开仓交易 id；优先按 id 找，找不到则 404
    const exists = db
      .prepare('SELECT id FROM user_trade_record WHERE id = ? AND user_id = ? AND is_deleted = 0')
      .get(id, user.sub);
    if (!exists) return reply.code(404).send(fail(404, 'NOT_FOUND', '交易记录不存在'));

    const fields: string[] = [];
    const params: unknown[] = [];
    const setField = (col: string, val: unknown) => {
      fields.push(`${col} = ?`);
      params.push(val);
    };
    if (body.buy_reason !== undefined)
      setField('buy_reason', body.buy_reason == null ? null : String(body.buy_reason));
    if (body.sell_reason !== undefined)
      setField('sell_reason', body.sell_reason == null ? null : String(body.sell_reason));
    if (body.emotion_status !== undefined)
      setField('emotion_status', body.emotion_status == null ? null : String(body.emotion_status));
    if (body.review_summary !== undefined)
      setField('review_summary', body.review_summary == null ? null : String(body.review_summary));
    if (body.remark !== undefined) setField('remark', body.remark == null ? null : String(body.remark));
    if (body.strategy_match !== undefined)
      setField('strategy_match', body.strategy_match == null ? null : Number(body.strategy_match));
    if (body.is_stop_loss !== undefined)
      setField('is_stop_loss', body.is_stop_loss == null ? null : Number(body.is_stop_loss));
    if (body.system_followed !== undefined)
      setField('system_followed', body.system_followed == null ? null : Number(body.system_followed));
    // 兼容旧 trade_reason：若只给 trade_reason，落 buy_reason（不覆盖已有）
    if (body.trade_reason !== undefined)
      setField('trade_reason', body.trade_reason == null ? null : String(body.trade_reason));

    if (fields.length === 0) return reply.code(400).send(fail(400, 'INVALID_BODY', '无有效字段'));

    params.push(id, user.sub);
    db.prepare(`UPDATE user_trade_record SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...params,
    );

    // 若更新了 buy_reason 且该 pair 的开仓交易与当前 id 不同，同步到开仓交易（INV-S6-2 独立存取，尽力同步）
    return reply.send(ok({ id }));
  });
}
