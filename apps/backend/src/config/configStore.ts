import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

/**
 * ConfigStore 单例
 * - 管理 better-sqlite3 连接
 * - 启动时初始化 PRAGMA + 所有 DDL（CREATE TABLE IF NOT EXISTS）
 * - DDL 全部幂等，支持重复启动不报错
 */

/**
 * `user_trade_record` 的**最终 schema**（列 + 约束）—— 单一真相源
 *
 * 🔴 **表级 UNIQUE 约束已被移除**（T87b）—— 改用**部分唯一索引**
 *    （T128 起为三条：手工 A + 源锚 B + 身份 C，见下方注释）。
 *    表级 UNIQUE **无法部分化**（不能带 WHERE 条件）⇒ 会把**软删记录也纳入约束**
 *    ⇒ 软删记录永久占用唯一键。修复后软删记录不再占用唯一键。
 *
 * 这段常量被两处复用，保证「新建库」与「旧库重建」产出的 schema **逐字一致**：
 *   ① DDL_SQL 的 `CREATE TABLE IF NOT EXISTS user_trade_record (...)`
 *   ② `_ensureTradeRecordUniqueConstraint()` 的幂等表重建
 */
const TRADE_RECORD_COLUMNS_SQL = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    trade_type TEXT NOT NULL CHECK (
        trade_type IN ('buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer')
    ),
    trade_date TEXT NOT NULL,
    -- T128（V3.2，INV-S3-11）：成交时间可空 —— 导入补录（B 类文件）无时间时留空，不得填假时间。
    -- 手工录入仍必填（服务层校验，INV-S3-12 的「非空记录」才受同刻唯一约束）。
    trade_time TEXT,
    quantity REAL NOT NULL CHECK (quantity >= 0),
    price REAL NOT NULL CHECK (price >= 0),
    fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
    trade_reason TEXT,
    fee_estimated INTEGER NOT NULL DEFAULT 0 CHECK (fee_estimated IN (0, 1)),
    is_auto_import INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_import IN (0, 1)),
    -- T128（V3.2，SDD_v3 §11.2 定稿）：券商维度三列（全部可空 = 手工录入）。
    -- broker_code 券商标识（与 broker_import_batch.broker_code 同一套编码）；
    -- broker_seq = 事实层 content_seq（同批次内同内容出现序号），导入身份键的一部分；
    -- source_broker_record_id = 事实层锚点（INV-S2-34 可回溯）。
    -- asset_class 不加列：靠 asset_code 关联 asset_class 表（D-34，分类规则/人工修正可热改）。
    broker_code TEXT,
    broker_seq INTEGER,
    source_broker_record_id INTEGER REFERENCES broker_trade_record(id),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    -- T131（V3.3）：复盘字段对齐 —— 买入/卖出逻辑分离（INV-S6-2）+ 情绪状态（INV-S6-3，5 档固定枚举）
    buy_reason TEXT,
    sell_reason TEXT,
    emotion_status TEXT CHECK (emotion_status IS NULL OR emotion_status IN ('极度兴奋','兴奋','平静','焦虑','恐慌')),
    review_summary TEXT,
    system_followed INTEGER CHECK (system_followed IS NULL OR system_followed IN (0, 1)),
    strategy_match INTEGER CHECK (strategy_match IS NULL OR strategy_match IN (0, 1)),
    is_stop_loss INTEGER CHECK (is_stop_loss IS NULL OR is_stop_loss IN (0, 1)),
    remark TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
`;

/**
 * 唯一键：**部分唯一索引**（只约束「未软删」的活记录）
 *
 * 🔴 为什么必须是「部分索引」而不是表级 UNIQUE：
 *   SQLite 的**表级 UNIQUE 无法部分化**（不支持 `WHERE` 条件）⇒
 *   表级 UNIQUE 把软删记录一并纳入约束 ⇒ 软删后同一键**再也录不进去**，
 *   而 `GET /api/trade` 过滤了 `is_deleted=0` ⇒ 用户**看不到**那条记录却提交必 409
 *   —— 典型的「幽灵占用」。部分索引 `WHERE is_deleted = 0` 只约束活记录：
 *     - 未软删时同键**仍被拒**（唯一性没丢）
 *     - 软删后同键**可再次录入**（幽灵占用消失）
 *
 * ⚠️ 索引名固定为 `idx_user_trade_record_unique_live`：
 *   幂等判定（`_inspectTradeRecordUniqueState`）、预检 SQL 的 `EXPLAIN QUERY PLAN`
 *   断言都依赖它 —— 改名 = 契约漂移。
 *
 * T128（V3.2）唯一性**两套并存**（SDD_v3 §11.2 定稿 / INV-S3-12~14）：
 *   A【手工】同键唯一，但**收窄到 `broker_code IS NULL`**——券商导入的同秒多笔不受它约束；
 *   B【源锚】`UNIQUE(source_broker_record_id)`——同一事实行最多一条活业务记录，
 *     软删释放（撤销补录后可重新补录，INV-S2-35）；
 *   C【身份】`(user_id, broker_code, asset_code, trade_type, trade_date, broker_seq, trade_time)`
 *     —— 导入侧兜底防重；trade_time 为 NULL 时 C 拦不住（SQLite 唯一索引 NULL 互异），
 *     由 B 兜住 —— 这是 B 与 C **同时存在**的原因（三索引而非 SDD 留白期的两索引）。
 */
const TRADE_RECORD_UNIQUE_INDEX_NAME = 'idx_user_trade_record_unique_live';
const TRADE_RECORD_UNIQUE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ${TRADE_RECORD_UNIQUE_INDEX_NAME}
    ON user_trade_record(user_id, asset_code, trade_type, trade_date, trade_time)
    WHERE is_deleted = 0 AND broker_code IS NULL`;

/** B（导入源锚）：事实层一行 ↔ 业务层一条活记录（软删释放） */
const TRADE_RECORD_BROKER_SOURCE_INDEX_NAME = 'idx_user_trade_record_broker_source';
const TRADE_RECORD_BROKER_SOURCE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ${TRADE_RECORD_BROKER_SOURCE_INDEX_NAME}
    ON user_trade_record(user_id, source_broker_record_id)
    WHERE is_deleted = 0 AND source_broker_record_id IS NOT NULL`;

/** C（导入身份键，含 broker_seq）：同秒同类型多笔可表达（不同事实行 seq 互异），同内容重复补录被拦 */
const TRADE_RECORD_BROKER_IDENTITY_INDEX_NAME = 'idx_user_trade_record_broker_identity';
const TRADE_RECORD_BROKER_IDENTITY_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ${TRADE_RECORD_BROKER_IDENTITY_INDEX_NAME}
    ON user_trade_record(user_id, broker_code, asset_code, trade_type, trade_date, broker_seq, trade_time)
    WHERE is_deleted = 0 AND broker_code IS NOT NULL`;

