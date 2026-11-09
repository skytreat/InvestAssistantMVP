/**
 * 纸面账户生命周期（PA-07 / 方案 §3.3、§5.2）
 *
 * 边界（S1 只做「表 + 配置 + 建户/查询/关闭/手动切阶段」）：
 *   - **不结算、不决策**（S2/S3）；
 *   - **不做出入金**（D5）：`initial_cash` 建户后不可变，DB 触发器兜底；
 *   - **单用户单账户**（D6）：`idx_paper_account_live_user` 唯一索引兜底。
 *
 * 切阶段 = **冷启动**（§3.3）：清水位、清持仓检查点、现金回到 `initial_cash`，
 * 影子期 `paper_order` 永久保留、**不补记**。
 */
import type Database from 'better-sqlite3';
import { DEFAULT_TRADE_RULES } from '../backtest/execution/simulator.js';
import { loadHolidayList, nextTradingDay } from '../backtest/calendar.js';
import { PaperError } from './errors.js';
import { resolveFeeConfig, type FeeSnapshot } from './fees.js';
import { resolvePaperStrategy } from './strategies.js';
import type { ParamField } from '../pluginEngine.js';

export type PaperPhase = 'shadow' | 'ledger';
export type PaperStatus = 'active' | 'paused' | 'closed';

export interface PaperAccountDto {
  id: number;
  userId: number;
  name: string;
  strategyId: string;
  strategyVersion: string;
  strategyName: string;
  params: Record<string, unknown>;
  rules: Record<string, unknown>;
  phase: PaperPhase;
  status: PaperStatus;
  initialCash: number;
  cash: number;
  startDate: string | null;
  ledgerStartDate: string | null;
  lastDecisionDate: string | null;
  lastSettledDate: string | null;
  benchmarkAssetCode: string;
  feeConfigId: number | null;
  feeSnapshot: FeeSnapshot;
  createdAt: string;
  updatedAt: string;
}

interface PaperAccountRow {
  id: number;
  user_id: number;
  strategy_id: string;
  strategy_version: string;
  strategy_name: string;
  name: string;
  params_json: string;
  rules_json: string;
  fee_config_id: number | null;
  fee_snapshot_json: string;
  phase: PaperPhase;
  status: PaperStatus;
  initial_cash: number;
  cash: number;
  start_date: string | null;
  ledger_start_date: string | null;
  last_decision_date: string | null;
  last_settled_date: string | null;
  benchmark_asset_code: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePaperAccountInput {
  userId: number;
  strategyId: string;
  strategyVersion: string;
  params?: Record<string, unknown>;
  initialCash: number;
  name?: string;
  feeConfigId?: number | null;
}

/** 本地时区的 `YYYY-MM-DD`（不依赖 `toISOString()` 的 UTC 口径） */
export function todayLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 建户参数校验（PA-07 补口）：按策略声明的 `paramSchema` 检查类型 / 范围 / 枚举。
 *
 * 只校验**声明过的**字段：`runtimeInjected` 与 schema 外字段跳过（各策略可能携带内部参数）；
 * `undefined` / `null` 视为「未提供」，由 `defaultParams` 兜底。
 */
function validateStrategyParams(
  schema: readonly ParamField[],
  params: Readonly<Record<string, unknown>>,
): void {
  const fail = (msg: string): never => {
    throw new PaperError('PARAM_INVALID', 400, msg);
  };
  for (const field of schema) {
    const value = params[field.key];
    if (value === undefined || value === null) continue;
    const name = `${field.label}(${field.key})`;
    switch (field.type) {
      case 'number':
      case 'integer': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          fail(`${name} 必须是${field.type === 'integer' ? '整数' : '数字'}`);
        }
        const num = value as number;
        if (field.type === 'integer' && !Number.isInteger(num)) {
          fail(`${name} 必须是整数（当前 ${String(num)}）`);
        }
        if (field.min !== undefined && num < field.min) {
          fail(`${name} 不能小于 ${field.min}（当前 ${String(num)}）`);
        }
        if (field.max !== undefined && num > field.max) {
          fail(`${name} 不能大于 ${field.max}（当前 ${String(num)}）`);
        }
        break;
      }
      case 'boolean':
        if (typeof value !== 'boolean') fail(`${name} 必须是 true / false`);
        break;
      case 'string':
        if (typeof value !== 'string' || value.trim() === '') {
          fail(`${name} 必须是非空字符串`);
        }
        break;
      case 'select': {
        const options = field.options ?? [];
        if (typeof value !== 'string' || !options.includes(value)) {
          fail(`${name} 必须是以下之一：${options.join(' / ')}（当前 ${String(value)}）`);
        }
        break;
      }
      default:
        break;
    }
  }
}

