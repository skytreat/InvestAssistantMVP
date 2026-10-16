import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { calcPosition, calcAllPositions, validateSufficientHolding } from '../services/positionCalculator.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * 交易 + 持仓 API（T25 + T26 + T39）
 *
 * 所有路由需要 JWT 鉴权（由 registerRoutes 里的 onRequest hook 统一处理）
 */

const REDUCE_TYPES = new Set(['sell', 'reduce', 'clear']);

export async function registerTradeRoutes(app: FastifyInstance) {
  // 录入交易
  app.post('/api/trades', async (request, reply) => {
    try {
      const body = request.body as {
        asset_code: string;
        trade_type: 'buy' | 'sell' | 'reduce' | 'clear' | 'dividend' | 'bonus' | 'transfer';
        trade_date: string;
        quantity: number;
        price: number;
        fee?: number;
        trade_reason?: string;
        remark?: string;
        system_followed?: number;  // T39: 系统信号驱动的交易，由 cron 自动设置
      };
      const user = (request as any).user as { sub: number; username: string; role: string };
      if (!body?.asset_code || !body?.trade_type || !body?.trade_date ||
          body.quantity == null || body.price == null) {
        return reply.code(400).send({ success: false, error: '必填字段缺失' });
      }
      if (body.quantity <= 0 || body.price < 0) {
        return reply.code(400).send({ success: false, error: '数量>0、价格>=0' });
      }
      if (!['buy', 'sell', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'].includes(body.trade_type)) {
        return reply.code(400).send({ success: false, error: 'trade_type 非法' });
      }

      const AUTO_IMPORT_TYPES = new Set(['dividend', 'bonus', 'transfer']);
      const NEED_REASON_TYPES = new Set(['buy', 'sell', 'reduce', 'clear']);
      let tradeReason: string | null;
      if (AUTO_IMPORT_TYPES.has(body.trade_type)) {
        tradeReason = body.trade_reason ?? `自动导入 - ${body.trade_date} ${body.trade_type}`;
      } else if (NEED_REASON_TYPES.has(body.trade_type)) {
        if (!body.trade_reason?.trim()) {
          return reply.code(400).send({ success: false, error: 'TRADE_REASON_REQUIRED', message: 'trade_reason 必填，说明本次交易原因' });
        }
        tradeReason = body.trade_reason.trim();
      } else {
        tradeReason = body.trade_reason ?? null;
      }

      if (REDUCE_TYPES.has(body.trade_type)) {
        if (!validateSufficientHolding(user.sub, body.asset_code, body.quantity)) {
          return reply.code(400).send({
            success: false,
            error: 'HOLDING_INSUFFICIENT',
            message: `持仓不足，无法${body.trade_type} ${body.asset_code}`,
          });
        }
      }

      const db = ConfigStore.getInstance().db;
      const info = db.prepare(
        `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, quantity, price, fee, trade_reason, remark, system_followed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.sub, body.asset_code, body.trade_type, body.trade_date,
        body.quantity, body.price, body.fee ?? 0, tradeReason, body.remark ?? null,
        body.system_followed ?? null
      );

      writeSystemLog({
        logType: 'trade', level: 'SUCCESS',
        message: `录入${body.trade_type} ${body.asset_code} qty=${body.quantity} price=${body.price}`,
      });

      reply.code(201).send({
        success: true,
        data: {
          trade_id: info.lastInsertRowid,
          position: calcPosition(user.sub, body.asset_code),
        },
      });
    } catch (err: any) {
      if (String(err).includes('UNIQUE')) {
        return reply.code(409).send({ success: false, error: 'TRADE_DUPLICATE', message: '同日同标的同方向交易已存在' });
      }
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 查询交易记录（T39: 增强筛选+分页）
  app.get('/api/trades', async (request, reply) => {
    try {
      const user = (request as any).user;
      const q = request.query as any;
      const assetCode = q.asset_code as string | undefined;
      const tradeType = q.trade_type as string | undefined;
      const startDate = q.start_date as string | undefined;
      const endDate = q.end_date as string | undefined;
      const systemFollowed = q.system_followed as string | undefined;
      const isStopLoss = q.is_stop_loss as string | undefined;
      const hasReview = q.has_review as string | undefined;
      const page = Math.max(1, Number(q.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const offset = (page - 1) * limit;

      const conditions: string[] = ['user_id = ?'];
      const params: any[] = [user.sub];

      if (assetCode) { conditions.push('asset_code = ?'); params.push(assetCode); }
      if (tradeType) { conditions.push('trade_type = ?'); params.push(tradeType); }
      if (startDate) { conditions.push('trade_date >= ?'); params.push(startDate); }
      if (endDate) { conditions.push('trade_date <= ?'); params.push(endDate); }
      if (systemFollowed !== undefined) { conditions.push('system_followed = ?'); params.push(Number(systemFollowed)); }
      if (isStopLoss !== undefined) { conditions.push('is_stop_loss = ?'); params.push(Number(isStopLoss)); }
      if (hasReview === 'true') { conditions.push('(review_summary IS NOT NULL AND review_summary != \'\') OR (is_stop_loss IS NOT NULL) OR (system_followed IS NOT NULL)'); }
      if (hasReview === 'false') { conditions.push('(review_summary IS NULL OR review_summary = \'\') AND is_stop_loss IS NULL AND system_followed IS NULL'); }

      const where = conditions.join(' AND ');
      const db = ConfigStore.getInstance().db;

      // 先拿总数
      const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM user_trade_record WHERE ${where} AND is_deleted = 0`).get(...params) as { cnt: number };

      // 分页查询
      const rows = db.prepare(
        `SELECT * FROM user_trade_record WHERE ${where} AND is_deleted = 0
         ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as any[];

      reply.send({
        success: true,
        data: rows,
        pagination: { page, limit, total: countRow.cnt, totalPages: Math.ceil(countRow.cnt / limit) },
      });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // T39: PATCH 复盘字段（只允许改 review_note/strategy_match/is_stop_loss/remark）
  app.patch('/api/trades/:id', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const body = request.body as Record<string, any>;
    const allowedFields = ['review_summary', 'strategy_match', 'is_stop_loss', 'remark'];
    const updates: string[] = [];
    const params: any[] = [];
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updates.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (updates.length === 0) {
      return reply.code(400).send({ success: false, error: '无有效更新字段' });
    }
    params.push(tradeId);
    params.push(user.sub);

    const db = ConfigStore.getInstance().db;
    try {
      db.prepare(`UPDATE user_trade_record SET ${updates.join(', ')} WHERE id = ? AND user_id = ? AND is_deleted = 0`).run(...params);
      writeSystemLog({
        logType: 'trade', level: 'SUCCESS',
        message: `${user.username} 更新复盘字段 trade_id=${tradeId}`,
      });
      reply.send({ success: true });
    } catch (err: any) {
      if (String(err).includes('no such column')) {
        return reply.code(500).send({ success: false, error: 'DDL未就绪，请联系管理员' });
      }
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // T39: 软删除交易
  app.delete('/api/trades/:id', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const db = ConfigStore.getInstance().db;
    const info = db.prepare(
      `UPDATE user_trade_record SET is_deleted = 1 WHERE id = ? AND user_id = ? AND is_deleted = 0`
    ).run(tradeId, user.sub);
    if (info.changes === 0) {
      return reply.code(404).send({ success: false, error: 'NOT_FOUND' });
    }
    writeSystemLog({
      logType: 'trade', level: 'INFO',
      message: `${user.username} 软删除交易 id=${tradeId}`,
    });
    reply.send({ success: true });
  });

  // T39: 恢复软删除
  app.post('/api/trades/:id/restore', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const db = ConfigStore.getInstance().db;
    const info = db.prepare(
      `UPDATE user_trade_record SET is_deleted = 0 WHERE id = ? AND user_id = ? AND is_deleted = 1`
    ).run(tradeId, user.sub);
    if (info.changes === 0) {
      return reply.code(404).send({ success: false, error: 'NOT_FOUND' });
    }
    writeSystemLog({
      logType: 'trade', level: 'INFO',
      message: `${user.username} 恢复交易 id=${tradeId}`,
    });
    reply.send({ success: true });
  });

  // 查询单个标的持仓
  app.get('/api/positions/:asset_code', async (request, reply) => {
    try {
      const user = (request as any).user;
      const assetCode = (request.params as any).asset_code as string;
      const pos = calcPosition(user.sub, assetCode);
      reply.send({ success: true, data: { asset_code: assetCode, ...pos } });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 查询全部持仓
  app.get('/api/positions', async (request, reply) => {
    try {
      const user = (request as any).user;
      const positions = calcAllPositions(user.sub);
      reply.send({ success: true, data: positions });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });
}
