#!/usr/bin/env node
/**
 * 回测库清理脚本（PA-05 / 方案 §13.4 第 3 条）
 *
 * 目标库**固定**为 `./data/backtest.db`（相对当前工作目录；**不接受参数/env 覆盖**）。
 * 必须在仓库根执行：`node scripts/cleanup-backtest-data.mjs`。
 *
 * 🔴 三条安全守卫（任何一条不满足就 abort，退出码非 0）：
 *   1. 探测 `sqlite_master` 里任何 `paper_*` 对象（表 / 索引 / 触发器）→ 命中即中止；
 *      `paper_*` 是账户账本，清理脚本**永远**不该碰它（误删 = 不可恢复）。
 *   2. 只删除 `bt_*` 表的数据，不 DROP 任何 schema，不删除库文件本身。
 *   3. 发现未知前缀对象时同样中止（只做白名单内的事）。
 *
 * 为什么用 `process.cwd()` 而不是脚本相对路径：测试需要在临时目录里放置
 * `data/backtest.db` 来验证「命中 paper 时真的 abort」；生产用法是在仓库根执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const PAPER_PATTERN = /^(paper_|idx_paper_|trg_paper_)/;
const ALLOWED_BT = /^bt_/;

function abort(msg) {
  console.error(`[cleanup-backtest-data] ABORT: ${msg}`);
  process.exit(1);
}

const dbPath = path.resolve(process.cwd(), 'data', 'backtest.db');

if (!fs.existsSync(dbPath)) {
  console.log(`[cleanup-backtest-data] 目标库不存在，无需清理：${dbPath}`);
  process.exit(0);
}

const db = new Database(dbPath, { fileMustExist: true });
try {
  const objects = db
    .prepare(`SELECT name, type, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`)
    .all();

  // ── 守卫 1：paper_* 命中即 abort（不看数量、不看类型） ──
  const paperHits = objects.filter(
    (o) => PAPER_PATTERN.test(o.name) || (typeof o.tbl_name === 'string' && o.tbl_name.startsWith('paper_')),
  );
  if (paperHits.length > 0) {
    abort(
      `检测到 paper_* 对象（${paperHits.map((o) => `${o.type}:${o.name}`).join(', ')}）；` +
        `该库同时承载纸面账户账本，拒绝清理`,
    );
  }

  // ── 守卫 3：白名单 —— 只处理 bt_* 表 ──
  const btTables = objects.filter((o) => o.type === 'table' && ALLOWED_BT.test(o.name));
  const unexpectedTables = objects.filter(
    (o) => o.type === 'table' && !ALLOWED_BT.test(o.name) && o.name !== 'sqlite_sequence',
  );
  if (unexpectedTables.length > 0) {
    abort(`存在非 bt_* 表（${unexpectedTables.map((o) => o.name).join(', ')}），超出清理白名单`);
  }

  // ── 守卫 2：只删数据，不删 schema / 库文件 ──
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    let deleted = 0;
    for (const table of btTables) {
      const info = db.prepare(`DELETE FROM ${table.name}`).run();
      deleted += info.changes;
    }
    db.exec('COMMIT');
    console.log(
      `[cleanup-backtest-data] 已清理 ${btTables.length} 张 bt_* 表，共删除 ${deleted} 行（库文件保留）`,
    );
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已回滚 */
    }
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
} catch (err) {
  console.error(`[cleanup-backtest-data] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
