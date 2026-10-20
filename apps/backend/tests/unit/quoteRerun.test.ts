/**
 * quoteRerun.test.ts — 单元测试 G3a WARN 自动补跑链路
 *
 * 覆盖 src/services/quoteRerun.ts 的降级链：
 *   - systemd-run 成功 → SUCCESS / method=systemd-run
 *   - systemd-run 失败 → 降级 systemctl
 *   - systemd-run + systemctl 都失败 → 降级直接 exec
 *   - 三条通道都不可用（ENOENT）→ SKIP，不抛错
 *
 * 以及 src/services/scheduler.ts 的 runDatacheckWithRerun 判定：
 *   - 全 PASS → 不触发补跑
 *   - C11/C12 SKIP/WARN → 不触发补跑（外部源问题补跑行情没用）
 *   - C1-C10 WARN → 触发补跑 + 重新校验
 *   - C1-C10 ERROR → 触发补跑（优先级更高）
 *   - 补跑 SKIP → 保留首轮结果且 rerunOk=false
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// execFile 被 promisify 包装后以 (file, args, options, callback) 调用
const h = vi.hoisted(() => ({
  execImpl: (_f: string, _a: string[], _cb: (e: any, o?: string, e2?: string) => void) => {
    _cb(null, '', '');
  },
}));

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

beforeEach(() => {
  // ⚠️ T81：必须还原上一用例留下的 spy（vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate') /
  //    vi.spyOn(validatorNs, 'runAllChecks')），否则后跑的用例会命中上一个用例的
  //    mock 实现（表现为「降级链」用例拿到 SKIP / 二次校验拿到旧结果）。
  vi.restoreAllMocks();
  h.execImpl = (_f, _a, cb) => cb(null, '', '');
  logMock.mockReset();
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

describe('scheduler.runDatacheckWithRerun — 补跑触发判定', () => {
  it('C1-C10 全 PASS + C11/C12 SKIP → 不触发补跑', async () => {
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
    expect(out.summaries.length).toBe(5);
    expect(rerunSpy).not.toHaveBeenCalled();
  });

  it('只有 C11 WARN（外部源）→ 不触发补跑', async () => {
    const rerunSpy = vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate');
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([
      summary('C1', 'PASS'),
      summary('C11', 'WARN'),
    ] as any);

    const out = await runDatacheckWithRerun('2026-10-16');
    expect(out.reran).toBe(false);
    expect(rerunSpy).not.toHaveBeenCalled();
  });

  it('C1 WARN → 触发补跑；补跑成功后二次校验，以二次结果为准', async () => {
    const rerunSpy = vi
      .spyOn(quoteRerunNs, 'rerunQuoteUpdate')
      .mockResolvedValue({ status: 'SUCCESS', method: 'exec', exitCode: 0, message: 'ok' });

    const runSpy = vi
      .spyOn(validatorNs, 'runAllChecks')
      .mockResolvedValueOnce([summary('C1', 'WARN')] as any)
      .mockResolvedValueOnce([summary('C1', 'PASS')] as any);

    const out = await runDatacheckWithRerun('2026-10-16');
    expect(rerunSpy).toHaveBeenCalledTimes(1);
    expect(rerunSpy.mock.calls[0][0]).toContain('WARN');
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(out.reran).toBe(true);
    expect(out.rerunOk).toBe(true);
    expect(out.summaries[0].result).toBe('PASS');
  });

  it('C1 ERROR → 触发补跑，reason 标为 ERROR', async () => {
    const rerunSpy = vi
      .spyOn(quoteRerunNs, 'rerunQuoteUpdate')
      .mockResolvedValue({ status: 'SUCCESS', method: 'systemd-run', exitCode: 0, message: 'ok' });
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([summary('C2', 'ERROR')] as any);

    await runDatacheckWithRerun('2026-10-16');
    expect(rerunSpy).toHaveBeenCalledTimes(1);
    expect(rerunSpy.mock.calls[0][0]).toContain('ERROR');
  });

  it('补跑返回 SKIP → 不二次校验，保留首轮结果且 rerunOk=false', async () => {
    vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate').mockResolvedValue({
      status: 'SKIP',
      method: 'none',
      message: '不可用',
    });
    const runSpy = vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([summary('C1', 'WARN')] as any);

    const out = await runDatacheckWithRerun('2026-10-16');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(out.reran).toBe(false);
    expect(out.rerunOk).toBe(false);
    expect(out.summaries[0].result).toBe('WARN');
  });

  it('补跑成功但二次仍 WARN → 终态保持 WARN 并写 WARN 明细', async () => {
    vi.spyOn(quoteRerunNs, 'rerunQuoteUpdate').mockResolvedValue({
      status: 'SUCCESS',
      method: 'exec',
      exitCode: 0,
      message: 'ok',
    });
    vi.spyOn(validatorNs, 'runAllChecks')
      .mockResolvedValueOnce([summary('C1', 'WARN')] as any)
      .mockResolvedValueOnce([summary('C1', 'WARN')] as any);

    const out = await runDatacheckWithRerun('2026-10-16');
    expect(out.summaries[0].result).toBe('WARN');
    const warnLogs = logMock.mock.calls.filter((c) => c[0]?.message?.includes('补跑后重新校验'));
    expect(warnLogs.length).toBe(1);
    expect(warnLogs[0][0].level).toBe('WARN');
    expect(warnLogs[0][0].detail).toContain('二次仍 WARN');
  });
});
