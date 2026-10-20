import type { CSSProperties } from 'react';
import { COLORS, MAX_WIDTH, RADIUS, SPACING, TYPO } from './tokens';

/**
 * 共享样式对象层（T66 · 分层收口）
 *
 * ## 为什么要有这一层
 *
 * T66 之前，所有共享样式对象都住在 `src/pages/_shared.tsx`（一个**页面层**文件）里，
 * 于是 `src/components/ConfirmDialog.tsx` 只能从 `../pages/_shared` 取 `cardStyle` / `buttonStyle`
 * —— **组件层反向依赖页面层**，依赖方向倒置。
 *
 * 现在把这些**纯样式对象**下沉到本文件（`src/theme/`），依赖方向变成：
 *
 * ```
 * pages/*    ──▶ theme/styles ──▶ theme/tokens
 * components/*──▶ theme/styles ──▶ theme/tokens
 * ```
 *
 * ⚠️ **本文件只允许 import `./tokens`** —— 不 import `components/`、不 import `pages/`。
 *    否则会形成 `pages/_shared → theme/ → components/ → pages/` 的**循环依赖**。
 *    本文件是**纯常量 + 纯样式对象**，无 React 组件、无 hook、无副作用。
 *
 * ## 与 `pages/_shared.tsx` 的关系
 *
 * `pages/_shared.tsx` **继续 re-export** 本文件的全部样式对象（见该文件的 re-export 段），
 * 以免 12+ 个页面大面积改 import 路径。**既有导出全部保持可用**。
 *
 * ## 数值来源
 *
 * 全部取自 `src/theme/tokens.ts`（其数值来自 `docs/client/ui-spec.md` §1），
 * **本文件不引入任何裸 hex**（唯一例外见下方 `secondaryButtonStyle` 的注释）。
 */

/** 页面容器：统一内边距 + 居中 + 给移动端底部 TabBar 让位 */
export const pageContainerStyle: CSSProperties = {
  padding: SPACING.pagePadding,
  maxWidth: MAX_WIDTH,
  margin: '0 auto',
  // 给移动端底部 TabBar 让位
  paddingBottom: '86px',
};

/** 卡片容器 */
export const cardStyle: CSSProperties = {
  border: `1px solid ${COLORS.borderLight}`,
  borderRadius: RADIUS.md,
  padding: SPACING.cardPadding,
  marginBottom: SPACING.cardMarginBottom,
  background: COLORS.cardBg,
};

/** 页面主标题 */
export const titleStyle: CSSProperties = {
  fontSize: TYPO.h1Size,
  fontWeight: TYPO.h1Weight,
  marginBottom: SPACING.gapRelaxed,
};

/** 卡片标题 */
export const cardTitleStyle: CSSProperties = {
  fontSize: TYPO.cardTitleSize,
  fontWeight: TYPO.cardTitleWeight,
  marginBottom: 12,
  borderBottom: `1px solid ${COLORS.borderSubtle}`,
  paddingBottom: SPACING.gapBase,
  color: COLORS.textPrimary,
};

/** 表格容器 */
export const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: TYPO.bodySize,
};

/** 表格单元格（th / td 共用） */
export const thTdStyle: CSSProperties = {
  border: `1px solid ${COLORS.borderLight}`,
  padding: '8px 10px',
  textAlign: 'left',
};

/** 表头单元格 */
export const thStyle: CSSProperties = {
  ...thTdStyle,
  background: COLORS.headerBg,
  fontWeight: TYPO.cardTitleWeight,
  color: COLORS.textSecondary,
};

/** 输入框 */
export const inputStyle: CSSProperties = {
  padding: SPACING.inputPadding,
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: RADIUS.sm,
  fontSize: TYPO.bodySize,
};

/** 主按钮 */
export const buttonStyle: CSSProperties = {
  padding: SPACING.btnPadding,
  background: COLORS.brand,
  color: COLORS.cardBg,
  border: 'none',
  borderRadius: RADIUS.sm,
  cursor: 'pointer',
  fontSize: TYPO.bodySize,
};

