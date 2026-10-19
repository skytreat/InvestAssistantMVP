/**
 * candidate.ts —— 候选池 HTTP 路由（T50：基准价固化 + 迁移价格模式）
 *
 * 覆盖 SDD §4.4「候选池 `/api/candidate/*` → 用户/admin，增删 + 迁移」，
 * 在 T50 之上补齐 Requirements §5.7 的两条：
 *   - 加入时固化基准价（加入日前复权收盘价，或用户显式指定）
 *   - 迁移时记录价格模式（'base' 复用基准价 / 'current' 用当前现价）
 *
 * ⚠️ 与 `routes/watch.ts` 的并存说明：
 *   `watch.ts:17` 的 `_crud(app, 'candidate')` 也注册了同名路径。本文件按 T50 要求
 *   独立实现基准价/price_mode 语义；**同一 Fastify 实例上二者不可同时注册**
 *   （Fastify 路由冲突）。路由归属收敛属 T90 范畴，本文件不做越界改动。
 *
 * 响应体沿用仓库现状的 `{ success, data }` / `{ success: false, error, message }`
 * 约定 —— `lib/envelope.ts`（T89a）尚未落地，不在本任务范围内。
 */

import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import {
  CandidateNotFoundError,
  MAX_REASON_LENGTH,
  QuoteSourceUnavailableError,
  QuoteUnavailableError,
  isValidAssetCode,
  isValidBasePrice,
  listCandidatesWithReturn,
  markCandidateMigrated,
  requireUser,
  resolveBasePrices,
} from '../services/candidateService.js';
import type { PriceMode } from '../services/candidateService.js';
import { writeSystemLog } from '../services/logger.js';

interface CreateCandidateBody {
  asset_code?: unknown;
  candidate_reason?: unknown;
  candidate_base_price?: unknown;
}

interface PromoteBody {
  price_mode?: unknown;
}

/** `price_mode` 白名单（DDL CHECK 同样是 IN ('base','current')） */
const PRICE_MODES: readonly string[] = ['base', 'current'];

export async function registerCandidateRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/candidate —— 列表（含基准价 + 相对收益）──
  app.get('/api/candidate', async (request, reply) => {
    const user = requireUser(request);
    const items = await listCandidatesWithReturn(user.sub);
    return reply.send({ success: true, data: items });
  });

  // ── POST /api/candidate —— 新增候选（固化基准价）──
  app.post('/api/candidate', async (request, reply) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as CreateCandidateBody;

    if (!isValidAssetCode(body.asset_code)) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: 'asset_code 必填且格式应为 sh600000 / sz000001',
      });
    }

    const assetCode = body.asset_code;

    // candidate_base_price：缺省 = 走行情库；给了就必须合法（NaN/Infinity/<=0 一律拒绝）
    const hasOverride = body.candidate_base_price !== undefined && body.candidate_base_price !== null;
    const overrides = new Map<string, number>();
    if (hasOverride) {
      if (!isValidBasePrice(body.candidate_base_price)) {
        return reply.code(400).send({
          success: false,
          error: 'PARAM_INVALID',
          message: 'candidate_base_price 必须是大于 0 的有限数值',
        });
      }
      overrides.set(assetCode, body.candidate_base_price);
    }

    let reason: string | null = null;
    if (body.candidate_reason !== undefined && body.candidate_reason !== null) {
      if (typeof body.candidate_reason !== 'string') {
        return reply.code(400).send({
          success: false,
          error: 'PARAM_INVALID',
          message: 'candidate_reason 必须是字符串',
        });
      }
      reason = body.candidate_reason.trim();
      if (reason.length > MAX_REASON_LENGTH) {
        return reply.code(400).send({
          success: false,
          error: 'PARAM_INVALID',
          message: `candidate_reason 不得超过 ${MAX_REASON_LENGTH} 字符`,
        });
      }
      if (reason === '') reason = null;
    }

    // 基准价解析：显式传了直接用；否则 1 次 DuckDB 批量查加入日前复权收盘价
    let resolved: Awaited<ReturnType<typeof resolveBasePrices>>;
    try {
      resolved = await resolveBasePrices([assetCode], overrides);
    } catch (err) {
      if (err instanceof QuoteUnavailableError) {
        return reply.code(404).send({
          success: false,
          error: 'SYMBOL_NOT_FOUND',
          message: `${err.message}；可显式传入 candidate_base_price 手动指定基准价`,
          data: { missing_symbols: err.symbols },
        });
      }
      if (err instanceof QuoteSourceUnavailableError) {
        return reply.code(503).send({
          success: false,
          error: 'EXTERNAL_SOURCE_UNAVAILABLE',
          message: err.message,
        });
      }
      throw err;
    }

    const base = resolved.get(assetCode);
    /* c8 ignore next */
    if (base === undefined) throw new Error('resolveBasePrices 未返回结果（内部一致性错误）');

    const db = ConfigStore.getInstance().db;
    try {
      const info = db
        .prepare(
          `INSERT INTO user_asset_rel (user_id, asset_code, rel_type, candidate_reason, candidate_base_price)
           VALUES (?, ?, 'candidate', ?, ?)`,
        )
        .run(user.sub, assetCode, reason, base.basePrice);

      return reply.code(201).send({
        success: true,
        data: {
          id: info.lastInsertRowid,
          asset_code: assetCode,
          rel_type: 'candidate',
          candidate_reason: reason,
          candidate_base_price: base.basePrice,
          candidate_base_price_date: base.basePriceDate,
          base_price_source: base.source,
        },
      });
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        return reply.code(409).send({
          success: false,
          error: 'DUPLICATE',
          message: `${assetCode} 已在 candidate 列表`,
        });
      }
      throw err;
    }
  });

  // ── POST /api/candidate/:asset_code/promote —— 迁移到自选（只打标记）──
  app.post('/api/candidate/:asset_code/promote', async (request, reply) => {
    const user = requireUser(request);
    const params = request.params as { asset_code?: string };
    const assetCode = params.asset_code;

    if (!isValidAssetCode(assetCode)) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: 'asset_code 格式应为 sh600000 / sz000001',
      });
    }

    const body = (request.body ?? {}) as PromoteBody;
    if (typeof body.price_mode !== 'string' || !PRICE_MODES.includes(body.price_mode)) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: "price_mode 必填且只能为 'base' 或 'current'",
      });
    }
    const priceMode = body.price_mode as PriceMode;

    try {
      const row = markCandidateMigrated(user.sub, assetCode, priceMode);
      // 🔴 T92：原实现用 `log_type='trade'` 记录候选迁移 —— **误用**（这不是交易）。
      //   改用专用的 `candidate_migrate`（system_log.log_type CHECK 已扩该值）。
      writeSystemLog({
        logType: 'candidate_migrate',
        level: 'INFO',
        message: `${user.username} ${assetCode} 从 candidate 迁移到 watch（price_mode=${priceMode}）`,
        detail: JSON.stringify({ assetCode, priceMode, marked: true, autoCreated: false }),
      });
      return reply.send({
        success: true,
        data: {
          asset_code: assetCode,
          from: 'candidate',
          to: 'watch',
          price_mode: priceMode,
          marked: true,
          // PRD S5：MVP 迁移候选到自选**只打标记**，不自动创建自选关联
          autoCreated: false,
          message: '已标记为迁移完成；不会自动加入自选，需手动从候选池加入自选',
          candidate: row,
        },
      });
    } catch (err) {
      if (err instanceof CandidateNotFoundError) {
        return reply.code(404).send({
          success: false,
          error: 'SYMBOL_NOT_FOUND',
          message: err.message,
        });
      }
      throw err;
    }
  });
}