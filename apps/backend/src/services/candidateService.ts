/**
 * candidateService.ts —— 候选池（T50 / T56）领域逻辑
 *
 * 业务口径来源（**L1 业务规则唯一真相源**）：`Requirements_simplified.md` §5.7
 *   1. 候选池独立于自选列表
 *   2. MVP 支持手动加标的：**基准价 = 加入日前复权收盘价**
 *   3. 每次筛选/加入固化「基准价」
 *   4. 迁移自选时可选择：复用基准价 / 使用当前现价；**MVP 迁移只打标记，不自动创建自选关联**
 *
 * 数据落点（**L3 技术契约**）：`configStore.ts` 的 `user_asset_rel` 表
 *   - `candidate_base_price REAL`      基准价
 *   - `candidate_reason TEXT`          加入理由
 *   - `migrated_price_mode TEXT`       CHECK IN ('base','current')
 *   - `migrated_from_candidate INTEGER`
 *   - `UNIQUE(user_id, asset_code, rel_type)` —— **三列，不得改成两列**（AGENTS.md 硬约束）
 *
 * 行情来源：**DuckDB 只读**（AGENTS.md：Node 侧禁止写 DuckDB，写入权仅 tdx2db）。
 *   复用 `services/marketData.ts` 的 `batchGetLatestClose()`（1 次 IN + ROW_NUMBER 查询），
 *   禁止逐标的循环查询。
 *
 * ⚠️ 与既有实现的关系（**不要误读为重复实现**）：
 *   `routes/watch.ts:17` 的 `_crud(app, 'candidate')` 目前也注册了 `POST/GET /api/candidate`
 *   与 `POST /api/candidate/:asset_code/promote`，但**不写基准价、不收 price_mode**。
 *   本文件是 T50 要求的带基准价版本；T90 会做路由契约对齐，届时需确定唯一归属。
 *   在那之前二者行为不同是已知状态，不是本文件的 bug。
 */

import type { FastifyRequest } from 'fastify';
import type { JwtPayload } from './auth.js';
import { ConfigStore } from '../config/configStore.js';
import { batchGetLatestClose } from './marketData.js';

// ─────────────────────────── 常量 ───────────────────────────

/** T56：单次批量入池上限。SDD §4.4 未定义具体数值，取 100（T56 卡片明写「上限 100」） */
export const MAX_BATCH_CANDIDATES = 100;

/** 标���代码格式：sh600000 / sz000001（与 `watch.ts:65` 的现网校验保持一致） */
export const ASSET_CODE_RE = /^(sh|sz)\d{6}$/;

/** `candidate_reason` 入库长度上限（TEXT 无长度约束，防御性截断防线） */
export const MAX_REASON_LENGTH = 1000;

/** 相对收益保留 6 位小数（前端展示用，避免浮点尾差噪声） */
const RETURN_SCALE = 1e6;

export type PriceMode = 'base' | 'current';
export type BasePriceSource = 'user' | 'duckdb';

// ─────────────────────────── 错误类型 ───────────────────────────

/**
 * DuckDB 查询本身失败（文件缺失 / 被锁 / 表不存在）——外部行情源不可用。
 * SDD §4.3：`EXTERNAL_SOURCE_UNAVAILABLE` → 503
 */
export class QuoteSourceUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`行情库不可用，无法确定基准价: ${String(cause)}`);
    this.name = 'QuoteSourceUnavailableError';
  }
}

/**
 * DuckDB 查询成功但**查不到这些标的**（无行情数据 / 非股票标的）。
 * SDD §4.3 无「候选池基准价取不到」专有码，取最接近的 `SYMBOL_NOT_FOUND` → 404。
 * ⚠️ 禁止静默写 NULL —— 会把「无基准价」的记录混进候选池污染胜率统计。
 */
export class QuoteUnavailableError extends Error {
  readonly symbols: string[];
  constructor(symbols: string[]) {
    super(`行情库无以下标的的日线数据，无法确定基准价: ${symbols.join(', ')}`);
    this.name = 'QuoteUnavailableError';
    this.symbols = symbols;
  }
}

/** 候选池中不存在该标的的**未删除**候选记录 —— `SYMBOL_NOT_FOUND` → 404 */
export class CandidateNotFoundError extends Error {
  constructor(assetCode: string) {
    super(`候选池中不存在标的 ${assetCode}`);
    this.name = 'CandidateNotFoundError';
  }
}

// ─────────────────────────── 类型 ───────────────────────────

export interface CandidateRow {
  id: number;
  user_id: number;
  asset_code: string;
  rel_type: string;
  watch_date: string | null;
  candidate_reason: string | null;
  candidate_base_price: number | null;
  is_deleted: number;
  migrated_from_candidate: number | null;
  migrated_price_mode: string | null;
  created_at: string;
}