/** 三条部分唯一索引（T128 最终形态）明细：名 → 完整 DDL + 索引列（语义复核用） */
const TRADE_RECORD_PARTIAL_UNIQUE_INDEXES: Array<{
  name: string;
  sql: string;
  columns: string[];
  predicate: 'manual' | 'broker-source' | 'broker-identity';
}> = [
  {
    name: TRADE_RECORD_UNIQUE_INDEX_NAME,
    sql: TRADE_RECORD_UNIQUE_INDEX_SQL,
    columns: ['user_id', 'asset_code', 'trade_type', 'trade_date', 'trade_time'],
    predicate: 'manual',
  },
  {
    name: TRADE_RECORD_BROKER_SOURCE_INDEX_NAME,
    sql: TRADE_RECORD_BROKER_SOURCE_INDEX_SQL,
    columns: ['user_id', 'source_broker_record_id'],
    predicate: 'broker-source',
  },
  {
    name: TRADE_RECORD_BROKER_IDENTITY_INDEX_NAME,
    sql: TRADE_RECORD_BROKER_IDENTITY_INDEX_SQL,
    columns: ['user_id', 'broker_code', 'asset_code', 'trade_type', 'trade_date', 'broker_seq', 'trade_time'],
    predicate: 'broker-identity',
  },
];

// DDL 脚本（全部 CREATE TABLE IF NOT EXISTS）
const DDL_SQL = `
-- 用户账户（MVP 单用户但保留多用户结构）
CREATE TABLE IF NOT EXISTS user_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE CHECK(length(username) >= 3 AND length(username) <= 32),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 交易记录
-- ⚠️ 表级 UNIQUE 已移除（T87b），唯一性由**三条部分唯一索引**承担（T128，SDD_v3 §11.2 定稿）：
--    A idx_user_trade_record_unique_live  手工唯一（WHERE broker_code IS NULL AND is_deleted = 0）
--    B idx_user_trade_record_broker_source 源锚（同一事实行最多一条活记录）
--    C idx_user_trade_record_broker_identity 导入身份键（同秒多笔可表达）
--    ⚠️ 三条索引**都不在本段 DDL 里建**：存量库可能缺 trade_time / 券商三维列，
--    建索引会直接报 "no such column" 而**卡死启动**。
--    ⇒ 索引统一由 _ensureTradeRecordUniqueConstraint() 负责
--      （新库 ⇒ 直接补建；旧库 ⇒ 表重建时一并建好）。
--    改已有表的约束必须走幂等表重建，见 _ensureTradeRecordUniqueConstraint()。
CREATE TABLE IF NOT EXISTS user_trade_record (${TRADE_RECORD_COLUMNS_SQL});
CREATE INDEX IF NOT EXISTS idx_trade_user_date ON user_trade_record(user_id, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_trade_asset ON user_trade_record(user_id, asset_code);

-- 用户-标的关联（watch/hold/candidate 三列独立唯一约束，AGENTS.md 硬约束）
CREATE TABLE IF NOT EXISTS user_asset_rel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    rel_type TEXT NOT NULL CHECK (rel_type IN ('watch', 'hold', 'candidate')),
    watch_date TEXT,
    candidate_reason TEXT,
    candidate_base_price REAL,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    migrated_from_candidate INTEGER DEFAULT 0,
    migrated_price_mode TEXT CHECK (migrated_price_mode IS NULL OR migrated_price_mode IN ('base', 'current')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, asset_code, rel_type),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);

-- 策略信号
CREATE TABLE IF NOT EXISTS user_strategy_signal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    plugin_category TEXT NOT NULL CHECK (plugin_category IN ('monitor', 'filter')),
    trade_date TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell', 'hold')),
    label TEXT NOT NULL,
    strength REAL,
    metrics_json TEXT,
    is_final INTEGER DEFAULT 1,
    -- T134（V3.4）信号生命周期
    grade TEXT CHECK (grade IS NULL OR grade IN ('strong','medium','weak')),
    expires_at TEXT,
    snapshot_json TEXT,
    adopted INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
    ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1)),
    adopted_at TEXT,
    cooldown_until TEXT,
    linked_trade_id INTEGER REFERENCES user_trade_record(id),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, asset_code, plugin_id, trade_date),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_signal_user_date ON user_strategy_signal(user_id, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_signal_user_plugin ON user_strategy_signal(user_id, plugin_id, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_signal_user_asset_date ON user_strategy_signal(user_id, asset_code, trade_date DESC);

-- T140（V3.7）费用模型配置（INV-S4-3~5）
CREATE TABLE IF NOT EXISTS user_fee_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    broker_code TEXT,
    asset_class TEXT CHECK (asset_class IS NULL OR asset_class IN ('risk','cash')),
    commission_rate REAL NOT NULL DEFAULT 0.0003,
    min_commission REAL NOT NULL DEFAULT 5,
    stamp_tax_rate REAL NOT NULL DEFAULT 0.001,
    transfer_fee_rate REAL NOT NULL DEFAULT 0.00002,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_fee_config_user ON user_fee_config(user_id, broker_code);

-- 插件配置
CREATE TABLE IF NOT EXISTS user_plugin_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plugin_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    params_json TEXT NOT NULL,
    UNIQUE(user_id, plugin_id),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);

-- 资产快照
CREATE TABLE IF NOT EXISTS user_asset_stat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    total_assets_price_yield REAL NOT NULL,
    total_assets_actual_yield REAL NOT NULL,
    total_profit_price REAL NOT NULL,
    total_profit_actual REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, trade_date),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);

-- 资产分类（T120，V3 SDD_v3 §2.2）：风险 vs 现金。
-- 不复用行情层 raw_symbol_class（那是行情层事实，业务侧不可改写，且分不出货币 ETF）。
-- rule_hit 记录初判规则标识；人工修正（source='manual'）后保留原值，可回溯。
CREATE TABLE IF NOT EXISTS asset_class (
    symbol        TEXT PRIMARY KEY,
    asset_class   TEXT NOT NULL CHECK (asset_class IN ('risk', 'cash')),
    rule_hit      TEXT,
    source        TEXT NOT NULL CHECK (source IN ('rule', 'manual')),
    updated_by    INTEGER REFERENCES user_account(id),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_asset_class_kind ON asset_class(asset_class);

-- 标的字典快照（T136，V3 SDD_v3 §11.1.4）：联想走业务层快照，不扫行情层。
-- 定位：只做名称联想搜索 + code6 歧义消解；存在性判定走行情层 raw_symbol_class。
-- 由 symbolDict.syncSymbolDict() 从行情层 raw_symbol_name 只读同步；pinyin 为预计算首字母。
CREATE TABLE IF NOT EXISTS symbol_dict (
    symbol        TEXT PRIMARY KEY,
    code6         TEXT NOT NULL,
    name          TEXT,
    pinyin        TEXT,
    market        TEXT,
    asset_class   TEXT NOT NULL CHECK (asset_class IN ('risk', 'cash')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_symbol_dict_code6 ON symbol_dict(code6);
CREATE INDEX IF NOT EXISTS idx_symbol_dict_pinyin ON symbol_dict(pinyin);

-- V3（T122，SDD_v3 §11.1.1）事实层：券商原始记录。
-- 幂等键 = row_hash（归一化内容 SHA-256）+ content_seq（同哈希在批次内出现序号，
--   「同内容多笔」不被误判为重复，「同文件重复上传」被识别为重复，INV-S2-39）。
-- raw_row_json 必存（INV-S2-6）：解析缺陷可重放，无需用户重新上传；敏感字段不入库（§3.6）。
CREATE TABLE IF NOT EXISTS broker_trade_record (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    import_batch_id     INTEGER NOT NULL,
    broker_code         TEXT NOT NULL,
    source_kind         TEXT NOT NULL CHECK (source_kind IN ('broker', 'manual_sheet')),
    event_type          TEXT NOT NULL,
    asset_code          TEXT,
    trade_date          TEXT,
    trade_time          TEXT,
    price               REAL,
    quantity            REAL,
    amount              REAL,
    cash_flow           REAL,
    fee_total           REAL,
    fee_breakdown_json  TEXT,
    balance_after       REAL,
    cash_balance_after  REAL,
    market              TEXT,
    raw_symbol          TEXT,
    raw_name            TEXT,
    raw_event_type      TEXT,
    raw_row_json        TEXT NOT NULL,
    source_file         TEXT,
    source_row_no       INTEGER,
    match_status        TEXT NOT NULL CHECK (match_status IN
                            ('MATCHED','FUZZY','MISSING','EXCLUDED','CONFLICT')),
    matched_trade_record_id INTEGER,
    exclude_reason      TEXT,
    match_confidence    TEXT,
    row_hash            TEXT NOT NULL,
    content_seq         INTEGER NOT NULL DEFAULT 0,
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_btr_hash    ON broker_trade_record(user_id, row_hash);
CREATE INDEX IF NOT EXISTS idx_btr_batch   ON broker_trade_record(user_id, import_batch_id);
CREATE INDEX IF NOT EXISTS idx_btr_match   ON broker_trade_record(user_id, broker_code, match_status);
CREATE INDEX IF NOT EXISTS idx_btr_key     ON broker_trade_record(user_id, broker_code, asset_code, trade_date);

-- V3（T122，SDD_v3 §11.1.2）导入批次
CREATE TABLE IF NOT EXISTS broker_import_batch (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    broker_code      TEXT NOT NULL,
    file_kind        TEXT NOT NULL CHECK (file_kind IN ('settlement','trade')),
    encoding         TEXT,
    file_name        TEXT,
    file_hash        TEXT NOT NULL,
    file_size        INTEGER,
    template_id      INTEGER,
    parser_version   TEXT NOT NULL,
    row_total        INTEGER NOT NULL DEFAULT 0,
    row_inserted     INTEGER NOT NULL DEFAULT 0,
    row_deduped      INTEGER NOT NULL DEFAULT 0,
    row_excluded     INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL CHECK (status IN ('pending','parsed','imported','revoked')),
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_batch_hash ON broker_import_batch(user_id, file_hash);

-- V3（T122，SDD_v3 §11.1.3）列映射模板（按 券商 × 文件类型 维度，UNIQUE 幂等）
CREATE TABLE IF NOT EXISTS broker_import_template (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    broker_code   TEXT NOT NULL,
    file_kind     TEXT NOT NULL CHECK (file_kind IN ('settlement','trade')),
    mapping_json  TEXT NOT NULL,
    is_deleted    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, broker_code, file_kind)
);

-- 系统日志（所有 cron 任务结果写入此表）
CREATE TABLE IF NOT EXISTS system_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    log_type TEXT NOT NULL CHECK (
        log_type IN ('tdx2db_update', 'datacheck', 'plugin_execute', 'signal_generate',
                     'dividend_import', 'backup', 'trigger_manual', 'startup', 'trade',
                     'candidate_migrate')
    ),
    level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS')),
    check_item TEXT,
    message TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_system_log_date ON system_log(log_date, log_type, level);
`;

