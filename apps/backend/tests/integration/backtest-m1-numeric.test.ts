/**
 * M1 锚点 —— 除权日复权连续性 / 停牌两形态（**数值型，迷你库即可**）
 *
 * 逐条对应 `docs/audit/proposal-strategy-backtest-framework.md` §10 的 M1 验收锚点 2、3：
 *   2. 除权日复权连续性：qfq 无跳空 / bfq 有跳空（sh510300 / sz159516 / sh515880 三例）
 *   3. 停牌两形态各 1 例（缺 bar / volume=0），且 `zeroVolumeSeries='drop'` 不自造 0 收益
 *
 * 🔴 **为什么这 6 条从真库降到迷你库**（2026-11-06 测试基建改造）：
 *   它们只断言**单只标的、具体日期上的一两个数值事实**（qfq 的 preclose == 前一日 close、
 *   bfq 的跳空幅度、某日 volume=0），**不含任何市场规模门槛** ⇒ 迷你库（真库的逐位一致子集）
 *   就够用。原先把它们与「673 只通过 / 140 组动态池」一起挂在 `scale` 守卫下，
 *   结果这 6 条也被迫读 1.24 GB 真库，白白贡献内存峰值。
 *
 * ⚠️ 断言**未做任何放宽** —— 与真库版逐条同值（数量、方向、阈值全部原样）。
 *   迷你夹具（`tests/fixtures/mini-market/`）已补齐这 5 只标的，且 window 前推到 2024-01
 *   以覆盖 sh510300 的 2024-01-18 除权日。
 *
 * ⚠️ 实测口径提醒（2026-11-06）：流动性窗口是 **截至 asOf 含当天** 的 3 个交易日
 *   （v5.2 的 `previous_date` 是运行时口径；回测引擎在 T 开盘前决策须传 `asOf = T-1`）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { marketDataUsableFor } from '../_marketData.js';

import type { Bar } from '../../src/services/backtest/types.js';
import type { TradingCalendar } from '../../src/services/backtest/calendar.js';

type PanelModule = typeof import('../../src/services/backtest/marketPanel.js');
type CalendarModule = typeof import('../../src/services/backtest/calendar.js');

let panel: PanelModule;
let calendar: TradingCalendar;

/** 数值型断言可跑？（迷你库即可 —— 迷你库是真库的逐位一致子集） */
const NUMERIC_READY = await marketDataUsableFor('numeric');

beforeAll(async () => {
  if (!NUMERIC_READY) return;
  panel = await import('../../src/services/backtest/marketPanel.js');
  const calendarModule: CalendarModule = await import('../../src/services/backtest/calendar.js');
  calendar = await calendarModule.loadTradingCalendar();
});

function seriesOf(bars: Map<string, Bar[]>, symbol: string): Bar[] {
  const s = bars.get(symbol);
  if (!s) throw new Error(`行情面板里没有 ${symbol}`);
  return s;
}

/* ─────────────────────────── 除权日复权连续性 ─────────────────────────── */

describe('M1 锚点 · 除权日复权连续性（qfq 连续 / bfq 跳空）', () => {
  /** 取某只票某窗口的序列 */
  async function fetchOne(symbol: string, start: string, end: string, adjust: 'qfq' | 'bfq') {
    const bars = await panel.getBars([symbol], start, end, { adjust });
    return seriesOf(bars, symbol);
  }

  /** bfq 在 exDate 的跳空幅度（preclose 相对前一交易日 close） */
  function bfqGap(bars: Bar[], exDate: string): number {
    const i = bars.findIndex((b) => b.date === exDate);
    expect(i).toBeGreaterThan(0);
    return bars[i].preclose / bars[i - 1].close - 1;
  }

  it.skipIf(!NUMERIC_READY)('sh510300 2024-01-18：qfq 连续、bfq 约 -2.1% 跳空', async () => {
    const start = '2024-01-16';
    const end = '2024-01-22';
    const qfq = await fetchOne('sh510300', start, end, 'qfq');
    const bfq = await fetchOne('sh510300', start, end, 'bfq');

    // qfq：2024-01-18 的 preclose == 2024-01-17 的 close（无跳空，收益连续）
    const qfqIdx = qfq.findIndex((b) => b.date === '2024-01-18');
    expect(qfqIdx).toBeGreaterThan(0);
    expect(qfq[qfqIdx].preclose).toBeCloseTo(qfq[qfqIdx - 1].close, 6);

    // bfq：preclose 带除权修正 ⇒ 与前一交易日 close 之间有 -2.1% 的口径缺口
    expect(bfqGap(bfq, '2024-01-18')).toBeLessThan(-0.01);
  });

  it.skipIf(!NUMERIC_READY)('sz159516 拆股：bfq 缺口落在 2026-03-30（非 03-31），qfq 两日均连续', async () => {
    const start = '2026-03-26';
    const end = '2026-04-02';
    const qfq = await fetchOne('sz159516', start, end, 'qfq');
    const bfq = await fetchOne('sz159516', start, end, 'bfq');

    // 实测：1:2 拆分生效日 = 2026-03-30（bfq preclose 0.83 vs 前一交易日 close 1.66）
    // ⇒ 锚点里写的 2026-03-31 在该数据源上不是拆股日（当日 qfq/bfq 都连续）
    expect(bfqGap(bfq, '2026-03-30')).toBeLessThan(-0.4);
    for (const d of ['2026-03-30', '2026-03-31']) {
      const i = qfq.findIndex((b) => b.date === d);
      expect(i).toBeGreaterThan(0);
      expect(qfq[i].preclose).toBeCloseTo(qfq[i - 1].close, 6);
    }
  });

  it.skipIf(!NUMERIC_READY)('sh515880 2026-07-06：qfq 连续、bfq 约 -50% 跳空', async () => {
    const start = '2026-07-02';
    const end = '2026-07-08';
    const qfq = await fetchOne('sh515880', start, end, 'qfq');
    const bfq = await fetchOne('sh515880', start, end, 'bfq');

    const i = qfq.findIndex((b) => b.date === '2026-07-06');
    expect(i).toBeGreaterThan(0);
    expect(qfq[i].preclose).toBeCloseTo(qfq[i - 1].close, 6);
    expect(bfqGap(bfq, '2026-07-06')).toBeLessThan(-0.4);
  });
});

