/**
 * K 线形态标注（双顶 / 双底）—— 后端算、前端只画
 *
 * 口径：`docs/client/pattern_recognition_design.md`（只做图上标注，不产信号）
 *
 * 数据流：
 *   `GET /api/quote/:symbol/patterns?days=`（后端按 **qfq 日线**识别）
 *     → `mapPatternsToBars` 把形态的日期映射到**当前周期的 K 线桶**
 *     → `APP_PATTERN` 指标的 `draw` 自绘（点标记 + 颈线 + 文字标签）
 *
 * ⚠️ 价格为**当前图表自己的 bar**（周/月用聚合后 high/low；复权口径跟随图表），
 *    形态几何只取后端给的日期，避免 qfq 与 bfq 切换时标注漂移。
 */

import type { BarBucket, RawBar } from './chartBars';

/** 后端 `/quote/:symbol/patterns` 的单条形态（只保留前端需要的字段） */
export interface PatternApiItem {
  kind: string;
  points: Array<{ role: string; date: string; price: number }>;
  neckline: { fromDate: string; toDate: string; fromPrice: number; toPrice: number; slope: number };
  breakout: { date: string; close: number; penetrationPct: number };
}

/** 已映射到图表 bar 下标的形态 */
export interface ChartPattern {
  kind: 'double_top' | 'double_bottom';
  firstIndex: number;
  middleIndex: number;
  secondIndex: number;
  confirmIndex: number;
  firstPrice: number;
  middlePrice: number;
  secondPrice: number;
  /** 颈线价位（水平；双顶为谷、双底为峰） */
  necklinePrice: number;
}

const SUPPORTED_KINDS = new Set(['double_top', 'double_bottom']);

/** 二分查找日期所属的周期桶（桶按 startDate 升序且互不重叠） */
function bucketIndexOfDate(buckets: BarBucket[], date: string): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (date < buckets[mid].startDate) hi = mid - 1;
    else if (date > buckets[mid].endDate) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function pointDateOf(item: PatternApiItem, role: string): string | null {
  const point = item.points.find((p) => p.role === role);
  return point?.date ?? null;
}

/**
 * 把后端形态映射到每根周期 K 线
 *
 * - 形态点在当前桶内 → 取该桶聚合后的 high / low（不复用 qfq 绝对价，保证与图表口径一致）
 * - 形态整体挂到 `confirmIndex` 那根 bar 上（绘制时统一收集，避免重复）
 * - 任一关键日期找不到桶 / 形态超出当前窗口 → 丢弃（不画残缺形态）
 */
export function mapPatternsToBars(
  buckets: BarBucket[],
  bars: RawBar[],
  items: PatternApiItem[],
): ChartPattern[][] {
  const result: ChartPattern[][] = buckets.map(() => []);
  if (items.length === 0 || buckets.length === 0 || bars.length !== buckets.length) return result;

  for (const item of items) {
    if (!SUPPORTED_KINDS.has(item.kind)) continue;

    const dates = {
      first: pointDateOf(item, 'first'),
      middle: pointDateOf(item, 'middle'),
      second: pointDateOf(item, 'second'),
      confirm: item.breakout?.date ?? null,
    };
    if (!dates.first || !dates.middle || !dates.second || !dates.confirm) continue;

    const firstIndex = bucketIndexOfDate(buckets, dates.first);
    const middleIndex = bucketIndexOfDate(buckets, dates.middle);
    const secondIndex = bucketIndexOfDate(buckets, dates.second);
    const confirmIndex = bucketIndexOfDate(buckets, dates.confirm);
    if (firstIndex < 0 || middleIndex < 0 || secondIndex < 0 || confirmIndex < 0) continue;

    const isTop = item.kind === 'double_top';
    const barFirst = bars[firstIndex];
    const barMiddle = bars[middleIndex];
    const barSecond = bars[secondIndex];

    const pattern: ChartPattern = {
      kind: item.kind as ChartPattern['kind'],
      firstIndex,
      middleIndex,
      secondIndex,
      // 突破可能在第二顶之后的同桶或后续桶；绘制到突破那一根
      confirmIndex: Math.max(secondIndex, confirmIndex),
      firstPrice: isTop ? barFirst.high : barFirst.low,
      middlePrice: isTop ? barMiddle.low : barMiddle.high,
      secondPrice: isTop ? barSecond.high : barSecond.low,
      necklinePrice: isTop ? barMiddle.low : barMiddle.high,
    };

    result[pattern.confirmIndex].push(pattern);
  }

  return result;
}

/** 形态绘制几何（可单测）：点 / 颈线 / 标签锚点 */
export interface PatternGeometry {
  kind: ChartPattern['kind'];
  label: '双顶' | '双底';
  points: Array<{ index: number; price: number }>;
  neckline: { fromIndex: number; toIndex: number; price: number };
}

export function toPatternGeometry(pattern: ChartPattern): PatternGeometry {
  return {
    kind: pattern.kind,
    label: pattern.kind === 'double_top' ? '双顶' : '双底',
    points: [
      { index: pattern.firstIndex, price: pattern.firstPrice },
      { index: pattern.middleIndex, price: pattern.middlePrice },
      { index: pattern.secondIndex, price: pattern.secondPrice },
    ],
    neckline: {
      fromIndex: pattern.firstIndex,
      toIndex: pattern.confirmIndex,
      price: pattern.necklinePrice,
    },
  };
}