/** system_log 单条写入的事务参数 */
type LogInsertArgs = (
  logDate: string,
  logType: string,
  level: string,
  message: string,
  detail: string | undefined,
  checkItem: string | undefined,
) => void;

/** system_log 批量写入的一行 */
interface LogBatchEntry {
  logType: string;
  level: string;
  message: string;
  detail?: string;
  checkItem?: string;
  logDate?: string;
}

export class ConfigStore {
  private static _instance: ConfigStore | null = null;
  private _db: Database.Database;
  private _dbPath: string;
  /** system_log INSERT 的 prepared statement（懒加载一次，见 _logStmt） */
  private _logStatement: Database.Statement | null = null;
  /** 单条日志的独立事务包装器（创建一次，反复调用） */
  private _logInsertTransaction: Database.Transaction<LogInsertArgs> | null = null;
  /** 批量日志的单事务包装器（创建一次，反复调用） */
  private _logBatchTransaction: Database.Transaction<(entries: LogBatchEntry[]) => void> | null = null;

  private constructor() {
    // 数据库路径：环境变量 > 默认位置
    // Windows 开发: ./data/business.db
    // Linux 部署: /opt/invol/IA_Prod/data/business.db（由 /opt/invol/IA_Prod/.env.local 指定）
    this._dbPath = process.env.SQLITE_DB_PATH ?? path.resolve('data', 'business.db');

    // 确保目录存在
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 创建连接
    this._db = new Database(this._dbPath);

    // 硬约束 PRAGMA（AGENTS.md 要求）
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
    this._db.pragma('foreign_keys = ON');

    // 初始化所有表（幂等，重复运行安全）
    this._db.exec(DDL_SQL);

    // SQLite CREATE TABLE IF NOT EXISTS 对已存在表无效——启动时检测并补齐缺失的列与唯一键
    // 顺序要求：先补列（ALTER ADD COLUMN，不重建表），让随后的表重建能携带新列；
    //           表重建**全表只有这一处**（AGENTS.md「DDL 变更判据」：多次 DROP/RENAME = 数据丢失风险）
    this._ensureTradeRecordReviewColumns();

    // T134（V3.4）：信号生命周期列补齐
    this._ensureSignalLifecycleColumns();

    // T87b：唯一键从「表级 UNIQUE 约束」迁移到「部分唯一索引（WHERE is_deleted = 0）」
    this._ensureTradeRecordUniqueConstraint();

    // system_log 的 CHECK 白名单也需要迁移（smoke-m1 先 init 会建旧 schema，smoke-m2 复用导致 plugin_execute 被拒绝）
    this._ensureSystemLogCheckConstraint();
  }

