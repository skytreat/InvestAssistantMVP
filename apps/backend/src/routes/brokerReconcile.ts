/**
 * V3.1（T126）broker-reconcile 路由 —— SDD_v3 §9.2
 * - POST /api/broker-reconcile/run    触发一次对账（重算去重/回填/归因，幂等）
 * - GET  /api/broker-reconcile/latest 最近一次对账报告（D-25：按需重算，事实层为唯一真相源）
 * - GET  /api/broker-reconcile/diff   差异明细（分页 + 按归因类别下钻）
 */
import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { ok, fail } from '../lib/envelope.js';
import { buildReconcileReport, attributionDrilldown } from '../services/broker/brokerReconcileReport.js';

function userIdOf(request: { user?: { sub?: number | string } }): number {
  return Number(request.user?.sub ?? 0);
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
}
