import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { calcPosition, calcAllPositions, validateSufficientHolding } from '../services/positionCalculator.js';
import { batchGetLatestClose } from '../services/marketData.js';
import { writeSystemLog } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';
import { defaultMessage } from '../lib/errorMessages.js';

/**
 * 交易 + 持仓 API（T25 + T26 + T39）
 *
 * 所有路由需要 JWT 鉴权（由 registerRoutes 里的 onRequest hook 统一处理）
 */

const REDUCE_TYPES = new Set(['sell', 'reduce', 'clear']);

/**
 * T87：`trade_time` 格式校验（秒级 HH:mm:ss）
 *
 * B-11 裁决：`trade_time` 必填无默认 —— 不能给默认时间，因为那样
 * 「同一天同一秒录入两笔」会静默撞唯一键，用户无从理解为何被拒。
 * 缺失时前端预填当前时间；后端只做格式与范围校验。
 */
export function validateTradeTime(t: unknown): t is string {
  if (typeof t !== 'string') return false;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return false;
  const h = Number(t.slice(0, 2));
  const m = Number(t.slice(3, 5));
  const s = Number(t.slice(6, 8));
  return h < 24 && m < 60 && s < 60;
}

/** 当前本地时间，秒级 HH:mm:ss */
export function nowTradeTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * T58：同步 `user_asset_rel` 的 `rel_type='hold'` 关系
 *
 * 口径（以 `calcPosition` 的移动加权成本结果为准，与 GET /api/positions 同一口径）：
 * - 持仓 > 0 → 关系存在：缺则 INSERT，软删则恢复（`is_deleted=0`）
 * - 持仓 = 0（清仓）→ **软删**（`is_deleted=1`），不物理删除（AGENTS.md 硬约束）
 *
 * 幂等：先按 UNIQUE(user_id, asset_code, rel_type) 查现状，再决定 INSERT/UPDATE，
 * 重复调用不会产生第二行，也不会抛 UNIQUE。
 *
 * ⚠️ 与 `exDividendSync.getHoldingBeforeDate` 的口径差异（**疑似，未修**）：
 *    后者把 `bonus` 计入 +quantity，`calcPosition`（core 移动加权）不计 bonus。
 *    「清仓后又有送转股」这类序列两者结论会相反。此处不擅自改动，等业务口径裁决。
 */
export function syncHoldRelation(userId: number, assetCode: string): { action: string; totalQuantity: number } {
  const db = ConfigStore.getInstance().db;
  const totalQuantity = calcPosition(userId, assetCode).totalQuantity;
  const shouldHold = totalQuantity > 0;

  const run = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id, is_deleted FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = ?'
    ).get(userId, assetCode, 'hold') as { id: number; is_deleted: number } | undefined;

    if (shouldHold) {
      if (!existing) {
        db.prepare(
          `INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, 'hold')`
        ).run(userId, assetCode);
        return 'created';
      }
      if (existing.is_deleted === 1) {
        db.prepare('UPDATE user_asset_rel SET is_deleted = 0 WHERE id = ?').run(existing.id);
        return 'restored';
      }
      return 'kept';
    }

    if (existing && existing.is_deleted === 0) {
      db.prepare('UPDATE user_asset_rel SET is_deleted = 1 WHERE id = ?').run(existing.id);
      return 'soft_deleted';
    }
    return 'noop';
  });

  return { action: run(), totalQuantity };
}

