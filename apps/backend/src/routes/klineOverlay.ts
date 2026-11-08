/**
 * klineOverlay.ts — K 线手工画线持久化（独立 PR）
 *
 * ## 为什么后端要存
 *
 * `klinecharts@10.1.0` 只负责 overlay 绘制，**不持久化**。刷新页面后必须由前端
 * 按「当前标的 + 周期」重新拉取并重放，故落库放在业务层 SQLite（`user_kline_overlay`）。
 *
 * ## 📌 复权口径：**写死不复权（bfq）**
 *
 * 点位存的是 `timestamp + value`（当时成交价）。前复权（qfq）会在除权日改写历史价格，
 * 导致已画的线在刷新后**漂移** —— 画线是人对当时价格的判断，故固定 bfq。
 * 未来若支持 qfq，必须对历史点位做迁移（见 PR 说明）。
 *
 * ## 落点校验分工
 *
 * 「timestamp 必须落在已有 bar 上」**由前端在绘制结束时校验**：只有前端知道
 * 当前加载的 bar 集合（含周期聚合结果）；后端无法复现前端的窗口/聚合口径，
 * 若在后端硬校验会对合法请求误报。后端只做**结构性校验**（工具白名单 / 点数 /
 * 数值类型），属于纵深防御，不是落点权威判定。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConfigStore } from '../config/configStore.js';
import { fail, ok } from '../lib/envelope.js';
import type { JwtPayload } from '../services/auth.js';

type AuthedRequest = FastifyRequest & { user: JwtPayload };

/** 与前端 `OVERLAY_TOOLS` 一一对应；点数 = klinecharts 模板 `totalStep - 1` */
export const OVERLAY_POINT_COUNTS: Readonly<Record<string, number>> = {
  rayLine: 2,
  horizontalStraightLine: 1,
  fibonacciLine: 2,
  priceChannelLine: 3,
  simpleAnnotation: 1,
};

const PERIODS = new Set(['day', 'week', 'month']);
const SYMBOL_RE = /^(sh|sz|bj)\d{6}$/;
const MAX_TEXT_LENGTH = 120;

interface OverlayPointDto {
  timestamp: number;
  value: number;
}

interface OverlayRow {
  id: number;
  asset_code: string;
  period: string;
  overlay_name: string;
  points_json: string;
  text: string | null;
  created_at: string;
}

interface OverlayDto {
  id: number;
  symbol: string;
  period: string;
  name: string;
  points: OverlayPointDto[];
  text: string | null;
  created_at: string;
}

/** `points_json` 解析失败时返回空数组（前端会因点数不符而跳过重放，不阻塞其他标注） */
function parseStoredPoints(raw: string): OverlayPointDto[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is OverlayPointDto =>
        p !== null &&
        typeof p === 'object' &&
        typeof (p as OverlayPointDto).timestamp === 'number' &&
        typeof (p as OverlayPointDto).value === 'number',
    );
  } catch {
    return [];
  }
}

function toDto(row: OverlayRow): OverlayDto {
  return {
    id: row.id,
    symbol: row.asset_code,
    period: row.period,
    name: row.overlay_name,
    points: parseStoredPoints(row.points_json),
    text: row.text,
    created_at: row.created_at,
  };
}

/** 校验点位数组；返回错误文案（合法则返回 null） */
function validatePoints(raw: unknown, expected: number): string | null {
  if (!Array.isArray(raw)) return 'points 必须是数组';
  if (raw.length !== expected) {
    return `该工具需要 ${expected} 个落点，实际收到 ${raw.length} 个`;
  }
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return '落点格式不合法';
    const timestamp = (item as OverlayPointDto).timestamp;
    const value = (item as OverlayPointDto).value;
    if (typeof timestamp !== 'number' || !Number.isInteger(timestamp) || timestamp <= 0) {
      return '落点的 timestamp 必须是正整数（毫秒）';
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '落点的 value 必须是有限数值';
    }
  }
  return null;
}

