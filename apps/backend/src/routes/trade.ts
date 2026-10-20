import type { FastifyInstance } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { calcPosition, calcAllPositions, validateSufficientHolding } from '../services/positionCalculator.js';
import {
  batchGetLatestAndPrevClose,
  batchGetSymbolNames,
  type LatestAndPrevClose,
} from '../services/marketData.js';
import { getLatestSignalsByAssets, type SignalRow } from '../services/todaySignals.js';
import { writeSystemLog } from '../services/logger.js';
import { ok, fail } from '../lib/envelope.js';
import { defaultMessage } from '../lib/errorMessages.js';

/**
 * 交易 + 持仓 API（T25 + T26 + T39）
 *
 * 所有路由需要 JWT 鉴权（由 registerRoutes 里的 onRequest hook 统一处理）
 */

/**
 * 交易类型白名单（**与 DDL CHECK + Requirements §5.1 三方一致**）
 *
 * 🔴 **本文件修复的 bug**：白名单曾写成
 *   `['buy', 'sell', 'reduce', 'clear', 'dividend', 'bonus', 'transfer']`
 *   —— **含 DDL 不认的 `'sell'`、且漏了 DDL 认的 `'add'`**，后果：
 *   ① `trade_type='sell'` → INSERT 撞 CHECK → **HTTP 500 + 裸 SQLite 报错外泄**
 *   ② `trade_type='add'`（前端「加仓」选项）→ **400 PARAM_INVALID** ⇒ 线上入口是坏的
 *
 * 口径依据（三方一致，任一可查证）：
 *   - `Requirements_simplified.md` §5.1：7 种（买入 / 加仓 / 减仓 / 清仓 + 分红 / 送股 / 转增）
 *   - `config/configStore.ts` DDL：`CHECK (trade_type IN ('buy','add','reduce','clear','dividend','bonus','transfer'))`
 *   - 实施计划 DEC-2 + T49 验收 ②：**移除 `sell`、加入 `add`**；`sell` 应为 400 非法值
 *
 * ⚠️ **`'sell'` 不是合法业务类型**（DEC-2 已裁定移除）：
 *   部分卖出 = `'reduce'`（减仓），全部卖出 = `'clear'`（清仓）。
 *   老客户端若仍发 `'sell'`，本入口返回 **400 PARAM_INVALID**（不落库、不 500），
 *   并在 message 里给出替代类型提示 —— 兼容靠**报错文案指引**，不靠引入 DDL 外的语义别名。
 */
export const TRADE_TYPES = ['buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer'] as const;

export type TradeType = (typeof TRADE_TYPES)[number];

/** 白名单查找表（路由入口校验用） */
const TRADE_TYPE_SET: ReadonlySet<string> = new Set<string>(TRADE_TYPES);

/**
 * 非法类型的迁移提示（老客户端 → 合法类型的对照）
 *
 * `'sell'` 不在 DDL 与 Requirements §5.1 内，故**不做入口归一**（归一会引入 DDL 外的
 * 第 8 种语义别名，正是本次 bug 的成因类别）；改为给出可执行的替代指引。
 */
const TRADE_TYPE_HINTS: Record<string, string> = {
  sell: "trade_type 'sell' 不是合法类型：部分卖出请用 'reduce'（减仓），全部卖出请用 'clear'（清仓）",
};

/** 卖出类：需持仓充足性校验（Requirements §5.2 减仓/清仓不得超过当时持仓） */
const REDUCE_TYPES = new Set<TradeType>(['reduce', 'clear']);

/** 需用户填写操作理由的类型（Requirements §5.2：买入 / 加仓 / 减仓 / 清仓） */
const NEED_REASON_TYPES = new Set<TradeType>(['buy', 'add', 'reduce', 'clear']);

/** 系统自动导入类：理由由系统固化写入（Requirements §5.2 分红 / 送股 / 转增） */
const AUTO_IMPORT_TYPES = new Set<TradeType>(['dividend', 'bonus', 'transfer']);

