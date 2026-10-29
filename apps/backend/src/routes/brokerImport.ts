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
  persistPreparedBrokerFile,
  preflightBrokerFile,
  revokeBatch,
  listBatches,
  saveTemplate,
  getTemplate,
  UnknownAssetCodesError,
  type ImportResult,
  type UnknownAssetDetail,
} from '../services/broker/brokerImport.js';
import { backfillTradeTime } from '../services/broker/brokerReconcile.js';
import type { BrokerFileInput } from '../services/broker/types.js';

import { ensureSymbolDict } from '../services/symbolDict.js';

/** 未知标的拒绝文案：最多列 20 个代码，避免错误消息过长 */
function unknownAssetsMessage(details: UnknownAssetDetail[]): string {
  const parts = details.map((d) => {
    const shownCodes = d.assetCodes.slice(0, 20);
    const shownNames = d.assetNames?.slice(0, 20) ?? [];
    const items = shownCodes.map((code, i) => {
      const name = shownNames[i];
      return name ? `${code}（${name}）` : code;
    });
    const more = d.assetCodes.length > shownCodes.length ? ` 等 ${d.assetCodes.length} 个` : '';
    return `${d.filename}: ${items.join('、')}${more}`;
  });
  return `标的代码不存在，本次未导入任何数据：${parts.join('；')}。请核对代码后重新导入。`;
}

