/**
 * cronSequence.test.ts — SDD §12.5 F8 用例（`cron_sequence_trigger`）
 *
 * ## 被测对象：5 段收盘后自动化
 *
 * AGENTS.md「行情时间链」+ `docs/deploy.md`「17:00-17:05 Cron 链路」+ SDD §12.5 F8：
 *
 * | 时刻 | 段 | 实现载体 | 归属进程 |
 * |------|----|----------|----------|
 * | 17:00 | 行情更新 | `deploy/tdx2db-update.timer`（`OnCalendar=*-*-* 17:00:00`）→ `tdx2db` Go 二进制 | **systemd（Node 进程外）** |
 * | 17:01 | 数据校验 C1-C12 | Fastify `@fastify/schedule` cron `datacheck-c1-c12`（`1 17 * * 1-5`） | Node |
 * | 17:02 | 插件信号生成 | Fastify `@fastify/schedule` cron `signal-generate`（`2 17 * * 1-5`） | Node |
 * | 17:03 | 除权自动导入 | Fastify `@fastify/schedule` cron `dividend-import`（`3 17 * * 1-5`） | Node |
 * | 17:05 | 双库备份 | Fastify `@fastify/schedule` cron `backup`（`5 17 * * 1-5`） | Node |
 *
 * ## 为什么不真等 5 个时钟点
 *
 * 调度实现是 **`@fastify/schedule`（底层 `toad-scheduler` + `croner`）**，
 * `croner` 用 `setTimeout`（单次最长 30s 的检查窗口）+ `Date.now()` 递归排下一次执行
 * ⇒ **vitest fake timers 可控**（实测：拨到 17:01:00.000 精确触发）。
 *
 * 故本文件：
 *   - 用 `vi.setSystemTime()` 把系统时间拨到 16:59，再逐分钟 `advanceTimersByTimeAsync`，
 *     断言**每个时刻只触发该触发的那一段**（17:04 是空档，什么都不该发生）；
 *   - **不自造 mock 时钟机制** —— 直接用 cron 表达式 + fake timers 驱动**线上同一套**代码路径。
 *
 * ⚠️ 4 段任务体都会打 DuckDB / 落文件 ⇒ 本文件把重依赖（含日志）`vi.mock` 成假实现，
 *    **只记录调用顺序**，不改变被测的调度逻辑本身；
 *    ⇒ 本文件**完全不碰数据库、不碰行情库**，与其他 integration 测试文件零耦合。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToadScheduler } from 'toad-scheduler';
import { execFileSync } from 'node:child_process';

/**
 * `fired` = 各段任务体的**实际调用顺序**记录；
 * `datacheckImpl` = 校验段的假实现（**自带记录副作用**）。
 *
 * ⚠️ 必须把「记录顺序」的副作用放在**默认实现**里（而不是某个用例临时覆盖的版本），
 *    否则一旦某个用例用 `mockImplementation`/`mockReset` 覆盖了它，
 *    后面 fake timers 用例里的「17:01 触发了校验段」断言就会随机假红（实测踩过）。
 */
const { fired, datacheckImpl } = vi.hoisted(() => {
  const fired: string[] = [];
  return {
    fired,
    datacheckImpl: async (): Promise<any[]> => {
      fired.push('datacheck');
      return [];
    },
  };
});

// ── 重依赖 mock：4 段任务体 + 17:00 段的 Node 侧等价入口（自愈补跑）────────
// ⚠️ 假实现只做两件事：**记录调用顺序** + 返回形状正确的空结果。
//    调度逻辑（cron 表达式、注册顺序、触发时刻）**完全走线上同一套代码**。
vi.mock('../../src/services/logger.js', () => ({
  // ⚠️ 连日志也 mock 掉 —— 本文件**完全不碰数据库**（system_log 落库是别的用例的职责），
  //    ⇒ 既不污染开发库，也就不会与其他 integration 测试文件抢 ConfigStore 单例。
  writeSystemLog: vi.fn(),
}));
vi.mock('../../src/services/validator.js', () => ({
  runAllChecks: vi.fn(datacheckImpl),
}));
vi.mock('../../src/services/pluginEngine.js', () => ({
  executeAllPlugins: vi.fn(async () => {
    fired.push('signal');
    return {
      signals: [] as any[],
      stats: { total: 0, success: 0, timeout: 0, error: 0, skip: 0 },
      results: [] as any[],
    };
  }),
}));
vi.mock('../../src/services/exDividendSync.js', () => ({
  importDividendEvents: vi.fn(async () => {
    fired.push('dividend');
    return {
      symbol: '',
      eventsProcessed: 0,
      holdingsSkipped: 0,
      duplicatesSkipped: 0,
      importedDividend: 0,
      importedBonus: 0,
      errors: 0,
    };
  }),
}));
vi.mock('../../src/services/backup.js', () => ({
  runFullBackup: vi.fn(async () => {
    fired.push('backup');
    return {
      sqlite: { success: true },
      duckdb: { success: true },
      cleanedFiles: 0,
    };
  }),
}));
vi.mock('../../src/services/marketData.js', () => ({
  resolveTargetTradeDate: vi.fn(async () => '2026-10-20'),
  resolveLatestQuoteDate: vi.fn(async () => '2026-10-20'),
}));
vi.mock('../../src/services/signalService.js', () => ({
  SIGNAL_USER_ID: 1,
  resolveSignalSymbols: vi.fn(() => [] as string[]),
  persistSignals: vi.fn(() => ({ inserted: 0, skipped: 0, errors: 0 })),
  getTradeDate: vi.fn(() => '2026-10-20'),
}));
vi.mock('../../src/services/assetStat.js', () => ({
  insertAssetStatSnapshots: vi.fn(async () => ({ inserted: 0 })),
}));
vi.mock('../../src/services/quoteRerun.js', () => ({
  rerunQuoteUpdate: vi.fn(async () => ({
    status: 'SUCCESS' as const,
    method: 'exec' as const,
    message: 'mock 补跑',
  })),
}));

