/**
 * 纸面账户 schema（PA-05）—— 与回测 **同库不同前缀**（D1 定稿：`data/backtest.db`）
 *
 * 🔴 **命名与隔离是硬验收项**（方案 §13.4）：
 *   - 表：`paper_account / paper_position / paper_order / paper_equity / paper_fee_config`（不多不少）；
 *   - 索引：一律 `idx_paper_*`；触发器：一律 `trg_paper_*`；
 *   - `paper_*` 与 `bt_*` **零交叉引用**（外键 / 触发器 / 视图 / 定义文本四路断言）。
 *
 * `createPaperSchema(db)` 在建表后**同一函数内立刻**跑隔离校验，任一断言失败整体抛错
 * （不留半成品）。理由：清理 / 重建脚本一旦误伤 `paper_*` 就是账本丢失，隔离必须由代码断言保证。
 *
 * ⚠️ **不把 paper 建表塞进 `BacktestStore`**：回测侧代码零改动（M3/M4 行为不变），
 * 纸面用自己的连接（WAL + busy_timeout + foreign_keys），两者共享同一 SQLite 文件。
 */
import type Database from 'better-sqlite3';

/** 纸面 schema 固定表清单（白名单：多一张少一张都算失败） */
export const PAPER_TABLES: readonly string[] = [
  'paper_account',
  'paper_equity',
  'paper_fee_config',
  'paper_order',
  'paper_position',
];

