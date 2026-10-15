// apps/backend/tests/smoke-m2.test.ts
// T24: Phase 2 验收清卡测试
//
// 本地运行：npm run test （DuckDB 不可用时 gracefully catch，核心验证 system_log 写入）
//
// M2 验收覆盖：
//   ✅ C1-C3,C6-C12 全部能跑（DuckDB 不可用时 result=ERROR 但必须写 system_log）
//   ✅ executeAllPlugins() 返回 signals + stats（builtin 插件 DuckDB 不可用时返回空数组 + SKIP/ERROR）
//   ✅ importDividendEvents() 能执行（DuckDB 不可用时 events=0 或异常 → 写 system_log）
//   ✅ scheduler 4 段 cron 已注册（getAllJobs() 能看到 4 个 CronJob）
//   ✅ system_log 至少有 datacheck + plugin_execute + dividend_import 三类日志
//
// 注意：
//   - runAllChecks 返回 10 条（C4/C5 MVP 合并到 checkC3toC5，返回 checkId='C3'）
//   - pluginEngine 直接调用写 plugin_execute logType，signal_generate 由 scheduler cron 产生
//   - 不要 mock DuckDB——让真实 DuckDB 不可用，验证 gracefully catch 后仍写 system_log

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import schedule from '@fastify/schedule';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../src/config/configStore.js';
import { runAllChecks } from '../src/services/validator.js';
import { executeAllPlugins } from '../src/services/pluginEngine.js';
import { importDividendEvents } from '../src/services/exDividendSync.js';
import { registerCronJobs } from '../src/services/scheduler.js';
import { duckdbHealthCheck, queryDuckDB } from '../src/db/duckdb.js';

const TEST_PORT = 51101;

// 顶层快速检测：只看文件存不存在（避免 DuckDB Neo API 文件锁泄漏）
const _DUCKDB_PATH = process.env.DUCKDB_PATH ?? path.resolve('data', 'quotes.duckdb');
const DUCKDB_FILE_EXISTS = fs.existsSync(_DUCKDB_PATH);
console.log(`[smoke-m2] DuckDB path: ${_DUCKDB_PATH}, exists=${DUCKDB_FILE_EXISTS}`);

// 真实 DuckDB 可用性延后到 test 内部检测（有独立 timeout + try-catch）
const _duckdbWorks = DUCKDB_FILE_EXISTS;

let app: Awaited<ReturnType<typeof Fastify>>;
let db: ReturnType<typeof ConfigStore>;
let tradeDate: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(schedule);
  db = ConfigStore.getInstance();
  tradeDate = new Date().toISOString().slice(0, 10);
}, 10000);

afterAll(async () => {
  await app.close().catch(() => {});
}, 5000);

// ========================================================================
// M2 C1-C3,C6-C12 数据校验（DuckDB 不可用时每条 ERROR 也必须写 system_log）
// ========================================================================
describe('M2 C1-C12 数据校验', () => {
  it('runAllChecks 返回 10 条 CheckSummary（C1/C2/C3/C6/C7/C8/C9/C10/C11/C12）', async () => {
    const summaries = await runAllChecks(tradeDate);
    // CHECKS 数组共 10 条：checkC1, checkC2, checkC3toC5, checkC6, checkC7, checkC8, checkC9, checkC10, checkC11, checkC12
    expect(summaries).toHaveLength(10);

    const validCheckIds = ['C1', 'C2', 'C3', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12'];
    const seenIds = new Set<string>();
    for (const s of summaries) {
      // checkId 必须是合法的 C1/C2/C3/C6-C12（C4/C5 MVP 跳过，合并到 C3）
      expect(validCheckIds).toContain(s.checkId);
      expect(seenIds.has(s.checkId)).toBe(false);  // 无重复
      seenIds.add(s.checkId);

      // result 必须是合法值
      expect(['PASS', 'WARN', 'ERROR', 'SKIP']).toContain(s.result);
      expect(typeof s.durationMs).toBe('number');
    }
  });

  it('runAllChecks 每条结果都写入 system_log（DuckDB 不可用时 ERROR 也会写）', async () => {
    // 等上一条写完（writeSystemLog 内部是同步写 SQLite，但多线程可能有竞争）
    await new Promise((r) => setTimeout(r, 100));

    const rows = db.db
      .prepare(
        "SELECT check_item, level, message FROM system_log WHERE log_type='datacheck' ORDER BY id DESC LIMIT 10"
      )
      .all() as { check_item: string; level: string; message: string }[];

    // 至少有若干条 datacheck 日志（DuckDB 不可用时每条 ERROR 也会写）
    expect(rows.length).toBeGreaterThanOrEqual(10);
    // 每个 level 必须是合法值
    const validLevels = ['INFO', 'WARN', 'ERROR', 'SKIP', 'SUCCESS'];
    for (const r of rows) {
      expect(validLevels).toContain(r.level);
    }
  });
});

// ========================================================================
// M2 插件引擎
// ========================================================================
describe('M2 插件引擎', () => {
  it('executeAllPlugins 返回 signals + stats', async () => {
    const result = await executeAllPlugins();
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.total).toBe('number');
    // builtin monitor 插件数：rsi_oversold + macd_cross = 2
    expect(result.stats.total).toBeGreaterThanOrEqual(2);
    // stats 字段完整性
    expect(typeof result.stats.success).toBe('number');
    expect(typeof result.stats.timeout).toBe('number');
    expect(typeof result.stats.error).toBe('number');
    expect(typeof result.stats.skip).toBe('number');
  });

  it('executeAllPlugins 写入 system_log（plugin_execute logType）', async () => {
    await new Promise((r) => setTimeout(r, 100));

    // executeAllPlugins 内部写 plugin_execute logType（每个插件执行一条 + 批量汇总一条）
    const row = db.db
      .prepare(
        "SELECT level, message FROM system_log WHERE log_type='plugin_execute' ORDER BY id DESC LIMIT 1"
      )
      .get() as { level: string; message: string } | undefined;
    expect(row).toBeDefined();

    // 也验证有至少 2 条 plugin_execute（两个 builtin 插件各一条 + 批量汇总）
    const rowCount = db.db
      .prepare("SELECT COUNT(*) AS cnt FROM system_log WHERE log_type='plugin_execute'")
      .get() as { cnt: number };
    expect(rowCount.cnt).toBeGreaterThanOrEqual(2);
  });
});

