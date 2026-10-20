import React from 'react';
import { COLORS, SPACING, TYPO } from '../theme/tokens';

/**
 * 加载指示器（T65 · ui-spec §4「aria-live」+ §5 架构决策第 2 条）
 *
 * ⚠️ **不引第三方动画库**（ui-spec §5 决策 3 的同款约束：K 线不引图表库同理）——
 *    动画用「CSS `border` + `@keyframes spin`」实现：
 *    - 圆环本体走 **inline style**（尺寸 / 颜色全部取 `src/theme/tokens.ts` 的 token）；
 *    - `@keyframes spin` 只能写在 CSS 文件里 → 落在 `src/styles/global.css`；
 *      动画名与 inline style 里的 `animation: spin ...` 一一对应。
 *    - 顺带挂了 `className="spinner-ring"`，只为让 `global.css` 里的
 *      `@media (prefers-reduced-motion: reduce)` 能用 `!important` 覆盖
 *      （inline style 优先级高于 class 选择器，不加 `!important` 覆盖不掉）。
 *
 * **a11y**（ui-spec §4「aria-live」项）：
 * - `role="status"` —— 加载完成的播报区域（隐含 `aria-live="polite"`，这里显式再写一遍）；
 * - `aria-live="polite"` —— 不打断读屏当前朗读；
 * - `aria-label={label}` —— 无障碍名即加载语义；
 * - 可见文案节点标 `aria-hidden="true"` —— 避免「容器 aria-label」与「可见文字」被读两遍。
 *
 * **`inline` 模式**：与相邻文字同一行（按钮内 / 表单内场景，如「查询中...」）。
 * 容器用 `<span>` 而非 `<div>` —— `<div>` 放进 `<button>` 里是无效 HTML。
 */
export interface SpinnerProps {
  /** 圆环直径（px），默认 24 */
  size?: number;
  /** 可见文案 + 无障碍名（`aria-label`），默认「加载中...」 */
  label?: string;
  /** 行内模式：与相邻文字同一行（默认 false = 独占一行的块级区域） */
  inline?: boolean;
}

/** 圆环描边粗细：随直径线性缩放，最小 2px */
function ringWidth(size: number): number {
  return Math.max(2, Math.round(size / 8));
}

export default function Spinner({ size = 24, label = '加载中...', inline = false }: SpinnerProps) {
  const w = ringWidth(size);
  const ring: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    /**
     * ⚠️ **只用长写属性**（`borderTopColor` …），**不混用 `border` 简写** ——
     *    React 在 rerender 时会对「简写 + 长写同现」发冲突告警
     *    （"don't mix shorthand and non-shorthand properties"）。
     */
    borderTopWidth: w,
    borderRightWidth: w,
    borderBottomWidth: w,
    borderLeftWidth: w,
    borderTopStyle: 'solid',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    // 顶部异色 → 转一圈即成一格「加载中」圆环
    borderTopColor: COLORS.brand,
    borderRightColor: COLORS.borderLight,
    borderBottomColor: COLORS.borderLight,
    borderLeftColor: COLORS.borderLight,
    animation: 'spin 0.8s linear infinite',
    boxSizing: 'border-box',
    flexShrink: 0,
    display: 'inline-block',
  };

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="spinner"
      style={{
        display: inline ? 'inline-flex' : 'flex',
        alignItems: 'center',
        gap: inline ? SPACING.gapTight : SPACING.gapBase,
        color: COLORS.neutral,
        fontSize: TYPO.bodySize,
        lineHeight: 1.4,
        ...(inline ? { verticalAlign: 'middle' } : null),
      }}
    >
      <span className="spinner-ring" data-testid="spinner-ring" style={ring} aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
