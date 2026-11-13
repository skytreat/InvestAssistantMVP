/**
 * 纸面账户路由（PA-07 / PA-06）
 *
 * 鉴权：走 `routes/index.ts` 的全局 JWT 钩子；`user.sub` 即 `user_id`。
 * 归属：所有读写都以 `user_id` 过滤，跨用户访问一律 404（不泄露存在性）。
 *
 * ⚠️ 切阶段是**危险操作**：`confirm` 由服务层再校验一次（前端弹窗不能作为唯一防线）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { ok, fail } from '../lib/envelope.js';
import { batchGetSymbolNames } from '../services/marketData.js';
import { PaperStore } from '../services/paper/store.js';
import { PaperError } from '../services/paper/errors.js';
import {
  changePaperPhase,
  closePaperAccount,
  createPaperAccount,
  getPaperAccount,
  listPaperAccounts,
} from '../services/paper/accountService.js';
import {
  createFeeConfig,
  deleteFeeConfig,
  listFeeConfigs,
  updateFeeConfig,
  type FeeConfigInput,
} from '../services/paper/fees.js';
import { listPaperStrategies } from '../services/paper/strategies.js';
import {
  getPaperReport,
  listPaperEquity,
  listPaperOrders,
  listPaperPositions,
  type PaperOrderDto,
} from '../services/paper/report.js';

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaperError) {
    return reply.code(err.status).send(fail(err.status, err.code, err.message));
  }
  reply.log.error({ err }, 'paper account error');
  return reply.code(500).send(fail(500, 'INTERNAL', '纸面账户服务异常'));
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PaperError('PARAM_INVALID', 400, `非法 id: ${raw}`);
  }
  return id;
}

/**
 * 为订单 / 持仓补标的中文名（行情层 `raw_symbol_name`，**1 次 IN 查询**）
 *
 * 与 `routes/review.ts` / `routes/signal.ts` 同口径：
 * - 名称是**装饰信息** —— 行情库不可用 / 该标的无名称时 `assetName = null`，
 *   前端回退为只显示代码，**不让整个纸面账户页 500**；
 * - 名称覆盖率约 70%（`raw_symbol_name` 只有 8726 行），**查不到是常态**。
 *
 * ⚠️ 补名只在**路由层**做（不污染 `services/paper/*` 的纯 DB DTO），
 *    业务层仍然只读 SQLite、不碰行情层。
 */
async function attachAssetNames<T extends { assetCode: string }>(
  rows: readonly T[],
): Promise<Array<T & { assetName: string | null }>> {
  let names = new Map<string, string>();
  try {
    names = await batchGetSymbolNames(rows.map((r) => r.assetCode));
  } catch {
    // 行情库不可用 → 只显示代码
  }
  return rows.map((r) => ({ ...r, assetName: names.get(r.assetCode) ?? null }));
}

export async function registerPaperRoutes(app: FastifyInstance) {
  const store = () => PaperStore.getInstance();

  // ── 元信息 ──
  app.get('/api/paper/strategies', async (_req, reply) => {
    reply.send(ok(listPaperStrategies()));
  });

  // ── 费用配置 CRUD ──
  app.get('/api/paper/fee-configs', async (request, reply) => {
    const user = (request as any).user;
    reply.send(ok(listFeeConfigs(store().db, user.sub)));
  });

  app.post('/api/paper/fee-configs', async (request, reply) => {
    const user = (request as any).user;
    try {
      const body = request.body as FeeConfigInput;
      const created = createFeeConfig(store().db, user.sub, body);
      reply.code(201).send(ok(created));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/paper/fee-configs/:id', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      const body = request.body as Partial<FeeConfigInput>;
      reply.send(ok(updateFeeConfig(store().db, user.sub, id, body)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/paper/fee-configs/:id', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      deleteFeeConfig(store().db, user.sub, id);
      reply.send(ok({ id }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 账户 ──
  app.get('/api/paper/accounts', async (request, reply) => {
    const user = (request as any).user;
    reply.send(ok(listPaperAccounts(store().db, user.sub)));
  });

  app.post('/api/paper/accounts', async (request, reply) => {
    const user = (request as any).user;
    try {
      const body = request.body as {
        strategyId?: string;
        strategyVersion?: string;
        params?: Record<string, unknown>;
        initialCash?: number;
        name?: string;
        feeConfigId?: number | null;
      };
      const created = createPaperAccount(store().db, ConfigStore.getInstance().db, {
        userId: user.sub,
        strategyId: body?.strategyId ?? '',
        strategyVersion: body?.strategyVersion ?? '',
        params: body?.params,
        initialCash: body?.initialCash ?? 0,
        name: body?.name,
        feeConfigId: body?.feeConfigId,
      });
      reply.code(201).send(ok(created));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/paper/accounts/:id', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      reply.send(ok(getPaperAccount(store().db, user.sub, id)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // 手动切换阶段 —— 页面按钮的唯一入口（单向 shadow → ledger，冷启动）
  app.post('/api/paper/accounts/:id/phase', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      const body = request.body as { to?: 'shadow' | 'ledger'; confirm?: boolean };
      const updated = await changePaperPhase(store().db, user.sub, id, {
        to: body?.to ?? 'shadow',
        confirm: body?.confirm === true,
      });
      reply.send(ok(updated));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/paper/accounts/:id/close', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      reply.send(ok(closePaperAccount(store().db, user.sub, id)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ── 只读报告（PA-09）：影子期看信号质量，落账期看净值 / 持仓 / 订单 ──
  app.get('/api/paper/accounts/:id/orders', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      const q = request.query as { decisionDate?: string; status?: string; limit?: string };
      const statuses = q.status
        ? (q.status
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as PaperOrderDto['status'][])
        : undefined;
      reply.send(
        ok(
          await attachAssetNames(
            listPaperOrders(store().db, user.sub, id, {
              decisionDate: q.decisionDate,
              statuses,
              limit: q.limit ? Number(q.limit) : undefined,
            }),
          ),
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/paper/accounts/:id/positions', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      reply.send(ok(await attachAssetNames(listPaperPositions(store().db, user.sub, id))));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/paper/accounts/:id/equity', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      const q = request.query as { from?: string; to?: string };
      reply.send(ok(listPaperEquity(store().db, user.sub, id, { from: q.from, to: q.to })));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/paper/accounts/:id/report', async (request, reply) => {
    const user = (request as any).user;
    try {
      const id = parseId((request.params as { id: string }).id);
      const q = request.query as { from?: string; to?: string };
      const report = await getPaperReport(store().db, user.sub, id, { from: q.from, to: q.to });
      // 补标的中文名（装饰信息）：影子期的目标清单 + 落账期的持仓
      const enriched = { ...report };
      if (report.shadow) {
        enriched.shadow = {
          ...report.shadow,
          latestTargets: await attachAssetNames(report.shadow.latestTargets),
        };
      }
      if (report.ledger) {
        enriched.ledger = {
          ...report.ledger,
          positions: await attachAssetNames(report.ledger.positions),
        };
      }
      reply.send(ok(enriched));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
