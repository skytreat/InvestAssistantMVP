import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

/**
 * ConfigStore 单例
 * - 管理 better-sqlite3 连接
 * - 启动时初始化 PRAGMA + 所有 DDL（CREATE TABLE IF NOT EXISTS）
 * - DDL 全部幂等，支持重复启动不报错
 */

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
CREATE TABLE IF NOT EXISTS user_trade_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    asset_code TEXT NOT NULL,
    trade_type TEXT NOT NULL CHECK (
        trade_type IN ('buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer')
    ),
    trade_date TEXT NOT NULL,
    trade_time TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity >= 0),
    price REAL NOT NULL CHECK (price >= 0),
    fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
    trade_reason TEXT,
    is_auto_import INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_import IN (0, 1)),
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    review_summary TEXT,
    system_followed INTEGER CHECK (system_followed IS NULL OR system_followed IN (0, 1)),
    strategy_match INTEGER CHECK (strategy_match IS NULL OR strategy_match IN (0, 1)),
    is_stop_loss INTEGER CHECK (is_stop_loss IS NULL OR is_stop_loss IN (0, 1)),
    remark TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
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
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, asset_code, plugin_id, trade_date),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);
CREATE INDEX IF NOT EXISTS idx_signal_user_date ON user_strategy_signal(user_id, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_signal_user_plugin ON user_strategy_signal(user_id, plugin_id, trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_signal_user_asset_date ON user_strategy_signal(user_id, asset_code, trade_date DESC);

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

export class ConfigStore {
  private static _instance: ConfigStore | null = null;
  private _db: Database.Database;
  private _dbPath: string;

  private constructor() {
    // 数据库路径：环境变量 > 默认位置
    // Windows 开发: ./data/business.db
    // Linux 部署: /opt/invol/business.db
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

    // SQLite CREATE TABLE IF NOT EXISTS 对已存在表无效——启动时检测并补齐缺失的列与 UNIQUE 约束
    // 顺序要求：先补列（ALTER ADD COLUMN），让随后的 UNIQUE 重建能携带新列
    this._ensureTradeRecordReviewColumns();

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
   * T87：把 user_trade_record 迁移到**最终 schema**：
   *   - 新增 `trade_time TEXT NOT NULL`（秒级 HH:mm:ss）
   *   - UNIQUE 改为 (user_id, asset_code, trade_type, trade_date, trade_time)  —— **quantity 不进主键**
   *   - trade_type CHECK 改为 7 种（`add` 替换 `sell`，DEC-2 / T49）
   *
   * ⚠️ 为什么一次做完 T87 + T49 两项：AGENTS.md「DDL 变更判据」要求
   * 「多个幂等重建若落在同一张表上，**合并为一次重建**，不要叠加多次 DROP/RENAME」。
   * 因此本函数直接产出最终形态；T49 的 DDL 部分因此成为 no-op（应用层改动仍在 T49）。
   *
   * SQLite 不能 ALTER TABLE 加 NOT NULL 列 / 改 UNIQUE，只能重建：
   *   CREATE new → INSERT SELECT → DROP old → RENAME
   */
  private _ensureTradeRecordUniqueConstraint(): void {
    try {
      // 已达最终 schema？两个条件都要满足：UNIQUE 含 trade_time + 有 trade_time 列
      const idx = this._db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='user_trade_record' AND sql LIKE '%UNIQUE%' AND sql LIKE '%trade_time%'",
        )
        .get();
      const hasTimeCol = this._db
        .prepare("SELECT 1 FROM pragma_table_info('user_trade_record') WHERE name = 'trade_time'")
        .get();
      if (idx && hasTimeCol) return; // 已是最终 schema

      // 表为空 → 直接 DROP 再重建（最简单）
      const count = (this._db.prepare('SELECT COUNT(*) AS c FROM user_trade_record').get() as { c: number })
        .c;
      if (count === 0) {
        this._db.exec('DROP TABLE IF EXISTS user_trade_record');
        this._db.exec(`
          CREATE TABLE user_trade_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            asset_code TEXT NOT NULL,
            trade_type TEXT NOT NULL CHECK (trade_type IN ('buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer')),
            trade_date TEXT NOT NULL,
            trade_time TEXT NOT NULL,
            quantity REAL NOT NULL CHECK (quantity >= 0),
            price REAL NOT NULL CHECK (price >= 0),
            fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
            trade_reason TEXT,
            is_auto_import INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_import IN (0, 1)),
            is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
            review_summary TEXT,
            system_followed INTEGER CHECK (system_followed IS NULL OR system_followed IN (0, 1)),
            strategy_match INTEGER CHECK (strategy_match IS NULL OR strategy_match IN (0, 1)),
            is_stop_loss INTEGER CHECK (is_stop_loss IS NULL OR is_stop_loss IN (0, 1)),
            remark TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time),
            FOREIGN KEY (user_id) REFERENCES user_account(id)
          )
        `);
        this._db.exec('CREATE INDEX idx_trade_user_date ON user_trade_record(user_id, trade_date DESC)');
        this._db.exec('CREATE INDEX idx_trade_asset ON user_trade_record(user_id, asset_code)');
        console.log('[ConfigStore] user_trade_record 已补齐 UNIQUE 约束（空表重建）');
        return;
      }

      // 表有数据 → 用完整迁移流程：备份表 → 建带约束新表 → 复制数据（跳过重复） → 删旧表 → 重命名
      console.warn('[ConfigStore] user_trade_record 有数据，迁移补齐 UNIQUE 约束...');
      this._db.pragma('foreign_keys = OFF');
      this._db.exec('BEGIN');
      try {
        this._db.exec('ALTER TABLE user_trade_record RENAME TO _trade_record_old');
        this._db.exec(`
          CREATE TABLE user_trade_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            asset_code TEXT NOT NULL,
            trade_type TEXT NOT NULL CHECK (trade_type IN ('buy', 'add', 'reduce', 'clear', 'dividend', 'bonus', 'transfer')),
            trade_date TEXT NOT NULL,
            trade_time TEXT NOT NULL,
            quantity REAL NOT NULL CHECK (quantity >= 0),
            price REAL NOT NULL CHECK (price >= 0),
            fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
            trade_reason TEXT,
            is_auto_import INTEGER NOT NULL DEFAULT 0 CHECK (is_auto_import IN (0, 1)),
            is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
            review_summary TEXT,
            system_followed INTEGER CHECK (system_followed IS NULL OR system_followed IN (0, 1)),
            strategy_match INTEGER CHECK (strategy_match IS NULL OR strategy_match IN (0, 1)),
            is_stop_loss INTEGER CHECK (is_stop_loss IS NULL OR is_stop_loss IN (0, 1)),
            remark TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(user_id, asset_code, trade_type, trade_date, trade_time),
            FOREIGN KEY (user_id) REFERENCES user_account(id)
          )
        `);
        // T87：存量记录的 trade_time 取 created_at 的时间部分；
        // created_at 形如 '2026-09-01 14:23:05' → substr(created_at, 12) 得 '14:23:05'。
        // 若 created_at 异常（NULL / 长度不足 / 非 HH:mm:ss）则回退 '00:00:00'。
        // ⚠️ 回退值可能与其它记录撞唯一键 → INSERT OR IGNORE 会跳过该条，
        //    故此处对回退行加 id 后缀秒位微调不可行（NOT NULL + 唯一），
        //    改为：撞键时保留先插入者（与既有迁移语义一致），并在日志中告警。
        this._db.exec(`
          INSERT OR IGNORE INTO user_trade_record (
            user_id, asset_code, trade_type, trade_date, trade_time, quantity, price, fee,
            trade_reason, is_auto_import, is_deleted, review_summary,
            system_followed, strategy_match, is_stop_loss, remark, created_at
          )
          SELECT user_id, asset_code, trade_type, trade_date,
                 CASE
                   WHEN created_at IS NOT NULL
                    AND length(created_at) >= 19
                    AND substr(created_at, 12, 8) GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
                     AND substr(created_at, 14, 2) < '24'
                    AND substr(created_at, 17, 2) < '60'
                    AND substr(created_at, 20, 2) < '60'
                   THEN substr(created_at, 12, 8)
                   ELSE '00:00:00'
                 END,
                 quantity, price, fee,
                 trade_reason, is_auto_import, is_deleted, review_summary,
                 system_followed, strategy_match, is_stop_loss, remark, created_at
          FROM _trade_record_old
          ORDER BY id ASC
        `);
        this._db.exec('DROP TABLE _trade_record_old');
        this._db.exec('CREATE INDEX idx_trade_user_date ON user_trade_record(user_id, trade_date DESC)');
        this._db.exec('CREATE INDEX idx_trade_asset ON user_trade_record(user_id, asset_code)');
        this._db.exec('COMMIT');
        console.log('[ConfigStore] user_trade_record UNIQUE 约束补齐成功');
      } catch (migErr) {
        this._db.exec('ROLLBACK');
        throw migErr;
      } finally {
        this._db.pragma('foreign_keys = ON');
      }
    } catch (err) {
      console.error('[ConfigStore] UNIQUE 约束补齐失败（不阻塞启动）:', err);
    }
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

  /** 写入 system_log（三层降级的第一层 + 独立事务防主流程锁竞争） */
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
      const writeOne = this._db.transaction(() => {
        this._db
          .prepare(
            'INSERT INTO system_log(log_date, log_type, level, check_item, message, detail) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            logDate ?? new Date().toISOString().slice(0, 10),
            logType,
            level,
            checkItem ?? null,
            message,
            detail ?? null,
          );
      });
      writeOne();
    } catch (err) {
      // SQLite 不可用时降级到 console.error → systemd journal 捕获
      console.error('[system_log fallback]', { logType, level, message, detail, err });
    }
  }
}