/* ─────────────────────────── 停牌两形态 ─────────────────────────── */

describe('M1 锚点 · 停牌两形态', () => {
  it.skipIf(!NUMERIC_READY)('形态① 缺 bar：sz159972 在 2026-09-28 无 bar（当日是交易日）', async () => {
    expect(calendar.has('2026-09-28')).toBe(true);
    const bars = seriesOf(await panel.getBars(['sz159972'], '2026-09-21', '2026-10-08'), 'sz159972');
    expect(bars.map((b) => b.date)).not.toContain('2026-09-28');

    expect(panel.isSuspended(bars, '2026-09-28')).toEqual({ suspended: true, reason: 'missing-bar' });
    // 显式关闭形态① ⇒ 不再判停牌
    expect(panel.isSuspended(bars, '2026-09-28', { missingBar: false })).toEqual({
      suspended: false,
      reason: null,
    });
  });

  it.skipIf(!NUMERIC_READY)('形态② volume=0：sh512390 在 2026-09-07 有 bar 但零成交', async () => {
    expect(calendar.has('2026-09-07')).toBe(true);
    const bars = seriesOf(await panel.getBars(['sh512390'], '2026-09-01', '2026-09-30'), 'sh512390');

    const bar = bars.find((b) => b.date === '2026-09-07');
    expect(bar).toBeDefined();
    expect(bar?.volume).toBe(0);
    // 实测：零量行的 amount 恒为 0
    expect(bar?.amount).toBe(0);

    expect(panel.isSuspended(bars, '2026-09-07')).toEqual({ suspended: true, reason: 'zero-volume' });
    expect(panel.isSuspended(bars, '2026-09-07', { zeroVolume: false })).toEqual({
      suspended: false,
      reason: null,
    });
  });

  it.skipIf(!NUMERIC_READY)("zeroVolumeSeries='drop' 剔除停牌日并缩短窗口 ⇒ 不自造 0% 收益", async () => {
    const keepMap = await panel.getBars(['sh512390'], '2026-09-01', '2026-09-30');
    const dropMap = await panel.getBars(['sh512390'], '2026-09-01', '2026-09-30', {
      zeroVolumeSeries: 'drop',
    });
    const keep = seriesOf(keepMap, 'sh512390');
    const drop = seriesOf(dropMap, 'sh512390');

    // keep 口径：09-07..09-30 全是零量，close 冻结在 1.227 ⇒ 逐日收益会被算成 0%
    expect(keep.length).toBe(21);
    expect(keep.filter((b) => b.volume === 0).length).toBe(17);
    const frozen = keep.filter((b) => b.volume === 0);
    expect(new Set(frozen.map((b) => b.close)).size).toBe(1);

    // drop 口径：只剩有成交的 4 天，序列变短；停牌日不再产生「假 0% 收益」
    expect(drop.length).toBe(4);
    expect(drop.every((b) => b.volume > 0)).toBe(true);

    const zeroReturnPairs = (series: readonly Bar[]): number =>
      series.slice(1).filter((b, i) => b.close === series[i].close).length;
    // keep：17 个零量日（每个都与前一交易日平价）+ 09-03→09-04 的真实平价 ⇒ 18 个 0% 收益
    expect(zeroReturnPairs(keep)).toBe(18);
    // drop：只剩 09-03→09-04 这 1 个「真实」平价（当日有成交，不是停牌造出来的）
    expect(zeroReturnPairs(drop)).toBe(1);
    // 缩短窗口后，最后一个有效日的日期也随之前移（09-04 而不是 09-30）
    expect(drop[drop.length - 1].date).toBe('2026-09-04');
  });
});
