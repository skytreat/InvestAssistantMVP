/**
 * K 线形态标注接口（只做图上标注，**不产生信号**）
 *
 * GET /api/quote/:symbol/patterns?days=120
 *
 * 口径：`docs/client/pattern_recognition_design.md`
 * - 一律按 **qfq 前复权** 识别（除权缺口会伪造跳空、破坏几何关系）
 * - 只读行情库（DuckDB），不写业务库
 * - 返回的形态只供前端 `APP_PATTERN` 指标自绘；无 direction、不进 F1/Top5/paper
 *
 * ⚠️ 本路由**独立于 `/api/quote/:symbol/kline`**：kline DTO 正被画线/组合策略线改动，
 *    形态另开端点避免扩大冲突面（设计文档 §7 / §13.1 #6）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { queryDuckDB } from '../db/duckdb.js';
import { ok, fail } from '../lib/envelope.js';
import type { JwtPayload } from '../services/auth.js';
import { detectDoubleTopBottom, detectHeadShoulders } from '../services/patterns/index.js';

type AuthedRequest = FastifyRequest & { user?: JwtPayload };

interface KlineRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

/**
 * 形态标注的最小结构（双顶/双底与头肩共用）
 *
 * ⚠️ 两种形态的 `points[].role` 不同（`first/middle/second` vs 肩/颈/头），
 *    故这里只要求结构字段，不做 role 枚举约束。
 */
interface AnnotatedPattern {
  kind: string;
  startIndex: number;
  points: Array<{ role: string; date: string; price: number }>;
  neckline: {
    from: { index: number; price: number };
    to: { index: number; price: number };
    slope: number;
  };
  breakout: { date: string; close: number; penetrationPct: number };
  /** 两种形态的指标字段不同（双顶/双底 vs 头肩），DTO 原样透传 */
  metrics: object;
}

/** 复权视图只取 qfq 一侧（分类见 `routes/kline.ts` 的 FQ_VIEWS_BY_CLASS） */
const QFQ_VIEW_BY_CLASS: Record<string, string> = {
  stock: 'v_stock_qfq',
  etf: 'v_etf_qfq',
};

const DEFAULT_DAYS = 120;
const MIN_DAYS = 10;
const MAX_DAYS = 500;

/** 形态 DTO：日期 + 价位，前端按日期映射到当前周期的 K 线桶 */
function toPatternDto(p: AnnotatedPattern, bars: KlineRow[]) {
  return {
    kind: p.kind,
    points: p.points.map((point) => ({
      role: point.role,
      date: point.date,
      price: point.price,
    })),
    neckline: {
      fromDate: bars[p.neckline.from.index]?.date ?? '',
      toDate: bars[p.neckline.to.index]?.date ?? '',
      fromPrice: p.neckline.from.price,
      toPrice: p.neckline.to.price,
      slope: p.neckline.slope,
    },
    breakout: {
      date: p.breakout.date,
      close: p.breakout.close,
      penetrationPct: p.breakout.penetrationPct,
    },
    metrics: p.metrics,
  };
}

export async function registerPatternRoutes(app: FastifyInstance) {
  app.get('/api/quote/:symbol/patterns', async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!user) {
      return reply.code(401).send(fail(401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <jwt>'));
    }

    const { symbol } = request.params as { symbol: string };
    if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) {
      return reply.code(400).send(fail(400, 'SYMBOL_NOT_FOUND', 'symbol 格式应为 sh600000 / sz000001'));
    }

    const query = request.query as { days?: number };
    const rawDays = Number(query.days ?? DEFAULT_DAYS);
    const days = Number.isFinite(rawDays)
      ? Math.min(Math.max(Math.trunc(rawDays), MIN_DAYS), MAX_DAYS)
      : DEFAULT_DAYS;

    try {
      const classRows = await queryDuckDB<{ class: string }>(
        'SELECT class FROM raw_symbol_class WHERE symbol = ?',
        [symbol],
      );
      const symbolClass = classRows[0]?.class ?? 'stock';
      const view = QFQ_VIEW_BY_CLASS[symbolClass] ?? QFQ_VIEW_BY_CLASS.stock;

      const rows = await queryDuckDB<KlineRow>(
        `SELECT date, open, high, low, close, volume, amount
         FROM ${view}
         WHERE symbol = ?
         ORDER BY date DESC
         LIMIT ?`,
        [symbol, days],
      );
      const bars = rows.reverse();

      if (bars.length === 0) {
        return reply.send(ok({ symbol, fq: 'qfq', patterns: [] }));
      }

      // 双顶/双底 + 头肩（同一套 ZigZag 枢轴与 ATR 口径），按形态起点排序
      const detected = [...detectDoubleTopBottom(bars), ...detectHeadShoulders(bars)].sort(
        (a, b) => a.startIndex - b.startIndex,
      );
      const patterns = detected.map((p) => toPatternDto(p, bars));
      return reply.send(ok({ symbol, fq: 'qfq', patterns }));
    } catch (err) {
      app.log.warn({ err, symbol, days }, '形态识别查询失败');
      return reply.code(500).send(fail(500, 'INTERNAL_ERROR', '形态识别查询失败'));
    }
  });
}
