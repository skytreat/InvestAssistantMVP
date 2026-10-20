import React from 'react';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';

/**
 * 交易复盘列表的 **4 色标签（pill）+ 图例**（T69 · PRD §5.5）
 *
 * ## 权威依据
 *
 * `docs/client/PRD.md` §5.5「复盘页交互」：
 *
 * > 列表标签颜色 | 未复盘（灰）/ 系统信号触发（绿）/ 主观决策（橙）/ 止损（红）叠加显示
 *
 * ⚠️ **「4 色」是「每行一个标签、按优先级取最高档」**（不是「一行 4 个标签同时显示」）：
 *    实施计划 T69 ② 明确「止损红 > 系统信号绿 > 主观决策橙 > 未复盘灰」，
 *    本组件的 `reviewTagOf()` 就是按这个顺序取**第一个命中**的档位。
 *
 * ## 颜色语义（全部走 token，不写裸 hex）
 *
 * | 档位 | 颜色 | token 三元组 | 判定条件 |
 * |---|---|---|---|
 * | 止损 | 🔴 红 | `bgPillDanger` / `textPillDanger` / `borderPillDanger` | `is_stop_loss === 1` |
 * | 系统信号 | 🟢 绿 | `bgPillSuccess` / `textPillSuccess` / `borderPillSuccess` | `system_followed === 1` / `is_auto_import === 1` |
 * | 主观决策 | 🟠 橙 | `bgPillWarning` / `textPillWarning` / `borderPillWarning` | 人工交易且**已复盘** |
 * | 未复盘 | ⚪ 灰 | `bgPillNeutral` / `textPillNeutral` / `borderPillNeutral` | 其余 |
 *
 * ## 为什么「系统导入」也归绿色档
 *
 * PRD §5.4「系统 vs 人工标签」要求自动导入的交易以**绿色**「系统导入」标签展示，
 * PRD §5.5 的绿色档叫「系统信号」—— 两者是**同一档颜色**、两个文案。
 * 故本组件的绿色档有两个文案：`系统信号`（跟信号下单）/ `系统导入`（除权自动导入），
 * 图例里合并写成「系统信号 / 系统导入」。
 */

/** 4 个档位（顺序 = 优先级从高到低）*/
export type ReviewTagKey = 'stopLoss' | 'systemSignal' | 'manualDecision' | 'unreviewed';

/** 判定标签所需的交易字段（只取用得到的，避免和页面里的接口类型耦合）*/
export interface ReviewTagInput {
  /** 是否止损：1=是 / 0=否 / null=未标记 */
  is_stop_loss: number | null;
  /** 是否跟随系统信号：1=是 / 0=否 / null=未标记 */
  system_followed: number | null;
  /** 是否系统自动导入（分红 / 送股 / 转增）*/
  is_auto_import: number;
  /** 复盘总结（null / '' = 未复盘）*/
  review_summary: string | null;
  /** 是否符合策略：1=是 / 0=否 / null=未标记 */
  strategy_match: number | null;
}

/** 一个标签（档位 + 文案）*/
export interface ReviewTag {
  readonly key: ReviewTagKey;
  readonly label: string;
}

/** 档位优先级（从高到低）—— 与 PRD §5.5 的颜色优先级一致 */
export const REVIEW_TAG_PRIORITY: readonly ReviewTagKey[] = [
  'stopLoss',
  'systemSignal',
  'manualDecision',
  'unreviewed',
];

/** 各档位的文案（图例与 pill 共用）*/
export const REVIEW_TAG_LABEL: Record<ReviewTagKey, string> = {
  stopLoss: '止损',
  systemSignal: '系统信号',
  manualDecision: '主观决策',
  unreviewed: '未复盘',
};

/** 各档位的配色（全部来自 `theme/tokens.ts`）*/
export const REVIEW_TAG_COLOR: Record<ReviewTagKey, { bg: string; fg: string; border: string }> = {
  stopLoss: { bg: COLORS.bgPillDanger, fg: COLORS.textPillDanger, border: COLORS.borderPillDanger },
  systemSignal: {
    bg: COLORS.bgPillSuccess,
    fg: COLORS.textPillSuccess,
    border: COLORS.borderPillSuccess,
  },
  manualDecision: {
    bg: COLORS.bgPillWarning,
    fg: COLORS.textPillWarning,
    border: COLORS.borderPillWarning,
  },
  unreviewed: {
    bg: COLORS.bgPillNeutral,
    fg: COLORS.textPillNeutral,
    border: COLORS.borderPillNeutral,
  },
};

