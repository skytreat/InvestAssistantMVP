/**
 * PA-08 写窗口守卫（方案 §7.1 / D1）
 *
 * 口径：**Asia/Shanghai** 工作日 17:00 ≤ t < 17:10 禁止回测批量任务。
 * 用固定 `Date`（UTC 表达）验证时区换算不会被宿主时区带偏。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  assertBacktestWriteWindowOpen,
  BacktestWriteWindowError,
  isInBacktestWriteWindow,
  shanghaiClock,
} from '../../src/services/backtest/writeWindow.js';

const origGuard = process.env.BACKTEST_WRITE_WINDOW_GUARD;

afterEach(() => {
  if (origGuard === undefined) delete process.env.BACKTEST_WRITE_WINDOW_GUARD;
  else process.env.BACKTEST_WRITE_WINDOW_GUARD = origGuard;
});

describe('时区换算', () => {
  it('UTC 09:05 → Asia/Shanghai 17:05（周一）', () => {
    const clock = shanghaiClock(new Date('2026-11-09T09:05:00Z'));
    expect(clock.weekday).toBe('Mon');
    expect(clock.minutes).toBe(17 * 60 + 5);
  });
});

describe('写窗口判定', () => {
  it('工作日 17:00 / 17:05 / 17:09 命中；17:10 与 16:59 不命中', () => {
    expect(isInBacktestWriteWindow(new Date('2026-11-09T09:00:00Z'))).toBe(true);
    expect(isInBacktestWriteWindow(new Date('2026-11-09T09:05:00Z'))).toBe(true);
    expect(isInBacktestWriteWindow(new Date('2026-11-09T09:09:00Z'))).toBe(true);
    expect(isInBacktestWriteWindow(new Date('2026-11-09T09:10:00Z'))).toBe(false);
    expect(isInBacktestWriteWindow(new Date('2026-11-09T08:59:00Z'))).toBe(false);
  });

  it('周末同一时刻不命中', () => {
    // 2026-11-14 是周六
    expect(isInBacktestWriteWindow(new Date('2026-11-14T09:05:00Z'))).toBe(false);
  });
});

describe('assertBacktestWriteWindowOpen', () => {
  it('命中窗口抛 BacktestWriteWindowError', () => {
    delete process.env.BACKTEST_WRITE_WINDOW_GUARD;
    expect(() => assertBacktestWriteWindowOpen(new Date('2026-11-09T09:05:00Z'))).toThrow(
      BacktestWriteWindowError,
    );
  });

  it('窗口外不抛', () => {
    delete process.env.BACKTEST_WRITE_WINDOW_GUARD;
    expect(() => assertBacktestWriteWindowOpen(new Date('2026-11-09T09:20:00Z'))).not.toThrow();
  });

  it('运维逃生阀 BACKTEST_WRITE_WINDOW_GUARD=off 可跳过', () => {
    process.env.BACKTEST_WRITE_WINDOW_GUARD = 'off';
    expect(() => assertBacktestWriteWindowOpen(new Date('2026-11-09T09:05:00Z'))).not.toThrow();
  });
});
