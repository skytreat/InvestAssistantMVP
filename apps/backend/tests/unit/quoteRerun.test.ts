/**
 * quoteRerun.test.ts — 补跑降级链 + ADR-018「WARN/ERROR 不再自动补跑」+ 空跑指纹
 *
 * 覆盖 src/services/quoteRerun.ts 的降级链：
 *   - systemd-run 成功 → SUCCESS / method=systemd-run
 *   - systemd-run 失败 → 降级 systemctl
 *   - systemd-run + systemctl 都失败 → 降级直接 exec
 *   - 三条通道都不可用（ENOENT）→ SKIP，不抛错
 *   - 传入 date 时补跑前后取指纹，`effective` 区分「有变化」/「空跑」/「未采集」
 *
 * 以及 src/services/scheduler.ts 的 runDatacheckWithRerun 判定（ADR-018）：
 *   - 全 PASS → 不补跑
 *   - C11/C12 SKIP/WARN → 不补跑（外部源问题补跑行情没用）
 *   - C1-C10 WARN/ERROR → **也不补跑**（tdx2db 增量语义下必为空跑）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // 补跑成功后要等 RETRY_SETTLE_MS；模块顶层常量在 import 时求值，
  // 故必须在 hoisted 阶段就把它压到 1ms，否则每个 SUCCESS 用例白等 3s。
  process.env.TDX2DB_RERUN_SETTLE_MS = '1';
  return {
    execImpl: (_f: string, _a: string[], _cb: (e: any, o?: string, e2?: string) => void) => {
      _cb(null, '', '');
    },
    fingerprint: {
      calls: 0,
      impl: async (): Promise<Record<string, unknown>[]> => [],
    },
  };
});

vi.mock('node:child_process', async () => {
  const util = await import('node:util');
  // Node 的 execFile 带 util.promisify.custom，resolve 的是 { stdout, stderr }
  // mock 必须复刻这个行为，否则调用方的解构拿不到值
  const execFile: any = (file: string, args: string[], _opts: any, cb: any) => h.execImpl(file, args, cb);
  execFile[util.promisify.custom] = (file: string, args: string[], opts: any) =>
    new Promise((resolve, reject) => {
      execFile(file, args, opts, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return {
    execFile,
    exec: (_f: string, _a: any, _o: any, cb: any) => cb?.(null, '', ''),
    execSync: () => '',
  };
});

vi.mock('../../src/services/logger.js', () => ({
  writeSystemLog: vi.fn(),
}));

import { rerunQuoteUpdate } from '../../src/services/quoteRerun.js';
import { writeSystemLog } from '../../src/services/logger.js';
import { runDatacheckWithRerun } from '../../src/services/scheduler.js';
import * as validatorNs from '../../src/services/validator.js';
import * as quoteRerunNs from '../../src/services/quoteRerun.js';
import * as duckdbNs from '../../src/db/duckdb.js';

const logMock = writeSystemLog as unknown as ReturnType<typeof vi.fn>;

/** 所有子进程都失败 → 走完整降级链最终 SKIP */
function allExecFail(): void {
  h.execImpl = (_f, _a, cb) => {
    const err: any = new Error('spawn ENOENT');
    err.code = 'ENOENT';
    cb(err);
  };
}

/** systemd-run 成功，其余不调用 */
function systemdRunOk(): void {
  h.execImpl = (file, _a, cb) => {
    if (file === 'systemd-run') cb(null, 'rerun done', '');
    else cb(new Error('should not be called'));
  };
}

function summary(checkId: string, result: string) {
  return { checkId, result, durationMs: 1, detail: 'mock detail' } as any;
}

function fingerprintRow(hash: string) {
  return {
    kline_rows: 10,
    kline_hash: hash,
    basic_rows: 10,
    basic_hash: hash,
    factor_rows: 0,
    factor_hash: '0',
  };
}

beforeEach(() => {
  // ⚠️ T81：必须还原上一用例留下的 spy（vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate') /
  //    vi.spyOn(validatorNs, 'runAllChecks')），否则后跑的用例会命中上一个用例的
  //    mock 实现（表现为「降级链」用例拿到 SKIP / 二次校验拿到旧结果）。
  vi.restoreAllMocks();
  h.execImpl = (_f, _a, cb) => cb(null, '', '');
  h.fingerprint.calls = 0;
  h.fingerprint.impl = async () => [];
  vi.spyOn(duckdbNs, 'queryDuckDB').mockImplementation(async () => {
    h.fingerprint.calls += 1;
    return h.fingerprint.impl();
  });
  logMock.mockReset();
  // 测试中始终启用 systemd-run 通道（默认生产环境跳过）
  process.env.TDX2DB_SKIP_SYSTEMD_RUN = '0';
});

