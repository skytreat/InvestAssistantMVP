import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { calcPosition, calcAllPositions, validateSufficientHolding } from '../services/positionCalculator.js';
import { writeSystemLog } from '../services/logger.js';

/**
 * 交易 + 持仓 API（T25 + T26）
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
        remark?: string;
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

      // T25 核心：减仓类型 sell/reduce/clear 必须先校验持仓充足
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
         (user_id, asset_code, trade_type, trade_date, quantity, price, fee, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.sub, body.asset_code, body.trade_type, body.trade_date,
        body.quantity, body.price, body.fee ?? 0, body.remark ?? null
      );

      // 写 system_log（trade）
      writeSystemLog({
        logType: 'trade', level: 'SUCCESS',
        message: `录入${body.trade_type} ${body.asset_code} qty=${body.quantity} price=${body.price}`,
      });

      reply.code(201).send({
        success: true,
        trade_id: info.lastInsertRowid,
        position: calcPosition(user.sub, body.asset_code),
      });
    } catch (err: any) {
      // UNIQUE 冲突：同一天同一标的同一方向重复录入
      if (String(err).includes('UNIQUE')) {
        return reply.code(409).send({ success: false, error: 'TRADE_DUPLICATE', message: '同日同标的同方向交易已存在' });
      }
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 查询交易记录
  app.get('/api/trades', async (request, reply) => {
    try {
      const user = (request as any).user;
      const assetCode = (request.query as any)?.asset_code as string | undefined;
      const db = ConfigStore.getInstance().db;
      const rows = db.prepare(
        `SELECT * FROM user_trade_record WHERE user_id = ? AND is_deleted = 0
         ${assetCode ? 'AND asset_code = ?' : ''}
         ORDER BY trade_date DESC, id DESC`
      ).all(...([user.sub, ...(assetCode ? [assetCode] : [])] as any)) as any[];
      reply.send({ success: true, data: rows });
    } catch (err) {
      reply.code(500).send({ success: false, error: String(err) });
    }
  });

  // 查询单个标的持仓
  app.get('/api/positions/:asset_code', async (request, reply) => {
    try {
      const user = (request as any).user;
      const assetCode = (request.params as any).asset_code as string;
      const pos = calcPosition(user.sub, assetCode);
      reply.send({ success: true, asset_code: assetCode, ...pos });
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