/** 纸面表 / 索引 / 触发器定义（幂等：全部 `IF NOT EXISTS`） */
const PAPER_SCHEMA_SQL = `
-- ─────────────────────────────────────────────────────────────
-- 费用配置（D3 定稿）：允许用户/券商配置；建户时快照冻结
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_fee_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,                 -- NULL = 系统级配置（所有用户可用）
    broker_name TEXT,                -- 「券商配置」展示标签；NULL = 用户手工配置
    name TEXT NOT NULL,
    commission_rate REAL NOT NULL DEFAULT 0.0001
        CHECK (commission_rate >= 0 AND commission_rate <= 0.003),
    min_commission REAL NOT NULL DEFAULT 5
        CHECK (min_commission >= 0 AND min_commission <= 100),
    stamp_duty_rate REAL NOT NULL DEFAULT 0     -- 印花税（仅卖出）；0 = ETF 口径，D1 起支持非 0
        CHECK (stamp_duty_rate >= 0 AND stamp_duty_rate <= 0.001),
    transfer_fee_rate REAL NOT NULL DEFAULT 0   -- 过户费（双边）；0 = ETF 口径，D1 起支持非 0
        CHECK (transfer_fee_rate >= 0 AND transfer_fee_rate <= 0.001),
    slippage_rate REAL NOT NULL DEFAULT 0.0001
        CHECK (slippage_rate >= 0 AND slippage_rate <= 0.02),
    lot_size INTEGER NOT NULL DEFAULT 100
        CHECK (lot_size >= 1 AND lot_size <= 1000),
    min_notional REAL NOT NULL DEFAULT 10
        CHECK (min_notional >= 0 AND min_notional <= 10000),
    price_limit_pct REAL NOT NULL DEFAULT 0.10
        CHECK (price_limit_pct >= 0 AND price_limit_pct <= 0.5),
    is_system_default INTEGER NOT NULL DEFAULT 0 CHECK (is_system_default IN (0, 1)),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 系统默认行全库至多一条（回退链的第 ③ 层）
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_fee_config_system_default
    ON paper_fee_config (is_system_default) WHERE is_system_default = 1 AND is_deleted = 0;

-- 同一用户下配置名唯一（系统级配置 user_id 为 NULL，靠 name 区分）
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_fee_config_user_name
    ON paper_fee_config (COALESCE(user_id, -1), name) WHERE is_deleted = 0;

-- ─────────────────────────────────────────────────────────────
-- 纸面账户（D6：单用户单账户；该账户锁定一个策略与一个版本）
-- ⚠️ 跨库限制：user_account 在 business.db，此处**不能**建外键，归属由服务层校验
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,  -- D4：锁定版本；运行时按 (id, version) 精确解析
    strategy_name TEXT NOT NULL,
    name TEXT NOT NULL,
    params_json TEXT NOT NULL,       -- 建户时参数快照，之后不可变
    rules_json TEXT NOT NULL,        -- 其它交易规则快照（先卖后买/涨跌停等）
    fee_config_id INTEGER,           -- 溯源用；NULL = 走内置默认
    fee_snapshot_json TEXT NOT NULL, -- D3：建户时冻结的费用快照，结算只读它
    phase TEXT NOT NULL DEFAULT 'shadow' CHECK (phase IN ('shadow', 'ledger')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
    initial_cash REAL NOT NULL CHECK (initial_cash > 0),
    cash REAL NOT NULL CHECK (cash >= -0.01),
    start_date TEXT,                 -- 影子期首个决策日
    ledger_start_date TEXT,          -- 落账期首个决策日（手动切换时写入）
    last_decision_date TEXT,
    last_settled_date TEXT,
    benchmark_asset_code TEXT NOT NULL DEFAULT 'sh510300',
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (fee_config_id) REFERENCES paper_fee_config(id)
);

-- D6：一个用户至多一个在用纸面账户（软删除 / 关闭后允许重建）
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_account_live_user
    ON paper_account (user_id) WHERE is_deleted = 0 AND status <> 'closed';

CREATE INDEX IF NOT EXISTS idx_paper_account_user_status
    ON paper_account (user_id, status);

-- D5：不做出入金 ⇒ 初始资金建户后不可变（DB 级兜底，API 也不提供改额接口）
CREATE TRIGGER IF NOT EXISTS trg_paper_account_initial_cash_immutable
BEFORE UPDATE OF initial_cash ON paper_account
FOR EACH ROW
WHEN OLD.initial_cash <> NEW.initial_cash
BEGIN
    SELECT RAISE(ABORT, 'paper_account.initial_cash is immutable (D5)');
END;

-- ─────────────────────────────────────────────────────────────
-- 当前持仓（截至 last_settled_date 的检查点）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_position (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 0 CHECK (qty >= 0),
    avg_cost REAL NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
    cost_basis REAL NOT NULL DEFAULT 0 CHECK (cost_basis >= 0),
    -- 结算完成后的「次日可卖量」= qty − 当日买入量
    closeable_qty REAL NOT NULL DEFAULT 0 CHECK (closeable_qty >= 0 AND closeable_qty <= qty),
    last_buy_date TEXT,
    last_price REAL,                 -- 展示用，不参与记账
    last_price_date TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (account_id, asset_code),
    FOREIGN KEY (account_id) REFERENCES paper_account(id)
);

-- ─────────────────────────────────────────────────────────────
-- 订单 / 成交 / 未成交事件（同一张表，用 status 区分）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_order (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    signal_id TEXT NOT NULL,         -- 内部自关联：psig_<account_id>_<decision_date>_<asset_code>
    decision_date TEXT NOT NULL,     -- 决策日 T
    trade_date TEXT NOT NULL,        -- 预期成交日 T+1
    seq INTEGER NOT NULL,            -- 保留 TargetSet.targets 的原始顺序；禁止按 symbol 重排
    asset_code TEXT NOT NULL,
    intent_kind TEXT NOT NULL CHECK (intent_kind IN ('target', 'liquidate')),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    rebalance_mode TEXT NOT NULL CHECK (rebalance_mode IN ('replace', 'incremental')),
    target_weight REAL CHECK (target_weight IS NULL OR (target_weight >= 0 AND target_weight <= 1)),
    target_notional REAL NOT NULL DEFAULT 0 CHECK (target_notional >= 0),
    cutoff_equity REAL NOT NULL CHECK (cutoff_equity >= 0),
    intent_notional REAL NOT NULL DEFAULT 0 CHECK (intent_notional >= 0),
    status TEXT NOT NULL CHECK (status IN ('shadow', 'pending', 'noop', 'filled', 'unfilled', 'superseded')),
    filled_qty REAL NOT NULL DEFAULT 0 CHECK (filled_qty >= 0),
    fill_price REAL CHECK (fill_price IS NULL OR fill_price >= 0),
    filled_notional REAL NOT NULL DEFAULT 0 CHECK (filled_notional >= 0),
    fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
    slippage_cost REAL NOT NULL DEFAULT 0 CHECK (slippage_cost >= 0),
    unfilled_reason TEXT CHECK (unfilled_reason IS NULL OR unfilled_reason IN (
        'suspended', 'limit-up', 'limit-down', 't-plus-1', 'no-position',
        'round-lot-zero', 'below-min-notional', 'insufficient-cash',
        'no-target-value', 'turnover-capped'
    )),
    unfilled_detail TEXT,
    is_replayed INTEGER NOT NULL DEFAULT 0 CHECK (is_replayed IN (0, 1)),
    settled_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (account_id, signal_id),
    UNIQUE (account_id, decision_date, asset_code),
    FOREIGN KEY (account_id) REFERENCES paper_account(id)
);

CREATE INDEX IF NOT EXISTS idx_paper_order_due
    ON paper_order (account_id, trade_date, status);

CREATE INDEX IF NOT EXISTS idx_paper_order_decision
    ON paper_order (account_id, decision_date, status);

-- ─────────────────────────────────────────────────────────────
-- 每日净值快照（镜像 bt_equity 的字段口径）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_equity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    equity REAL NOT NULL CHECK (equity >= -0.01),
    cash REAL NOT NULL CHECK (cash >= -0.01),
    risk_mv REAL NOT NULL DEFAULT 0,
    cash_mv REAL NOT NULL DEFAULT 0,
    exposure REAL NOT NULL DEFAULT 0,
    benchmark_close REAL,
    benchmark_stale INTEGER NOT NULL DEFAULT 0 CHECK (benchmark_stale IN (0, 1)),
    drawdown_ratio REAL,
    stale_symbol_count INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (account_id, trade_date),
    FOREIGN KEY (account_id) REFERENCES paper_account(id)
);

CREATE INDEX IF NOT EXISTS idx_paper_equity_account_date
    ON paper_equity (account_id, trade_date);
`;

