/**
 * broker_event_normalize.test.ts — T123（V3.1）事件归一化
 * 对应 SDD_v3 §4 / §12.1；gate 验收点①「40 种实测表述全部归一到 13 种之一」。
 * 载体 = tests/fixtures/broker-event-phrases.json（从 6 份脱敏样本提取的 40 个实测类别词）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeEvent, isExcludedFromSystemRecord } from '../../src/services/broker/eventNormalize.js';
import phrases from '../../../../tests/fixtures/broker-event-phrases.json';

const list = phrases.phrases as Array<{ raw: string; expect: string; crossBorder?: boolean; broker: string }>;

describe('T123 · 40 种实测表述全部归一（gate 验收点①）', () => {
  it('无 UNKNOWN', () => {
    expect(list).toHaveLength(40);
    for (const p of list) {
      const r = normalizeEvent(p.raw);
      expect(r.event_type, p.raw).toBe(p.expect);
      expect(r.event_type, p.raw).not.toBe('UNKNOWN');
      expect(r.raw_event_type, '原文保留').toBe(p.raw);
    }
  });

  it('跨境维度标记（策略适用品种用）', () => {
    for (const p of list.filter((x) => x.crossBorder)) {
      expect(normalizeEvent(p.raw).crossBorder, p.raw).toBe(true);
    }
    expect(normalizeEvent('上海跨市场股票ETF竞价买入').crossBorder).toBe(false); // 跨市场 ≠ 跨境
  });
});

describe('T123 · 排除项仍进事实层（§4.3 / INV 对账归因）', () => {
  it('场外 / 占位 / 忽略 三类有 exclude_reason，且 isExcludedFromSystemRecord=true', () => {
    const off = normalizeEvent('基金申购');
    expect(off.event_type).toBe('EXCLUDED_OFFEXCHANGE');
    expect(off.exclude_reason).toBeTruthy();
    expect(isExcludedFromSystemRecord(off)).toBe(true);
    const ph = normalizeEvent('指定');
    expect(isExcludedFromSystemRecord(ph)).toBe(true);
    const ign = normalizeEvent('股息税');
    expect(isExcludedFromSystemRecord(ign)).toBe(true);
  });

  it('REPO / CASH_LIKE_ETF 进系统记录（现金类资产），不被排除', () => {
    expect(isExcludedFromSystemRecord(normalizeEvent('融券'))).toBe(false);
    expect(isExcludedFromSystemRecord(normalizeEvent('上海货币ETF现金申购'))).toBe(false);
  });
});

describe('T123 · 未知表述保留原文（INV-S2-7，不得丢弃）', () => {
  it('未实测的长描述组合 → UNKNOWN + raw 保留', () => {
    const r = normalizeEvent('北京货币基金竞价买入');
    expect(r.event_type).toBe('UNKNOWN');
    expect(r.raw_event_type).toBe('北京货币基金竞价买入');
  });

  it('空串 → UNKNOWN', () => {
    expect(normalizeEvent('').event_type).toBe('UNKNOWN');
  });

  it('包裹残留（="..." / "..."）先剥再归一（幂等防回退）', () => {
    expect(normalizeEvent('="买入"').event_type).toBe('TRADE_BUY');
    expect(normalizeEvent('"融券"').event_type).toBe('REPO');
  });
});