/**
 * 判定一笔交易落在哪个标签档位
 *
 * 优先级（**高 → 低**，命中即返回）：
 * 1. `is_stop_loss === 1` → 止损（红）
 * 2. `system_followed === 1` → 系统信号（绿）
 * 3. `is_auto_import === 1` → 系统导入（绿，与系统信号同档不同文案）
 * 4. 已复盘（有 `review_summary` 或任一三态字段非 null）→ 主观决策（橙）
 * 5. 其余 → 未复盘（灰）
 */
export function reviewTagOf(t: ReviewTagInput): ReviewTag {
  if (t.is_stop_loss === 1) return { key: 'stopLoss', label: REVIEW_TAG_LABEL.stopLoss };
  if (t.system_followed === 1) {
    return { key: 'systemSignal', label: REVIEW_TAG_LABEL.systemSignal };
  }
  if (t.is_auto_import === 1) return { key: 'systemSignal', label: '系统导入' };
  const reviewed =
    (t.review_summary !== null && t.review_summary !== '') ||
    t.strategy_match !== null ||
    t.is_stop_loss !== null;
  if (reviewed) return { key: 'manualDecision', label: REVIEW_TAG_LABEL.manualDecision };
  return { key: 'unreviewed', label: REVIEW_TAG_LABEL.unreviewed };
}

/** pill 的公共样式（圆角 + 描边 + 不换行）*/
const pillStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: RADIUS.sm,
  fontSize: TYPO.captionSize,
  fontWeight: TYPO.cardTitleWeight,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
};

/**
 * 单个标签 pill
 *
 * ⚠️ **是 pill（带底色 + 描边 + 圆角），不是彩色文字** ——
 *    gap-list F-R2 实测旧实现「以 `<td>` 彩色文字呈现，`span[style*=borderRadius]` 数 = 0」。
 */
export function ReviewTagPill({ tag, title }: { tag: ReviewTag; title?: string }) {
  const c = REVIEW_TAG_COLOR[tag.key];
  return (
    <span
      data-testid={`review-tag-${tag.key}`}
      data-tag-key={tag.key}
      title={title}
      style={{
        ...pillStyle,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
      }}
    >
      {tag.label}
    </span>
  );
}

/** 图例条目文案（绿色档合并「系统信号 / 系统导入」两种文案）*/
const LEGEND_LABEL: Record<ReviewTagKey, string> = {
  stopLoss: '止损',
  systemSignal: '系统信号 / 系统导入',
  manualDecision: '主观决策',
  unreviewed: '未复盘',
};

/**
 * 标签颜色图例（4 色各一色块 + 文案）
 *
 * 图例是**必须项**：4 色 pill 靠颜色传达信息，
 * 没有图例用户无从知道「橙 = 主观决策」。
 */
export function ReviewTagLegend() {
  return (
    <div
      /*
        ⚠️ **必须带 `role="group"`** —— 裸 `<div>` 的隐式角色是 `generic`，
           而 `aria-label` 在 `generic` 上**不被允许**（axe `aria-prohibited-attr` 判违规）。
           `group` 角色**支持** `aria-label`，且不是 landmark → 不会触发 `landmark-unique`。
           （同一坑见 `components/ScrollableTable.tsx` 的注释。）
      */
      role="group"
      aria-label="标签颜色图例"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SPACING.gapRelaxed,
        flexWrap: 'wrap',
        fontSize: TYPO.captionSize,
        color: COLORS.textSecondary,
      }}
    >
      <span>标签：</span>
      {REVIEW_TAG_PRIORITY.map((key) => {
        const c = REVIEW_TAG_COLOR[key];
        return (
          <span
            key={key}
            data-testid={`review-legend-${key}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: RADIUS.sm,
                background: c.bg,
                border: `1px solid ${c.border}`,
              }}
            />
            {LEGEND_LABEL[key]}
          </span>
        );
      })}
    </div>
  );
}