export async function registerKlineOverlayRoutes(app: FastifyInstance) {
  /** GET /api/kline-overlays?symbol=sh600000&period=day */
  app.get('/api/kline-overlays', async (request: FastifyRequest, reply) => {
    const req = request as AuthedRequest;
    const query = request.query as Record<string, unknown>;
    const symbol = typeof query.symbol === 'string' ? query.symbol.trim().toLowerCase() : '';
    const period = typeof query.period === 'string' ? query.period : '';

    if (!SYMBOL_RE.test(symbol)) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', 'symbol 格式应为 sh600000 / sz000001'));
    }
    if (!PERIODS.has(period)) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', 'period 必须是 day / week / month'));
    }

    const rows = ConfigStore.getInstance()
      .db.prepare(
        `SELECT id, asset_code, period, overlay_name, points_json, text, created_at
           FROM user_kline_overlay
          WHERE user_id = ? AND asset_code = ? AND period = ? AND is_deleted = 0
          ORDER BY created_at ASC, id ASC`,
      )
      .all(req.user.sub, symbol, period) as OverlayRow[];

    return ok(rows.map(toDto));
  });

  /** POST /api/kline-overlays */
  app.post('/api/kline-overlays', async (request: FastifyRequest, reply) => {
    const req = request as AuthedRequest;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toLowerCase() : '';
    if (!SYMBOL_RE.test(symbol)) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', 'symbol 格式应为 sh600000 / sz000001'));
    }

    const period = typeof body.period === 'string' ? body.period : '';
    if (!PERIODS.has(period)) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', 'period 必须是 day / week / month'));
    }

    const name = typeof body.name === 'string' ? body.name : '';
    const expected = OVERLAY_POINT_COUNTS[name];
    if (expected === undefined) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', `不支持的画线工具：${name || '(空)'}`));
    }

    const pointError = validatePoints(body.points, expected);
    if (pointError) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', pointError));
    }

    // 文字标注必须带文字；其余工具忽略传入的 text
    let text: string | null = null;
    if (name === 'simpleAnnotation') {
      const rawText = typeof body.text === 'string' ? body.text.trim() : '';
      if (!rawText) {
        return reply.code(400).send(fail(400, 'OVERLAY_INVALID', '文字标注不能为空'));
      }
      if (rawText.length > MAX_TEXT_LENGTH) {
        return reply.code(400).send(fail(400, 'OVERLAY_INVALID', `标注文字不能超过 ${MAX_TEXT_LENGTH} 字`));
      }
      text = rawText;
    }

    const points = body.points as OverlayPointDto[];
    const db = ConfigStore.getInstance().db;
    const result = db
      .prepare(
        `INSERT INTO user_kline_overlay
           (user_id, asset_code, period, overlay_name, points_json, text, styles_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(req.user.sub, symbol, period, name, JSON.stringify(points), text);

    const id = Number(result.lastInsertRowid);
    const row = db
      .prepare(
        `SELECT id, asset_code, period, overlay_name, points_json, text, created_at
           FROM user_kline_overlay WHERE id = ?`,
      )
      .get(id) as OverlayRow;

    return reply.code(201).send(ok(toDto(row)));
  });

  /** DELETE /api/kline-overlays/:id —— 软删除（AGENTS：业务记录禁止物理删除） */
  app.delete('/api/kline-overlays/:id', async (request: FastifyRequest, reply) => {
    const req = request as AuthedRequest;
    const params = request.params as { id?: string };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send(fail(400, 'OVERLAY_INVALID', 'id 必须是正整数'));
    }

    const result = ConfigStore.getInstance()
      .db.prepare(
        `UPDATE user_kline_overlay
            SET is_deleted = 1, updated_at = datetime('now','localtime')
          WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      )
      .run(id, req.user.sub);

    if (result.changes === 0) {
      return reply.code(404).send(fail(404, 'NOT_FOUND', '画线不存在或已删除'));
    }
    return ok(null);
  });
}
