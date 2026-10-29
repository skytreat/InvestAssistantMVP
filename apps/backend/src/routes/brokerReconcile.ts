/**
 * V3.1~V3.2 broker-reconcile 路由 —— SDD_v3 §9.2 / §9.3
 * - POST /api/broker-reconcile/run        触发一次对账（重算去重/回填/归因，幂等）
 * - GET  /api/broker-reconcile/latest     最近一次对账报告（D-25：按需重算，事实层为唯一真相源）
 * - GET  /api/broker-reconcile/diff       差异明细（分页 + 按归因类别下钻）
 * - POST /api/broker-reconcile/confirm    T129 确认补录（批量 + 逐条可修正；admin）
 * - POST /api/broker-reconcile/diff/:id/match  T129 标记「已手工记录」（admin）
 *
 * 🔴 权限（SDD_v3 §10.3）：**导入与补录仅 admin**（补录会改业务数据）。
 */
import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { ok, fail } from '../lib/envelope.js';
import { buildReconcileReport, attributionDrilldown } from '../services/broker/brokerReconcileReport.js';
import {
  confirmTrades,
  markAsManuallyRecorded,
  CONFIRMABLE_TRADE_TYPES,
  type ConfirmItem,
} from '../services/broker/brokerConfirm.js';

function userIdOf(request: { user?: { sub?: number | string } }): number {
  return Number(request.user?.sub ?? 0);
}

/** SDD §10.3：写操作仅 admin（补录会改业务数据） */
function ensureAdmin(request: { user?: { sub?: number | string; role?: string } }): boolean {
  return request.user?.role === 'admin';
}

