/**
 * klineOverlays.ts — K 线手工画线的纯逻辑（无 React / 无网络）
 *
 * 职责收敛到一处，便于单测：
 *   1. **工具清单**（5 个内置模板 + 每个模板需要的落点数）
 *   2. **落点校验**（timestamp 必须落在当前已加载的 bar 上）
 *   3. **重放过滤**（刷新后只重放「时间戳能对应当前 bar 集合」的标注）
 *   4. **创建参数构造**（把持久化记录转成 `chart.createOverlay()` 的参数）
 *
 * ## 🔒 复权口径：**不复权（bfq）**，写死
 *
 * 点位存 `timestamp + value`（当时成交价）。前复权会在除权日改写历史价格 ⇒ 已画的线会漂移。
 * 因此只有 `fq === 'bfq'` 时才允许绘制/重放；未来切 qfq 需迁移历史点位。
 *
 * ## 📌 斐波那契分级位固定
 *
 * `klinecharts` 的 `fibonacciLine` 模板分级位（1 / 0.786 / 0.618 / 0.5 / 0.382 / 0.236 / 0）
 * 是**写死在模板里的**，用户不可改；故只持久化两个落点（PR 说明已注明）。
 */
import type { OverlayCreate } from 'klinecharts';

export type OverlayToolName =
  'rayLine' | 'horizontalStraightLine' | 'fibonacciLine' | 'priceChannelLine' | 'simpleAnnotation';

export interface OverlayToolDef {
  name: OverlayToolName;
  /** 工具栏展示名 */
  label: string;
  /** 需要的落点数（= 模板 totalStep - 1） */
  pointCount: number;
  /** 是否需要用户输入文字（仅 simpleAnnotation） */
  needsText: boolean;
}

/** 工具栏顺序与用户确认的一致：趋势线 / 水平线 / 斐波那契 / 价格通道 / 文字标注 */
export const OVERLAY_TOOLS: readonly OverlayToolDef[] = [
  { name: 'rayLine', label: '趋势线', pointCount: 2, needsText: false },
  { name: 'horizontalStraightLine', label: '水平线', pointCount: 1, needsText: false },
  { name: 'fibonacciLine', label: '斐波那契', pointCount: 2, needsText: false },
  { name: 'priceChannelLine', label: '价格通道', pointCount: 3, needsText: false },
  { name: 'simpleAnnotation', label: '文字标注', pointCount: 1, needsText: true },
];

/** 文字标注留空时的默认文字（保证后端「标注不能为空」不会被误触发） */
export const DEFAULT_ANNOTATION_TEXT = '标注';

export interface OverlayPoint {
  /** 毫秒时间戳（对应 bar 的 timestamp） */
  timestamp: number;
  /** 不复权价格 */
  value: number;
}

export interface OverlayDraft {
  symbol: string;
  period: string;
  name: OverlayToolName;
  points: OverlayPoint[];
  text: string | null;
}

export interface StoredOverlay extends OverlayDraft {
  id: number | string;
  created_at?: string;
}

export interface OverlaySaveResult {
  ok: boolean;
  /** 保存成功后的记录 id */
  id?: number;
  message?: string;
}

export function getOverlayTool(name: string): OverlayToolDef | undefined {
  return OVERLAY_TOOLS.find((tool) => tool.name === name);
}

/** 收集当前加载的 bar 时间戳集合（重放/落点校验的唯一依据） */
export function collectBarTimestamps(bars: ReadonlyArray<{ timestamp: number }>): Set<number> {
  const set = new Set<number>();
  for (const bar of bars) {
    if (typeof bar.timestamp === 'number' && Number.isFinite(bar.timestamp)) {
      set.add(bar.timestamp);
    }
  }
  return set;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);
  return date.toISOString().slice(0, 10);
}

/**
 * 校验一份待保存画线；返回错误文案（合法返回 `null`）。
 *
 * 落点校验是**保存前的最后一道关**：timestamp 不在当前 bar 集合里 ⇒ 拒绝保存并给出明确提示。
 */
