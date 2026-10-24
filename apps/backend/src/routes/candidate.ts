/**
 * candidate.ts —— 候选池 HTTP 路由（T50：基准价固化 + 迁移价格模式；T74：列表补字段 + 移除候选）
 *
 * 覆盖 SDD §4.4「候选池 `/api/candidate/*` → 用户/admin，增删查 + 迁移」，
 * 在 T50 之上补齐 Requirements §5.7 的两条：
 *   - 加入时固化基准价（加入日前复权收盘价，或用户显式指定）
 *   - 迁移时记录价格模式（'base' 复用基准价 / 'current' 用当前现价）
 *
 * ── T74 的三处改动（实测结论见下）──
 *
 * ① **补 `DELETE /api/candidate/:asset_code`（软删候选）**
 *    实测（2026-10-21，`app.printRoutes()` + `app.inject()`）：T92 之前
 *    `routes/watch.ts` 的 `_crud(app,'candidate')` 顺带注册过候选的删改查，
 *    T92 把候选路由收敛到本文件时**只搬走了 GET / POST / migrate**，
 *    候选的**删除端点整体丢失**（实测 `DELETE /api/candidate/sh600519` → **404 路由不存在**）。
 *    而 T74 卡片要求「【移除】软删」+ SDD §4.4 汇总行（§4.4:1350）写明候选池 =「增删查 + 迁移」
 *    ⇒ 属**端点确有缺陷**，本文件补齐。
 *
 * ② **GET 列表补 `name` / `tracked_days` / `signal`（只加不改）**
 *    - `tracked_days`：**SDD §4.4:1426 的契约字段**（原实现缺失 ⇒ 契约缺陷）；
 *    - `name`：中文名（`raw_symbol_name.name`，1 次 IN 查询，查不到 → null）；
 *    - `signal`：该标的**最新一条**信号（1 次查询，无 N+1）。
 *    ⚠️ 三者**任何一项降级都不得让接口 500**（DuckDB 不可用 → name=null；信号查询失败 → signal=null）。
 *
 * ③ **不动迁移语义** —— 仍是「只打标记，不建关联」（PRD S5 / SDD §12.3 B6 / T92），
 *    `POST /api/candidate/:id/migrate` 的行为与响应体**一个字都没改**。
 *
 * ⚠️ 与 `routes/watch.ts` 的并存说明：
 *   `watch.ts` 现只注册自选（watch）的 CRUD，候选路由**全部**在本文件 —— 二者不再冲突。
 *
 * 响应体走统一 envelope（`lib/envelope.ts` · SDD §4.2）：
 * 成功 `{ code: 0, data, timestamp }` / 失败 `{ code: <错误码>, message, data: null, timestamp, error }`。
 * ⚠️ T89b 起响应体**不再有 `success` 字段**。
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
import { batchGetSymbolNames } from '../services/marketData.js';
import { getLatestSignalsByAssets } from '../services/todaySignals.js';
import type { SignalRow } from '../services/todaySignals.js';
import { writeSystemLog } from '../services/logger.js';
import { defaultMessage } from '../lib/errorMessages.js';
import { ok, fail } from '../lib/envelope.js';

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

/**
 * 计算「跟踪天数」（SDD §4.4:1426 要求的 `GET /api/candidate` 契约字段）
 *
 * 口径 = **加入日 → 今天** 的自然日天数（当天加入 = 0 天）。
 *
 * ⚠️ `created_at` 的格式是 SQLite `datetime('now','localtime')` 产出的
 *   **本地时间**字符串（`YYYY-MM-DD HH:MM:SS`）⇒ 按本地日历取日期分量，
 *   不做时区换算（换算会跨天出错）。
 *
 * ⚠️ 未来时间（时钟回拨 / 手工造数）返回 0 而不是负数 —— 负的「跟踪天数」无业务含义。
 */
function computeTrackedDays(createdAt: string | null | undefined, now: Date = new Date()): number | null {
  if (typeof createdAt !== 'string') return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt);
  if (!matched) return null;
  const created = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  if (Number.isNaN(created.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - created.getTime()) / 86400000);
  return days < 0 ? 0 : days;
}