describe('quoteRerun — 降级链', () => {
  it('systemd-run 成功 → SUCCESS 且 method=systemd-run', async () => {
    systemdRunOk();
    const result = await rerunQuoteUpdate('单测触发');
    expect(result.status).toBe('SUCCESS');
    expect(result.method).toBe('systemd-run');
  });

  it('systemd-run 失败 → 降级到 systemctl（async 轮询到 inactive）', async () => {
    h.execImpl = (file, _a, cb) => {
      if (file === 'systemd-run') return cb(new Error('no such unit'));
      if (file === 'systemctl' && _a[0] === 'start') return cb(null, '', '');
      if (file === 'systemctl' && _a[0] === 'show') return cb(null, 'inactive\n0\n', '');
      cb(new Error('unexpected'));
    };
    const result = await rerunQuoteUpdate('单测降级');
    expect(result.status).toBe('SUCCESS');
    expect(result.method).toBe('systemctl');
  }, 20000);

  it('systemd + systemctl 都失败 → 降级直接 exec tdx2db', async () => {
    h.execImpl = (file, _a, cb) => {
      if (file === 'tdx2db' || file.includes('tdx2db')) return cb(null, 'cron ok', '');
      cb(new Error('unavailable'));
    };
    const result = await rerunQuoteUpdate('单测降级 2');
    expect(result.status).toBe('SUCCESS');
    expect(result.method).toBe('exec');
  });

  it('三条通道都不可用（ENOENT）→ SKIP 而不是抛错（本地开发常态）', async () => {
    allExecFail();
    const result = await rerunQuoteUpdate('无二进制环境');
    expect(result.status).toBe('SKIP');
    expect(result.method).toBe('none');
    const skipLogs = logMock.mock.calls.filter((c) => c[0]?.level === 'SKIP');
    expect(skipLogs.length).toBeGreaterThan(0);
  });

  it('必定写一条「触发行情更新补跑」原因日志', async () => {
    systemdRunOk();
    await rerunQuoteUpdate('reason-for-test');
    const triggered = logMock.mock.calls.filter((c) => c[0]?.message?.includes('触发行情更新补跑'));
    expect(triggered.length).toBe(1);
    expect(triggered[0][0].message).toContain('reason-for-test');
  });
});

describe('quoteRerun — 数据指纹与空跑判定（ADR-018）', () => {
  it('未传 date → 不采集指纹，effective=null', async () => {
    systemdRunOk();
    const result = await rerunQuoteUpdate('无日期');
    expect(result.status).toBe('SUCCESS');
    expect(result.effective).toBeNull();
    expect(h.fingerprint.calls).toBe(0);
  });

  it('前后指纹一致 → effective=false，并写「空跑」WARN 日志', async () => {
    systemdRunOk();
    h.fingerprint.impl = async () => [fingerprintRow('111')];

    const result = await rerunQuoteUpdate('空跑用例', { date: '2026-10-16' });

    expect(result.status).toBe('SUCCESS');
    expect(result.effective).toBe(false);
    expect(h.fingerprint.calls).toBe(2);
    const log = logMock.mock.calls.find((c) => c[0]?.message?.includes('无变化（空跑）'));
    expect(log?.[0].level).toBe('WARN');
  });

  it('前后指纹变化 → effective=true', async () => {
    systemdRunOk();
    let n = 0;
    h.fingerprint.impl = async () => [fingerprintRow(n++ === 0 ? '111' : '222')];

    const result = await rerunQuoteUpdate('有变化用例', { date: '2026-10-16' });

    expect(result.effective).toBe(true);
    expect(logMock.mock.calls.some((c) => c[0]?.message?.includes('数据有变化'))).toBe(true);
  });

  it('指纹查询失败 → effective=null，不影响补跑本身', async () => {
    systemdRunOk();
    h.fingerprint.impl = async () => {
      throw new Error('no duckdb');
    };

    const result = await rerunQuoteUpdate('指纹失败', { date: '2026-10-16' });

    expect(result.status).toBe('SUCCESS');
    expect(result.effective).toBeNull();
  });
});

describe('scheduler.runDatacheckWithRerun — ADR-018 不补跑', () => {
  it('C1-C10 全 PASS + C11/C12 SKIP → 不补跑', async () => {
    const rerunSpy = vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate');
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([
      summary('C1', 'PASS'),
      summary('C2', 'PASS'),
      summary('C10', 'PASS'),
      summary('C11', 'SKIP'),
      summary('C12', 'SKIP'),
    ] as any);

    const out = await runDatacheckWithRerun('2026-10-16');
    expect(out.reran).toBe(false);
    expect(out.rerunOk).toBe(true);
    expect(out.rerunSkippedReason).toBeUndefined();
    expect(out.summaries.length).toBe(5);
    expect(rerunSpy).not.toHaveBeenCalled();
  });

  it('只有 C11 WARN（外部源）→ 不补跑', async () => {
    const rerunSpy = vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate');
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([
      summary('C1', 'PASS'),
      summary('C11', 'WARN'),
    ] as any);

    const out = await runDatacheckWithRerun('2026-10-16');
    expect(out.reran).toBe(false);
    expect(rerunSpy).not.toHaveBeenCalled();
  });

  it('C1 WARN → 不补跑、只跑一次校验，记录 noop-by-design', async () => {
    const rerunSpy = vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate');
    const runSpy = vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([summary('C1', 'WARN')] as any);

    const out = await runDatacheckWithRerun('2026-10-16');

    expect(rerunSpy).not.toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(out.reran).toBe(false);
    expect(out.rerunSkippedReason).toBe('noop-by-design');
    expect(out.summaries[0].result).toBe('WARN');
    const skipLog = logMock.mock.calls.find((c) => c[0]?.detail === 'rerun=skipped(noop-by-design)');
    expect(skipLog?.[0].level).toBe('WARN');
  });

  it('C2 ERROR → 同样不补跑，日志升级为 ERROR', async () => {
    const rerunSpy = vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate');
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([summary('C2', 'ERROR')] as any);

    const out = await runDatacheckWithRerun('2026-10-16');

    expect(rerunSpy).not.toHaveBeenCalled();
    expect(out.rerunSkippedReason).toBe('noop-by-design');
    const skipLog = logMock.mock.calls.find((c) => c[0]?.detail === 'rerun=skipped(noop-by-design)');
    expect(skipLog?.[0].level).toBe('ERROR');
  });
});
