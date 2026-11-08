/**
 * 组合策略配置仓储（T133，PA-02）
 *
 * 职责：`strategy_combo` / `strategy_combo_condition` 的增删改查 + 软删 + 版本递增。
 * 不做条件计算、不产出信号（求值见 `comboEvaluator.ts`）。
 *
 * 口径（方案 §6，owner 已定）：
 * - **MVP 仅 AND**：`combine_op` 固定写 `'AND'`；
 * - **历史不可变（D4）**：本仓储只改配置，不触碰 `user_strategy_signal`；
 * - 条件变更 `config_version + 1`（用于 P1 版本化回放）；
 * - 软删 `is_deleted=1`，禁止物理删除。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** 适用品种（INV-S3-17 / PRD L358） */
export const COMBO_ASSET_SCOPES = [
  'all',
  'stock',
  'etf',
  'cross_border',
  'exclude_cross_border',
  'exclude_cash',
] as const;

export type ComboAssetScope = (typeof COMBO_ASSET_SCOPES)[number];

export interface ComboConditionInput {
  /** 只允许产出 BUY/SELL 的 monitor 插件（risk 插件由调用方/路由层拦截） */
  pluginId: string;
  enabled?: boolean;
  /** 形状 = 插件 `paramSchema` */
  params?: Record<string, unknown>;
}

export interface CreateComboInput {
  userId: number;
  name: string;
  assetScope?: ComboAssetScope;
  cooldownBars?: number;
  id?: string;
  conditions: ComboConditionInput[];
}

export interface UpdateComboPatch {
  name?: string;
  assetScope?: ComboAssetScope;
  cooldownBars?: number;
  enabled?: boolean;
  conditions?: ComboConditionInput[];
}

export interface ComboCondition {
  id: number;
  comboId: string;
  seq: number;
  pluginId: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface Combo {
  id: string;
  userId: number;
  name: string;
  enabled: boolean;
  combineOp: 'AND';
  assetScope: ComboAssetScope;
  period: 'daily';
  cooldownBars: number;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
  conditions: ComboCondition[];
}

/** 配置校验失败（路由层映射 400 `PARAM_INVALID`） */
export class ComboInputError extends Error {
  readonly code = 'PARAM_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ComboInputError';
  }
}

interface ComboRow {
  id: string;
  user_id: number;
  name: string;
  enabled: number;
  combine_op: string;
  asset_scope: string;
  period: string;
  cooldown_bars: number;
  config_version: number;
  created_at: string;
  updated_at: string;
}

interface ConditionRow {
  id: number;
  combo_id: string;
  seq: number;
  plugin_id: string;
  enabled: number;
  params_json: string;
}

function assertConditions(conditions: readonly ComboConditionInput[]): void {
  if (conditions.length < 2) {
    throw new ComboInputError('组合至少需要 2 个条件');
  }
  const seen = new Set<string>();
  for (const condition of conditions) {
    if (!condition.pluginId || condition.pluginId.trim() === '') {
      throw new ComboInputError('条件 pluginId 不能为空');
    }
    if (seen.has(condition.pluginId)) {
      throw new ComboInputError(`条件 pluginId 重复：${condition.pluginId}`);
    }
    seen.add(condition.pluginId);
    const params = condition.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) {
      throw new ComboInputError(`条件参数必须是对象：${condition.pluginId}`);
    }
  }
}

function assertAssetScope(scope: string): asserts scope is ComboAssetScope {
  if (!(COMBO_ASSET_SCOPES as readonly string[]).includes(scope)) {
    throw new ComboInputError(`未知适用品种：${scope}`);
  }
}

function assertCooldownBars(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new ComboInputError('冷却根数必须是 1~20 的整数');
  }
}

function assertName(name: string): void {
  if (name.trim() === '') {
    throw new ComboInputError('组合名称不能为空');
  }
}

function parseParams(raw: string, pluginId: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 落到下方统一报错
  }
  throw new ComboInputError(`条件参数不是合法 JSON 对象：${pluginId}`);
}

function mapCombo(row: ComboRow, conditions: ComboCondition[]): Combo {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    enabled: row.enabled === 1,
    combineOp: 'AND',
    assetScope: row.asset_scope as ComboAssetScope,
    period: 'daily',
    cooldownBars: row.cooldown_bars,
    configVersion: row.config_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conditions,
  };
}

function readConditions(db: Database.Database, comboId: string): ComboCondition[] {
  const rows = db
    .prepare(
      `SELECT id, combo_id, seq, plugin_id, enabled, params_json
         FROM strategy_combo_condition
        WHERE combo_id = ?
        ORDER BY seq ASC`,
    )
    .all(comboId) as ConditionRow[];

  return rows.map((row) => ({
    id: row.id,
    comboId: row.combo_id,
    seq: row.seq,
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    params: parseParams(row.params_json, row.plugin_id),
  }));
}