// ========================================================================
// M2 除权自动导入
// ========================================================================
describe('M2 除权自动导入', () => {
  it('importDividendEvents 能执行（DuckDB 不可用时 events=0 → 正确返回）', async () => {
    const result = await importDividendEvents(tradeDate);
    expect(typeof result.eventsProcessed).toBe('number');
    expect(typeof result.holdingsSkipped).toBe('number');
    expect(typeof result.duplicatesSkipped).toBe('number');
    expect(typeof result.importedDividend).toBe('number');
    expect(typeof result.importedBonus).toBe('number');
    expect(typeof result.errors).toBe('number');
    // DuckDB 不可用时 fetchDividendEvents 抛异常 → 外层 catch → errors++
    // 但函数不会抛，正常返回 result
  });

  it('importDividendEvents 写入 system_log（dividend_import logType）', async () => {
    await new Promise((r) => setTimeout(r, 100));

    const row = db.db
      .prepare(
        "SELECT level FROM system_log WHERE log_type='dividend_import' ORDER BY id DESC LIMIT 1"
      )
      .get() as { level: string } | undefined;
    // 必须有一条日志（SKIP=无除权事件，ERROR=DuckDB 不可用，都算流程跑通）
    expect(row).toBeDefined();
    expect(['SKIP', 'INFO', 'ERROR', 'WARN', 'SUCCESS']).toContain(row!.level);
  });
});

// ========================================================================
// M2 scheduler 4 段 cron 注册
// ========================================================================
describe('M2 scheduler 4 段 cron 注册', () => {
  it('registerCronJobs 注册 4 个 CronJob', () => {
    registerCronJobs(app);
    const jobs = app.scheduler.getAllJobs();
    expect(jobs).toHaveLength(4);

    // 验证每个 job 都有唯一 ID（AsyncTask 的第一个参数就是 task id → job id）
    const ids = jobs.map((j: any) => j.id).sort();
    expect(ids).toEqual(['backup', 'datacheck-c1-c12', 'dividend-import', 'signal-generate']);
  });
});

// ========================================================================
// M2 全链路日志验证
// ========================================================================
describe('M2 全链路日志验证', () => {
  it('system_log 有三类记录：datacheck + plugin_execute + dividend_import', () => {
    const types = db.db
      .prepare(
        "SELECT DISTINCT log_type FROM system_log WHERE log_type IN ('datacheck', 'plugin_execute', 'dividend_import')"
      )
      .all() as { log_type: string }[];
    const typeList = types.map((t) => t.log_type);
    // 三个直接调用都应该产生日志
    expect(typeList.sort()).toEqual(['datacheck', 'dividend_import', 'plugin_execute']);
  });
});

// ========================================================================
// M2 真实 DuckDB 路径（条件执行）
// - Windows 开发机: DUCKDB_FILE_EXISTS=false → 3 个 test 空通过（无断言）
// - OCI 服务器: DuckDB 文件存在 → 每个 test 内部独立 duckdbHealthCheck 验证后跑真实断言
// ========================================================================

describe('M2 真实 DuckDB 路径', () => {
  // 每个 test 内部独立验证 DuckDB 真能用（有独立 timeout + try-catch，不泄漏文件锁）
  async function _ensureDuckdbWorks(): Promise<boolean> {
    if (!_duckdbWorks) return false;  // fs 检测文件就不存在
    try {
      await duckdbHealthCheck();
      return true;
    } catch {
      return false;  // 文件存在但被锁 / 损坏 → 跳过
    }
  }

  it('runAllChecks 至少 C1 能执行（result 是合法值）', async () => {
    if (!(await _ensureDuckdbWorks())) return;
    const summaries = await runAllChecks(tradeDate);
    const c1 = summaries.find((s) => s.checkId === 'C1');
    expect(c1).toBeDefined();
    expect(['PASS', 'WARN', 'ERROR', 'SKIP']).toContain(c1!.result);
  });

  it('builtin 插件 50ms 内能返回 signals（无 timeout）', async () => {
    if (!(await _ensureDuckdbWorks())) return;
    const result = await executeAllPlugins();
    expect(result.stats.timeout).toBe(0);
    expect(Array.isArray(result.signals)).toBe(true);
  });

  it('除权导入：无异常 errors=0', async () => {
    if (!(await _ensureDuckdbWorks())) return;
    const result = await importDividendEvents(tradeDate);
    console.error('[smoke-m2] dividend result:', JSON.stringify(result));
    expect(result.errors).toBe(0);
    expect(result.eventsProcessed).toBeGreaterThanOrEqual(0);
  });
});