  /**
   * 补齐 user_trade_record 的复盘字段列（T38/T39 G6a）
   *
   * Requirements §5.2 定义复盘 4 字段：review_summary / strategy_match / is_stop_loss / remark。
   * 早期 schema 只建了 review_summary / is_stop_loss / remark，
   * PATCH /api/trades/:id 写 strategy_match 会直接报 no such column。
   *
   * SQLite ALTER TABLE ADD COLUMN 不支持 CHECK 之外的复杂约束但支持带 CHECK 的可空列，
   * 且不重写表数据 —— 存量库零成本补齐，无需走重建流程。
   */
  private _ensureTradeRecordReviewColumns(): void {
    const EXPECTED: Record<string, string> = {
      review_summary: 'TEXT',
      strategy_match: 'INTEGER CHECK (strategy_match IS NULL OR strategy_match IN (0, 1))',
      is_stop_loss: 'INTEGER CHECK (is_stop_loss IS NULL OR is_stop_loss IN (0, 1))',
      remark: 'TEXT',
      fee_estimated: 'INTEGER NOT NULL DEFAULT 0 CHECK (fee_estimated IN (0, 1))',
      // T131（V3.3）：复盘字段对齐 —— 买入/卖出逻辑分离 + 情绪状态（5 档固定枚举）
      buy_reason: 'TEXT',
      sell_reason: 'TEXT',
      emotion_status:
        "TEXT CHECK (emotion_status IS NULL OR emotion_status IN ('极度兴奋','兴奋','平静','焦虑','恐慌'))",
    };

    try {
      const table = this._db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
        .get();
      if (!table) return; // 表还没建（DDL_SQL 已 CREATE IF NOT EXISTS，理论上必有），保守返回

      const cols = (this._db.prepare('PRAGMA table_info(user_trade_record)').all() as { name: string }[]).map(
        (c) => c.name,
      );

      const missing = Object.keys(EXPECTED).filter((c) => !cols.includes(c));
      if (missing.length === 0) return; // 已是最新 schema

      for (const col of missing) {
        this._db.exec(`ALTER TABLE user_trade_record ADD COLUMN ${col} ${EXPECTED[col]}`);
        console.log(`[ConfigStore] user_trade_record 补齐列 ${col}`);
      }
    } catch (err) {
      console.error('[ConfigStore] 复盘字段列补齐失败（不阻塞启动）:', err);
    }
  }

  /**
   * T134（V3.4）：补齐 user_strategy_signal 的生命周期列
   * SQLite ALTER TABLE ADD COLUMN 支持带 CHECK 的可空列。
   */
  private _ensureSignalLifecycleColumns(): void {
    const EXPECTED: Record<string, string> = {
      grade: "TEXT CHECK (grade IS NULL OR grade IN ('strong','medium','weak'))",
      expires_at: 'TEXT',
      snapshot_json: 'TEXT',
      adopted: 'INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1))',
      ignored: 'INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0, 1))',
      adopted_at: 'TEXT',
      cooldown_until: 'TEXT',
      linked_trade_id: 'INTEGER REFERENCES user_trade_record(id)',
    };
    try {
      const table = this._db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_strategy_signal'")
        .get();
      if (!table) return;
      const cols = (
        this._db.prepare('PRAGMA table_info(user_strategy_signal)').all() as { name: string }[]
      ).map((c) => c.name);
      const missing = Object.keys(EXPECTED).filter((c) => !cols.includes(c));
      if (missing.length === 0) return;
      for (const col of missing) {
        this._db.exec(`ALTER TABLE user_strategy_signal ADD COLUMN ${col} ${EXPECTED[col]}`);
        console.log(`[ConfigStore] user_strategy_signal 补齐列 ${col}`);
      }
    } catch (err) {
      console.error('[ConfigStore] 信号生命周期列补齐失败（不阻塞启动）:', err);
    }
  }

  /**
   * 补齐 system_log 的 CHECK(log_type IN (...)) 白名单
   * 新增 plugin_execute / trade 后，旧建的表 CHECK 约束还没包含它们
   * 检测方式：CREATE TABLE system_log_new (完整 DDL) → ALTER RENAME → INSERT SELECT → DROP
   */
  private _ensureSystemLogCheckConstraint(): void {
    const EXPECTED_TYPES = [
      'tdx2db_update',
      'datacheck',
      'plugin_execute',
      'signal_generate',
      'dividend_import',
      'backup',
      'trigger_manual',
      'startup',
      'trade',
      'candidate_migrate',
    ];
    const EXPECTED_LEVELS = ['INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS'];

    try {
      const current = this._db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='system_log'")
        .get() as { sql: string } | undefined;
      if (!current) return;

      // 检测 CHECK 白名单是否已包含所有期望值
      const missingType = EXPECTED_TYPES.find((t) => !current.sql.includes(`'${t}'`));
      const missingLevel = EXPECTED_LEVELS.find((l) => !current.sql.includes(`'${l}'`));
      if (!missingType && !missingLevel) return; // 已是最新 schema

      console.warn(
        `[ConfigStore] system_log CHECK 约束过旧（缺 type=${missingType ?? '无'} level=${missingLevel ?? '无'}），迁移中...`,
      );

      // 检测是否有数据（没数据直接 DROP 重建更快）
      const count = (this._db.prepare('SELECT COUNT(*) AS c FROM system_log').get() as { c: number }).c;

      const newDDL = `
        CREATE TABLE _system_log_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_date TEXT NOT NULL,
            log_type TEXT NOT NULL CHECK (
                log_type IN ('${EXPECTED_TYPES.join("','")}')
            ),
            level TEXT NOT NULL CHECK (level IN ('${EXPECTED_LEVELS.join("','")}')),
            check_item TEXT,
            message TEXT NOT NULL,
            detail TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
      `;

      this._db.pragma('foreign_keys = OFF');
      this._db.exec('BEGIN');
      try {
        this._db.exec(newDDL);
        if (count > 0) {
          // INSERT OR IGNORE：如果旧数据里有不在白名单的 log_type（理论上不应该），跳过
          this._db.exec(`
            INSERT OR IGNORE INTO _system_log_new (id, log_date, log_type, level, check_item, message, detail, created_at)
            SELECT id, log_date, log_type, level, check_item, message, detail, created_at FROM system_log
          `);
        }
        this._db.exec('DROP TABLE system_log');
        this._db.exec('ALTER TABLE _system_log_new RENAME TO system_log');
        this._db.exec('CREATE INDEX idx_system_log_date ON system_log(log_date, log_type, level)');
        this._db.exec('COMMIT');
        console.log('[ConfigStore] system_log CHECK 约束迁移成功');
      } catch (migErr) {
        this._db.exec('ROLLBACK');
        throw migErr;
      } finally {
        this._db.pragma('foreign_keys = ON');
      }
    } catch (err) {
      console.error('[ConfigStore] system_log CHECK 约束迁移失败（不阻塞启动）:', err);
    }
  }

