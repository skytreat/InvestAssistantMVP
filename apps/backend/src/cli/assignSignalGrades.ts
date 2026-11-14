/**
 * 信号定级 / 冷却回填 CLI（默认 **dry-run**，`--execute` 才落库）
 *
 * 🔴 背景（2026-11-14 arm 生产实测）：`user_strategy_signal` 的 `grade` / `expires_at` /
 *    `cooldown_until` 三列在**实时链路（17:02 cron / admin 手动触发）下从未被写** ——
 *    定级函数只被回放链路调用 ⇒ 全部行 `grade = NULL`
 *    ⇒ 信号页「分级」默认档（强/中/弱 → `WHERE grade='strong'`）把全部行滤掉
 *    ⇒ 持仓组 / 自选组两 Tab 全空。
 *
 * 本 CLI 用于**补历史缺口**（与实时链路修复配套）：
 * - 口径**完全复用** `assignSignalGrades` / `assignSignalCooldowns`（不复制分档逻辑）；
 * - 只写 `grade` / `expires_at` / `cooldown_until` 三列，**不增删信号行**、不改其它列；
 * - **幂等**：重复执行结果相同（同日同集合 ⇒ 同分档）。
 *
 * 用法（在 `apps/backend` 下）：
 *   npx tsx --env-file=../../.env.local src/cli/assignSignalGrades.ts                 # dry-run：库中所有有信号的交易日
 *   npx tsx --env-file=../../.env.local src/cli/assignSignalGrades.ts --date 2026-11-13
 *   npx tsx --env-file=../../.env.local src/cli/assignSignalGrades.ts --from 2026-11-12 --to 2026-11-13 --execute
 *   npx tsx --env-file=../../.env.local src/cli/assignSignalGrades.ts --latest --execute
 *
 * 参数：
 *   --date YYYY-MM-DD    指定单个交易日
 *   --from/--to          闭区间（两个都给才生效）
 *   --latest             只处理库中最新有信号的交易日
 *   --all                处理库中所有有信号的交易日（缺省行为）
 *   --execute            真落库（**落库前自动 `db.backup()` 全库热备份**并打印备份路径）
 *
 * 环境变量：`SQLITE_DB_PATH`（默认 data/business.db）、`DUCKDB_PATH`（默认 data/quotes.duckdb）
 *          —— `expires_at` / `cooldown_until` 依赖**交易日历**（行情库），行情库不可用时退化为工作日推算。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../config/configStore.js';
import {
  assignSignalCooldowns,
  assignSignalGrades,
  computeSignalGrades,
  SIGNAL_USER_ID,
} from '../services/signalService.js';

function argOf(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const dateArg = argOf(argv, '--date');
  const fromArg = argOf(argv, '--from');
  const toArg = argOf(argv, '--to');
  const latestOnly = argv.includes('--latest');

  for (const [label, value] of [
    ['--date', dateArg],
    ['--from', fromArg],
    ['--to', toArg],
  ] as const) {
    if (value !== undefined && !DATE_RE.test(value)) {
      console.error(`${label} 必须是 YYYY-MM-DD，收到「${value}」`);
      process.exit(1);
    }
  }

  const db = ConfigStore.getInstance().db;
  const userId = SIGNAL_USER_ID;

  // ── 目标交易日集合 ────────────────────────────────────────────────
  const allDates = (
    db
      .prepare(
        `SELECT DISTINCT trade_date FROM user_strategy_signal
         WHERE user_id = ? AND is_deleted = 0 ORDER BY trade_date ASC`,
      )
      .all(userId) as Array<{ trade_date: string }>
  ).map((r) => r.trade_date);

  let dates: string[];
  if (dateArg) {
    dates = [dateArg];
  } else if (fromArg && toArg) {
    dates = allDates.filter((d) => d >= fromArg && d <= toArg);
  } else if (latestOnly) {
    dates = allDates.length > 0 ? [allDates[allDates.length - 1]] : [];
  } else {
    dates = allDates;
  }

  console.log(`\n[${execute ? 'EXECUTE' : 'DRY-RUN'}] 信号定级 / 冷却回填`);
  console.log(`  交易日集合: ${dates.length ? dates.join(', ') : '(空)'}`);
  if (dates.length === 0) {
    console.log('  无待处理交易日');
    return;
  }

  // ── 落库前自动热备份（生产写操作前置）────────────────────────────
  if (execute) {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-grade-backup-'));
    const backupPath = path.join(backupDir, 'business.db');
    await db.backup(backupPath);
    console.log(`  备份: ${backupPath}`);
  }

  for (const d of dates) {
    const plan = computeSignalGrades(d, userId);
    const ungraded = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM user_strategy_signal
           WHERE user_id = ? AND trade_date = ? AND is_deleted = 0 AND strength IS NULL`,
        )
        .get(userId, d) as { c: number }
    ).c;
    const alreadyGraded = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM user_strategy_signal
           WHERE user_id = ? AND trade_date = ? AND is_deleted = 0 AND grade IS NOT NULL`,
        )
        .get(userId, d) as { c: number }
    ).c;

    const head = `  ${d}  可定级=${plan.rows.length}（强${plan.strong}/中${plan.medium}/弱${plan.weak}）  未分级(无 strength)=${ungraded}  已定级=${alreadyGraded}`;

    if (!execute) {
      console.log(`${head}  [dry-run，未写库]`);
      continue;
    }
    const graded = await assignSignalGrades(d, userId);
    const cooldown = await assignSignalCooldowns(d, userId);
    console.log(
      `${head}  → 已写 graded=${graded.graded}（强${graded.strong}/中${graded.medium}/弱${graded.weak}） cooldown_until=${cooldown.cooldownUntil}（${cooldown.updated} 行）`,
    );
  }

  if (!execute) console.log('\n（dry-run 未写库；确认无误后加 --execute 重跑）');
}

main().catch((err) => {
  console.error('[assign-signal-grades] 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
