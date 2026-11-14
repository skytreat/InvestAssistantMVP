/**
 * T156 —— 信号定级 / 冷却的**调用点**回归测试
 *
 * 🔴 为什么要有这个文件（2026-11-14 arm 生产实测事故）：
 *
 *   生产现象：信号页「持仓组 / 自选组」两 Tab 全空，而策略有效性页显示 38 条信号。
 *
 *   取证链：
 *   ① 浏览器实况请求 `/api/signal?...&grade=strong&dedupe=1&scope=holdings` → **0 行**；
 *      去掉 `grade=strong` → 38 行；
 *   ② 生产库 `user_strategy_signal` 38 条信号 `grade` / `expires_at` **全为 NULL**；
 *   ③ 根因：`assignSignalGrades` / `assignSignalCooldowns` **只被回放链路**
 *      （`signalReplay.ts`）调用 —— 17:02 实时链路与 admin 手动触发**都没调**；
 *   ④ 放大器：前端分级 tab 默认「强」⇒ `WHERE grade='strong'` 把未分级行全滤掉。
 *
 * ⚠️ 既有 `f1-signal-grade.test.ts` **只测函数本身**（函数有单测 ≠ 有人调用）⇒ 假绿。
 *    本文件专门钉「**谁调用了它**」：17:02 cron 段 + admin 手动触发段，两条路径都必须
 *    让当日信号拿到 `grade` / `expires_at` / `cooldown_until`。
 *
 * 钉死的口径：
 *   - 实时链路与回放链路**同一函数、同一 user、同一 tradeDate、幂等**；
 *   - `strength IS NULL` 的行（监控类，如 `position_risk_alert`）**保持未分级**
 *     （`assignSignalGrades` 既定口径：无强度不定档）；
 *   - 回填 CLI 与写库路径**同源**（`computeSignalGrades` 只读预览 = 实际落库结果）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGINAL_SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;
const tmpDbPath = path.join(os.tmpdir(), `invest-grade-wiring-${Date.now()}.db`);
process.env.SQLITE_DB_PATH = tmpDbPath;

// 插件引擎：只替换 `executeAllPlugins`（cron 段只需要「跑完、无信号」），
// 其余导出保持真实实现（避免 mock 工厂漏导出导致下游模块 import 失败）
vi.mock('../../src/services/pluginEngine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/pluginEngine.js')>();
  return {
    ...actual,
    executeAllPlugins: vi.fn(async () => ({
      results: [],
      signals: [],
      stats: { total: 0, success: 0, skip: 0, noData: 0, timeout: 0, error: 0, positionUnavailable: 0 },
    })),
  };
});

import { ConfigStore } from '../../src/config/configStore.js';
import { registerCronJobs } from '../../src/services/scheduler.js';
import { computeSignalGrades, getTradeDate } from '../../src/services/signalService.js';
import * as marketNs from '../../src/services/marketData.js';
import * as duckdbNs from '../../src/db/duckdb.js';
import * as loggerNs from '../../src/services/logger.js';

/** 固定交易日（周五）—— 纯工作日兜底下 +1=周一 / +2=周二 / +3=周三 */
const TRADE_DATE = '2026-11-13';

let db: ReturnType<typeof ConfigStore.getInstance>;

function insertSignal(userId: number, code: string, strength: number | null): number {
  return Number(
    db.db
      .prepare(
        `INSERT INTO user_strategy_signal
           (user_id, asset_code, plugin_id, plugin_category, trade_date, direction, label,
            strength, grade, expires_at, metrics_json, is_final, origin)
         VALUES (?, ?, 'macd_cross', 'monitor', ?, 'buy', 'L', ?, NULL, NULL, '{}', 1, 'live')`,
      )
      .run(userId, code, TRADE_DATE, strength).lastInsertRowid,
  );
}

function readGrade(id: number): {
  grade: string | null;
  expires_at: string | null;
  cooldown_until: string | null;
} {
  return db.db
    .prepare(`SELECT grade, expires_at, cooldown_until FROM user_strategy_signal WHERE id = ?`)
    .get(id) as { grade: string | null; expires_at: string | null; cooldown_until: string | null };
}