/** 错误提示文字 */
export const errorStyle: CSSProperties = {
  color: COLORS.danger,
  fontSize: TYPO.bodySize,
  marginTop: SPACING.gapBase,
};

/** 成功提示文字 */
export const successStyle: CSSProperties = {
  color: COLORS.success,
  fontSize: TYPO.bodySize,
  marginTop: SPACING.gapBase,
};

/** 表单行（label + 控件横向排列） */
export const formRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: SPACING.formRowGap,
  marginBottom: SPACING.formRowMarginBottom,
};

/** 表单 label */
export const labelStyle: CSSProperties = {
  minWidth: SPACING.labelMinWidth,
  color: COLORS.textSecondary,
  fontSize: TYPO.bodySize,
};

/* ──────────────────── ui-spec §2「按钮变体」（T66 补齐） ──────────────────── */

/**
 * 危险按钮（删除 / 软删除等不可逆操作）
 *
 * 数值来源：`docs/client/ui-spec.md` §2「按钮变体」—— **逐字照抄**：
 * `background: '#dc2626'` = `COLORS.danger`（同值），
 * `color: '#fff'` ≡ `COLORS.cardBg`（`'#ffffff'`，同色不同写法）。
 */
export const dangerButtonStyle: CSSProperties = {
  background: COLORS.danger,
  color: COLORS.cardBg,
};

/**
 * 幽灵按钮（次要操作：描边、无底色）
 *
 * 数值来源：ui-spec §2 —— `background: 'transparent'` / `color: '#2563eb'`（= `COLORS.brand`）
 * / `border: '1px solid #2563eb'`。
 */
export const ghostButtonStyle: CSSProperties = {
  background: 'transparent',
  color: COLORS.brand,
  border: `1px solid ${COLORS.brand}`,
};

/**
 * 次级按钮（中性底色）
 *
 * ⚠️ **ui-spec §2 的文字色是 `#374151`，与 token `COLORS.textSecondary`（`#4b5563`）不同值。**
 *    ui-spec §3 的「全站内联颜色清单」把 `#374151` 映射到 `COLORS.textSecondary`，
 *    但 §1 的 token 表给 `textSecondary` 的是 `#4b5563` —— **两处规格本身不一致**。
 *
 *    本文件按任务要求「**值与 ui-spec §2 逐字一致**」取 `#374151`，
 *    底色用 `COLORS.borderLight`（`#e5e7eb`，与 §2 逐字一致）。
 *    ⚠️ 故此处**必须**留一个裸 hex（`#374151`）—— 它没有等值 token 可用。
 *    TODO（待办）：ui-spec §1 / §2 / §3 三处对「表头 / 次级文字色」的取值需统一，
 *    统一后应改回 `COLORS.textSecondary` 并删除本裸 hex。
 */
export const secondaryButtonStyle: CSSProperties = {
  background: COLORS.borderLight,
  color: '#374151',
};

/**
 * 禁用按钮
 *
 * 数值来源：ui-spec §2 —— `background: '#9ca3af'`（= `COLORS.textMuted`，同值）
 * / `color: '#fff'`（≡ `COLORS.cardBg`）/ `cursor: 'not-allowed'`。
 */
export const buttonDisabledStyle: CSSProperties = {
  background: COLORS.textMuted,
  color: COLORS.cardBg,
  cursor: 'not-allowed',
};

/*
 * 焦点环 —— **本文件不提供**
 *
 * ui-spec §2 列的 `focusRingStyle = { outline: '2px solid #2563eb', outlineOffset: '2px' }`
 * 已由 T62 的 `src/styles/global.css` 的全局 `:focus-visible` 规则**等价实现**：
 * `outline: 2px solid #2563eb; outline-offset: 2px;`
 * —— 重复提供一份样式对象只会产生「两处真理」，故此处**不再定义**。
 */
