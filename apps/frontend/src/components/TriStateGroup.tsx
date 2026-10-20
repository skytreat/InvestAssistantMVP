import React from 'react';
import { COLORS, SPACING, TYPO } from '../theme/tokens';
import { inputStyle } from '../theme/styles';

/**
 * 复盘三态按钮组（T69 · PRD §5.5）
 *
 * ## 三态是什么（**不是** PASS/WARN/ERROR）
 *
 * ⚠️ 实施计划 §12.7 的 **G4.3 原文写「复盘三态弹窗（PASS/WARN/ERROR）正确分流」—— 那是笔误**：
 *    PRD §5.5「复盘编辑弹窗」定义的三态字段是
 *    **未标记（null）/ 是 / 否**，对应两个字段 `strategy_match`（是否符合策略）
 *    与 `is_stop_loss`（是否止损），与「12 项校验」的 PASS/WARN/ERROR 毫无关系。
 *
 * ## 颜色口径（PRD §5.5 逐字）
 *
 * > 三态字段默认未标记（null），显示灰色"未标记"文字，点击可切换为"是"（绿色）/"否"（红色）
 *
 * ⇒ **是 = 绿 / 否 = 红 / 未标记 = 灰**，且**「是」和「否」必须视觉可区分**
 * （旧实现里两者共用同一个选中底色，只靠文字区分 —— 不符合 PRD）。
 *
 * ## 选中态视觉加强（ux_v2 §3.3-4）
 *
 * 选中项额外加 `fontWeight: 600` + `borderWidth: 2px`，
 * 使「选中 / 未选中」在**色觉障碍 / 灰度打印**下依然可区分（不只依赖底色）。
 */

/** 三态取值：'' = 未标记（对应后端 null），'1' = 是，'0' = 否 */
export type TriState = '' | '0' | '1';

/** 三态的三个选项（顺序即渲染顺序：未标记 / 是 / 否）*/
export const TRI_STATE_OPTIONS: ReadonlyArray<{ value: TriState; label: string }> = [
  { value: '', label: '未标记' },
  { value: '1', label: '是' },
  { value: '0', label: '否' },
];

/** 三态 → 配色（与 4 色标签色板同源，`tokens.ts` 的 `bgPill*` 系列）*/
const TRI_STATE_COLOR: Record<string, { bg: string; fg: string; border: string }> = {
  '': { bg: COLORS.bgPillNeutral, fg: COLORS.textPillNeutral, border: COLORS.borderPillNeutral },
  '1': { bg: COLORS.bgPillSuccess, fg: COLORS.textPillSuccess, border: COLORS.borderPillSuccess },
  '0': { bg: COLORS.bgPillDanger, fg: COLORS.textPillDanger, border: COLORS.borderPillDanger },
};

export interface TriStateGroupProps {
  /** 组标题元素的 id（同时用作 `aria-labelledby` 的目标）*/
  readonly labelId: string;
  /** 组标题文案（如「是否符合策略」）*/
  readonly label: string;
  /** 当前值*/
  readonly value: TriState;
  /** 值变化回调*/
  readonly onChange: (value: TriState) => void;
}

/**
 * 三态按钮组
 *
 * ⚠️ **它不是 form label**（T63 已定）：它标的是**一组按钮**，不是单个控件
 *    → 标题用 `<span id=...>`，按钮组用 `role="group"` + `aria-labelledby` 指向该 span；
 *    每个按钮加 `aria-pressed` 暴露选中态（否则选中态仅靠颜色传达）。
 */
export default function TriStateGroup({ labelId, label, value, onChange }: TriStateGroupProps) {
  return (
    <div>
      <span id={labelId} style={{ fontSize: TYPO.smallSize, color: COLORS.textSecondary }}>
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        style={{ display: 'flex', gap: SPACING.gapBase, marginTop: 4 }}
      >
        {TRI_STATE_OPTIONS.map((opt) => {
          const selected = value === opt.value;
          const c = TRI_STATE_COLOR[opt.value];
          return (
            <button
              key={opt.value || 'none'}
              type="button"
              aria-pressed={selected}
              data-testid={`tri-state-${labelId}-${opt.value === '' ? 'none' : opt.value}`}
              style={{
                ...inputStyle,
                cursor: 'pointer',
                background: selected ? c.bg : COLORS.cardBg,
                color: selected ? c.fg : COLORS.textSecondary,
                // 选中态加粗描边（ux_v2 §3.3-4）：不只靠底色区分选中与否
                border: `${selected ? 2 : 1}px solid ${selected ? c.border : COLORS.borderMedium}`,
                fontWeight: selected ? 600 : 400,
              }}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
