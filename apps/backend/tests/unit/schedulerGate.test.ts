import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runScheduledDatacheck } from '../../src/services/scheduler.js';
import * as loggerNs from '../../src/services/logger.js';
import * as validatorNs from '../../src/services/validator.js';
import * as quoteStatusNs from '../../src/services/quoteUpdateStatus.js';
import * as marketNs from '../../src/services/marketData.js';
import * as rerunNs from '../../src/services/quoteRerun.js';
import * as duckdbNs from '../../src/db/duckdb.js';
import * as alertNs from '../../src/services/alert.js';

vi.mock('../../src/services/alert.js', () => ({
  sendWecomAlert: vi.fn(async () => ({ sent: true, reason: 'SENT' })),
}));

/**
 * T106：17:01 校验闸门语义。
 *
 * 关键契约：
 *   - 无行情数据时**跳过校验**（不产生假绿），但必须留下 ERROR 证据；
 *   - 更新失败 / 未触发 ≠ 校验通过；
 *   - 更新「成功」但无数据 → 先补跑，补跑后仍无数据 → ERROR。
 */

type Status = Awaited<ReturnType<typeof quoteStatusNs.reportTdx2dbRunOutcome>>;

function status(state: Status['state'], message = `mock ${state}`): Status {
  return { state, message };
}

function logs(): Array<{ logType: string; level: string; message: string }> {
  return vi.mocked(loggerNs.writeSystemLog).mock.calls.map((c) => c[0] as any);
}

