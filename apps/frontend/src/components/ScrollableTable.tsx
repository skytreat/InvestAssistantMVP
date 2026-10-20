import React from 'react';
import { scrollableTableContainerStyle } from '../theme/styles';

/**
 * 可横向滚动的表格容器（G3.5 · 文档级横向溢出修复）
 *
 * ## 它解决什么
 *
 * 表格的 `width: '100%'` 只是**最小宽度** —— 单元格里的长不可断字符串
 * （系统日志里的文件路径、插件说明…）会把表格顶到容器宽度之外，
 * 溢出再向上冒泡 → `document.documentElement.scrollWidth` 变大 →
 * **文档级横向溢出**（G3.5 判据：`scrollWidth − clientWidth ≤ 2`）。
 *
 * 本组件给表格套一层 `overflow-x: auto` 的滚动容器：
 * 表格在**自己内部**横向滚动，容器宽度仍受父级约束 → 文档不再被撑宽。
 *
 * ## 为什么必须带无障碍属性（不是可选装饰）
 *
 * axe 的 `scrollable-region-focusable` 规则（**serious** 级）要求：
 * **可横向滚动的区域必须能被键盘访问**，否则键盘用户无法滚动它。
 * 修法三件套：
 *
 * - `tabIndex={0}` —— 让容器进入 Tab 序列（可聚焦）；
 * - `role="region"` —— 让容器成为 landmark（`region` 角色**支持** `aria-label`）；
 * - `aria-label` —— 给这个 landmark 一个可访问名（否则 `region` 没有名字，
 *   读屏会念成「区域」这种无意义提示）。
 *
 * ⚠️ **不要**只写 `aria-label` 而不写 `role="region"`：
 *    裸 `<div>` 的隐式角色是 `generic`，`aria-label` 在 `generic` 上**不被允许**
 *    （axe `aria-allowed-attr` / `aria-prohibited-attr` 会判违规）。
 *
 * ⚠️ jsdom **没有 layout engine** → `scrollWidth`/`clientWidth` 恒为 0 →
 *    `scrollable-region-focusable` 在 jsdom 下**恒判 inapplicable**（假阴性）。
 *    该规则的真实验证必须走**真浏览器**（`scripts/a11y-check.mjs`）。
 *    本组件的用例只能断言**结构契约**（role / aria-label / tabindex / overflow-x）。
 */

export interface ScrollableTableProps {
  /**
   * 滚动区域的**可访问名**（`role="region"` 的必填项）
   *
   * 命名约定：`"<表名>表"`，如「最新信号表」「最近日志表」——
   * 与表格自身的 `aria-label`（「最新信号」）刻意错开一个字，
   * 避免读屏里两个名字完全一样而无法区分。
   */
  readonly label: string;
  /** 表格本体（`<table>` 元素）*/
  readonly children: React.ReactNode;
}

export default function ScrollableTable({ label, children }: ScrollableTableProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      style={scrollableTableContainerStyle}
      data-testid="scrollable-table"
    >
      {children}
    </div>
  );
}
