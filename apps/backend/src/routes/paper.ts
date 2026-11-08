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
}