/**
 * T87：`trade_time` 格式校验（秒级 HH:mm:ss）
 *
 * B-11 裁决：`trade_time` 必填无默认 —— 不能给默认时间，因为那样
 * 「同一天同一秒录入两笔」会静默撞唯一键，用户无从理解为何被拒。
 * 缺失时前端预填当前时间；后端只做格式与范围校验。
 */
export function validateTradeTime(t: unknown): t is string {
  if (typeof t !== 'string') return false;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return false;
  const h = Number(t.slice(0, 2));
  const m = Number(t.slice(3, 5));
  const s = Number(t.slice(6, 8));
  return h < 24 && m < 60 && s < 60;
}

/** 当前本地时间，秒级 HH:mm:ss */
export function nowTradeTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * T58：同步 `user_asset_rel` 的 `rel_type='hold'` 关系
 *
 * 口径（以 `calcPosition` 的移动加权成本结果为准，与 GET /api/positions 同一口径）：
 * - 持仓 > 0 → 关系存在：缺则 INSERT，软删则恢复（`is_deleted=0`）
 * - 持仓 = 0（清仓）→ **软删**（`is_deleted=1`），不物理删除（AGENTS.md 硬约束）
 *
 * 幂等：先按 UNIQUE(user_id, asset_code, rel_type) 查现状，再决定 INSERT/UPDATE，
 * 重复调用不会产生第二行，也不会抛 UNIQUE。
 *
 * ⚠️ 与 `exDividendSync.getHoldingBeforeDate` 的口径差异（**疑似，未修**）：
 *    后者把 `bonus` 计入 +quantity，`calcPosition`（core 移动加权）不计 bonus。
 *    「清仓后又有送转股」这类序列两者结论会相反。此处不擅自改动，等业务口径裁决。
 */
export function syncHoldRelation(
  userId: number,
  assetCode: string,
): { action: string; totalQuantity: number } {
  const db = ConfigStore.getInstance().db;
  const totalQuantity = calcPosition(userId, assetCode).totalQuantity;
  const shouldHold = totalQuantity > 0;

  const run = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT id, is_deleted FROM user_asset_rel WHERE user_id = ? AND asset_code = ? AND rel_type = ?',
      )
      .get(userId, assetCode, 'hold') as { id: number; is_deleted: number } | undefined;

    if (shouldHold) {
      if (!existing) {
        db.prepare(`INSERT INTO user_asset_rel (user_id, asset_code, rel_type) VALUES (?, ?, 'hold')`).run(
          userId,
          assetCode,
        );
        return 'created';
      }
      if (existing.is_deleted === 1) {
        db.prepare('UPDATE user_asset_rel SET is_deleted = 0 WHERE id = ?').run(existing.id);
        return 'restored';
      }
      return 'kept';
    }

    if (existing && existing.is_deleted === 0) {
      db.prepare('UPDATE user_asset_rel SET is_deleted = 1 WHERE id = ?').run(existing.id);
      return 'soft_deleted';
    }
    return 'noop';
  });

  return { action: run(), totalQuantity };
}

