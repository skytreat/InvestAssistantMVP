/**
 * 组合策略配置 schema（T133，方案 §4.1 / PA-01）
 *
 * 只新增表，不改 `user_strategy_signal` 结构；全部 `CREATE TABLE IF NOT EXISTS`
 * ⇒ 重复启动幂等，不引入迁移框架（AGENTS.md「DDL 变更判据」）。
 *
 * ⚠️ ConfigStore 启动时调用 `ensureComboTables(db)`（PA-06 已接入），与 `DDL_SQL` 同为幂等建表。
 */
import type Database from 'better-sqlite3';

/** 组合配置固定表清单（白名单：多一张少一张都算失败） */
export const COMBO_TABLES: readonly string[] = ['strategy_combo', 'strategy_combo_condition'];

const COMBO_SCHEMA_SQL = `
-- ─────────────────────────────────────────────────────────────
-- 组合策略主表
-- MVP 只有 AND（D1 已定）；combine_op 保留 OR 取值，但服务层只写 'AND'
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategy_combo (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    name            TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    combine_op      TEXT NOT NULL DEFAULT 'AND' CHECK (combine_op IN ('AND', 'OR')),
    asset_scope     TEXT NOT NULL DEFAULT 'all'
                    CHECK (asset_scope IN (
                        'all', 'stock', 'etf', 'cross_border', 'exclude_cross_border', 'exclude_cash'
                    )),
    period          TEXT NOT NULL DEFAULT 'daily' CHECK (period IN ('daily')),
    cooldown_bars   INTEGER NOT NULL DEFAULT 3 CHECK (cooldown_bars >= 1 AND cooldown_bars <= 20),
    config_version  INTEGER NOT NULL DEFAULT 1 CHECK (config_version >= 1),
    is_deleted      INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (user_id) REFERENCES user_account(id)
);

-- 组合条件（有序）
CREATE TABLE IF NOT EXISTS strategy_combo_condition (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    combo_id        TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    plugin_id       TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    params_json     TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (combo_id, seq),
    FOREIGN KEY (combo_id) REFERENCES strategy_combo(id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_combo_user
    ON strategy_combo (user_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_strategy_combo_condition
    ON strategy_combo_condition (combo_id, seq);
`;

/**
 * 建表（幂等）
 *
 * 调用方需自行保证 `user_account` 已存在（业务库由 ConfigStore 建）；
 * 单测可用最小的 `user_account (id INTEGER PRIMARY KEY)` 桩替代。
 */
export function ensureComboTables(db: Database.Database): void {
  db.exec(COMBO_SCHEMA_SQL);
}
