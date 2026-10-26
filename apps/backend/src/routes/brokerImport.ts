/**
 * V3.1（T122）broker-import 路由 —— SDD_v3 §9.1
 *
 * 语义边界（ADR-013）：confirm 只写**事实层**（broker_trade_record + 批次），
 * 不写 `user_trade_record`（业务记录由 T129 补录显式产生）。
 *
 * 上传通道：base64 JSON（D-19：零新依赖；10MB 上限 = 约 13.3MB JSON，MVP 够用）。
 * 文件类型**按内容探测**（解析器），文件名 / 扩展名不可信（SDD §3.2）。
 */
import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { ok, fail } from '../lib/envelope.js';
import { parseBrokerFile } from '../services/broker/brokerParser.js';
import {
  importBrokerFile,
  revokeBatch,
  listBatches,
  saveTemplate,
  getTemplate,
} from '../services/broker/brokerImport.js';
import type { BrokerFileInput } from '../services/broker/types.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // SDD §3：上传 10MB 上限，扩展名不可信 → 以内容嗅探为准

interface UploadBody {
  filename?: string;
  fileBase64?: string;
  brokerCode?: string;
}

function toInput(body: UploadBody): {
  input?: BrokerFileInput;
  err?: { code: number; body: ReturnType<typeof fail> };
} {
  if (!body.fileBase64) {
    return { err: { code: 400, body: fail(400, 'INVALID_BODY', '缺少 fileBase64') } };
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(body.fileBase64, 'base64');
  } catch {
    return { err: { code: 400, body: fail(400, 'INVALID_BODY', 'fileBase64 不是合法 base64') } };
  }
  if (buffer.length === 0) return { err: { code: 400, body: fail(400, 'INVALID_BODY', '空文件') } };
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      err: {
        code: 400,
        body: fail(400, 'FILE_TOO_LARGE', `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`),
      },
    };
  }
  return { input: { buffer, filename: body.filename || 'upload', declaredBroker: body.brokerCode } };
}

/** 鉴权后取 userId（绝不信请求参数，SDD 约定） */
function userIdOf(request: { user?: { sub?: number | string } }): number {
  return Number(request.user?.sub ?? 0);
}

