import React from 'react';
import { COLORS, TYPO } from '../theme/tokens';

/**
 * 全站合规声明（T95）
 *
 * 🔴 文案是 **PRD §5.9「全局合规声明」逐字**：
 * > 全站所有页面顶部或底部常驻：「本工具不构成投资建议，数据仅供参考」
 *
 * ⚠️ **不得改写、不得增删标点** —— 这是面向用户的合规文案，改动需回 PRD 走评审。
 *
 * 落位说明：
 * - 实施计划 T95 要求「`App.tsx` 布局 footer」→ 本组件由 `App.tsx` 的 `<footer>` 渲染
 * - **登录页也要有** —— PRD 写的是「**全站所有页面**」，未登录页同样在「全站」内
 * - 样式沿用原有的琥珀色提示条（`bgDisclaimer` / `textDisclaimer`），只是从 Navbar 下方搬到页脚
 */
export default function ComplianceFooter() {
  return (
    <footer
      style={{
        marginTop: 24,
        background: COLORS.bgDisclaimer,
        color: COLORS.textDisclaimer,
        fontSize: TYPO.captionSize,
        textAlign: 'center',
        padding: '6px 12px',
        borderRadius: 4,
      }}
    >
      本工具不构成投资建议，数据仅供参考
    </footer>
  );
}