export async function registerCandidateRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/candidate —— 列表（含基准价 + 相对收益）──
  app.get('/api/candidate', async (request, reply) => {
    const user = requireUser(request);
    const items = await listCandidatesWithReturn(user.sub);

    // ── T74 enrich（**只加不改**：既有字段一个都没动，只补 3 个）──
    const codes = items.map((item) => item.asset_code);

    // 1 次 IN 查询拿全部候选标的中文名（DuckDB 不可用 → 降级为无名称，不 500）
    let names: Map<string, string> = new Map();
    if (codes.length > 0) {
      try {
        names = await batchGetSymbolNames(codes);
      } catch (err) {
        app.log.warn({ err }, '候选池标的名称查询失败，降级为无名称');
      }
    }

    // 1 次查询拿全部候选标的的最新一条信号（SQLite；同样禁止逐标的循环查）
    let signals: Map<string, SignalRow> = new Map();
    if (codes.length > 0) {
      try {
        signals = await getLatestSignalsByAssets(user.sub, codes);
      } catch (err) {
        app.log.warn({ err }, '候选池信号查询失败，降级为无信号');
      }
    }

    const enriched = items.map((item) => ({
      ...item,
      /** 中文名（`raw_symbol_name.name`）；查不到 → null（实测覆盖率约 70%，缺失是常态）*/
      name: names.get(item.asset_code) ?? null,
      /** 跟踪天数（加入日 → 今天）；`created_at` 不可解析 → null */
      tracked_days: computeTrackedDays(item.created_at),
      /** 该标的的最新一条信号；无信号 → null */
      signal: signals.get(item.asset_code) ?? null,
    }));

    return reply.send(ok(enriched));
  });

  // ── POST /api/candidate —— 新增候选（固化基准价）──
  app.post('/api/candidate', async (request, reply) => {
    const user = requireUser(request);
    const body = (request.body ?? {}) as CreateCandidateBody;

    if (!isValidAssetCode(body.asset_code)) {
      return reply
        .code(400)
        .send(fail(400, 'PARAM_INVALID', 'asset_code 必填且格式应为 sh600000 / sz000001'));
    }

    const assetCode = body.asset_code;

    // candidate_base_price：缺省 = 走行情库；给了就必须合法（NaN/Infinity/<=0 一律拒绝）
    const hasOverride = body.candidate_base_price !== undefined && body.candidate_base_price !== null;
    const overrides = new Map<string, number>();
    if (hasOverride) {
      if (!isValidBasePrice(body.candidate_base_price)) {
        return reply
          .code(400)
          .send(fail(400, 'PARAM_INVALID', 'candidate_base_price 必须是大于 0 的有限数值'));
      }
      overrides.set(assetCode, body.candidate_base_price);
    }

    let reason: string | null = null;
    if (body.candidate_reason !== undefined && body.candidate_reason !== null) {
      if (typeof body.candidate_reason !== 'string') {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'candidate_reason 必须是字符串'));
      }
      reason = body.candidate_reason.trim();
      if (reason.length > MAX_REASON_LENGTH) {
        return reply
          .code(400)
          .send(fail(400, 'PARAM_INVALID', `candidate_reason 不得超过 ${MAX_REASON_LENGTH} 字符`));
      }
      if (reason === '') reason = null;
    }

    // 基准价解析：显式传了直接用；否则 1 次 DuckDB 批量查加入日前复权收盘价
    let resolved: Awaited<ReturnType<typeof resolveBasePrices>>;
    try {
      resolved = await resolveBasePrices([assetCode], overrides);
    } catch (err) {
      if (err instanceof QuoteUnavailableError) {
        return reply
          .code(404)
          .send(
            fail(404, 'SYMBOL_NOT_FOUND', `${err.message}；可显式传入 candidate_base_price 手动指定基准价`),
          );
      }
      if (err instanceof QuoteSourceUnavailableError) {
        return reply.code(503).send(fail(503, 'EXTERNAL_SOURCE_UNAVAILABLE', err.message));
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

      return reply.code(201).send(
        ok({
          id: info.lastInsertRowid,
          asset_code: assetCode,
          rel_type: 'candidate',
          candidate_reason: reason,
          candidate_base_price: base.basePrice,
          candidate_base_price_date: base.basePriceDate,
          base_price_source: base.source,
        }),
      );
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        return reply.code(409).send(fail(409, 'DUPLICATE', `${assetCode} 已在 candidate 列表`));
      }
      throw err;
    }
  });

  // ── DELETE /api/candidate/:asset_code —— 移除候选（软删）──
  //
  // 🔴 **T74 补齐的缺失端点**（实测：T92 把候选路由收敛到本文件时，删除端点整体丢失 →
  //    `DELETE /api/candidate/:asset_code` 返回 **404 路由不存在**）。
  //
  // 口径（Requirements §5.7 #3 + AGENTS.md「禁止物理删除」）：
  //   - **软删**（`is_deleted = 1`），历史跟踪记录保留；
  //   - 只删 `rel_type = 'candidate'` 的那一行 —— **`watch` / `hold` 关联完全不受影响**
  //     （`UNIQUE(user_id, asset_code, rel_type)` 三列独立共存，AGENTS.md 硬约束）；
  //   - 候选不存在 / 已软删 → 404 `NOT_FOUND`（与 `watch.ts` 的删除语义一致）。
  app.delete('/api/candidate/:asset_code', async (request, reply) => {
    const user = requireUser(request);
    const assetCode = (request.params as { asset_code?: string }).asset_code;

    if (!isValidAssetCode(assetCode)) {
      return reply.code(400).send(fail(400, 'PARAM_INVALID', 'asset_code 格式应为 sh600000 / sz000001'));
    }

    const db = ConfigStore.getInstance().db;
    const info = db
      .prepare(
        `UPDATE user_asset_rel SET is_deleted = 1
          WHERE user_id = ? AND asset_code = ? AND rel_type = 'candidate' AND is_deleted = 0`,
      )
      .run(user.sub, assetCode);

    if (info.changes === 0) {
      return reply.code(404).send(fail(404, 'NOT_FOUND', defaultMessage('NOT_FOUND')));
    }

    // ⚠️ `system_log.log_type` 的 CHECK 是固定白名单，**没有** `candidate_remove`；
    //   新增 log_type 要改 configStore 的幂等表重建（越界）⇒ 沿用 T56 的既有做法：
    //   用语义最接近的 `trigger_manual`（用户手动触发）。
    writeSystemLog({
      logType: 'trigger_manual',
      level: 'INFO',
      message: `${user.username} 移除候选 ${assetCode}（软删）`,
      detail: JSON.stringify({ assetCode, relType: 'candidate', softDeleted: true }),
    });

    return reply.send(
      ok({
        asset_code: assetCode,
        rel_type: 'candidate',
        is_deleted: true,
        message: '已从候选池移除',
      }),
    );
  });

  // ── POST /api/candidate/:asset_code/promote —— 迁移到自选（只打标记）──
  app.post('/api/candidate/:id/migrate', async (request, reply) => {
    const user = requireUser(request);
    // T90：路由改名 `/api/candidate/:asset_code/promote` → `/api/candidate/:id/migrate`
    //      ⇒ 路径参数名同步改为 :id（SDD §4.4:1272）
    const params = request.params as { id?: string };
    const assetCode = params.id;

    if (!isValidAssetCode(assetCode)) {
      return reply.code(400).send(fail(400, 'PARAM_INVALID', 'asset_code 格式应为 sh600000 / sz000001'));
    }

    const body = (request.body ?? {}) as PromoteBody;
    if (typeof body.price_mode !== 'string' || !PRICE_MODES.includes(body.price_mode)) {
      return reply.code(400).send(fail(400, 'PARAM_INVALID', "price_mode 必填且只能为 'base' 或 'current'"));
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
      return reply.send(
        ok({
          asset_code: assetCode,
          from: 'candidate',
          to: 'watch',
          price_mode: priceMode,
          marked: true,
          // PRD S5：MVP 迁移候选到自选**只打标记**，不自动创建自选关联
          autoCreated: false,
          message: '已标记为迁移完成；不会自动加入自选，需手动从候选池加入自选',
          candidate: row,
        }),
      );
    } catch (err) {
      if (err instanceof CandidateNotFoundError) {
        return reply.code(404).send(fail(404, 'SYMBOL_NOT_FOUND', err.message));
      }
      throw err;
    }
  });
}