export async function registerTradeRoutes(app: FastifyInstance) {
  // 录入交易
  app.post('/api/trade', async (request, reply) => {
    try {
      const body = request.body as {
asset_code: string;
        trade_type: 'buy' | 'sell' | 'reduce' | 'clear' | 'dividend' | 'bonus' | 'transfer';
        trade_date: string;
        trade_time?: string;   // T87：秒级 HH:mm:ss，必填无默认
        quantity: number;
        price: number;
        fee?: number;
        trade_reason?: string;
        remark?: string;
        system_followed?: number;  // T39: 由信号触发的导入（cron 自动导入）
      };
      const user = (request as any).user as { sub: number; username: string; role: string };
      if (!body?.asset_code || !body?.trade_type || !body?.trade_date ||
          body.quantity == null || body.price == null) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '必要字段缺失'));
      }
      // T87：trade_time 必填且格式合法
      if (!validateTradeTime(body.trade_time)) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_time 必填，格式 HH:mm:ss（秒级）'));
      }
      if (body.quantity <= 0 || body.price < 0) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '数量>0、价格>=0'));
      }
      if (!['buy', 'sell', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'].includes(body.trade_type)) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_type 非法'));
      }

      const AUTO_IMPORT_TYPES = new Set(['dividend', 'bonus', 'transfer']);
      const NEED_REASON_TYPES = new Set(['buy', 'sell', 'reduce', 'clear']);
      let tradeReason: string | null;
      if (AUTO_IMPORT_TYPES.has(body.trade_type)) {
        tradeReason = body.trade_reason ?? `自动导入 - ${body.trade_date} ${body.trade_type}`;
      } else if (NEED_REASON_TYPES.has(body.trade_type)) {
        if (!body.trade_reason?.trim()) {
          return reply.code(400).send(fail(400, 'TRADE_REASON_REQUIRED', 'trade_reason 必填，说明本次交易原因'));
        }
        tradeReason = body.trade_reason.trim();
      } else {
        tradeReason = body.trade_reason ?? null;
      }

      if (REDUCE_TYPES.has(body.trade_type)) {
        // T84（P0-13）：必须传 trade_date —— 以卖出发生时点回放，
        // 否则尚未发生的买入会支撑更早的卖出（日期交错绕过校验）
        if (!validateSufficientHolding(user.sub, body.asset_code, body.quantity, body.trade_date, body.trade_time)) {
          // B-10 裁决：HOLDING_INSUFFICIENT = HTTP 409（非 400）
          return reply.code(409).send(fail(409, 'HOLDING_INSUFFICIENT', `持仓不足：无法${body.trade_type} ${body.asset_code}`));
        }
      }

      const db = ConfigStore.getInstance().db;
      const info = db.prepare(
        `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, remark, system_followed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.sub, body.asset_code, body.trade_type, body.trade_date, body.trade_time,
        body.quantity, body.price, body.fee ?? 0, tradeReason, body.remark ?? null,
        body.system_followed ?? null
      );

      writeSystemLog({
        logType: 'trade', level: 'SUCCESS',
        message: `录入${body.trade_type} ${body.asset_code} qty=${body.quantity} price=${body.price}`,
      });

      // T58：同步 hold 关系（清仓 → 软删；买入/加仓 → 建立或恢复）
      const holdRel = syncHoldRelation(user.sub, body.asset_code);

      reply.code(201).send(ok({
          trade_id: info.lastInsertRowid,
          position: calcPosition(user.sub, body.asset_code),
          hold_rel: holdRel,
        }));
    } catch (err: any) {
      if (String(err).includes('UNIQUE')) {
        return reply.code(409).send(fail(409, 'TRADE_DUPLICATE', '同日同标的同方向交易已存在'));
      }
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 查询交易记录（T39: 增强筛选+分页）
  app.get('/api/trade', async (request, reply) => {
    try {
      const user = (request as any).user;
      const q = request.query as any;
      const assetCode = q.asset_code as string | undefined;
      const tradeType = q.trade_type as string | undefined;
      const startDate = q.start_date as string | undefined;
      const endDate = q.end_date as string | undefined;
      const systemFollowed = q.system_followed as string | undefined;
      const strategyMatch = q.strategy_match as string | undefined;
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
      if (strategyMatch !== undefined) { conditions.push('strategy_match = ?'); params.push(Number(strategyMatch)); }
      if (isStopLoss !== undefined) { conditions.push('is_stop_loss = ?'); params.push(Number(isStopLoss)); }
      if (hasReview === 'true') { conditions.push(`(review_summary IS NOT NULL AND review_summary != '') OR strategy_match IS NOT NULL OR is_stop_loss IS NOT NULL`); }
      if (hasReview === 'false') { conditions.push(`(review_summary IS NULL OR review_summary = '') AND strategy_match IS NULL AND is_stop_loss IS NULL`); }

      const where = conditions.join(' AND ');
      const db = ConfigStore.getInstance().db;

      // 先拿总数
      const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM user_trade_record WHERE ${where} AND is_deleted = 0`).get(...params) as { cnt: number };

      // 分页查询
      const rows = db.prepare(
        `SELECT * FROM user_trade_record WHERE ${where} AND is_deleted = 0
         ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as any[];

      reply.send(ok(rows, { pagination: { page, limit, total: countRow.cnt, totalPages: Math.ceil(countRow.cnt / limit) } }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T39: PATCH 复盘字段（只允许改 review_note/strategy_match/is_stop_loss/remark）
  app.patch('/api/trade/:id', async (request, reply) => {
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
      return reply.code(400).send(fail(400, 'PARAM_INVALID', '无有效更新字段'));
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
      reply.send(ok(null));
    } catch (err: any) {
      if (String(err).includes('no such column')) {
        return reply.code(500).send(fail(500, 'DB_UNAVAILABLE', 'DDL 未就绪，请联系管理员'));
      }
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T39: 软删除交易
  app.post('/api/trade/:id/soft-delete', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const db = ConfigStore.getInstance().db;
    const info = db.prepare(
      `UPDATE user_trade_record SET is_deleted = 1 WHERE id = ? AND user_id = ? AND is_deleted = 0`
    ).run(tradeId, user.sub);
    if (info.changes === 0) {
      return reply.code(404).send(fail(404, 'NOT_FOUND', defaultMessage('NOT_FOUND')));
    }
    // T58：软删交易后同步 hold 关系（删掉的是买入 → 持仓归零 → 软删 hold）
    const row = db.prepare('SELECT asset_code FROM user_trade_record WHERE id = ?').get(tradeId) as
      { asset_code: string } | undefined;
    const holdRel = row ? syncHoldRelation(user.sub, row.asset_code) : null;
    writeSystemLog({
      logType: 'trade', level: 'INFO',
      message: `${user.username} 软删除交易 id=${tradeId}`,
      detail: holdRel ? JSON.stringify(holdRel) : undefined,
    });
    reply.send(ok({ hold_rel: holdRel }));
  });

  // T39: 恢复软删除
  app.post('/api/trade/:id/restore', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const db = ConfigStore.getInstance().db;
    const info = db.prepare(
      `UPDATE user_trade_record SET is_deleted = 0 WHERE id = ? AND user_id = ? AND is_deleted = 1`
    ).run(tradeId, user.sub);
    if (info.changes === 0) {
      return reply.code(404).send(fail(404, 'NOT_FOUND', defaultMessage('NOT_FOUND')));
    }
    // T58：恢复交易 → 持仓回升 → hold 关系恢复
    const row = db.prepare('SELECT asset_code FROM user_trade_record WHERE id = ?').get(tradeId) as
      { asset_code: string } | undefined;
    const holdRel = row ? syncHoldRelation(user.sub, row.asset_code) : null;
    writeSystemLog({
      logType: 'trade', level: 'INFO',
      message: `${user.username} 恢复交易 id=${tradeId}`,
      detail: holdRel ? JSON.stringify(holdRel) : undefined,
    });
    reply.send(ok({ hold_rel: holdRel }));
  });

  // 查询单个标的持仓
  app.get('/api/holding/:asset_code', async (request, reply) => {
    try {
      const user = (request as any).user;
      const assetCode = (request.params as any).asset_code as string;
      const pos = calcPosition(user.sub, assetCode);
      reply.send(ok({ asset_code: assetCode, ...pos }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 查询全部持仓（T33：带现价 / 市值 / 盈亏 / 仓位占比，供仪表盘持仓卡使用）
  app.get('/api/holding', async (request, reply) => {
    try {
      const user = (request as any).user;
      const positions = calcAllPositions(user.sub);
      if (positions.length === 0) {
        return reply.send(ok([]));
      }

      // 1 次 IN 查询拿全量最新价（AGENTS.md DuckDB 硬约束：禁止逐标的循环查）
      let latest: Map<string, { date: string; close: number }> = new Map();
      let priceDate: string | null = null;
      try {
        latest = await batchGetLatestClose(positions.map(p => p.asset_code));
        const dates = new Set([...latest.values()].map(v => v.date));
        priceDate = dates.size === 1 ? [...dates][0] : null;
      } catch (err: any) {
        // DuckDB 不可用不阻塞持仓展示，前端降级为"无现价"
        app.log.warn({ err }, '持仓现价查询失败，降级为无现价');
      }

      // 市值合计 → 每只标的的仓位占比
      const enriched = positions.map((p) => {
        const quote = latest.get(p.asset_code);
        const currentPrice = quote?.close ?? null;
        const marketValue = currentPrice !== null ? currentPrice * p.totalQuantity : null;
        const unrealizedPnl = marketValue !== null ? marketValue - p.totalCostBasis : null;
        const unrealizedYield = p.totalCostBasis > 0 && unrealizedPnl !== null
          ? unrealizedPnl / p.totalCostBasis
          : null;
        return { ...p, currentPrice, priceDate: quote?.date ?? null, marketValue, unrealizedPnl, unrealizedYield };
      });

      const totalMarketValue = enriched.reduce((s, p) => s + (p.marketValue ?? 0), 0);
      const withWeight = enriched.map(p => ({
        ...p,
        weight: totalMarketValue > 0 && p.marketValue !== null ? p.marketValue / totalMarketValue : null,
      }));

      // T89a：summary 是**顶层**字段（前端 Dashboard.tsx 读 `res.data.summary`）
      return reply.send(ok(withWeight, {
        summary: {
          totalMarketValue,
          totalCostBasis: withWeight.reduce((s, p) => s + p.totalCostBasis, 0),
          unrealizedPnl: withWeight.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0),
          realizedPnl: withWeight.reduce((s, p) => s + p.realizedPnL, 0),
          priceDate,
          positionCount: withWeight.length,
        },
      }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