/** 纸面 schema 隔离校验失败 */
export class PaperSchemaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaperSchemaError';
    this.code = code;
  }
}

interface MasterRow {
  name: string;
  type: string;
  tbl_name: string;
  sql: string | null;
}

function masterRows(db: Database.Database): MasterRow[] {
  return db
    .prepare(`SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all() as MasterRow[];
}

function isPaperObject(row: MasterRow): boolean {
  if (row.type === 'table' || row.type === 'view') return row.name.startsWith('paper_');
  return row.tbl_name.startsWith('paper_');
}

function isBtObject(row: MasterRow): boolean {
  if (row.type === 'table' || row.type === 'view') return row.name.startsWith('bt_');
  return row.tbl_name.startsWith('bt_');
}

/** 文本里是否出现某个前缀（按 SQL 标识符边界匹配，避免 `xbt_` 这类误判） */
function mentionsPrefix(sql: string, prefix: string): boolean {
  return new RegExp(`\\b${prefix}`).test(sql);
}

/**
 * 建表后立刻执行的跨前缀隔离校验（§13.4 的 1）与 2），不通过即抛错。
 *
 * 判据是 `sqlite_master.sql` 定向文本扫描 + `PRAGMA foreign_key_list` 双路；
 * **定向**（只查本前缀对象里是否出现对面前缀）而不是全库 `LIKE '%bt_%'`，
 * 否则会把校验 SQL 自身 / 索引名误报。
 */
export function assertPaperSchemaIsolation(db: Database.Database): void {
  const rows = masterRows(db);

  // ── 1) 外键：双向零引用 ──
  for (const row of rows) {
    if (row.type !== 'table') continue;
    if (!row.name.startsWith('paper_') && !row.name.startsWith('bt_')) continue;
    const expectedOther = row.name.startsWith('paper_') ? 'bt_' : 'paper_';
    const fks = db.prepare(`PRAGMA foreign_key_list(${row.name})`).all() as { table: string }[];
    for (const fk of fks) {
      if (fk.table.startsWith(expectedOther)) {
        throw new PaperSchemaError(
          'PAPER_SCHEMA_CROSS_PREFIX_REF',
          `${row.name} 的外键指向 ${fk.table}（paper_* 与 bt_* 禁止交叉引用）`,
        );
      }
    }
  }

  // ── 2) 触发器 / 视图 / 定义文本：双向零引用 ──
  for (const row of rows) {
    if (row.sql === null) continue;
    if (isPaperObject(row) && mentionsPrefix(row.sql, 'bt_')) {
      throw new PaperSchemaError(
        'PAPER_SCHEMA_CROSS_PREFIX_REF',
        `${row.type} ${row.name} 的定义里出现 bt_ 引用：${row.sql}`,
      );
    }
    if (isBtObject(row) && mentionsPrefix(row.sql, 'paper_')) {
      throw new PaperSchemaError(
        'PAPER_SCHEMA_CROSS_PREFIX_REF',
        `${row.type} ${row.name} 的定义里出现 paper_ 引用：${row.sql}`,
      );
    }
    if (row.type === 'view' && mentionsPrefix(row.sql, 'paper_') && mentionsPrefix(row.sql, 'bt_')) {
      throw new PaperSchemaError(
        'PAPER_SCHEMA_CROSS_PREFIX_REF',
        `视图 ${row.name} 同时引用 paper_* 与 bt_*`,
      );
    }
  }

  // ── 3) 命名断言：表白名单 / 索引 idx_paper_ / 触发器 trg_paper_ ──
  const tables = rows
    .filter((r) => r.type === 'table' && r.name.startsWith('paper_'))
    .map((r) => r.name)
    .sort();
  const expectedTables = [...PAPER_TABLES].sort();
  if (tables.join(',') !== expectedTables.join(',')) {
    throw new PaperSchemaError(
      'PAPER_SCHEMA_TABLE_SET_MISMATCH',
      `paper_* 表清单与约定不一致：实际 [${tables.join(', ')}]，期望 [${expectedTables.join(', ')}]`,
    );
  }

  const badIndex = rows.find(
    (r) =>
      r.type === 'index' && r.tbl_name.startsWith('paper_') && r.sql !== null && !/^idx_paper_/.test(r.name),
  );
  if (badIndex) {
    throw new PaperSchemaError('PAPER_SCHEMA_BAD_PREFIX', `索引 ${badIndex.name} 未使用 idx_paper_ 前缀`);
  }

  const badTrigger = rows.find(
    (r) => r.type === 'trigger' && isPaperObject(r) && !/^trg_paper_/.test(r.name),
  );
  if (badTrigger) {
    throw new PaperSchemaError('PAPER_SCHEMA_BAD_PREFIX', `触发器 ${badTrigger.name} 未使用 trg_paper_ 前缀`);
  }
}

/**
 * 建纸面表 + 索引 + 触发器，并在**同一函数内立刻**做隔离校验。
 *
 * 幂等：连续执行两次不产生差异（`IF NOT EXISTS` + 无数据写入）。
 */
export function createPaperSchema(db: Database.Database): void {
  db.exec(PAPER_SCHEMA_SQL);
  assertPaperSchemaIsolation(db);
  ensurePaperOrderExitReasonColumn(db);
  ensurePaperOrderStatusIndex(db);
}

/** 幂等：给 paper_order 加 exit_reason 列 */
function ensurePaperOrderExitReasonColumn(db: Database.Database): void {
  const tableInfo = db.prepare('PRAGMA table_info(paper_order)').all() as Array<{ name: string }>;
  const hasExitReason = tableInfo.some((col) => col.name === 'exit_reason');
  if (!hasExitReason) {
    db.exec(
      'ALTER TABLE paper_order ADD COLUMN exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN (' +
        "'take-profit', 'stop-loss', 'momentum-decay', 'defensive-fallback'," +
        "'holding-retained', 'candidate-top', 'weak-period-exit'," +
        "'drop-from-pool', 'out-of-candidate', 'rebalance', 'rebalance-replace'," +
        "'exit-of-backtest'" +
        '))',
    );
  }
}

/** 幂等：补 idx_paper_order_status 索引 */
function ensurePaperOrderStatusIndex(db: Database.Database): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_paper_order_status ON paper_order (account_id, status)');
}