beforeEach(() => {
  vi.spyOn(loggerNs, 'writeSystemLog').mockImplementation(() => {});
  vi.mocked(alertNs.sendWecomAlert).mockClear();
  vi.spyOn(duckdbNs, 'isDuckDBWriteSentinelPresent').mockReturnValue(false);
  vi.spyOn(marketNs, 'resolveTargetTradeDate').mockResolvedValue('2026-10-23');
  vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([]);
  vi.spyOn(validatorNs, 'hasQuoteDataOn').mockResolvedValue(true);
  vi.spyOn(rerunNs, 'rerunQuoteUpdate').mockResolvedValue({
    status: 'SUCCESS',
    method: 'exec',
    message: 'mock rerun ok',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDX2DB_SENTINEL_WAIT_MS;
  delete process.env.TDX2DB_SENTINEL_POLL_MS;
});

describe('T106 校验闸门', () => {
  it('更新失败 + 无数据 → 跳过校验且写 ERROR（不再出现 ERROR=0 WARN=0 假健康）', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('FAIL'));
    vi.spyOn(validatorNs, 'hasQuoteDataOn').mockResolvedValue(false);

    const result = await runScheduledDatacheck();

    expect(result.action).toBe('UPDATE_FAILED');
    expect(validatorNs.runAllChecks).not.toHaveBeenCalled();
    expect(rerunNs.rerunQuoteUpdate).not.toHaveBeenCalled();
    const err = logs().find((l) => l.logType === 'datacheck' && l.level === 'ERROR');
    expect(err?.message).toContain('行情更新未生效');
    expect(alertNs.sendWecomAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-10-23',
        kind: 'quote_chain_failed',
        title: expect.stringContaining('更新未生效'),
        lines: expect.arrayContaining([expect.stringContaining('状态：FAIL')]),
      }),
    );
  });

  it('更新未触发 + 无数据 → UPDATE_FAILED', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('NOT_RUN'));
    vi.spyOn(validatorNs, 'hasQuoteDataOn').mockResolvedValue(false);

    const result = await runScheduledDatacheck();
    expect(result.action).toBe('UPDATE_FAILED');
    expect(validatorNs.runAllChecks).not.toHaveBeenCalled();
  });

  it('更新仍在运行 → 跳过且 WARN', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('RUNNING'));

    const result = await runScheduledDatacheck();
    expect(result.action).toBe('UPDATE_RUNNING');
    expect(validatorNs.runAllChecks).not.toHaveBeenCalled();
    expect(logs().some((l) => l.level === 'WARN' && l.message.includes('仍在运行'))).toBe(true);
  });

  it('更新成功 + 无数据 → 补跑一次；补跑后有数据则继续校验', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));
    vi.spyOn(validatorNs, 'hasQuoteDataOn').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.spyOn(rerunNs, 'rerunQuoteUpdate').mockResolvedValue({
      status: 'SUCCESS',
      method: 'exec',
      message: 'mock rerun ok',
      effective: false,
    });

    const result = await runScheduledDatacheck();

    expect(result.action).toBe('CHECKED');
    expect(rerunNs.rerunQuoteUpdate).toHaveBeenCalledTimes(1);
    expect(rerunNs.rerunQuoteUpdate).toHaveBeenCalledWith(
      expect.stringContaining('2026-10-23'),
      expect.objectContaining({ date: '2026-10-23' }),
    );
    // 补跑前后指纹一致 → 透传空跑结论，便于管理端/日志判定补跑是否白跑
    expect(result.rerunEffective).toBe(false);
    expect(validatorNs.runAllChecks).toHaveBeenCalledTimes(1);
  });

  it('校验存在 WARN/ERROR → 不再补跑（ADR-018），只跑一次校验', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([
      { checkId: 'C1', name: 'C1', result: 'WARN', message: 'warn', detail: 'warn' },
    ] as any);

    const result = await runScheduledDatacheck();

    expect(result.action).toBe('CHECKED');
    expect(rerunNs.rerunQuoteUpdate).not.toHaveBeenCalled();
    expect(result.reran).toBe(false);
    expect(result.rerunSkippedReason).toBe('noop-by-design');
    expect(validatorNs.runAllChecks).toHaveBeenCalledTimes(1);
  });

  it('更新成功 + 无数据 → 补跑成功但仍无数据 → ERROR 且不跑校验', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));
    vi.spyOn(validatorNs, 'hasQuoteDataOn').mockResolvedValue(false);

    const result = await runScheduledDatacheck();

    expect(result.action).toBe('NO_DATA_AFTER_RERUN');
    expect(rerunNs.rerunQuoteUpdate).toHaveBeenCalledTimes(1);
    expect(validatorNs.runAllChecks).not.toHaveBeenCalled();
    const err = logs().find((l) => l.logType === 'datacheck' && l.level === 'ERROR');
    expect(err?.message).toContain('仍无行情数据');
  });

  it('更新成功 + 无数据 → 补跑失败 → ERROR 且不跑校验', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));
    vi.spyOn(validatorNs, 'hasQuoteDataOn').mockResolvedValue(false);
    vi.spyOn(rerunNs, 'rerunQuoteUpdate').mockResolvedValue({
      status: 'FAIL',
      method: 'none',
      message: 'no channel',
    });

    const result = await runScheduledDatacheck();
    expect(result.action).toBe('NO_DATA_AFTER_RERUN');
    expect(result.rerunOk).toBe(false);
    expect(validatorNs.runAllChecks).not.toHaveBeenCalled();
  });

  it('更新成功 + 有数据 → 直接校验，不补跑', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));

    const result = await runScheduledDatacheck();
    expect(result.action).toBe('CHECKED');
    expect(validatorNs.runAllChecks).toHaveBeenCalledTimes(1);
    expect(rerunNs.rerunQuoteUpdate).not.toHaveBeenCalled();
  });

  it('更新失败但有数据（部分落库）→ 仍然校验，让校验结果暴露问题', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('FAIL'));

    const result = await runScheduledDatacheck();
    expect(result.action).toBe('CHECKED');
    expect(validatorNs.runAllChecks).toHaveBeenCalledTimes(1);
    expect(alertNs.sendWecomAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('更新结果异常') }),
    );
  });

  it('校验出现 ERROR → 推送企业微信告警（含 ERROR 项）', async () => {
    vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));
    vi.spyOn(validatorNs, 'runAllChecks').mockResolvedValue([
      { checkId: 'C1', name: 'C1', result: 'ERROR', message: 'missing', detail: 'no rows' },
    ] as any);

    const result = await runScheduledDatacheck();

    expect(result.action).toBe('CHECKED');
    expect(alertNs.sendWecomAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-10-23',
        kind: 'quote_chain_failed',
        title: expect.stringContaining('数据校验未通过'),
        lines: expect.arrayContaining([expect.stringContaining('C1')]),
      }),
    );
  });

  it('等哨兵超时 → WAIT_TIMEOUT，不写更新结果、不校验', async () => {
    process.env.TDX2DB_SENTINEL_WAIT_MS = '20';
    process.env.TDX2DB_SENTINEL_POLL_MS = '5';
    vi.spyOn(duckdbNs, 'isDuckDBWriteSentinelPresent').mockReturnValue(true);
    const reportSpy = vi.spyOn(quoteStatusNs, 'reportTdx2dbRunOutcome').mockResolvedValue(status('SUCCESS'));

    const result = await runScheduledDatacheck();
    expect(result.action).toBe('WAIT_TIMEOUT');
    expect(reportSpy).not.toHaveBeenCalled();
    expect(validatorNs.runAllChecks).not.toHaveBeenCalled();
    const updateLog = logs().find((l) => l.logType === 'tdx2db_update' && l.level === 'WARN');
    expect(updateLog?.message).toContain('未结束');
    expect(alertNs.sendWecomAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('写窗口超时') }),
    );
  });
});