  /**
   * T87b：把 `user_trade_record` 的唯一键从**表级 UNIQUE 约束**迁移到**部分唯一索引**
   *
   * ── 为什么要迁（P0 数据缺陷）──
   *   旧表级约束 `UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time)`
   *   **不含 is_deleted** ⇒ **软删记录永久占用唯一键**。用户可见症状：
   *     ① 软删一笔交易后，同一标的/类型/日期/时刻**再也录不进去**（提交必 409 TRADE_DUPLICATE）；
   *     ② 但 `GET /api/trade` 过滤了 `is_deleted = 0` ⇒ **用户看不到那条记录**；
   *     ⇒ 「列表里没有这一笔，但系统说重复」—— 典型的**幽灵占用**。
   *
   *   修法：SQLite 的**表级 UNIQUE 无法部分化**（不支持 WHERE 条件）
   *   ⇒ 必须去掉表级约束 + 改用部分唯一索引 `WHERE is_deleted = 0`。
   *
   * ── 幂等策略（四态判定，见 `_inspectTradeRecordUniqueState`）──
   *   ① `ready`          —— 无表级 UNIQUE + 三条部分唯一索引形态全对 ⇒ **一个字节都不动**（重复启动零动作）
   *   ② `missing-index`  —— 表已是最终形态、只差索引 ⇒ **只补建索引**（不重建表、不碰数据）
   *   ③ `stale-index`    —— 表已是最终形态、但索引是 T87b 旧形态（谓词缺 broker_code / 缺 B 或 C）
   *                         ⇒ 只重建索引（DROP 旧形态 + CREATE 新形态），不碰数据
   *   ④ `legacy`         —— 仍有表级 UNIQUE / 缺 T128 新列 / trade_time 仍 NOT NULL ⇒ **幂等表重建**
   *                         （建新表 → 灌数据 → 删旧表 → 改名 → 建索引，全程包在 `db.transaction()` 里）
   *                         🔴 与 T87b/T49 的重建历史**合并为一次**（AGENTS.md「DDL 变更判据」：
   *                            多次 DROP/RENAME 会留下重建碎片 → 数据风险）
   *
   * ⚠️ **本表只此一处做表重建**（AGENTS.md「DDL 变更判据」）。
   *   `_ensureTradeRecordReviewColumns()` 只做 `ALTER TABLE ADD COLUMN`（不重建），
   *   且在**本函数之前**执行 ⇒ 重建时新表已含复盘 4 列，两处不打架。
   *
   * ⚠️ 迁移失败**不阻塞启动**：DB 保持旧 schema，数据**零丢失**
   *   （`db.transaction()` 事务体抛错会自动 ROLLBACK）。
   */
  private _ensureTradeRecordUniqueConstraint(): void {
    try {
      const state = this._inspectTradeRecordUniqueState();
      if (state === 'ready') return; // 幂等：已是新 schema，什么都不做

      if (state === 'missing-index' || state === 'stale-index') {
        // 表已是最终形态（新库刚建好 / 上次迁移只差索引 / 索引是旧形态）→ 只调索引，不重建表
        this._ensureTradeRecordPartialUniqueIndexes();
        console.log(`[ConfigStore] user_trade_record 部分唯一索引已同步（${state}）`);
        return;
      }

      // legacy：仍有表级 UNIQUE / 缺列 / trade_time NOT NULL → 幂等表重建
      console.warn('[ConfigStore] user_trade_record schema 需刷新（T87b/T128 合并重建）...');
      this._rebuildTradeRecordTable();
      console.log('[ConfigStore] user_trade_record 迁移成功（券商维度 + 三条部分唯一索引）');
    } catch (err) {
      console.error('[ConfigStore] user_trade_record 唯一键迁移失败（不阻塞启动）:', err);
    }
  }

  /**
   * 索引级同步（表已为最终形态，不碰数据）：
   * DROP 三条旧索引（若名下存在，可能是 T87b 旧形态）→ CREATE 三条新形态。
   * 幂等：DROP IF EXISTS + CREATE IF NOT EXISTS。
   */
  private _ensureTradeRecordPartialUniqueIndexes(): void {
    for (const idx of TRADE_RECORD_PARTIAL_UNIQUE_INDEXES) {
      this._db.exec(`DROP INDEX IF EXISTS ${idx.name}`);
    }
    for (const idx of TRADE_RECORD_PARTIAL_UNIQUE_INDEXES) {
      this._db.exec(idx.sql);
    }
  }

  /**
   * 判定 `user_trade_record` 处于哪种 schema 状态（四态）
   *
   * ⚠️ **判定依据必须落在「结构」上，不能靠「索引名猜测」**：
   *   - 表级 UNIQUE 在 `sqlite_master` 里**没有**独立的索引行
   *     （它生成的是 `sqlite_autoindex_*`，其 `sql` 字段为 **NULL**）
   *     ⇒ 只能从**表定义文本**里判断「还有没有表级 UNIQUE」。
   *   - 部分唯一索引是我们自己 `CREATE` 出来的 ⇒ `sqlite_master.sql` 有文本，
   *     再用 `PRAGMA index_list` 的 `unique/partial` 标志做结构复核。
   */
  private _inspectTradeRecordUniqueState(): 'ready' | 'missing-index' | 'stale-index' | 'legacy' {
    const tbl = this._db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_trade_record'")
      .get() as { sql: string | null } | undefined;
    if (!tbl?.sql) return 'missing-index'; // 表不存在（理论上 DDL_SQL 已建）→ 保守按「只补索引」

    // ⚠️ 列不齐（存量库还没有 T128 三列 / trade_time 仍 NOT NULL / 仍有表级 UNIQUE）
    //   ⇒ 必须**重建**：部分唯一索引引用 broker_code 等，缺列时建索引会直接报错。
    if (this._tradeRecordNeedsRebuild(tbl.sql)) return 'legacy';

    return this._tradeRecordIndexesReady() ? 'ready' : 'missing-index';
  }

