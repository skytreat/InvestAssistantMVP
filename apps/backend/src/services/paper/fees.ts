/**
 * 费用配置（PA-06 / 方案 §4.3）
 *
 * 口径（D3 定稿）：
 *   - 建户时**快照冻结**，结算只读 `paper_account.fee_snapshot_json`；
 *   - 回退链：显式 `feeConfigId`（账户级）→ 用户默认（本人最早一条）→ 系统默认 → 内置默认；
 *   - **支持印花税 / 过户费**（D1 定稿，2026-11-08）：模拟器 `TradeRules` 已补
 *     `stampDutyRate`（仅卖出）/ `transferFeeRate`（双边），费率可配且结算真实生效；
 *   - 旧快照（`fee_snapshot_json` 无这两个字段）**按 0 解读**，不报错（向后兼容）。
 */
import type Database from 'better-sqlite3';
import { DEFAULT_TRADE_RULES, type TradeRules } from '../backtest/execution/simulator.js';
import { PaperError } from './errors.js';

export interface FeeConfigValues {
  commissionRate: number;
  minCommission: number;
  stampDutyRate: number;
  transferFeeRate: number;
  slippageRate: number;
  lotSize: number;
  minNotional: number;
  priceLimitPct: number;
}

export type FeeSource = 'account' | 'user' | 'system' | 'builtin';

/** 建户时冻结到 `paper_account.fee_snapshot_json` 的内容 */
export interface FeeSnapshot extends FeeConfigValues {
  source: FeeSource;
  feeConfigId: number | null;
  name: string;
  brokerName: string | null;
}

