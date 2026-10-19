/**
 * candidates.ts —— 候选池批量接口（T56）
 *
 * `POST /api/candidates/batch`（SDD §4.4 计划新增路由，T90 负责登记进契约表）
 *
 * 契约（T56 卡片）：
 *   - body `{ asset_codes: string[] }`，单次上限 **100**
 *   - 整个写入包在 `db.transaction()` 里
 *   - `INSERT OR IGNORE` 幂等：重复项进 `duplicates`，**不报错**
 *   - 返回 `{ added, skipped, duplicates[] }`
 *   - 写 `system_log`
 *
 * ⚠️ 基准价：T56 卡片**未要求**批量解析基准价，故本接口不查 DuckDB，
 *   入池记录的 `candidate_base_price` 为 NULL → GET 侧 `relative_return` 返 null。
 *   与 Requirements §5.7 #3「每次加入固化基准价」存在缺口，已上报，**不在本任务擅自补**。
 *
 * ⚠️ `system_log.log_type` 的 CHECK 是固定白名单（`configStore.ts:120-123`），
 *   没有 `candidate_batch`。新增 log_type 需改 configStore 的幂等表重建 —— 越界，
 *   故此处用语义最接近的 **`trigger_manual`（用户手动触发）**。
 */

import type { FastifyInstance } from 'fastify';
import {
  MAX_BATCH_CANDIDATES,
  MAX_REASON_LENGTH,
  isValidAssetCode,
  batchInsertCandidates,
  requireUser,
} from '../services/candidateService.js';
import { writeSystemLog } from '../services/logger.js';

interface BatchCandidateBody {
  asset_codes?: unknown;
  /** 可选：整批共用的加入理由 */
  candidate_reason?: unknown;
}

export async function registerBatchCandidateRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/candidates/batch', async (request, reply) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as BatchCandidateBody;

    // ── 参数校验：先类型后内容，全部 400 PARAM_INVALID ──
    if (!Array.isArray(body.asset_codes)) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: 'asset_codes 必填且必须是数组',
      });
    }
    if (body.asset_codes.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: 'asset_codes 不能为空数组',
      });
    }
    if (body.asset_codes.length > MAX_BATCH_CANDIDATES) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: `asset_codes 单次最多 ${MAX_BATCH_CANDIDATES} 条，当前 ${body.asset_codes.length} 条`,
      });
    }
    const invalid = body.asset_codes.filter((c) => !isValidAssetCode(c));
    if (invalid.length > 0) {
      return reply.code(400).send({
        success: false,
        error: 'PARAM_INVALID',
        message: `以下标���格式非法（应为 sh600000 / sz000001）: ${invalid.join(', ')}`,
      });
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

    // ── 事务写入（服务层内 db.transaction() 包裹，失败整批回滚）──
    let result: ReturnType<typeof batchInsertCandidates>;
    try {
      result = batchInsertCandidates(user.sub, body.asset_codes as string[], reason);
    } catch (err) {
      // 事务已回滚，此处只记录日志并向上抛业务错误
      writeSystemLog({
        logType: 'trigger_manual',
        level: 'ERROR',
        message: `${user.username} 候选池批量入池失败（已回滚）`,
        detail: JSON.stringify({ requested: body.asset_codes.length, error: String(err) }),
      });
      throw err;
    }

    writeSystemLog({
      logType: 'trigger_manual',
      level: 'INFO',
      message: `${user.username} 候选池批量入池：新增 ${result.added} 条，跳过 ${result.skipped} 条`,
      detail: JSON.stringify({
        requested: body.asset_codes.length,
        added: result.added,
        skipped: result.skipped,
        duplicates: result.duplicates,
      }),
    });

    return reply.code(201).send({ success: true, data: result });
  });
}