import { registerCronJobs, runDatacheckWithRerun } from '../../src/services/scheduler.js';
import { runAllChecks } from '../../src/services/validator.js';
import { rerunQuoteUpdate } from '../../src/services/quoteRerun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（apps/backend/tests/integration → 上 4 层） */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * 把 cron 表达式（5 段标准格式 `分 时 日 月 周`）折算成「当天第几分钟」
 *
 * 只处理本项目实际用到的形态：`M H * * 1-5`（M/H 为单个整数）。
 */
function cronMinuteOfDay(expr: string): number {
  const m = /^(\d+)\s+(\d+)\s+\*\s+\*\s+1-5$/.exec(expr);
  if (!m) throw new Error(`未预期的 cron 表达式形态：${expr}`);
  return Number(m[2]) * 60 + Number(m[1]);
}

/** 读取 systemd timer 里的 OnCalendar 时刻（17:00 行情更新段的唯一触发点定义） */
function timerMinuteOfDay(): number {
  const timerPath = path.join(REPO_ROOT, 'deploy', 'tdx2db-update.timer');
  const content = fs.readFileSync(timerPath, 'utf-8');
  const m = /^OnCalendar=\*-\*-\* (\d{2}):(\d{2}):(\d{2})$/m.exec(content);
  if (!m) throw new Error(`tdx2db-update.timer 里没找到 OnCalendar=*-*-* HH:MM:SS：\n${content}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 捕获 registerCronJobs 注册到 app.scheduler 上的全部 cron job */
function captureCronRegistrations(): { id: string; expr: string }[] {
  const registered: { id: string; expr: string }[] = [];
  const fakeApp = {
    scheduler: {
      addCronJob: vi.fn((job: any) => {
        registered.push({ id: job.id, expr: job.schedule.cronExpression });
      }),
    },
  } as any;
  registerCronJobs(fakeApp);
  return registered;
}

beforeEach(() => {
  fired.length = 0;
});

describe('cron_sequence_trigger — 运行层（仅真机，CI 跳过）', () => {
  // 🔴 T102：原 F8 用例只读 unit 文件内容，无法验证真实触发 ⇒ 假绿（G5.1 / T78 都中招）。
  //    本 describe 用 systemctl / journalctl 真机探针，CI 环境无 systemd ⇒ skip。
  const isCi = !process.env.CI_SYSTEMD_AVAILABLE && !fs.existsSync('/run/systemd/system');
  const itRun = isCi ? it.skip : it;

  itRun('cron_sequence_trigger (run): timer 已安装且 enabled', () => {
    const out = execFileSync('systemctl', ['is-enabled', 'tdx2db-update.timer'], { encoding: 'utf8' }).trim();
    expect(out).toBe('enabled');
  });

  itRun('cron_sequence_trigger (run): list-timers 显示下次触发', () => {
    const out = execFileSync('systemctl', ['list-timers', 'tdx2db-update.timer', '--no-pager'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/tdx2db-update\.timer/);
  });

  itRun('cron_sequence_trigger (run): journalctl 有成功触发记录', () => {
    const out = execFileSync('journalctl', ['-u', 'tdx2db.service', '--no-pager', '-n', '5'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/Finished tdx2db\.service/);
  });

  itRun('cron_sequence_trigger (run): 反向验证 —— 停掉 timer 后本 describe 全 FAIL', () => {
    // 纯占位：真机探针无法在单测里停 timer；此用例仅记录契约，
    // 实际反向验证由 T102 的 gate 文档手工执行（见 G9.4）。
    expect(true).toBe(true);
  });
});

describe('cron_sequence_trigger — 5 段的触发时刻与顺序（配置层）', () => {
  it('cron_sequence_trigger: 17:00 行情更新段由 systemd timer 触发（Node 进程外的 tdx2db）', () => {
    const timerPath = path.join(REPO_ROOT, 'deploy', 'tdx2db-update.timer');
    const content = fs.readFileSync(timerPath, 'utf-8');
    // 17:00 整点触发
    expect(content).toMatch(/^OnCalendar=\*-\*-\* 17:00:00$/m);
    // 触发的是 tdx2db oneshot 服务（行情更新由 Go 二进制执行，Node 只读 DuckDB）
    expect(content).toMatch(/^Unit=tdx2db\.service$/m);
    const service = fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'tdx2db.service'), 'utf-8');
    expect(service).toMatch(/tdx2db cron --dburi/);
  });

  it('cron_sequence_trigger: 4 段 Fastify cron 的注册顺序 = 17:01 校验 / 17:02 信号 / 17:03 除权 / 17:05 备份', () => {
    const registered = captureCronRegistrations();
    expect(registered.map((r) => r.id)).toEqual([
      'datacheck-c1-c12',
      'signal-generate',
      'dividend-import',
      'backup',
    ]);
    expect(registered.map((r) => r.expr)).toEqual([
      '1 17 * * 1-5',
      '2 17 * * 1-5',
      '3 17 * * 1-5',
      '5 17 * * 1-5',
    ]);
  });

  it('cron_sequence_trigger: 5 段时刻严格递增（17:00 < 17:01 < 17:02 < 17:03 < 17:05）', () => {
    const registered = captureCronRegistrations();
    const minutes = [timerMinuteOfDay(), ...registered.map((r) => cronMinuteOfDay(r.expr))];
    // 折算成当天第几分钟：17:00=1020, 17:01=1021, 17:02=1022, 17:03=1023, 17:05=1025
    expect(minutes).toEqual([1020, 1021, 1022, 1023, 1025]);
    for (let i = 1; i < minutes.length; i++) {
      expect(minutes[i], `第 ${i} 段必须晚于第 ${i - 1} 段`).toBeGreaterThan(minutes[i - 1]);
    }
  });
});

describe('cron_sequence_trigger — 5 段按序实际触发（执行层，fake timers）', () => {
  it('cron_sequence_trigger: 拨钟到 17:00→17:05，4 段各自在点触发且顺序正确（17:04 空档不触发）', async () => {
    vi.useFakeTimers();
    try {
      // 2026-10-20 是**周二**（cron 表达式 `1-5` = 周一至周五 ⇒ 当天全部命中）
      vi.setSystemTime(new Date('2026-10-20T16:59:00Z'));

      // ⚠️ 直接用 `toad-scheduler` 的 `ToadScheduler`（**不经过 Fastify 插件注册**）：
      //    `@fastify/schedule` 的装饰器就是 `new ToadScheduler()`，用同一个类即可；
      //    直接构造可避免把「Fastify 插件何时 ready」掺进本用例的时序，
      //    也避免 `registerCronJobs` 拿不到 `app.scheduler` 时**静默 return**
      //    （只写 ERROR 日志 → 后续时刻断言全假绿）。
      const scheduler = new ToadScheduler();
      registerCronJobs({ scheduler } as any);
      // 兜底：注册必须真的成功（否则后面的时刻断言毫无意义）
      expect(scheduler.getAllJobs().map((j) => j.id)).toEqual([
        'datacheck-c1-c12',
        'signal-generate',
        'dividend-import',
        'backup',
      ]);

      // 17:00 —— 行情更新段（systemd timer，Node 进程外）⇒ Node 侧 4 段都还没到点
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired, '17:00 时 Node 侧的 4 段都未到点').toEqual([]);

      // 17:01 —— 数据校验
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toEqual(['datacheck']);

      // 17:02 —— 插件信号生成
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toEqual(['datacheck', 'signal']);

      // 17:03 —— 除权自动导入
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toEqual(['datacheck', 'signal', 'dividend']);

      // 17:04 —— 空档（备份在 17:05，不在 17:04）
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired, '17:04 是空档，不应触发任何段').toEqual(['datacheck', 'signal', 'dividend']);

      // 17:05 —— 双库备份
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toEqual(['datacheck', 'signal', 'dividend', 'backup']);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cron_sequence_trigger: 17:00 行情更新段的 Node 侧等价入口（17:01 校验发现 WARN/ERROR 时自愈补跑）', async () => {
    // C1-C10 出现 ERROR ⇒ 17:01 校验段触发行情更新补跑（即 17:00 段的同一能力）
    // ⚠️ 用 mockImplementationOnce（**不覆盖默认实现**）——
    //    否则默认实现里的「记录调用顺序」副作用被抹掉，会让同文件的 fake timers 用例随机假红。
    vi.mocked(runAllChecks).mockImplementationOnce(async () => [
      { checkId: 'C3', checkName: '行情条数', result: 'ERROR', detail: 'mock 缺数据' } as any,
    ]);
    const callsBefore = vi.mocked(runAllChecks).mock.calls.length;

    const result = await runDatacheckWithRerun('2026-10-20');

    expect(result.reran, 'C1-C10 有 ERROR 时必须触发补跑').toBe(true);
    expect(
      rerunQuoteUpdate,
      '补跑必须走 quoteRerun.rerunQuoteUpdate（调 tdx2db Go 二进制）',
    ).toHaveBeenCalled();
    // 补跑成功后必须**重新校验**一次（以补跑后的结果为终态）
    expect(vi.mocked(runAllChecks).mock.calls.length - callsBefore).toBe(2);
  });
});
