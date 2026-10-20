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

/**
 * 表格横向滚动容器（G3.5 · dashboard 375px 文档级横向溢出修复）
 *
 * ## 为什么需要它
 *
 * `tableStyle` 的 `width: '100%'` 对 `<table>` 只是**最小宽度**：
 * 单元格里的长不可断字符串（日志消息里的文件路径、插件说明…）会把表格的
 * **最小内容宽度**顶到容器宽度之外 → 表格溢出卡片 → 溢出继续向上冒泡 →
 * `document.documentElement.scrollWidth` 变大 → **文档级横向溢出**。
 *
 * G3.5 的判据是**文档级**的（`scrollWidth − clientWidth ≤ 2`），
 * 所以只要给表格套一层 `overflow-x: auto` 的容器，
 * 表格就在**自己内部**横向滚动，不再把文档撑宽 —— 这是标准解法。
 *
 * ## `minWidth: 0` 为什么必须显式写
 *
 * Grid / Flex 子项的 `min-width` 默认是 `auto`（≈ min-content），
 * 意味着「子项内容有多宽，父容器就被撑到多宽」——
 * **滚动容器自己反而会撑破父级**，加不加 `overflow-x` 都一样。
 * 显式写 `minWidth: 0` 才能让子项真正收缩到父容器宽度内。
 *
 * ⚠️ **刻意不设 `table-layout: fixed`** —— 那会重算所有列宽，
 *    破坏既有视觉与既有用例断言（列宽是既有页面的既定观感）。
 *
 * ⚠️ 本对象是**新增的可选样式**，全站共享的 `tableStyle` 本身**一个字都没改**
 *    （避免与其它波次的并行改动冲突）。
 */
export const scrollableTableContainerStyle: CSSProperties = {
  overflowX: 'auto',
  // Grid/Flex 子项默认 min-width:auto → 内容过宽会撑破容器（G3.5 第二个根因）
  minWidth: 0,
  maxWidth: '100%',
};

/**
 * 单元格内长文本截断（G3.5）
 *
 * ⚠️ **必须作用在单元格内部的子元素上，不能直接写在 `<td>` 上** ——
 *    CSS 2.1 明确「`max-width` 不适用于自动表格布局下的单元格」，
 *    写在 `<td>` 上会被忽略，长文本照样把整列撑宽。
 *
 * - `whiteSpace: 'nowrap'`：`text-overflow: ellipsis` **只在不换行时**才生效；
 * - `overflow: 'hidden'` + `textOverflow: 'ellipsis'`：视觉上截断成「…」；
 * - 完整内容由调用方通过 `title` 属性暴露（悬停可见全文），
 *   DOM 里的文本**不被裁剪** → 读屏用户仍能读到完整日志内容。
 *
 * ⚠️ **220px 不是 ui-spec §1 的 token**（ui-spec 未规定截断宽度）——
 *    它是**实测反推**的产物：dashboard「消息」列实测最宽 217px
 *    （探针 `scripts/probe-overflow.mjs` 实测），加单元格 10px 内边距取整 → 220px。
 *    取这个值的目的是「把列宽钉死，不再由路径文本长度决定」；
 *    ⚠️ 若将来日志文案变长，**上限不变**（宁可是横向滚动，也不撑破文档）。
 */
export const truncatedTextStyle: CSSProperties = {
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