export async function registerTradeRoutes(app: FastifyInstance) {
  // 录入交易
  app.post('/api/trade', async (request, reply) => {
    try {
      const body = request.body as {
        asset_code: string;
        trade_type: string;
        trade_date: string;
        trade_time?: string; // T87：秒级 HH:mm:ss，必填无默认
        quantity: number;
        price: number;
        fee?: number;
        trade_reason?: string;
        remark?: string;
        system_followed?: number; // T39: 由信号触发的导入（cron 自动导入）
      };
      const user = (request as any).user as { sub: number; username: string; role: string };
      if (
        !body?.asset_code ||
        !body?.trade_type ||
        !body?.trade_date ||
        body.quantity == null ||
        body.price == null
      ) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '必要字段缺失'));
      }
      // T87：trade_time 必填且格式合法
      if (!validateTradeTime(body.trade_time)) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', 'trade_time 必填，格式 HH:mm:ss（秒级）'));
      }
      if (body.quantity <= 0 || body.price < 0) {
        return reply.code(400).send(fail(400, 'PARAM_INVALID', '数量>0、价格>=0'));
      }
      // 交易类型白名单（与 DDL CHECK 逐项一致，见文件头 TRADE_TYPES 注释）
      if (!TRADE_TYPE_SET.has(body.trade_type)) {
        const hint = TRADE_TYPE_HINTS[body.trade_type];
        return reply
          .code(400)
          .send(
            fail(400, 'PARAM_INVALID', hint ?? `trade_type 非法，仅支持 7 种：${TRADE_TYPES.join(' / ')}`),
          );
      }
      const tradeType = body.trade_type as TradeType;

      let tradeReason: string | null;
      if (AUTO_IMPORT_TYPES.has(tradeType)) {
        tradeReason = body.trade_reason ?? `自动导入 - ${body.trade_date} ${tradeType}`;
      } else if (NEED_REASON_TYPES.has(tradeType)) {
        if (!body.trade_reason?.trim()) {
          return reply
            .code(400)
            .send(fail(400, 'TRADE_REASON_REQUIRED', 'trade_reason 必填，说明本次交易原因'));
        }
        tradeReason = body.trade_reason.trim();
      } else {
        tradeReason = body.trade_reason ?? null;
      }

      if (REDUCE_TYPES.has(tradeType)) {
        // T84（P0-13）：必须传 trade_date —— 以卖出发生时点回放，
        // 否则尚未发生的买入会支撑更早的卖出（日期交错绕过校验）
        if (
          !validateSufficientHolding(
            user.sub,
            body.asset_code,
            body.quantity,
            body.trade_date,
            body.trade_time,
          )
        ) {
          // B-10 裁决：HOLDING_INSUFFICIENT = HTTP 409（非 400）
          return reply
            .code(409)
            .send(fail(409, 'HOLDING_INSUFFICIENT', `持仓不足：无法${tradeType} ${body.asset_code}`));
        }
      }

      const db = ConfigStore.getInstance().db;
      const info = db
        .prepare(
          `INSERT INTO user_trade_record
         (user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee, trade_reason, remark, system_followed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user.sub,
          body.asset_code,
          tradeType,
          body.trade_date,
          body.trade_time,
          body.quantity,
          body.price,
          body.fee ?? 0,
          tradeReason,
          body.remark ?? null,
          body.system_followed ?? null,
        );

      writeSystemLog({
        logType: 'trade',
        level: 'SUCCESS',
        message: `录入${tradeType} ${body.asset_code} qty=${body.quantity} price=${body.price}`,
      });

      // T58：同步 hold 关系（清仓 → 软删；买入/加仓 → 建立或恢复）
      const holdRel = syncHoldRelation(user.sub, body.asset_code);

      reply.code(201).send(
        ok({
          trade_id: info.lastInsertRowid,
          position: calcPosition(user.sub, body.asset_code),
          hold_rel: holdRel,
        }),
      );
    } catch (err: any) {
      const raw = String(err);
      if (raw.includes('UNIQUE')) {
        return reply.code(409).send(fail(409, 'TRADE_DUPLICATE', '同日同标的同方向交易已存在'));
      }
      // 🔴 CHECK 约束失败 → 400 PARAM_INVALID（不再 500 + 裸 SQLite 报错外泄）
      //   本次 bug 的症状之一就是「trade_type='sell' → 500 + 裸 SQLite 报错」；
      //   白名单修好后这条路理论上不可达，但保留为**兜底**：任何漏网的值都不得以 500 泄漏内部报错。
      if (raw.includes('CHECK constraint failed')) {
        return reply
          .code(400)
          .send(fail(400, 'PARAM_INVALID', '数据不满足数据库约束（trade_type / quantity / price 非法）'));
      }
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', raw));
    }
  });

  // 查询交易记录（T39: 增强筛选+分页）
  app.get('/api/trade', async (request, reply) => {
    try {
      const user = (request as any).user;
      const q = request.query as any;
      const assetCode = q.asset_code as string | undefined;
      const tradeType = q.trade_type as string | undefined;
      const startDate = q.start_date as string | undefined;
      const endDate = q.end_date as string | undefined;
      const systemFollowed = q.system_followed as string | undefined;
      const strategyMatch = q.strategy_match as string | undefined;
      const isStopLoss = q.is_stop_loss as string | undefined;
      const hasReview = q.has_review as string | undefined;
      const page = Math.max(1, Number(q.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const offset = (page - 1) * limit;

      const conditions: string[] = ['user_id = ?'];
      const params: any[] = [user.sub];

      if (assetCode) {
        conditions.push('asset_code = ?');
        params.push(assetCode);
      }
      if (tradeType) {
        conditions.push('trade_type = ?');
        params.push(tradeType);
      }
      if (startDate) {
        conditions.push('trade_date >= ?');
        params.push(startDate);
      }
      if (endDate) {
        conditions.push('trade_date <= ?');
        params.push(endDate);
      }
      if (systemFollowed !== undefined) {
        conditions.push('system_followed = ?');
        params.push(Number(systemFollowed));
      }
      if (strategyMatch !== undefined) {
        conditions.push('strategy_match = ?');
        params.push(Number(strategyMatch));
      }
      if (isStopLoss !== undefined) {
        conditions.push('is_stop_loss = ?');
        params.push(Number(isStopLoss));
      }
      if (hasReview === 'true') {
        conditions.push(
          `(review_summary IS NOT NULL AND review_summary != '') OR strategy_match IS NOT NULL OR is_stop_loss IS NOT NULL`,
        );
      }
      if (hasReview === 'false') {
        conditions.push(
          `(review_summary IS NULL OR review_summary = '') AND strategy_match IS NULL AND is_stop_loss IS NULL`,
        );
      }

      const where = conditions.join(' AND ');
      const db = ConfigStore.getInstance().db;

      // 先拿总数
      const countRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM user_trade_record WHERE ${where} AND is_deleted = 0`)
        .get(...params) as { cnt: number };

      // 分页查询
      const rows = db
        .prepare(
          `SELECT * FROM user_trade_record WHERE ${where} AND is_deleted = 0
         ORDER BY trade_date DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as any[];

      reply.send(
        ok(rows, {
          pagination: { page, limit, total: countRow.cnt, totalPages: Math.ceil(countRow.cnt / limit) },
        }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T39: PATCH 复盘字段（只允许改 review_note/strategy_match/is_stop_loss/remark）
  app.patch('/api/trade/:id', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const body = request.body as Record<string, any>;
    const allowedFields = ['review_summary', 'strategy_match', 'is_stop_loss', 'remark'];
    const updates: string[] = [];
    const params: any[] = [];
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updates.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (updates.length === 0) {
      return reply.code(400).send(fail(400, 'PARAM_INVALID', '无有效更新字段'));
    }
    params.push(tradeId);
    params.push(user.sub);

    const db = ConfigStore.getInstance().db;
    try {
      db.prepare(
        `UPDATE user_trade_record SET ${updates.join(', ')} WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      ).run(...params);
      writeSystemLog({
        logType: 'trade',
        level: 'SUCCESS',
        message: `${user.username} 更新复盘字段 trade_id=${tradeId}`,
      });
      reply.send(ok(null));
    } catch (err: any) {
      if (String(err).includes('no such column')) {
        return reply.code(500).send(fail(500, 'DB_UNAVAILABLE', 'DDL 未就绪，请联系管理员'));
      }
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // T39: 软删除交易
  app.post('/api/trade/:id/soft-delete', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const db = ConfigStore.getInstance().db;
    const info = db
      .prepare(`UPDATE user_trade_record SET is_deleted = 1 WHERE id = ? AND user_id = ? AND is_deleted = 0`)
      .run(tradeId, user.sub);
    if (info.changes === 0) {
      return reply.code(404).send(fail(404, 'NOT_FOUND', defaultMessage('NOT_FOUND')));
    }
    // T58：软删交易后同步 hold 关系（删掉的是买入 → 持仓归零 → 软删 hold）
    const row = db.prepare('SELECT asset_code FROM user_trade_record WHERE id = ?').get(tradeId) as
      { asset_code: string } | undefined;
    const holdRel = row ? syncHoldRelation(user.sub, row.asset_code) : null;
    writeSystemLog({
      logType: 'trade',
      level: 'INFO',
      message: `${user.username} 软删除交易 id=${tradeId}`,
      detail: holdRel ? JSON.stringify(holdRel) : undefined,
    });
    reply.send(ok({ hold_rel: holdRel }));
  });

  // T39: 恢复软删除
  app.post('/api/trade/:id/restore', async (request, reply) => {
    const user = (request as any).user;
    const tradeId = Number((request.params as any).id);
    const db = ConfigStore.getInstance().db;
    const info = db
      .prepare(`UPDATE user_trade_record SET is_deleted = 0 WHERE id = ? AND user_id = ? AND is_deleted = 1`)
      .run(tradeId, user.sub);
    if (info.changes === 0) {
      return reply.code(404).send(fail(404, 'NOT_FOUND', defaultMessage('NOT_FOUND')));
    }
    // T58：恢复交易 → 持仓回升 → hold 关系恢复
    const row = db.prepare('SELECT asset_code FROM user_trade_record WHERE id = ?').get(tradeId) as
      { asset_code: string } | undefined;
    const holdRel = row ? syncHoldRelation(user.sub, row.asset_code) : null;
    writeSystemLog({
      logType: 'trade',
      level: 'INFO',
      message: `${user.username} 恢复交易 id=${tradeId}`,
      detail: holdRel ? JSON.stringify(holdRel) : undefined,
    });
    reply.send(ok({ hold_rel: holdRel }));
  });

  // 查询单个标的持仓
  app.get('/api/holding/:asset_code', async (request, reply) => {
    try {
      const user = (request as any).user;
      const assetCode = (request.params as any).asset_code as string;
      const pos = calcPosition(user.sub, assetCode);
      reply.send(ok({ asset_code: assetCode, ...pos }));
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });

  // 查询全部持仓（T33：带现价 / 市值 / 盈亏 / 仓位占比，供仪表盘持仓卡使用）
  //
  // ── T67 enrich（**只加不改**，既有字段的路径 / 方法 / 响应形状全部不变）──
  //   每个 position 新增 3 个字段：
  //   - `prevClose: number | null` —— **昨收**（该标的上一根日线的收盘价），
  //     供「总资产变化（对比昨日）」用；无行情 / 无上一根 → null。
  //   - `signal: { plugin_id, direction, label, trade_date } | null` —— 该标的的
  //     **最新一条**信号（建议 A）；无信号 → null。
  //   - `name: string | null` —— **中文名**（`raw_symbol_name.name`）；
  //     查不到 → null（实测覆盖率约 70%，缺失是常态）。
  //   - `industry: string | null` —— **契约预留字段**，当前恒为 null（见下）。
  //   ⚠️ 降级：DuckDB 不可用 → prevClose 全为 null；信号查询失败 → signal 全为 null。
  //     **任何一种降级都不得让整条接口 500**。
  app.get('/api/holding', async (request, reply) => {
    try {
      const user = (request as any).user;
      const positions = calcAllPositions(user.sub);
      if (positions.length === 0) {
        return reply.send(ok([]));
      }

      // 1 次 IN 查询拿全量最新价 + 昨收（AGENTS.md DuckDB 硬约束：禁止逐标的循环查）
      let quotes: Map<string, LatestAndPrevClose> = new Map();
      let priceDate: string | null = null;
      try {
        quotes = await batchGetLatestAndPrevClose(positions.map((p) => p.asset_code));
        const dates = new Set([...quotes.values()].map((v) => v.date));
        priceDate = dates.size === 1 ? [...dates][0] : null;
      } catch (err: any) {
        // DuckDB 不可用不阻塞持仓展示，前端降级为"无现价"
        app.log.warn({ err }, '持仓现价/昨收查询失败，降级为无现价');
      }

      // 1 次 IN 查询拿全部持仓标的的**中文名**（T67 卡 1；同样禁止逐标的循环查）
      let names: Map<string, string> = new Map();
      try {
        names = await batchGetSymbolNames(positions.map((p) => p.asset_code));
      } catch (err: any) {
        // 名称查不到不阻塞持仓展示，前端降级为"只显示代码"
        app.log.warn({ err }, '持仓标的名称查询失败，降级为无名称');
      }

      // 1 次 IN 查询拿全部持仓标的的最新信号（T67 建议 A；同样禁止逐标的循环查）
      let signals: Map<string, SignalRow> = new Map();
      try {
        signals = await getLatestSignalsByAssets(
          user.sub,
          positions.map((p) => p.asset_code),
        );
      } catch (err: any) {
        // 信号查询失败不阻塞持仓展示，前端降级为"无信号标记"
        app.log.warn({ err }, '持仓信号查询失败，降级为无信号标记');
      }

      // 市值合计 → 每只标的的仓位占比
      const enriched = positions.map((p) => {
        const quote = quotes.get(p.asset_code);
        const currentPrice = quote?.close ?? null;
        const marketValue = currentPrice !== null ? currentPrice * p.totalQuantity : null;
        const unrealizedPnl = marketValue !== null ? marketValue - p.totalCostBasis : null;
        const unrealizedYield =
          p.totalCostBasis > 0 && unrealizedPnl !== null ? unrealizedPnl / p.totalCostBasis : null;
        return {
          ...p,
          currentPrice,
          priceDate: quote?.date ?? null,
          marketValue,
          unrealizedPnl,
          unrealizedYield,
          // ── T67 enrich（**只加不改**：既有字段的路径/方法/形状全部不变）──
          /** 昨收 = 该标的上一根日线的收盘价（对比昨日涨跌）；无行情/无上一根 → null */
          prevClose: quote?.prevClose ?? null,
          /** 该标的的最新一条信号；无信号 → null */
          signal: signals.get(p.asset_code) ?? null,
          /** 中文名（`raw_symbol_name.name`）；查不到 → null（覆盖率约 70%，缺失是常态） */
          name: names.get(p.asset_code) ?? null,
          /**
           * 行业（**契约预留字段，当前恒为 null**）
           *
           * 实测（2026-10-20）：`raw_tdx_blocks_member` 与 `raw_tdx_blocks_info` **均为 0 行**，
           *   且 `raw_tdx_blocks_member` 实际列名是 `(stock_symbol, block_code)`
           *   —— 与 SDD §3.3 行 1299 登记的 `symbol` **不一致**（AGENTS.md：放行 ≠ 已知列名）。
           * ⇒ 行业在当前数据源下**可证明恒为 null**。
           * ⚠️ 接入真实查询前必须先甄别 `block_type`（行业 / 概念 / 地区）——
           *   空表上无法实测该取值集合，故本卡**不写猜测口径**，只把字段预留进契约，
           *   前端据此把「行业筛选」显式降级（禁用 + 说明文案），不许静默失效。
           */
          industry: null,
        };
      });

      const totalMarketValue = enriched.reduce((s, p) => s + (p.marketValue ?? 0), 0);
      const withWeight = enriched.map((p) => ({
        ...p,
        weight: totalMarketValue > 0 && p.marketValue !== null ? p.marketValue / totalMarketValue : null,
      }));

      // T89a：summary 是**顶层**字段（前端 Dashboard.tsx 读 `res.data.summary`）
      return reply.send(
        ok(withWeight, {
          summary: {
            totalMarketValue,
            totalCostBasis: withWeight.reduce((s, p) => s + p.totalCostBasis, 0),
            unrealizedPnl: withWeight.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0),
            realizedPnl: withWeight.reduce((s, p) => s + p.realizedPnL, 0),
            priceDate,
            positionCount: withWeight.length,
          },
        }),
      );
    } catch (err) {
      reply.code(500).send(fail(500, 'INTERNAL_ERROR', String(err)));
    }
  });
}