export async function registerBrokerImportRoutes(app: FastifyInstance) {
  // 上传 → 探测 + 预览 + 映射建议（**不落库**，SDD §9.1）
  app.post('/api/broker-import/upload', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const body = request.body as UploadBody;
    const got = toInput(body);
    if (got.err) return reply.code(got.err.code).send(got.err.body);
    const input = got.input!;
    const parse = await parseBrokerFile(input);
    if (!parse.ok || parse.fileKind === 'unknown') {
      return reply
        .code(422)
        .send(fail(422, 'BROKER_PARSE_FAILED', parse.errors[0]?.message ?? '无法识别文件类型'));
    }
    return ok({
      fileKind: parse.fileKind,
      encoding: parse.encoding,
      headerRowIndex: parse.headerRowIndex,
      columns: parse.columns,
      mappingSuggestion: parse.mappingSuggestion,
      previewRows: parse.rows.slice(0, 5),
      rowTotal: parse.rows.length,
      warnings: parse.warnings,
    });
  });

  // 预览：按给定映射（模板）重新预览（**不落库**）
  app.post('/api/broker-import/preview', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const body = request.body as UploadBody & { mappingJson?: string };
    const got = toInput(body);
    if (got.err) return reply.code(got.err.code).send(got.err.body);
    const input = got.input!;
    const parse = await parseBrokerFile(input);
    if (!parse.ok)
      return reply.code(422).send(fail(422, 'BROKER_PARSE_FAILED', parse.errors[0]?.message ?? '解析失败'));
    // 映射模板仅调整建议字段（T122⑦ 完整模板化在 T129 前细化），预览仍返回默认建议
    if (body.mappingJson) {
      try {
        JSON.parse(body.mappingJson);
      } catch {
        return reply.code(400).send(fail(400, 'INVALID_MAPPING_JSON', 'mappingJson 不是合法 JSON'));
      }
    }
    return ok({
      fileKind: parse.fileKind,
      columns: parse.columns,
      mappingSuggestion: parse.mappingSuggestion,
      previewRows: parse.rows.slice(0, 5),
      rowTotal: parse.rows.length,
    });
  });

  // 确认导入 → 落事实层 + 批次（**不写 user_trade_record**；SDD §10.3 仅 admin）
  app.post('/api/broker-import/confirm', async (request, reply) => {
    const req = request as { user?: { sub?: number | string; role?: string } };
    const userId = userIdOf(req);
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    if (req.user?.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可导入（SDD §10.3）'));
    const body = request.body as UploadBody;
    if (!body?.brokerCode?.trim()) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode（逻辑券商标识，用户自维护）'));
    }
    const got = toInput(body);
    if (got.err) return reply.code(got.err.code).send(got.err.body);
    const input = got.input!;
    try {
      const r = await importBrokerFile(ConfigStore.getInstance().db, userId, body.brokerCode.trim(), input);
      return ok(r);
    } catch (e) {
      return reply
        .code(422)
        .send(fail(422, 'BROKER_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  });

  // 批次列表（含统计与撤销入口信息）
  app.get('/api/broker-import/batches', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    return ok({ batches: listBatches(ConfigStore.getInstance().db, userId) });
  });

  // 撤销批次（软删事实层；raw_row_json 证据保留；SDD §10.3 仅 admin）
  app.post('/api/broker-import/batches/:id/revoke', async (request, reply) => {
    const req = request as { user?: { sub?: number | string; role?: string } };
    const userId = userIdOf(req);
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    if (req.user?.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可撤销导入（SDD §10.3）'));
    const batchId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(batchId) || batchId <= 0) {
      return reply.code(400).send(fail(400, 'INVALID_BATCH_ID', '批次 id 非法'));
    }
    const affected = revokeBatch(ConfigStore.getInstance().db, userId, batchId);
    if (affected === 0) {
      const exists = listBatches(ConfigStore.getInstance().db, userId).some((b) => b.id === batchId);
      if (!exists) return reply.code(404).send(fail(404, 'BATCH_NOT_FOUND', '批次不存在或已撤销'));
      return ok({ batchId, affectedRows: 0 });
    }
    return ok({ batchId, affectedRows: affected });
  });

  // 列映射模板（GET 读 / POST 存，UNIQUE(user, broker, kind) 幂等）
  app.get('/api/broker-import/templates', async (request, reply) => {
    const userId = userIdOf(request as { user?: { sub?: number | string } });
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    const q = request.query as { brokerCode?: string; fileKind?: string };
    const db = ConfigStore.getInstance().db;
    if (q.brokerCode && (q.fileKind === 'settlement' || q.fileKind === 'trade')) {
      const t = getTemplate(db, userId, q.brokerCode, q.fileKind);
      return ok({ template: t });
    }
    const rows = db
      .prepare(
        `SELECT id, broker_code, file_kind, mapping_json, created_at FROM broker_import_template WHERE user_id = ? AND is_deleted = 0 ORDER BY id`,
      )
      .all(userId) as Array<Record<string, unknown>>;
    return ok({ templates: rows });
  });

  app.post('/api/broker-import/templates', async (request, reply) => {
    const req = request as { user?: { sub?: number | string; role?: string } };
    const userId = userIdOf(req);
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    if (req.user?.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可维护导入模板（SDD §10.3）'));
    const body = request.body as {
      brokerCode?: string;
      fileKind?: 'settlement' | 'trade';
      mappingJson?: string;
    };
    if (
      !body?.brokerCode?.trim() ||
      !(body.fileKind === 'settlement' || body.fileKind === 'trade') ||
      !body.mappingJson
    ) {
      return reply
        .code(400)
        .send(fail(400, 'INVALID_BODY', '需要 brokerCode + fileKind(settlement|trade) + mappingJson'));
    }
    try {
      JSON.parse(body.mappingJson);
    } catch {
      return reply.code(400).send(fail(400, 'INVALID_MAPPING_JSON', 'mappingJson 不是合法 JSON'));
    }
    const id = saveTemplate(
      ConfigStore.getInstance().db,
      userId,
      body.brokerCode.trim(),
      body.fileKind,
      body.mappingJson,
    );
    return ok({ id });
  });
}