  /**
   * 表是否需要**重建**（而非只调索引）：
   * ① 缺 T128 新列（broker_code / broker_seq / source_broker_record_id）；
   * ② trade_time 仍 NOT NULL（T87 时代的表级约束，改约束必须重建）；
   * ③ 仍有表级 UNIQUE。
   */
  private _tradeRecordNeedsRebuild(tableSql: string): boolean {
    const cols = this._db.prepare("PRAGMA table_info('user_trade_record')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));
    for (const required of ['broker_code', 'broker_seq', 'source_broker_record_id']) {
      if (!colMap.has(required)) return true;
    }
    const tradeTime = colMap.get('trade_time');
    if (!tradeTime || tradeTime.notnull === 1) return true;
    if (/UNIQUE\s*\(/i.test(tableSql)) return true;
    return false;
  }

  /** 表定义文本检查后的最终判定 —— 是否已有构成「ready」的三条部分唯一索引 */
  private _tradeRecordIndexesReady(): boolean {
    for (const idx of TRADE_RECORD_PARTIAL_UNIQUE_INDEXES) {
      if (!this._tradeRecordPartialIndexShapeOK(idx)) return false;
    }
    return true;
  }

  /**
   * 单条部分唯一索引**形态复核**（T87b 同语义，泛化到三条）：
   * ① PRAGMA index_list 上 unique=1 + partial=1；
   * ② sqlite_master.sql 里谓词含 `is_deleted = 0`（T87b 锚）；
   * ③ 索引列集合 = 期望列（数量 + 名称，顺序无关）；
   * ④ 谓词附加条件：manual 须含 `broker_code IS NULL`、
   *    broker-source 须含 `source_broker_record_id IS NOT NULL`、
   *    broker-identity 须含 `broker_code IS NOT NULL`（T128 新形态锚点，缺 = 旧形态 → 走重建索引）。
   */
  private _tradeRecordPartialIndexShapeOK(idx: {
    name: string;
    columns: string[];
    predicate: 'manual' | 'broker-source' | 'broker-identity';
  }): boolean {
    const list = this._db.prepare('PRAGMA index_list(user_trade_record)').all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const meta = list.find((i) => i.name === idx.name);
    if (!meta || meta.unique !== 1 || meta.partial !== 1) return false;

    const row = this._db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get(idx.name) as { sql: string | null } | undefined;
    if (!row?.sql) return false;
    if (!/WHERE\s+is_deleted\s*=\s*0/i.test(row.sql)) return false;

    // 谓词形态（缺锚点 = T87b 旧形态）
    const want =
      idx.predicate === 'manual'
        ? /broker_code\s+IS\s+NULL/i
        : idx.predicate === 'broker-source'
          ? /source_broker_record_id\s+IS\s+NOT\s+NULL/i
          : /broker_code\s+IS\s+NOT\s+NULL/i;
    if (!want.test(row.sql)) return false;

    // 索引列集合（表重建后 SQLite 会把表名写成带引号的 `"user_trade_record"` ⇒ 引号可选）
    const m = /ON\s+"?user_trade_record"?\s*\(([^)]*)\)/i.exec(row.sql);
    if (!m) return false;
    const cols = m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    return cols.length === idx.columns.length && idx.columns.every((c) => cols.includes(c));
  }

  /**
   * 幂等表重建：把 `user_trade_record` 换成「表级 UNIQUE → 部分唯一索引」的新 schema
   *
   * 完整形态（**全程包在 `db.transaction()` 里**，事务体抛错自动 ROLLBACK）：
   *   ① DROP INDEX IF EXISTS idx_user_trade_record_unique_live  （释放索引名）
   *   ② CREATE TABLE _user_trade_record_new (<最终 schema>)
   *   ③ CREATE UNIQUE INDEX idx_user_trade_record_unique_live ON _user_trade_record_new(...) WHERE is_deleted = 0
   *   ④ INSERT INTO _user_trade_record_new (<显式列清单>) SELECT <显式表达式> FROM user_trade_record ORDER BY id ASC
   *   ⑤ DROP TABLE user_trade_record
   *   ⑥ ALTER TABLE _user_trade_record_new RENAME TO user_trade_record
   *   ⑦ CREATE INDEX idx_trade_user_date / idx_trade_asset（随旧表一起消失的普通索引要补回来）
   *
   * ⚠️ **为什么先建索引再灌数据**：让唯一性冲突在**事务内立刻炸**并整体回滚，
   *   而不是等索引建成时才失败 —— **绝不静默丢行**（旧实现用 `INSERT OR IGNORE`，
   *   撞键的行会被**静默丢弃** ⇒ 数据丢失）。
   *
   * ⚠️ **为什么不用 `INSERT INTO 新 SELECT * FROM 旧`**：旧表列顺序随历史演进而变
   *   （`ALTER TABLE ADD COLUMN` 把新列追加到**末尾**），`SELECT *` 按位置对齐 ⇒ 串列。
   *   ⇒ 逐列**按列名**显式映射（见 `_buildTradeRecordCopyPlan`）。
   */
  private _rebuildTradeRecordTable(): void {
    const db = this._db;
    const oldCols = new Set(
      (db.prepare('PRAGMA table_info(user_trade_record)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );

    // 必备列缺失 → 无法安全迁移（不猜、不造数据）：直接失败，让上层记日志，DB 保持原样
    for (const required of ['user_id', 'asset_code', 'trade_type', 'trade_date', 'quantity', 'price']) {
      if (!oldCols.has(required)) {
        throw new Error(`user_trade_record 缺少必需列 ${required}，无法安全迁移（未做任何改动）`);
      }
    }

    // 预检：trade_type 必须满足新 CHECK（7 种），否则灌数据会在事务里失败
    const badTypes = (
      db
        .prepare(
          `SELECT DISTINCT trade_type FROM user_trade_record
           WHERE trade_type IS NULL
              OR trade_type NOT IN ('buy','add','reduce','clear','dividend','bonus','transfer')`,
        )
        .all() as Array<{ trade_type: string | null }>
    ).map((r) => String(r.trade_type));
    if (badTypes.length > 0) {
      throw new Error(
        `user_trade_record 存在非法 trade_type（${badTypes.join(', ')}），迁移会违反新 CHECK 约束；` +
          `请先人工订正这些记录（迁移未做任何改动）`,
      );
    }

    const before = (db.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get() as { c: number }).c;
    const { columns, selects } = this._buildTradeRecordCopyPlan(oldCols);

    // 被丢弃的旧列（不在新 schema 里）→ 记日志，避免「静默丢字段」
    const target = new Set(columns);
    const dropped = [...oldCols].filter((c) => !target.has(c));
    if (dropped.length > 0) {
      console.warn(`[ConfigStore] user_trade_record 迁移将丢弃旧列：${dropped.join(', ')}`);
    }

    // ⚠️ 迁移期间关闭 FK 检查：存量库可能有孤儿 user_id，
    //    开着 FK 迁移会把它们判成违规而**回滚整笔迁移**（白跑一趟）；
    //    关闭期间**不删除任何数据**，孤儿行原样搬过去，迁移结束立即恢复 FK。
    //    （T128：新表还带 source_broker_record_id FK，迁移时旧数据全 NULL，同理关闭。）
    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        // ① 释放索引名（旧表上的同名索引随旧表一起消失，先显式 DROP 更稳）
        for (const idx of TRADE_RECORD_PARTIAL_UNIQUE_INDEXES) {
          db.exec(`DROP INDEX IF EXISTS ${idx.name}`);
        }
        // ② 建新表（最终 schema：表级 UNIQUE 已去掉、trade_time 可空、含券商维度三列）
        db.exec(`CREATE TABLE _user_trade_record_new (${TRADE_RECORD_COLUMNS_SQL})`);
        // ③ 先建三条部分唯一索引，再灌数据 ⇒ 唯一性冲突在事务内立刻炸（不静默丢行）
        //    ⚠️ 不能无脑 replace：索引名（idx_user_trade_record_*）也含 user_trade_record 子串，
        //    String.replace 只替换第一处 ⇒ 会把「索引名」换掉而漏掉「ON 表名」。
        //    故显式替换 ` ON user_trade_record`。
        for (const idx of TRADE_RECORD_PARTIAL_UNIQUE_INDEXES) {
          db.exec(idx.sql.replace(' ON user_trade_record', ' ON _user_trade_record_new'));
        }
        // ④ 搬数据（逐列按列名显式映射；trade_time 有则原样保留，无则从 created_at 回填）
        db.exec(
          `INSERT INTO _user_trade_record_new (${columns.join(', ')})
           SELECT ${selects.join(', ')} FROM user_trade_record ORDER BY id ASC`,
        );
        // ⑤ 删旧表 + 改名
        db.exec('DROP TABLE user_trade_record');
        db.exec('ALTER TABLE _user_trade_record_new RENAME TO user_trade_record');
        // ⑥ 补回随旧表一起消失的普通索引
        db.exec('CREATE INDEX idx_trade_user_date ON user_trade_record(user_id, trade_date DESC)');
        db.exec('CREATE INDEX idx_trade_asset ON user_trade_record(user_id, asset_code)');
      });
      tx();
    } finally {
      db.pragma('foreign_keys = ON');
    }

    // ⑦ 事后校验：行数必须一致（不等 = 迁移丢数据 ⇒ 抛错报警）
    const after = (db.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get() as { c: number }).c;
    if (after !== before) {
      throw new Error(`user_trade_record 迁移后行数不一致（迁移前 ${before} → 迁移后 ${after}）`);
    }
    console.log(`[ConfigStore] user_trade_record 迁移完成：${before} 行全部保留`);
  }

  /**
   * 生成「旧表 → 新表」的逐列搬运映射
   *
   * ⚠️ **不能**用 `INSERT INTO 新 SELECT * FROM 旧`：
   *   旧表列顺序随历史演进而变（`ALTER TABLE ADD COLUMN` 把新列追加到**末尾**），
   *   `SELECT *` 按位置对齐 ⇒ 串列（列名对了、值错了，比直接报错更难查）。
   *   ⇒ 逐列**按列名**显式映射；缺列用安全默认值补齐。
   *
   * ⚠️ `trade_time` 的搬运口径：
   *   - 旧表**已有** trade_time ⇒ **原样保留**（用户录的成交时刻不能被迁移改写）
   *   - 旧表**没有** trade_time ⇒ 从 `created_at` 的时分秒回填（T87 存量迁移口径）
   */
  private _buildTradeRecordCopyPlan(oldCols: Set<string>): { columns: string[]; selects: string[] } {
    const columns: string[] = [];
    const selects: string[] = [];
    const add = (col: string, expr: string): void => {
      columns.push(col);
      selects.push(expr);
    };
    const has = (col: string): boolean => oldCols.has(col);

    // 无 trade_time 列时：从 created_at（'YYYY-MM-DD HH:mm:ss'）回填成交时刻
    // ⚠️ 偏移量：年 1-4、月 6-7、日 9-10、空格 11、时 12-13、分 15-16、秒 18-19
    const derivedTime = has('created_at')
      ? `CASE
          WHEN created_at IS NOT NULL
           AND length(created_at) >= 19
           AND substr(created_at, 12, 2) GLOB '[0-9][0-9]'
           AND substr(created_at, 15, 2) GLOB '[0-9][0-9]'
           AND substr(created_at, 18, 2) GLOB '[0-9][0-9]'
           AND CAST(substr(created_at, 12, 2) AS INTEGER) < 24
           AND CAST(substr(created_at, 15, 2) AS INTEGER) < 60
           AND CAST(substr(created_at, 18, 2) AS INTEGER) < 60
          THEN substr(created_at, 12, 2) || ':' || substr(created_at, 15, 2) || ':' || substr(created_at, 18, 2)
          ELSE '00:00:00'
        END`
      : `'00:00:00'`;

    const createdAtExpr = has('created_at')
      ? `COALESCE(created_at, datetime('now','localtime'))`
      : `datetime('now','localtime')`;

    add('id', has('id') ? 'id' : 'NULL'); // 显式搬 id ⇒ AUTOINCREMENT 序号与历史一致
    add('user_id', 'user_id');
    add('asset_code', 'asset_code');
    add('trade_type', 'trade_type');
    add('trade_date', 'trade_date');
    add(
      'trade_time',
      has('trade_time') ? `COALESCE(NULLIF(TRIM(trade_time), ''), ${derivedTime})` : derivedTime,
    );
    add('quantity', has('quantity') ? 'COALESCE(quantity, 0)' : '0');
    add('price', has('price') ? 'COALESCE(price, 0)' : '0');
    add('fee', has('fee') ? 'COALESCE(fee, 0)' : '0');
    add('fee_estimated', has('fee_estimated') ? 'COALESCE(fee_estimated, 0)' : '0');
    add('trade_reason', has('trade_reason') ? 'trade_reason' : 'NULL');
    // T131（V3.3）复盘字段对齐：存量库没有这些列 ⇒ NULL（历史复盘数据须人工补录，不造数据）
    add('buy_reason', has('buy_reason') ? 'buy_reason' : 'NULL');
    add('sell_reason', has('sell_reason') ? 'sell_reason' : 'NULL');
    add('emotion_status', has('emotion_status') ? 'emotion_status' : 'NULL');
    add('is_auto_import', has('is_auto_import') ? 'COALESCE(is_auto_import, 0)' : '0');
    // T128 券商维度三列：存量库没有这些列（全部手工人为）⇒ 统一 NULL（手工形态），不造数据
    add('broker_code', has('broker_code') ? 'broker_code' : 'NULL');
    add('broker_seq', has('broker_seq') ? 'broker_seq' : 'NULL');
    add('source_broker_record_id', has('source_broker_record_id') ? 'source_broker_record_id' : 'NULL');
    add('is_deleted', has('is_deleted') ? 'COALESCE(is_deleted, 0)' : '0');
    add('review_summary', has('review_summary') ? 'review_summary' : 'NULL');
    add('system_followed', has('system_followed') ? 'system_followed' : 'NULL');
    add('strategy_match', has('strategy_match') ? 'strategy_match' : 'NULL');
    add('is_stop_loss', has('is_stop_loss') ? 'is_stop_loss' : 'NULL');
    add('remark', has('remark') ? 'remark' : 'NULL');
    add('created_at', createdAtExpr);

    return { columns, selects };
  }

  static getInstance(): ConfigStore {
    if (!ConfigStore._instance) {
      ConfigStore._instance = new ConfigStore();
    }
    return ConfigStore._instance;
  }

  /**
   * 关闭当前连接并清空单例，下次 getInstance() 会用同一 _dbPath 重新打开
   *
   * 仅备份恢复流程使用：恢复时必须先断开 WAL 连接、替换库文件、再重开，
   * 否则 better-sqlite3 会继续读写旧的文件句柄。
   */
  static resetInstance(): void {
    if (ConfigStore._instance) {
      try {
        ConfigStore._instance._db.close();
      } catch {
        /* 已关闭 */
      }
      ConfigStore._instance = null;
    }
  }

  get db(): Database.Database {
    return this._db;
  }

  getDbPath(): string {
    return this._dbPath;
  }

  /**
   * 写入 system_log（三层降级的第一层 + 独立事务防主流程锁竞争）
   *
   * ⚠️ **prepared statement 复用**（2026-10-20）：原实现每次调用都
   *   `db.transaction(fn)` + `db.prepare(sql)` —— better-sqlite3 的
   *   `transaction()` 适合「创建一次、反复调用」，每次新建会重复构造包装器；
   *   `prepare()` 每次都要重新解析 SQL。高频写日志场景（选股 5000 次插件执行）
   *   实测这条路径单独就要 ~1.6s。
   */
  writeLog(
    logType: string,
    level: string,
    message: string,
    detail?: string,
    checkItem?: string,
    logDate?: string,
  ): void {
    try {
      // SDD §12.5 要求 writeSystemLog 独立事务——
      // 用闭包事务包装单条 INSERT，避免共享连接池时被其他事务阻塞
      this._logInsertTx(
        logDate ?? new Date().toISOString().slice(0, 10),
        logType,
        level,
        message,
        detail,
        checkItem,
      );
    } catch (err) {
      // SQLite 不可用时降级到 console.error → systemd journal 捕获
      console.error('[system_log fallback]', { logType, level, message, detail, err });
    }
  }

  /**
   * 批量写入 system_log（**单事务**）
   *
   * 🔴 2026-10-20 新增：选股路径一次请求会产生 **5000 条** plugin_execute 日志。
   *   逐条 auto-commit 实测 ~1.6s；合成单事务后实测 ~20ms（**80x**）。
   *   落库的**行内容与顺序完全一致**，只是提交次数从 5000 降到 1。
   *
   * ⚠️ **失败必须抛出，不得就地吞掉**（2026-10-21 修正）：
   *   本方法若自己 catch 掉异常，调用方（`services/logger.ts` 的 `flushBuffer`）
   *   就**永远不会**进入「降级逐条写入」分支 ⇒ 批量失败时 5000 条日志**全丢**。
   *   ⇒ 这里让异常上抛，由调用方决定降级策略。
   */
  writeLogBatch(entries: LogBatchEntry[]): void {
    if (entries.length === 0) return;
    this._logBatchTx(entries);
  }

  /** 单条 INSERT 的 prepared statement（懒加载一次，复用） */
  private _logStmt(): Database.Statement {
    if (!this._logStatement) {
      this._logStatement = this._db.prepare(
        'INSERT INTO system_log(log_date, log_type, level, check_item, message, detail) VALUES (?, ?, ?, ?, ?, ?)',
      );
    }
    return this._logStatement;
  }

  /** 单条写入的独立事务（事务包装器只创建一次，反复调用） */
  private _logInsertTx(
    logDate: string,
    logType: string,
    level: string,
    message: string,
    detail: string | undefined,
    checkItem: string | undefined,
  ): void {
    if (!this._logInsertTransaction) {
      this._logInsertTransaction = this._db.transaction(
        (d: string, t: string, l: string, m: string, det: string | undefined, ci: string | undefined) => {
          this._logStmt().run(d, t, l, ci ?? null, m, det ?? null);
        },
      );
    }
    this._logInsertTransaction(logDate, logType, level, message, detail, checkItem);
  }

  /** 批量写入的单事务 */
  private _logBatchTx(entries: LogBatchEntry[]): void {
    if (!this._logBatchTransaction) {
      this._logBatchTransaction = this._db.transaction((rows: LogBatchEntry[]) => {
        const stmt = this._logStmt();
        const today = new Date().toISOString().slice(0, 10);
        for (const e of rows) {
          stmt.run(e.logDate ?? today, e.logType, e.level, e.checkItem ?? null, e.message, e.detail ?? null);
        }
      });
    }
    this._logBatchTransaction(entries);
  }
}