export function createPaperAccount(
  db: Database.Database,
  businessDb: Database.Database,
  input: CreatePaperAccountInput,
): PaperAccountDto {
  if (!Number.isFinite(input.initialCash) || input.initialCash <= 0) {
    throw new PaperError('PARAM_INVALID', 400, 'initialCash 必须为正数（单位：元）');
  }
  if (
    input.params !== undefined &&
    (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params))
  ) {
    throw new PaperError('PARAM_INVALID', 400, 'params 必须是对象');
  }

  const user = businessDb.prepare(`SELECT id FROM user_account WHERE id = ?`).get(input.userId);
  if (!user) throw new PaperError('USER_NOT_FOUND', 400, `用户 ${input.userId} 不存在`);

  const strategy = resolvePaperStrategy(input.strategyId, input.strategyVersion);
  const params = { ...strategy.defaultParams, ...(input.params ?? {}) };
  validateStrategyParams(strategy.paramSchema, params);
  const feeSnapshot = resolveFeeConfig(db, { userId: input.userId, feeConfigId: input.feeConfigId });
  // 「其它交易规则」快照：先卖后买口径 + 涨跌停幅度（费用快照之外的部分）
  const rules = {
    buyBeforeSell: false,
    priceLimit: feeSnapshot.priceLimitPct ?? DEFAULT_TRADE_RULES.priceLimit,
  };

  let inserted: number;
  try {
    const info = db
      .prepare(
        `INSERT INTO paper_account (
           user_id, strategy_id, strategy_version, strategy_name, name,
           params_json, rules_json, fee_config_id, fee_snapshot_json,
           phase, status, initial_cash, cash, benchmark_asset_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'shadow', 'active', ?, ?, 'sh510300')`,
      )
      .run(
        input.userId,
        strategy.id,
        strategy.version,
        strategy.name,
        (input.name ?? '纸面账户').trim() || '纸面账户',
        JSON.stringify(params),
        JSON.stringify(rules),
        feeSnapshot.feeConfigId,
        JSON.stringify(feeSnapshot),
        input.initialCash,
        input.initialCash,
      );
    inserted = Number(info.lastInsertRowid);
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new PaperError('PAPER_ACCOUNT_EXISTS', 409, '该用户已有在用纸面账户（单用户单账户）');
    }
    throw err;
  }

  const row = findRow(db, input.userId, inserted);
  if (!row) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 500, '建户后回读失败');
  return toDto(row);
}

export function listPaperAccounts(db: Database.Database, userId: number): PaperAccountDto[] {
  const rows = db
    .prepare(
      `SELECT * FROM paper_account WHERE user_id = ? AND is_deleted = 0 ORDER BY created_at ASC, id ASC`,
    )
    .all(userId) as PaperAccountRow[];
  return rows.map(toDto);
}

export function getPaperAccount(db: Database.Database, userId: number, id: number): PaperAccountDto {
  const row = findRow(db, userId, id);
  if (!row) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 404, `纸面账户 ${id} 不存在`);
  return toDto(row);
}

export function closePaperAccount(db: Database.Database, userId: number, id: number): PaperAccountDto {
  const row = findRow(db, userId, id);
  if (!row) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 404, `纸面账户 ${id} 不存在`);
  if (row.status === 'closed') return toDto(row);
  db.prepare(
    `UPDATE paper_account SET status = 'closed', updated_at = datetime('now', 'localtime')
      WHERE id = ? AND user_id = ?`,
  ).run(id, userId);
  const after = findRow(db, userId, id);
  if (!after) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 500, '关闭后回读失败');
  return toDto(after);
}

export interface ChangePhaseInput {
  to: PaperPhase;
  /** 危险操作二次确认（前端必须弹窗后置 true）；缺失或不为 true 一律拒绝 */
  confirm: boolean;
  /** 注入用；默认取本地当天 */
  today?: string;
  /** 注入用；默认读 DuckDB `raw_holidays` */
  loadHolidays?: () => Promise<string[]>;
}

/**
 * 手动切换阶段（**单向** shadow → ledger，且**冷启动**）
 *
 * 失败语义：全部抛 `PaperError`，不允许半切换 —— 更新在单事务内完成。
 * `confirm` 在服务层再次校验（前端弹窗只是 UX，不能作为唯一防线）。
 */