function insertConditions(
  db: Database.Database,
  comboId: string,
  conditions: readonly ComboConditionInput[],
): void {
  const insert = db.prepare(
    `INSERT INTO strategy_combo_condition (combo_id, seq, plugin_id, enabled, params_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  conditions.forEach((condition, index) => {
    insert.run(
      comboId,
      index + 1,
      condition.pluginId,
      condition.enabled === false ? 0 : 1,
      JSON.stringify(condition.params ?? {}),
    );
  });
}

/** 新建组合：主表 + 条件表在同一事务内写入，失败不留半成品 */
export function createCombo(db: Database.Database, input: CreateComboInput): Combo {
  assertName(input.name);
  assertConditions(input.conditions);
  const assetScope = input.assetScope ?? 'all';
  assertAssetScope(assetScope);
  const cooldownBars = input.cooldownBars ?? 3;
  assertCooldownBars(cooldownBars);

  const id = input.id ?? `combo_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO strategy_combo
         (id, user_id, name, enabled, combine_op, asset_scope, period, cooldown_bars, config_version)
       VALUES (?, ?, ?, 1, 'AND', ?, 'daily', ?, 1)`,
    ).run(id, input.userId, input.name.trim(), assetScope, cooldownBars);
    insertConditions(db, id, input.conditions);
  });
  run();

  const created = getCombo(db, input.userId, id);
  if (created === null) {
    throw new ComboInputError('组合创建后无法读取');
  }
  return created;
}

/** 读取单个存活组合（软删不可见） */
export function getCombo(db: Database.Database, userId: number, id: string): Combo | null {
  const row = db
    .prepare(
      `SELECT id, user_id, name, enabled, combine_op, asset_scope, period, cooldown_bars,
              config_version, created_at, updated_at
         FROM strategy_combo
        WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    )
    .get(id, userId) as ComboRow | undefined;

  if (!row) {
    return null;
  }
  return mapCombo(row, readConditions(db, id));
}

/** 列出存活组合（默认只返回启用的） */
export function listCombos(
  db: Database.Database,
  userId: number,
  options: { includeDisabled?: boolean } = {},
): Combo[] {
  const rows = db
    .prepare(
      `SELECT id, user_id, name, enabled, combine_op, asset_scope, period, cooldown_bars,
              config_version, created_at, updated_at
         FROM strategy_combo
        WHERE user_id = ? AND is_deleted = 0
          AND (? = 1 OR enabled = 1)
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(userId, options.includeDisabled ? 1 : 0) as ComboRow[];

  return rows.map((row) => mapCombo(row, readConditions(db, row.id)));
}

/**
 * 更新组合
 *
 * `config_version` 只在**判据变化**时 +1（条件/参数、适用品种、冷却）；
 * 改名与启停不递增，避免"版本"与"信号口径"脱钩。
 */
export function updateCombo(
  db: Database.Database,
  userId: number,
  id: string,
  patch: UpdateComboPatch,
): Combo | null {
  const current = getCombo(db, userId, id);
  if (current === null) {
    return null;
  }

  if (patch.name !== undefined) {
    assertName(patch.name);
  }
  if (patch.assetScope !== undefined) {
    assertAssetScope(patch.assetScope);
  }
  if (patch.cooldownBars !== undefined) {
    assertCooldownBars(patch.cooldownBars);
  }
  if (patch.conditions !== undefined) {
    assertConditions(patch.conditions);
  }

  const versionBump =
    patch.conditions !== undefined || patch.assetScope !== undefined || patch.cooldownBars !== undefined;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE strategy_combo
         SET name = COALESCE(?, name),
             enabled = COALESCE(?, enabled),
             asset_scope = COALESCE(?, asset_scope),
             cooldown_bars = COALESCE(?, cooldown_bars),
             config_version = config_version + ?,
             updated_at = datetime('now', 'localtime')
       WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    ).run(
      patch.name ?? null,
      patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
      patch.assetScope ?? null,
      patch.cooldownBars ?? null,
      versionBump ? 1 : 0,
      id,
      userId,
    );

    if (patch.conditions !== undefined) {
      db.prepare(`DELETE FROM strategy_combo_condition WHERE combo_id = ?`).run(id);
      insertConditions(db, id, patch.conditions);
    }
  });
  run();

  return getCombo(db, userId, id);
}

/** 启停（不改判据 ⇒ 不递增版本） */
export function toggleCombo(
  db: Database.Database,
  userId: number,
  id: string,
  enabled: boolean,
): Combo | null {
  return updateCombo(db, userId, id, { enabled });
}

/** 软删：`is_deleted=1` + `enabled=0`，历史信号不动 */
export function deleteCombo(db: Database.Database, userId: number, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE strategy_combo
         SET is_deleted = 1,
             enabled = 0,
             updated_at = datetime('now', 'localtime')
       WHERE id = ? AND user_id = ? AND is_deleted = 0`,
    )
    .run(id, userId);
  return result.changes > 0;
}
