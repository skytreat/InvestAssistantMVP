/**
 * kline-overlays.test.ts — 纯逻辑单测（不渲染、不联网）
 *
 * 覆盖：5 个工具清单 / 落点校验 / 重放过滤 / createOverlay 参数构造（含斐波那契）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANNOTATION_TEXT,
  OVERLAY_TOOLS,
  buildOverlayCreate,
  collectBarTimestamps,
  filterReplayableOverlays,
  overlayPointsFromChart,
  validateOverlayDraft,
  type OverlayDraft,
  type StoredOverlay,
} from '../../src/indicators/klineOverlays';

const TS_A = Date.UTC(2026, 9, 12);
const TS_B = Date.UTC(2026, 9, 13);
const TS_C = Date.UTC(2026, 9, 14);
const BARS = [{ timestamp: TS_A }, { timestamp: TS_B }, { timestamp: TS_C }];
const BAR_TIMESTAMPS = collectBarTimestamps(BARS);

function draft(overrides: Partial<OverlayDraft> = {}): OverlayDraft {
  return {
    symbol: 'sh600000',
    period: 'day',
    name: 'horizontalStraightLine',
    points: [{ timestamp: TS_A, value: 10 }],
    text: null,
    ...overrides,
  };
}

describe('OVERLAY_TOOLS', () => {
  it('正好 5 个工具，名称与点数与 klinecharts 模板一致', () => {
    expect(OVERLAY_TOOLS.map((tool) => tool.name)).toEqual([
      'rayLine',
      'horizontalStraightLine',
      'fibonacciLine',
      'priceChannelLine',
      'simpleAnnotation',
    ]);
    expect(OVERLAY_TOOLS.map((tool) => tool.pointCount)).toEqual([2, 1, 2, 3, 1]);
    expect(OVERLAY_TOOLS.filter((tool) => tool.needsText).map((tool) => tool.name)).toEqual([
      'simpleAnnotation',
    ]);
  });
});

describe('collectBarTimestamps', () => {
  it('只收集有限数值时间戳', () => {
    const set = collectBarTimestamps([
      { timestamp: TS_A },
      { timestamp: Number.NaN },
      { timestamp: Number.POSITIVE_INFINITY },
      { timestamp: TS_B },
    ]);
    expect(Array.from(set)).toEqual([TS_A, TS_B]);
  });
});

describe('validateOverlayDraft', () => {
  it('合法水平线通过', () => {
    expect(validateOverlayDraft(draft(), BAR_TIMESTAMPS)).toBeNull();
  });

  it('合法斐波那契（2 点）通过', () => {
    const result = validateOverlayDraft(
      draft({
        name: 'fibonacciLine',
        points: [
          { timestamp: TS_A, value: 10 },
          { timestamp: TS_B, value: 12 },
        ],
      }),
      BAR_TIMESTAMPS,
    );
    expect(result).toBeNull();
  });

  it('点数不符被拒（斐波那契只给 1 点）', () => {
    const result = validateOverlayDraft(
      draft({ name: 'fibonacciLine', points: [{ timestamp: TS_A, value: 10 }] }),
      BAR_TIMESTAMPS,
    );
    expect(result).toContain('需要 2 个落点');
  });

  it('落点 timestamp 不在当前 bar 集合内被拒（斐波那契第 2 点非法）', () => {
    const result = validateOverlayDraft(
      draft({
        name: 'fibonacciLine',
        points: [
          { timestamp: TS_A, value: 10 },
          { timestamp: Date.UTC(2020, 0, 1), value: 12 },
        ],
      }),
      BAR_TIMESTAMPS,
    );
    expect(result).toContain('落点不在当前 K 线范围内');
  });

  it('价格非有限数值被拒', () => {
    const result = validateOverlayDraft(
      draft({ points: [{ timestamp: TS_A, value: Number.NaN }] }),
      BAR_TIMESTAMPS,
    );
    expect(result).toContain('落点价格无效');
  });

  it('文字标注为空被拒', () => {
    const result = validateOverlayDraft(
      draft({
        name: 'simpleAnnotation',
        points: [{ timestamp: TS_A, value: 10 }],
        text: '   ',
      }),
      BAR_TIMESTAMPS,
    );
    expect(result).toContain('不能为空');
  });

  it('未知工具被拒', () => {
    const result = validateOverlayDraft(draft({ name: 'segment' as OverlayDraft['name'] }), BAR_TIMESTAMPS);
    expect(result).toContain('未知的画线工具');
  });
});

describe('filterReplayableOverlays', () => {
  const stored = (overrides: Partial<StoredOverlay> = {}): StoredOverlay => ({
    id: 1,
    symbol: 'sh600000',
    period: 'day',
    name: 'horizontalStraightLine',
    points: [{ timestamp: TS_A, value: 10 }],
    text: null,
    ...overrides,
  });

  it('只保留时间戳能对上当前 bar 的标注（对不上的跳过）', () => {
    const rows = [
      stored({ id: 1 }),
      stored({ id: 2, points: [{ timestamp: Date.UTC(2020, 0, 1), value: 10 }] }),
      stored({
        id: 3,
        name: 'fibonacciLine',
        points: [
          { timestamp: TS_A, value: 10 },
          { timestamp: TS_C, value: 12 },
        ],
      }),
      stored({ id: 4, name: 'fibonacciLine', points: [{ timestamp: TS_A, value: 10 }] }),
    ];
    const replayable = filterReplayableOverlays(rows, BAR_TIMESTAMPS);
    expect(replayable.map((row) => row.id)).toEqual([1, 3]);
  });
});

describe('overlayPointsFromChart', () => {
  it('把图表点位转成 timestamp + value', () => {
    expect(overlayPointsFromChart({ points: [{ timestamp: TS_A, value: 10.5 }] })).toEqual([
      { timestamp: TS_A, value: 10.5 },
    ]);
  });

  it('缺点位或字段非法时返回 null（上层据此拒绝保存）', () => {
    expect(overlayPointsFromChart({ points: [{ value: 10.5 }] })).toBeNull();
    expect(overlayPointsFromChart({ points: [{ timestamp: TS_A }] })).toBeNull();
    expect(overlayPointsFromChart({ points: [] })).toEqual([]);
  });
});

describe('buildOverlayCreate', () => {
  it('id 转字符串、点位原样传递（斐波那契两点）', () => {
    const create = buildOverlayCreate(
      {
        id: 7,
        symbol: 'sh600000',
        period: 'day',
        name: 'fibonacciLine',
        points: [
          { timestamp: TS_A, value: 10 },
          { timestamp: TS_B, value: 12 },
        ],
        text: null,
      },
      'candle_pane',
    );
    expect(create.id).toBe('7');
    expect(create.name).toBe('fibonacciLine');
    expect(create.paneId).toBe('candle_pane');
    expect(create.points).toEqual([
      { timestamp: TS_A, value: 10 },
      { timestamp: TS_B, value: 12 },
    ]);
    expect(create.extendData).toBeUndefined();
  });

  it('文字标注把 text 放进 extendData（留空回退默认文案）', () => {
    const create = buildOverlayCreate(
      {
        id: '8',
        symbol: 'sh600000',
        period: 'day',
        name: 'simpleAnnotation',
        points: [{ timestamp: TS_A, value: 10 }],
        text: null,
      },
      'candle_pane',
    );
    // caller 会先补默认文字；这里验证 null 时也不会写入空字符串以外的非法结构
    expect(typeof create.extendData).toBe('string');
    expect(create.extendData).toBe('');
    expect(DEFAULT_ANNOTATION_TEXT).toBe('标注');
  });
});