export async function registerBrokerReconcileRoutes(app: FastifyInstance) {
  app.post('/api/broker-reconcile/run', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const body = (request.body ?? {}) as { brokerCode?: string };
    if (!body?.brokerCode?.trim()) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode'));
    }
    const db = ConfigStore.getInstance().db;
    const has = db
      .prepare(
        `SELECT 1 AS x FROM broker_trade_record WHERE user_id = ? AND broker_code = ? AND is_deleted = 0 LIMIT 1`,
      )
      .get(userId, body.brokerCode.trim());
    if (!has) {
      return reply.code(404).send(fail(404, 'BROKER_NO_DATA', '该券商无已导入事实层记录'));
    }
    const report = buildReconcileReport(db, userId, body.brokerCode.trim());
    return ok(report);
  });

  app.get('/api/broker-reconcile/latest', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const q = request.query as { brokerCode?: string };
    if (!q.brokerCode?.trim()) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode'));
    }
    const db = ConfigStore.getInstance().db;
    const has = db
      .prepare(
        `SELECT 1 AS x FROM broker_trade_record WHERE user_id = ? AND broker_code = ? AND is_deleted = 0 LIMIT 1`,
      )
      .get(userId, q.brokerCode.trim());
    if (!has) {
      return reply.code(404).send(fail(404, 'BROKER_NO_DATA', '该券商无已导入事实层记录'));
    }
    return ok(buildReconcileReport(db, userId, q.brokerCode.trim()));
  });

  app.get('/api/broker-reconcile/diff', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const q = request.query as { brokerCode?: string; category?: string; page?: string; pageSize?: string };
    if (!q.brokerCode?.trim()) return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode'));
    const category = (q.category ?? 'unmatched') as
      'repo' | 'cashLikeEtf' | 'dividend' | 'offExchange' | 'unknown' | 'unmatched';
    if (!['repo', 'cashLikeEtf', 'dividend', 'offExchange', 'unknown', 'unmatched'].includes(category)) {
      return reply
        .code(400)
        .send(
          fail(
            400,
            'INVALID_CATEGORY',
            `category 须为 repo|cashLikeEtf|dividend|offExchange|unknown|unmatched`,
          ),
        );
    }
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const r = attributionDrilldown(
      ConfigStore.getInstance().db,
      userId,
      q.brokerCode.trim(),
      category,
      page,
      pageSize,
    );
    return ok(r, { pagination: { page, pageSize, total: r.total } });
  });

  /**
   * T129 ① 补录确认（SDD_v3 §9.3 / INV-S2-33~36、INV-S3-6~9）
   *
   * body: { brokerCode, items: [{ sourceId, tradeType? }, ...] }（≤500 条）
   * - tradeType 缺省 → 系统推导（有 balance_after 单行判定；无 → 按券商分组回放）
   * - tradeType 给定 → 用户修正优先，落库后不再被自动覆盖（INV-S3-9）
   * - 一次确认整体一个事务，部分失败全回滚（G5）
   * - 成交时间缺失留空（INV-S2-36）；补充事实以 source_broker_record_id 可回溯（G3）
   */
  app.post('/api/broker-reconcile/confirm', async (request, reply) => {
    const req = request as { user?: { sub?: number; role?: string } };
    const userId = userIdOf(req);
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    if (!ensureAdmin(req))
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可补录（SDD §10.3）'));
    const body = (request.body ?? {}) as { brokerCode?: string; items?: ConfirmItem[] };
    if (!body?.brokerCode?.trim()) return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode'));
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return reply.code(400).send(fail(400, 'INVALID_BODY', 'items 不能为空'));
    if (items.length > 500) return reply.code(400).send(fail(400, 'INVALID_BODY', '单次补录 ≤ 500 条'));
    const sourcesClean = items.every((i) => Number.isFinite(Number(i?.sourceId)) && Number(i.sourceId) > 0);
    if (!sourcesClean) return reply.code(400).send(fail(400, 'INVALID_BODY', 'items[].sourceId 非法'));

    const db = ConfigStore.getInstance().db;
    try {
      const result = await confirmTrades(db, userId, body.brokerCode.trim(), items);
      return ok(result);
    } catch (err: any) {
      // UNIQUE 撞 B/C 锚 → 结构化 409；不外泄裸 SQLite 报错（AGENTS 错误处理约定）
      if (String(err).includes('UNIQUE')) {
        return reply
          .code(409)
          .send(
            fail(409, 'BROKER_CONFIRM_CONFLICT', '补录冲突：同一事实行/同内容已存在活记录，事务已整体回滚'),
          );
      }
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  /**
   * T129 ② 标记「已手工记录」（SDD_v3 §9.3 /diff/:id/match）
   *
   * body: { tradeRecordId } —— 关联到既有 user_trade_record（须属当前用户、标的一致）
   * 事实层**不被软删**（INV-S2-35），业务层不动；仅 match_status → MATCHED。
   */
  app.post('/api/broker-reconcile/diff/:id/match', async (request, reply) => {
    const req = request as { user?: { sub?: number; role?: string } };
    const userId = userIdOf(req);
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    if (!ensureAdmin(req))
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可标记（SDD §10.3）'));
    const factId = Number((request.params as { id?: string }).id);
    if (!Number.isFinite(factId) || factId <= 0) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', 'id 非法'));
    }
    const body = (request.body ?? {}) as { tradeRecordId?: number | null };
    const tradeRecordId = body?.tradeRecordId == null ? null : Number(body.tradeRecordId);
    if (tradeRecordId != null && (!Number.isFinite(tradeRecordId) || tradeRecordId <= 0)) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', 'tradeRecordId 非法'));
    }
    const db = ConfigStore.getInstance().db;
    const r = markAsManuallyRecorded(db, userId, factId, tradeRecordId);
    if (!r.ok) return reply.code(404).send(fail(404, 'NOT_FOUND', r.reason ?? '无法标记'));
    return ok({ sourceId: factId, tradeRecordId });
  });
}

/** T129 补录可修正类型的白名单（对外暴露给 envelope 遍历表 / 前端） */
export const BROKER_CONFIRM_TRADE_TYPES = CONFIRMABLE_TRADE_TYPES;