beforeAll(() => {
  db = ConfigStore.getInstance();
  // `user_strategy_signal.user_id` 外键指向 `user_account(id)`；cron 段固定用 SIGNAL_USER_ID=1
  db.db
    .prepare(
      `INSERT OR IGNORE INTO user_account (id, username, password_hash, role) VALUES (1, 'grade_wiring_user', 'dummy-hash', 'admin')`,
    )
    .run();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDbPath, { force: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_SQLITE_DB_PATH !== undefined) process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_DB_PATH;
  else delete process.env.SQLITE_DB_PATH;
  (ConfigStore as any)._instance = null;
});

beforeEach(() => {
  vi.spyOn(duckdbNs, 'isDuckDBWriteSentinelPresent').mockReturnValue(false);
  vi.spyOn(marketNs, 'resolveLatestQuoteDate').mockResolvedValue(TRADE_DATE);
  vi.spyOn(loggerNs, 'writeSystemLog').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  db.db.prepare(`DELETE FROM user_strategy_signal`).run();
});

/**
 * 捕获 17:02 cron 段并**真实执行**其任务体
 *
 * ⚠️ `CronJob.task` 在 toad-scheduler 里是 private 字段，运行时可直接取；
 *    `AsyncTask.executeAsync()` 会 await 任务体（与真实触发同路径）。
 */
async function runSignalGenerateCron(): Promise<void> {
  const jobs: any[] = [];
  const fakeApp = {
    scheduler: {
      addCronJob: (job: unknown) => {
        jobs.push(job);
      },
    },
  } as any;
  registerCronJobs(fakeApp);
  const signalJob = jobs.find((j) => j?.task?.id === 'signal-generate');
  expect(signalJob, '未捕获到 17:02 signal-generate cron').toBeTruthy();
  await signalJob.task.executeAsync();
}

describe('T156 · 17:02 实时链路必须给信号定级 + 标冷却', () => {
  it('cron 段执行后，当日信号拿到 grade / expires_at / cooldown_until', async () => {
    const id = insertSignal(1, 'sh600000', 0.9);

    expect(readGrade(id).grade).toBeNull();

    await runSignalGenerateCron();

    const after = readGrade(id);
    // ① 定级：单候选 < GRADE_MIN_CANDIDATES(10) ⇒ 绝对分值兜底：0.9 ≥ 0.6 ⇒ strong
    expect(after.grade).toBe('strong');
    // ② 有效期：强 = 交易日 + 3 个交易日
    expect(after.expires_at).toBeTruthy();
    // ③ 冷却窗口（F6 展示层合并去重的判据）
    expect(after.cooldown_until).toBeTruthy();
  }, 30000);

  it('监控类信号（strength IS NULL）保持未分级 —— 不被硬塞进强/中/弱', async () => {
    const id = insertSignal(1, 'sh600001', null);

    await runSignalGenerateCron();

    const after = readGrade(id);
    expect(after.grade).toBeNull();
    expect(after.expires_at).toBeNull();
    // 冷却窗口与强度无关，仍应写入
    expect(after.cooldown_until).toBeTruthy();
  }, 30000);
});

describe('T156 · 定档计划与写库同源（dry-run 预览 = 实际结果）', () => {
  it('computeSignalGrades 预览的档位与 assignSignalGrades 落库结果一致', async () => {
    const strongId = insertSignal(1, 'sh600002', 0.9);
    const weakId = insertSignal(1, 'sh600003', 0.1);

    const plan = computeSignalGrades(TRADE_DATE, 1);
    const planById = new Map(plan.rows.map((r) => [r.id, r.grade]));

    expect(planById.get(strongId)).toBe('strong');
    expect(planById.get(weakId)).toBe('weak');

    // 落库（cron 段）后 DB 值 = 预览值
    await runSignalGenerateCron();
    expect(readGrade(strongId).grade).toBe(planById.get(strongId));
    expect(readGrade(weakId).grade).toBe(planById.get(weakId));
  }, 30000);

  it('getTradeDate 是 YYYY-MM-DD（回填 CLI 与实时链路的 tradeDate 口径一致）', () => {
    expect(getTradeDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