export interface FeeConfigRecord extends FeeConfigValues {
  id: number;
  userId: number | null;
  brokerName: string | null;
  name: string;
  isSystemDefault: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FeeConfigInput extends Partial<FeeConfigValues> {
  name: string;
  brokerName?: string | null;
}

interface FeeRow {
  id: number;
  user_id: number | null;
  broker_name: string | null;
  name: string;
  commission_rate: number;
  min_commission: number;
  stamp_duty_rate: number;
  transfer_fee_rate: number;
  slippage_rate: number;
  lot_size: number;
  min_notional: number;
  price_limit_pct: number;
  is_system_default: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

const BUILTIN_SNAPSHOT: FeeSnapshot = Object.freeze({
  source: 'builtin' as const,
  feeConfigId: null,
  name: '内置默认（不可配置）',
  brokerName: null,
  commissionRate: DEFAULT_TRADE_RULES.commissionRate,
  minCommission: DEFAULT_TRADE_RULES.minCommission,
  stampDutyRate: 0,
  transferFeeRate: 0,
  slippageRate: DEFAULT_TRADE_RULES.slippageRate,
  lotSize: DEFAULT_TRADE_RULES.lotSize,
  minNotional: DEFAULT_TRADE_RULES.minNotional,
  priceLimitPct: DEFAULT_TRADE_RULES.priceLimit,
});

const RANGES: Record<Exclude<keyof FeeConfigValues, 'lotSize'>, [number, number]> = {
  commissionRate: [0, 0.003],
  minCommission: [0, 100],
  stampDutyRate: [0, 0.001],
  transferFeeRate: [0, 0.001],
  slippageRate: [0, 0.02],
  minNotional: [0, 10_000],
  priceLimitPct: [0, 0.5],
};

function resolveValues(input: Partial<FeeConfigValues>): FeeConfigValues {
  return {
    commissionRate: input.commissionRate ?? BUILTIN_SNAPSHOT.commissionRate,
    minCommission: input.minCommission ?? BUILTIN_SNAPSHOT.minCommission,
    stampDutyRate: input.stampDutyRate ?? 0,
    transferFeeRate: input.transferFeeRate ?? 0,
    slippageRate: input.slippageRate ?? BUILTIN_SNAPSHOT.slippageRate,
    lotSize: input.lotSize ?? BUILTIN_SNAPSHOT.lotSize,
    minNotional: input.minNotional ?? BUILTIN_SNAPSHOT.minNotional,
    priceLimitPct: input.priceLimitPct ?? BUILTIN_SNAPSHOT.priceLimitPct,
  };
}

/** 校验费率、档位与取值范围；不通过抛 `FEE_VALUE_INVALID` */
export function validateFeeConfig(input: Partial<FeeConfigValues>): FeeConfigValues {
  const values = resolveValues(input);

  for (const [key, [min, max]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    const v = values[key];
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new PaperError('FEE_VALUE_INVALID', 400, `${key}=${v} 超出允许范围 [${min}, ${max}]`);
    }
  }
  if (!Number.isInteger(values.lotSize) || values.lotSize < 1 || values.lotSize > 1000) {
    throw new PaperError('FEE_VALUE_INVALID', 400, `lotSize=${values.lotSize} 必须是 1~1000 的整数`);
  }
  return values;
}

/**
 * 冻结快照 → 模拟器 `TradeRules`（结算唯一入口；不读回退链）
 *
 * D1（F4 定稿）：印花税（仅卖出）/ 过户费（买卖双边）随快照进入规则；
 * **旧快照缺这两个字段时按 0 解读**（`?? 0`），不报错 —— 已有账户的结算结果逐位不变。
 */
export function feeSnapshotToTradeRules(snapshot: FeeSnapshot): TradeRules {
  const s = snapshot as Partial<FeeConfigValues>;
  return {
    commissionRate: snapshot.commissionRate,
    minCommission: snapshot.minCommission,
    stampDutyRate: s.stampDutyRate ?? 0,
    transferFeeRate: s.transferFeeRate ?? 0,
    slippageRate: snapshot.slippageRate,
    lotSize: snapshot.lotSize,
    minNotional: snapshot.minNotional,
    priceLimit: snapshot.priceLimitPct,
  };
}

/** 解析建户/预览用快照（回退链严格按 D3 顺序） */
export function resolveFeeConfig(
  db: Database.Database,
  args: { userId: number; feeConfigId?: number | null },
): FeeSnapshot {
  const explicit = args.feeConfigId;
  if (explicit !== undefined && explicit !== null) {
    const row = findById(db, explicit);
    if (!row) throw new PaperError('FEE_CONFIG_NOT_FOUND', 400, `费用配置 ${explicit} 不存在`);
    if (row.user_id !== null && row.user_id !== args.userId) {
      throw new PaperError('FEE_CONFIG_FORBIDDEN', 403, '不能使用其他用户的费用配置');
    }
    return toSnapshot(row, row.user_id === null ? 'system' : 'account');
  }

  const userRow = db
    .prepare(
      `SELECT * FROM paper_fee_config
        WHERE user_id = ? AND is_deleted = 0 AND is_system_default = 0
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .get(args.userId) as FeeRow | undefined;
  if (userRow) return toSnapshot(userRow, 'user');

  const systemRow = db
    .prepare(
      `SELECT * FROM paper_fee_config
        WHERE is_system_default = 1 AND is_deleted = 0
        ORDER BY id ASC LIMIT 1`,
    )
    .get() as FeeRow | undefined;
  if (systemRow) return toSnapshot(systemRow, 'system');

  return { ...BUILTIN_SNAPSHOT };
}

/** 系统默认行（回退链第 ③ 层）；已存在则不动 */
export function ensureSystemDefaultFeeConfig(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT 1 FROM paper_fee_config WHERE is_system_default = 1 AND is_deleted = 0`)
    .get();
  if (exists) return;
  const v = validateFeeConfig({});
  db.prepare(
    `INSERT INTO paper_fee_config (
       user_id, broker_name, name, commission_rate, min_commission, stamp_duty_rate,
       transfer_fee_rate, slippage_rate, lot_size, min_notional, price_limit_pct, is_system_default
     ) VALUES (NULL, '内置', '系统默认', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    v.commissionRate,
    v.minCommission,
    v.stampDutyRate,
    v.transferFeeRate,
    v.slippageRate,
    v.lotSize,
    v.minNotional,
    v.priceLimitPct,
  );
}

export function createFeeConfig(
  db: Database.Database,
  userId: number,
  input: FeeConfigInput,
): FeeConfigRecord {
  if (!input.name || !input.name.trim()) {
    throw new PaperError('FEE_VALUE_INVALID', 400, 'name 不能为空');
  }
  const v = validateFeeConfig(input);
  const dup = db
    .prepare(`SELECT 1 FROM paper_fee_config WHERE COALESCE(user_id, -1) = ? AND name = ? AND is_deleted = 0`)
    .get(userId, input.name.trim());
  if (dup) throw new PaperError('FEE_VALUE_INVALID', 400, `费用配置名「${input.name}」已存在`);

  const info = db
    .prepare(
      `INSERT INTO paper_fee_config (
         user_id, broker_name, name, commission_rate, min_commission, stamp_duty_rate,
         transfer_fee_rate, slippage_rate, lot_size, min_notional, price_limit_pct
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      input.brokerName ?? null,
      input.name.trim(),
      v.commissionRate,
      v.minCommission,
      v.stampDutyRate,
      v.transferFeeRate,
      v.slippageRate,
      v.lotSize,
      v.minNotional,
      v.priceLimitPct,
    );
  const row = findById(db, Number(info.lastInsertRowid));
  if (!row) throw new PaperError('FEE_CONFIG_NOT_FOUND', 500, '费用配置写入后回读失败');
  return rowToRecord(row);
}

export function updateFeeConfig(
  db: Database.Database,
  userId: number,
  id: number,
  input: Partial<FeeConfigInput>,
): FeeConfigRecord {
  const row = findById(db, id);
  if (!row || row.is_deleted === 1) {
    throw new PaperError('FEE_CONFIG_NOT_FOUND', 404, `费用配置 ${id} 不存在`);
  }
  if (row.user_id !== userId) {
    throw new PaperError('FEE_CONFIG_FORBIDDEN', 403, '系统配置或他人配置不可修改');
  }
  const merged = validateFeeConfig({
    commissionRate: input.commissionRate ?? row.commission_rate,
    minCommission: input.minCommission ?? row.min_commission,
    stampDutyRate: input.stampDutyRate ?? row.stamp_duty_rate,
    transferFeeRate: input.transferFeeRate ?? row.transfer_fee_rate,
    slippageRate: input.slippageRate ?? row.slippage_rate,
    lotSize: input.lotSize ?? row.lot_size,
    minNotional: input.minNotional ?? row.min_notional,
    priceLimitPct: input.priceLimitPct ?? row.price_limit_pct,
  });
  db.prepare(
    `UPDATE paper_fee_config SET
       broker_name = ?, name = ?, commission_rate = ?, min_commission = ?, stamp_duty_rate = ?,
       transfer_fee_rate = ?, slippage_rate = ?, lot_size = ?, min_notional = ?, price_limit_pct = ?,
       updated_at = datetime('now', 'localtime')
     WHERE id = ?`,
  ).run(
    input.brokerName ?? row.broker_name,
    (input.name ?? row.name).trim(),
    merged.commissionRate,
    merged.minCommission,
    merged.stampDutyRate,
    merged.transferFeeRate,
    merged.slippageRate,
    merged.lotSize,
    merged.minNotional,
    merged.priceLimitPct,
    id,
  );
  const after = findById(db, id);
  if (!after) throw new PaperError('FEE_CONFIG_NOT_FOUND', 500, '费用配置更新后回读失败');
  return rowToRecord(after);
}

export function deleteFeeConfig(db: Database.Database, userId: number, id: number): void {
  const row = findById(db, id);
  if (!row || row.is_deleted === 1) {
    throw new PaperError('FEE_CONFIG_NOT_FOUND', 404, `费用配置 ${id} 不存在`);
  }
  if (row.user_id !== userId) {
    throw new PaperError('FEE_CONFIG_FORBIDDEN', 403, '系统配置或他人配置不可删除');
  }
  db.prepare(
    `UPDATE paper_fee_config SET is_deleted = 1, updated_at = datetime('now', 'localtime') WHERE id = ?`,
  ).run(id);
}

export function listFeeConfigs(db: Database.Database, userId: number): FeeConfigRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM paper_fee_config
        WHERE is_deleted = 0 AND (user_id = ? OR is_system_default = 1)
        ORDER BY is_system_default DESC, created_at ASC, id ASC`,
    )
    .all(userId) as FeeRow[];
  return rows.map(rowToRecord);
}

function findById(db: Database.Database, id: number): FeeRow | undefined {
  return db.prepare(`SELECT * FROM paper_fee_config WHERE id = ?`).get(id) as FeeRow | undefined;
}

function toSnapshot(row: FeeRow, source: FeeSource): FeeSnapshot {
  return { ...rowToValues(row), source, feeConfigId: row.id, name: row.name, brokerName: row.broker_name };
}

function rowToValues(row: FeeRow): FeeConfigValues {
  return {
    commissionRate: row.commission_rate,
    minCommission: row.min_commission,
    stampDutyRate: row.stamp_duty_rate,
    transferFeeRate: row.transfer_fee_rate,
    slippageRate: row.slippage_rate,
    lotSize: row.lot_size,
    minNotional: row.min_notional,
    priceLimitPct: row.price_limit_pct,
  };
}

function rowToRecord(row: FeeRow): FeeConfigRecord {
  return {
    ...rowToValues(row),
    id: row.id,
    userId: row.user_id,
    brokerName: row.broker_name,
    name: row.name,
    isSystemDefault: row.is_system_default === 1,
    isDeleted: row.is_deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