export interface ResolvedBasePrice {
  /** 写入 `candidate_base_price` 的数值 */
  basePrice: number;
  /** 基准价对应的行情日期（用户显式指定时为 null） */
  basePriceDate: string | null;
  /** 'user' = 用户显式传入；'duckdb' = 行情库查询所得 */
  source: BasePriceSource;
}

/** GET /api/candidate 的返回项 */
export interface CandidateListItem extends CandidateRow {
  /** 最新前复权收盘价（DuckDB 无行情 / DuckDB 不可用时为 null） */
  current_close: number | null;
  /** 基准价对应的行情日期 */
  base_price_date: string | null;
  /** 相对收益 = (当前价 - 基准价) / 基准价；任一端缺失则为 null */
  relative_return: number | null;
}

export interface BatchInsertResult {
  added: number;
  skipped: number;
  duplicates: string[];
}

// ─────────────────────────── 工具 ───────────────────────────

/**
 * 取鉴权后的用户。
 *
 * `routes/index.ts:44` 的 onRequest 钩子把 JWT payload 挂到了 `request.user`，
 * 但仓库未做 fastify 类型增强（`watch.ts:20` 因此写的是 `as any`）。
 * 这里用交叉类型取，**避免新增 `any`**。
 */
export function requireUser(request: FastifyRequest): JwtPayload {
  const user = (request as FastifyRequest & { user?: JwtPayload }).user;
  if (!user) throw new Error('鉴权信息缺失（onRequest 钩子未注入 request.user）');
  return user;
}

export function isValidAssetCode(value: unknown): value is string {
  return typeof value === 'string' && ASSET_CODE_RE.test(value);
}

/** `candidate_base_price` 校验：必须是有限正数 */
export function isValidBasePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 相对收益，缺任一端返回 null（**不返回 0** —— 0 会被误读成「持平」） */
export function computeRelativeReturn(
  basePrice: number | null,
  currentClose: number | null,
): number | null {
  if (basePrice === null || currentClose === null) return null;
  if (!Number.isFinite(basePrice) || basePrice === 0) return null;
  if (!Number.isFinite(currentClose)) return null;
  return Math.round(((currentClose - basePrice) / basePrice) * RETURN_SCALE) / RETURN_SCALE;
}

// ─────────────────────────── 基准价解析 ───────────────────────────

/**
 * 解析候选池基准价（Requirements §5.7 #2/#3）。
 *
 * - `overrides` 里显式给出的标的直接采用用户值（尊重用户输入，不查 DuckDB）
 * - 其余标的**合并成 1 次** `batchGetLatestClose` 查询（IN + ROW_NUMBER，非逐标的循环）
 * - DuckDB 查不到 → 抛 `QuoteUnavailableError`（调用方转 404），**绝不静默写 NULL**
 * - DuckDB 查询本身失败 → 抛 `QuoteSourceUnavailableError`（调用方转 503）
 */
export async function resolveBasePrices(
  symbols: string[],
  overrides: Map<string, number> = new Map(),
): Promise<Map<string, ResolvedBasePrice>> {
  const resolved = new Map<string, ResolvedBasePrice>();

  const needQuery: string[] = [];
  for (const code of symbols) {
    const override = overrides.get(code);
    if (override !== undefined) {
      resolved.set(code, { basePrice: override, basePriceDate: null, source: 'user' });
    } else {
      needQuery.push(code);
    }
  }

  if (needQuery.length === 0) return resolved;

  let closes: Map<string, { date: string; close: number }>;
  try {
    closes = await batchGetLatestClose(needQuery, 'qfq');
  } catch (err) {
    throw new QuoteSourceUnavailableError(err);
  }

  const missing: string[] = [];
  for (const code of needQuery) {
    const hit = closes.get(code);
    if (hit === undefined) {
      missing.push(code);
      continue;
    }
    resolved.set(code, { basePrice: hit.close, basePriceDate: hit.date, source: 'duckdb' });
  }

  if (missing.length > 0) throw new QuoteUnavailableError(missing);
  return resolved;
}

// ─────────────────────────── 候选池读写 ───────────────────────────

/**
 * 读取候选池 + 相对收益（T50 的 GET 侧）。
 *
 * 当前价同样来自 **1 次** `batchGetLatestClose`（不是逐标的循环）。
 * DuckDB 不可用时**降级**返回 `current_close: null` / `relative_return: null` ——
 * 列表页要能看，哪怕没有行情；但 `POST` 侧不允许降级（会污染基准价）。
 */
