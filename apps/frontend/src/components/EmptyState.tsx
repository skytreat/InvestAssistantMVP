import React from 'react';
import { COLORS, SPACING, TYPO } from '../theme/tokens';

/**
 * 空状态占位（T65 · ui-spec §4 / 实施计划 T65 验收「空态有引导文案 + 动作按钮」）
 *
 * ⚠️ **本组件只提供容器，不内置任何业务文案** ——
 *    标题 / 说明 / 动作按钮的具体内容一律由调用方传入，
 *    避免「组件里写死一句『暂无数据』，各页面想表达的东西又不一样」。
 *
 * 视觉：整体居中、弱化配色（`COLORS.textMuted` / `COLORS.neutral`），
 * 内边距用 `SPACING` token，不引入任何裸 hex。
 */
export interface EmptyStateProps {
  /** 主标题（必填）—— 调用方给具体业务文案 */
  title: string;
  /** 补充说明（可选） */
  description?: string;
  /** 装饰性图标（可选）—— 视为纯装饰，对读屏隐藏，语义由 title 承担 */
  icon?: React.ReactNode;
  /** 引导动作（可选）—— 通常是「去添加 / 重试」按钮 */
  action?: React.ReactNode;
}

export default function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACING.gapBase,
        padding: SPACING.gapLoose,
        textAlign: 'center',
        color: COLORS.neutral,
      }}
    >
      {icon !== undefined && icon !== null && (
        <div aria-hidden="true" style={{ fontSize: 28, lineHeight: '32px', color: COLORS.textMuted }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: TYPO.bodySize, fontWeight: TYPO.cardTitleWeight, color: COLORS.textSecondary }}>
        {title}
      </div>
      {description !== undefined && description !== null && description !== '' && (
        <div style={{ fontSize: TYPO.smallSize, color: COLORS.textMuted }}>{description}</div>
      )}
      {action !== undefined && action !== null && <div style={{ marginTop: SPACING.gapTight }}>{action}</div>}
    </div>
  );
}
