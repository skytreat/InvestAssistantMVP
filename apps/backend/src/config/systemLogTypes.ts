/**
 * system_log 的 `log_type` / `level` 白名单 —— **唯一真相源**
 *
 * 🔴 2026-11-13 事故驱动（生产实测）：
 *   纸面账户日更（17:04）每晚写 `logType: 'paper_account'`，
 *   而 `system_log` 的 CHECK 白名单里**没有**这个类型 ⇒ INSERT 抛
 *   `CHECK constraint failed` ⇒ `writeNow` 三层降级到 console/journald
 *   ⇒ **纸面段的全部日志（含结算失败/异常）在 DB 里查不到**，前端/管理端也看不到。
 *   同期该段还用了小写 level（`'info'/'warn'/'error'`），同样不在 level 白名单里。
 *
 * ⇒ 白名单必须是**唯一真相源**：DDL、迁移、运行时校验、类型定义全部从这里派生，
 *   并由 `tests/unit/systemLogTypes.test.ts` 守住「代码里用到的类型 ⊆ 白名单」。
 *
 * ⚠️ 新增 log_type 的正确姿势：
 *   ① 把字面量加进本文件的 `SYSTEM_LOG_TYPES`；
 *   ② 旧库的 CHECK 约束由 `ConfigStore._ensureSystemLogCheckConstraint()` 自动重建
 *      （幂等表重建，见 AGENTS.md「改 CHECK / UNIQUE → 幂等表重建」）。
 */

/** 允许写入 `system_log.log_type` 的全部类型 */
export const SYSTEM_LOG_TYPES = [
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
  'paper_account',
  'alert',
] as const;

export type SystemLogType = (typeof SYSTEM_LOG_TYPES)[number];

/** 允许写入 `system_log.level` 的全部等级（**必须大写**） */
export const SYSTEM_LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS'] as const;

export type SystemLogLevel = (typeof SYSTEM_LOG_LEVELS)[number];

/** 生成 DDL 里 CHECK 子句用的字面量列表（`'a', 'b', ...`） */
export const SYSTEM_LOG_TYPE_LIST_SQL = SYSTEM_LOG_TYPES.map((t) => `'${t}'`).join(', ');
export const SYSTEM_LOG_LEVEL_LIST_SQL = SYSTEM_LOG_LEVELS.map((l) => `'${l}'`).join(', ');