export async function changePaperPhase(
  db: Database.Database,
  userId: number,
  id: number,
  input: ChangePhaseInput,
): Promise<PaperAccountDto> {
  if (input.confirm !== true) {
    throw new PaperError('PAPER_CONFIRM_REQUIRED', 400, '切换阶段必须显式确认（confirm=true）');
  }
  if (input.to !== 'ledger') {
    throw new PaperError('PAPER_PHASE_NOT_ALLOWED', 400, '阶段只允许单向 shadow → ledger');
  }

  const row = findRow(db, userId, id);
  if (!row) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 404, `纸面账户 ${id} 不存在`);
  if (row.status !== 'active') {
    throw new PaperError('PAPER_ACCOUNT_NOT_ACTIVE', 409, `账户状态为 ${row.status}，不能切阶段`);
  }
  if (row.phase !== 'shadow') {
    throw new PaperError('PAPER_PHASE_TRANSITION_INVALID', 409, `当前阶段已是 ${row.phase}`);
  }
  if (row.ledger_start_date !== null) {
    throw new PaperError('PAPER_PHASE_TRANSITION_INVALID', 409, '落账期已启动，不允许再次切换');
  }

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM paper_order
        WHERE account_id = ? AND status = 'pending' AND is_deleted = 0`,
    )
    .get(id) as { n: number };
  if (pending.n > 0) {
    throw new PaperError('PAPER_PENDING_EXISTS', 409, `存在 ${pending.n} 条待成交订单，不能切阶段`);
  }

  const today = input.today ?? todayLocalDate();
  let ledgerStart: string;
  try {
    const holidays = await (input.loadHolidays ?? loadHolidayList)();
    ledgerStart = nextTradingDay(today, holidays);
  } catch (err) {
    if (err instanceof PaperError) throw err;
    throw new PaperError(
      'CALENDAR_UNAVAILABLE',
      503,
      `无法确定下一交易日（休市日历不可用）：${(err as Error).message}`,
    );
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE paper_account SET
         phase = 'ledger',
         cash = initial_cash,
         ledger_start_date = ?,
         last_decision_date = NULL,
         last_settled_date = NULL,
         updated_at = datetime('now', 'localtime')
       WHERE id = ? AND user_id = ? AND phase = 'shadow' AND ledger_start_date IS NULL`,
    ).run(ledgerStart, id, userId);

    // 冷启动：清空持仓检查点（影子期本就不写，此处为幂等防御）
    db.prepare(`DELETE FROM paper_position WHERE account_id = ?`).run(id);

    // 种子净值点（§3.3）：落账起点 = 初始现金；S3 首次结算同键 UPSERT，不会重复
    db.prepare(
      `INSERT INTO paper_equity (
         account_id, trade_date, equity, cash, risk_mv, cash_mv, exposure, benchmark_stale
       ) VALUES (?, ?, ?, ?, 0, 0, 0, 0)
       ON CONFLICT(account_id, trade_date) DO UPDATE SET
         equity = excluded.equity,
         cash = excluded.cash,
         risk_mv = excluded.risk_mv,
         cash_mv = excluded.cash_mv,
         exposure = excluded.exposure,
         updated_at = datetime('now', 'localtime')`,
    ).run(id, ledgerStart, row.initial_cash, row.initial_cash);
  });
  tx();

  const after = findRow(db, userId, id);
  if (!after) throw new PaperError('PAPER_ACCOUNT_NOT_FOUND', 500, '切阶段后回读失败');
  return toDto(after);
}

function findRow(db: Database.Database, userId: number, id: number): PaperAccountRow | undefined {
  return db
    .prepare(`SELECT * FROM paper_account WHERE id = ? AND user_id = ? AND is_deleted = 0`)
    .get(id, userId) as PaperAccountRow | undefined;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toDto(row: PaperAccountRow): PaperAccountDto {
  const snapshot = parseJson<FeeSnapshot | null>(row.fee_snapshot_json, null);
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    strategyName: row.strategy_name,
    params: parseJson<Record<string, unknown>>(row.params_json, {}),
    rules: parseJson<Record<string, unknown>>(row.rules_json, {}),
    phase: row.phase,
    status: row.status,
    initialCash: row.initial_cash,
    cash: row.cash,
    startDate: row.start_date,
    ledgerStartDate: row.ledger_start_date,
    lastDecisionDate: row.last_decision_date,
    lastSettledDate: row.last_settled_date,
    benchmarkAssetCode: row.benchmark_asset_code,
    feeConfigId: row.fee_config_id,
    // 快照缺失时给内置兜底，保证 DTO 形状稳定（正常路径不会走到）
    feeSnapshot: snapshot ?? {
      source: 'builtin',
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
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