export async function listCandidatesWithReturn(userId: number): Promise<CandidateListItem[]> {
  const db = ConfigStore.getInstance().db;
  const rows = db
    .prepare(
      `SELECT id, user_id, asset_code, rel_type, watch_date, candidate_reason,
              candidate_base_price, is_deleted, migrated_from_candidate,
              migrated_price_mode, created_at
         FROM user_asset_rel
        WHERE user_id = ? AND rel_type = 'candidate' AND is_deleted = 0
        ORDER BY created_at DESC`,
    )
    .all(userId) as CandidateRow[];

  let closes = new Map<string, { date: string; close: number }>();
  if (rows.length > 0) {
    try {
      closes = await batchGetLatestClose(rows.map((r) => r.asset_code), 'qfq');
    } catch {
      // 行情降级：列表可读，相对收益为 null
      closes = new Map();
    }
  }

  return rows.map((row) => {
    const hit = closes.get(row.asset_code);
    const currentClose = hit?.close ?? null;
    return {
      ...row,
      current_close: currentClose,
      base_price_date: hit?.date ?? null,
      relative_return: computeRelativeReturn(row.candidate_base_price, currentClose),
    };
  });
}

/**
 * 批量入池（T56）：**整个调用包在一个 `db.transaction()` 里**。
 *
 * 幂等：`INSERT OR IGNORE` 命中 `UNIQUE(user_id, asset_code, rel_type)` 时 `changes === 0`，
 * 该标的计入 `duplicates` 且 `skipped +1`，**不报错**。
 *
 * 事务粒度说明：SQLite 的 `ON CONFLICT` 冲突算法只覆盖 UNIQUE / NOT NULL / CHECK，
 * **不覆盖外键**（SQLite 官方文档明载）。因此传入不存在的 `user_id` 会抛 FK 违例 →
 * 整批回滚 —— 这正是「事务中途失败全量回滚」的验证抓手。
 *
 * ⚠️ 软删除语义：`UNIQUE` 不忽略 `is_deleted`，故**已软删的候选仍算已存在** → 进 duplicates。
 * 这是「禁止物理删除 + 三列 UNIQUE」的必然结果，不是 bug。
 */
export function batchInsertCandidates(
  userId: number,
  assetCodes: string[],
  reason: string | null = null,
): BatchInsertResult {
  const db = ConfigStore.getInstance().db;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO user_asset_rel (user_id, asset_code, rel_type, candidate_reason)
     VALUES (?, ?, 'candidate', ?)`,
  );

  const runBatch = db.transaction((codes: string[]): BatchInsertResult => {
    const duplicates: string[] = [];
    let added = 0;

    for (const code of codes) {
      const info = insert.run(userId, code, reason);
      if (info.changes > 0) {
        added += 1;
      } else {
        duplicates.push(code);
      }
    }

    return { added, skipped: codes.length - added, duplicates };
  });

  return runBatch(assetCodes);
}

/**
 * 候选迁移打标记（T50 的 `price_mode` 侧 + Requirements §5.7 #4）。
 *
 * 只写标记，**不创建 watch 关联**（PRD S5 / SDD §12.3 B6）。
 * 与 `watch.ts:85-88` 现存的「INSERT 到 watch」分支行为不同，
 * 那是 T92 要收敛的存量偏差 —— 本函数按 Requirements/PRD 明文实现。
 *
 * 整个读-改-写在同一个 `db.transaction()` 内，失败时标记不会落库。
 */
export function markCandidateMigrated(
  userId: number,
  assetCode: string,
  priceMode: PriceMode,
): CandidateRow {
  const db = ConfigStore.getInstance().db;

  const runTx = db.transaction((): CandidateRow => {
    const row = db
      .prepare(
        `SELECT id, user_id, asset_code, rel_type, watch_date, candidate_reason,
                candidate_base_price, is_deleted, migrated_from_candidate,
                migrated_price_mode, created_at
           FROM user_asset_rel
          WHERE user_id = ? AND asset_code = ? AND rel_type = 'candidate' AND is_deleted = 0`,
      )
      .get(userId, assetCode) as CandidateRow | undefined;

    if (row === undefined) throw new CandidateNotFoundError(assetCode);

    db.prepare(
      `UPDATE user_asset_rel
          SET migrated_from_candidate = 1, migrated_price_mode = ?
        WHERE id = ?`,
    ).run(priceMode, row.id);

    return db
      .prepare(
        `SELECT id, user_id, asset_code, rel_type, watch_date, candidate_reason,
                candidate_base_price, is_deleted, migrated_from_candidate,
                migrated_price_mode, created_at
           FROM user_asset_rel WHERE id = ?`,
      )
      .get(row.id) as CandidateRow;
  });

  return runTx();
}