/** 构建 pending_unknown_assets 响应体（200 返回，供前端弹窗让用户选择跳过） */
function buildPendingUnknownBody(
  prepared: Awaited<ReturnType<typeof preflightBrokerFile>>[],
): { pending_unknown_assets: Array<{ filename: string; assetCodes: string[]; assetNames: (string | null)[] }> } {
  return {
    pending_unknown_assets: prepared
      .filter((p) => p.unknownAssets.length > 0)
      .map((p) => ({ filename: p.filename, assetCodes: p.unknownAssets, assetNames: p.unknownAssetNames })),
  };
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
    // 导入前确保标的字典已同步：未知标的行必须可判定（不允许在字典缺失时盲导）
    const dictCount = await ensureSymbolDict();
    if (dictCount === 0) {
      return reply
        .code(422)
        .send(
          fail(
            422,
            'SYMBOL_DICT_UNAVAILABLE',
            '标的字典未同步，无法校验标的代码；请先确认行情库可用并打开一次标的搜索',
          ),
        );
    }
    try {
      const prepared = await preflightBrokerFile(db, userId, brokerCode, input);
      if (prepared.unknownAssets.length > 0) {
        return ok(buildPendingUnknownBody([prepared]));
      }
      const r = persistPreparedBrokerFile(db, userId, brokerCode, prepared);
      // 导入后自动回填：交割单缺 trade_time 时，从该券商已有成交流水行补齐（L1/L2/L3）
      const backfill = backfillTradeTime(db, userId, brokerCode);
      return ok({ ...r, backfill });
    } catch (e) {
      if (e instanceof UnknownAssetCodesError) {
        return reply.code(422).send(fail(422, 'UNKNOWN_ASSET_CODES', unknownAssetsMessage(e.details)));
      }
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
    const dictCount = await ensureSymbolDict();
    if (dictCount === 0) {
      return reply
        .code(422)
        .send(
          fail(
            422,
            'SYMBOL_DICT_UNAVAILABLE',
            '标的字典未同步，无法校验标的代码；请先确认行情库可用并打开一次标的搜索',
          ),
        );
    }
    // 第一步：整批预检（解析 + 归一化 + 未知标的检查），不写任何事实层
    const prepared: Awaited<ReturnType<typeof preflightBrokerFile>>[] = [];
    for (const f of body.files) {
      const got = toInput(f);
      if (got.err) {
        return reply.code(got.err.code).send(got.err.body);
      }
      try {
        prepared.push(await preflightBrokerFile(db, userId, brokerCode, got.input!));
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
    const unknownPrepared = prepared.filter((p) => p.unknownAssets.length > 0);
    if (unknownPrepared.length > 0) {
      return ok(buildPendingUnknownBody(unknownPrepared));
    }

    // 第二步：整批落盘（单事务；任一文件失败则全部回滚）
    const results: ImportResult[] = [];
    try {
      const persistAll = db.transaction(() => {
        for (const p of prepared) {
          results.push(persistPreparedBrokerFile(db, userId, brokerCode, p));
        }
      });
      persistAll();
    } catch (e) {
      return reply
        .code(422)
        .send(fail(422, 'BROKER_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
    }
    // 全部导入完成后统一回填一次（交割单缺 trade_time ← 成交流水）
    const backfill = backfillTradeTime(db, userId, brokerCode);
    return ok({
      files: prepared.map((p, i) => ({ filename: p.filename, ...results[i] })),
      backfill,
    });
  });

  /**
   * 携带 skipUnknownAssetCodes 的最终确认端点。
   * 由前端在用户选择了要跳过的未知标的后调用（二次确认，非幂等）。
   */
  app.post(
    '/api/broker-import/confirm-final',
    async (request, reply) => {
      const req = request as { user?: { sub?: number | string; role?: string } };
      const userId = userIdOf(req);
      if (userId <= 0) return reply.code(401).send(fail(401, 'UNAUTHORIZED', '未登录'));
      if (req.user?.role !== 'admin')
        return reply.code(403).send(fail(403, 'FORBIDDEN', '仅 admin 可导入（SDD §10.3）'));
      const body = request.body as {
        brokerCode?: string;
        files?: UploadBody[];
        skipUnknownAssetCodes?: string[];
      };
      if (!body?.brokerCode?.trim()) {
        return reply.code(400).send(fail(400, 'INVALID_BODY', '缺少 brokerCode'));
      }
      if (!Array.isArray(body.files) || body.files.length === 0) {
        return reply.code(400).send(fail(400, 'INVALID_BODY', 'files 不能为空'));
      }
      if (body.files.length > 5) {
        return reply.code(400).send(fail(400, 'INVALID_BODY', '单次批量导入不超过 5 个文件'));
      }
      const skipCodes: string[] = Array.isArray(body.skipUnknownAssetCodes) ? body.skipUnknownAssetCodes : [];
      const db = ConfigStore.getInstance().db;
      const brokerCode = body.brokerCode.trim();
      const dictCount = await ensureSymbolDict();
      if (dictCount === 0) {
        return reply
          .code(422)
          .send(
            fail(
              422,
              'SYMBOL_DICT_UNAVAILABLE',
              '标的字典未同步，无法校验标的代码；请先确认行情库可用并打开一次标的搜索',
            ),
          );
      }
      const prepared: Awaited<ReturnType<typeof preflightBrokerFile>>[] = [];
      for (const f of body.files) {
        const got = toInput(f);
        if (got.err) {
          return reply.code(got.err.code).send(got.err.body);
        }
        try {
          prepared.push(await preflightBrokerFile(db, userId, brokerCode, got.input!));
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
      // 应用 skip 逻辑后再检查残留未知标的
      for (const p of prepared) {
        if (skipCodes.length > 0) {
          const skipSet = new Set(skipCodes);
          const keptCodes: string[] = [];
          const keptNames: (string | null)[] = [];
          for (let i = 0; i < p.unknownAssets.length; i++) {
            if (!skipSet.has(p.unknownAssets[i])) {
              keptCodes.push(p.unknownAssets[i]);
              keptNames.push(p.unknownAssetNames[i] ?? null);
            }
          }
          p.unknownAssets = keptCodes;
          p.unknownAssetNames = keptNames;
        }
      }
      const remainingUnknown = prepared.filter((p) => p.unknownAssets.length > 0);
      if (remainingUnknown.length > 0) {
        return reply.code(422).send(
          fail(422, 'UNKNOWN_ASSET_CODES', unknownAssetsMessage(remainingUnknown.map((p) => ({
            filename: p.filename,
            assetCodes: p.unknownAssets,
            assetNames: p.unknownAssetNames,
          })))),
        );
      }
      const results: ImportResult[] = [];
      try {
        const persistAll = db.transaction(() => {
          for (const p of prepared) {
            results.push(persistPreparedBrokerFile(db, userId, brokerCode, p, skipCodes));
          }
        });
        persistAll();
      } catch (e) {
        return reply
          .code(422)
          .send(fail(422, 'BROKER_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
      }
      const backfill = backfillTradeTime(db, userId, brokerCode);
      return ok({
        files: prepared.map((p, i) => ({ filename: p.filename, ...results[i] })),
        skippedCodes: skipCodes,
        backfill,
      });
    },
  );

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