export function validateOverlayDraft(draft: OverlayDraft, barTimestamps: ReadonlySet<number>): string | null {
  const tool = getOverlayTool(draft.name);
  if (!tool) return `未知的画线工具：${draft.name}`;

  if (!Array.isArray(draft.points) || draft.points.length !== tool.pointCount) {
    return `「${tool.label}」需要 ${tool.pointCount} 个落点，实际 ${
      Array.isArray(draft.points) ? draft.points.length : 0
    } 个`;
  }

  for (const point of draft.points) {
    if (
      !point ||
      typeof point.timestamp !== 'number' ||
      !Number.isInteger(point.timestamp) ||
      point.timestamp <= 0
    ) {
      return '落点时间无效，请重新绘制';
    }
    if (typeof point.value !== 'number' || !Number.isFinite(point.value)) {
      return '落点价格无效，请重新绘制';
    }
    if (!barTimestamps.has(point.timestamp)) {
      return `落点不在当前 K 线范围内（${formatTimestamp(point.timestamp)}），请重新绘制`;
    }
  }

  if (tool.needsText) {
    const text = (draft.text ?? '').trim();
    if (!text) return '文字标注不能为空';
  }

  return null;
}

/**
 * 只保留可重放的标注：工具名合法、点数正确、所有 timestamp 都能在当前 bar 集合中找到。
 *
 * 对不上的标注**跳过**（不报错、不删除），因为可能只是当前窗口/周期不包含它。
 */
export function filterReplayableOverlays(
  overlays: readonly StoredOverlay[],
  barTimestamps: ReadonlySet<number>,
): StoredOverlay[] {
  return overlays.filter((overlay) => {
    const draft: OverlayDraft = {
      symbol: overlay.symbol,
      period: overlay.period,
      name: overlay.name,
      points: overlay.points,
      text: overlay.text,
    };
    return validateOverlayDraft(draft, barTimestamps) === null;
  });
}

/**
 * 把「服务端返回的列表」与「本地当前列表」按 `id` 合并。
 *
 * 为什么需要合并：加载请求是异步的，用户可能在请求飞行途中新增或删除标注。
 * 直接用 `setOverlays(rows)` 会**覆盖本地意图**（新增的消失、删除的被刷回来）。
 * 合并规则：
 * - 同一 `id` 以**服务端为准**（后端权威）；
 * - 本次加载窗口内新增、但服务端返回里还没有的 ⇒ **保留**；
 * - 本地已删除的 `id` ⇒ **排除**（即使返回里仍带着它）；
 * - 只保留 `symbol + period` 与当前页一致的本地项（切换标的 / 周期时不能串数据）。
 */
export function mergeOverlaysFromServer(
  serverRows: readonly StoredOverlay[],
  localRows: readonly StoredOverlay[],
  options: { symbol: string; period: string; deletedIds?: ReadonlySet<number> },
): StoredOverlay[] {
  const deletedIds = options.deletedIds ?? new Set<number>();
  const merged: StoredOverlay[] = [];
  const seen = new Set<string>();

  for (const row of serverRows) {
    const key = String(row.id);
    if (deletedIds.has(Number(row.id)) || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  for (const row of localRows) {
    if (row.symbol !== options.symbol || row.period !== options.period) continue;
    const key = String(row.id);
    if (deletedIds.has(Number(row.id)) || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }

  return merged;
}

/** 把图表 overlay 的 points 转成持久化点位；缺失 timestamp / value 的点位返回 null */
export function overlayPointsFromChart(overlay: {
  points?: ReadonlyArray<{ timestamp?: number; value?: number }>;
}): OverlayPoint[] | null {
  const raw = overlay.points ?? [];
  const points: OverlayPoint[] = [];
  for (const point of raw) {
    const timestamp = point.timestamp;
    const value = point.value;
    if (
      typeof timestamp !== 'number' ||
      !Number.isInteger(timestamp) ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) {
      return null;
    }
    points.push({ timestamp, value });
  }
  return points;
}

/**
 * 构造 `chart.createOverlay()` 的参数。
 *
 * 传入 `id`（持久化记录的 id）后，图表上的 overlay 与库记录一一对应，删除时可直接映射。
 * 传 `points` 会直接完成绘制（不再进入绘制态），用于刷新后的重放。
 */
export function buildOverlayCreate(overlay: StoredOverlay, paneId: string): OverlayCreate {
  const create: OverlayCreate = {
    id: String(overlay.id),
    name: overlay.name,
    paneId,
    points: overlay.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.value,
    })),
    needDefaultPointFigure: true,
  };
  if (overlay.name === 'simpleAnnotation') {
    create.extendData = overlay.text ?? '';
  }
  return create;
}
