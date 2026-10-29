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
import { backfillTradeTime } from '../services/broker/brokerReconcile.js';
import type { Database } from 'better-sqlite3';
import type { BrokerFileInput } from '../services/broker/types.js';

import { softDeleteOrphanUserTradeRecords } from '../services/symbolDict.js';

/** 检查批次中 asset_code 在 symbol_dict 中不存在的标的（返回空数组 = 全部存在或字典为空） */
function findUnknownAssets(db: Database, userId: number, batchId: number): string[] {
  const codes = db
    .prepare(
      `SELECT DISTINCT asset_code FROM broker_trade_record
       WHERE user_id = ? AND import_batch_id = ? AND is_deleted = 0 AND asset_code IS NOT NULL`,
    )
    .all(userId, batchId) as Array<{ asset_code: string }>;
  if (codes.length === 0) return [];
  const dictCount = (db.prepare('SELECT COUNT(*) c FROM symbol_dict').get() as { c: number }).c;
  if (dictCount === 0) return []; // 字典未同步，跳过检查
  const ph = codes.map(() => '?').join(',');
  const found = db
    .prepare(`SELECT DISTINCT symbol FROM symbol_dict WHERE symbol IN (${ph})`)
    .all(...codes.map((c) => c.asset_code)) as Array<{ symbol: string }>;
  const foundSet = new Set(found.map((f) => f.symbol));
  return codes.map((c) => c.asset_code).filter((c) => !foundSet.has(c));
}

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
      // T151①：券商名推断（仅元数据行；前端在其为空时自动填入券商标识框，可改）
      ...(parse.brokerNameHint !== undefined ? { brokerNameHint: parse.brokerNameHint } : {}),
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
    const db = ConfigStore.getInstance().db;
    const brokerCode = body.brokerCode.trim();
    try {
      const r = await importBrokerFile(db, userId, brokerCode, input);
      // 导入后自动回填：交割单缺 trade_time 时，从该券商已有成交流水行补齐（L1/L2/L3）
      const backfill = backfillTradeTime(db, userId, brokerCode);
      // 检查标的代码是否在系统字典中存在；若字典已同步，自动软删不存在的标的交易记录
      softDeleteOrphanUserTradeRecords();
      const unknownAssets = findUnknownAssets(db, userId, r.batchId);
      return ok({ ...r, backfill, unknownAssets });
    } catch (e) {
      return reply
        .code(422)
        .send(fail(422, 'BROKER_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  });

  // 批量确认导入（同券商多文件一次提交，如成交流水+交割单；导入后自动回填 trade_time）
  app.post('/api/broker-import/confirm-batch', async (request, reply) => {
    const req = request as { user?: { sub?: number | string; role?: string } };
    const userId = userIdOf(req);
    if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
    if (req.user?.role !== 'admin')
      return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可导入（SDD §10.3）'));
    const body = request.body as { brokerCode?: string; files?: UploadBody[] };
    if (!body?.brokerCode?.trim()) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode'));
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', 'files 不能为空'));
    }
    if (body.files.length > 5) {
      return reply.code(400).send(fail(400, 'INVALID_BODY', '单次批量导入不超过 5 个文件'));
    }
    const db = ConfigStore.getInstance().db;
    const brokerCode = body.brokerCode.trim();
    const results: Array<Record<string, unknown>> = [];
    for (const f of body.files) {
      const got = toInput(f);
      if (got.err) {
        return reply.code(got.err.code).send(got.err.body);
      }
      try {
        const r = await importBrokerFile(db, userId, brokerCode, got.input!);
        results.push({ filename: f.filename, ...r });
      } catch (e) {
        return reply
          .code(422)
          .send(
            fail(
              422,
              'BROKER_IMPORT_FAILED',
              `文件 ${f.filename}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      }
    }
    // 全部导入完成后统一回填一次（交割单缺 trade_time ← 成交流水）
    const backfill = backfillTradeTime(db, userId, brokerCode);
    softDeleteOrphanUserTradeRecords();
    // 检查所有批次中的标的代码是否在系统字典中存在
    const unknownAssets = new Set<string>();
    for (const r of results) {
      const bid = (r as { batchId?: number }).batchId;
      if (bid) {
        for (const code of findUnknownAssets(db, userId, bid)) unknownAssets.add(code);
      }
    }
    return ok({ files: results, backfill, unknownAssets: [...unknownAssets] });
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
