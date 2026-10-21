import React from 'react';
import { NavLink } from 'react-router-dom';
import { SPACING } from '../theme/tokens';
import { navLinkActiveStyle, navLinkStyle } from '../theme/styles';

/**
 * 桌面左侧导航栏（T76 ① · PRD §5.8 #7）
 *
 * ## 定位
 *
 * 桌面端（≥1024px）的主导航入口，垂直排列，**与顶栏平铺导航是同一批入口**：
 * 入口清单由调用方（`pages/_shared.tsx` 的 `NAV_ITEMS`）传入，
 * 本组件**只负责渲染**（垂直排列 + 当前页高亮 + `aria-current`）。
 *
 * ⚠️ **组件层不反向依赖页面层** —— 导航项清单、角色过滤、可见性判断都不在本文件里：
 * - 清单 → `pages/_shared.tsx` 的 `NAV_ITEMS`（单一来源，顶栏与侧栏共用）；
 * - 「是不是管理员」→ 调用方用 `isAdmin` 传进来（权限判定在 store 侧）；
 * - 「要不要渲染侧栏」→ 调用方按视口断点决定（`useIsDesktop()`，≥1024px）。
 *
 * ## 为什么侧栏宽度是写死的 200px
 *
 * ⚠️ **200 不是 token**（`theme/tokens.ts` 未规定侧栏宽度，且 T76 不改 token 文件）。
 *    它取自「桌面端一行放得下 9 个中文入口（4 字 × 9 ≈ 36 字 + 内边距）」的实测值，
 *    与 `truncatedTextStyle` 的 220px 同性质：**写死上限，不让内容把它顶开**。
 */
const SIDE_NAV_WIDTH = 200;

/** 导航项（入口清单由调用方传入）*/
export interface NavItem {
  /** 路由路径 */
  to: string;
  /** 入口文案 */
  label: string;
  /** 仅管理员可见 */
  adminOnly?: boolean;
}

export interface SideNavProps {
  /** 入口清单（顺序即展示顺序）*/
  items: NavItem[];
  /** 当前登录者是否管理员 —— 决定 `adminOnly` 项是否渲染 */
  isAdmin: boolean;
}

/** 侧栏内的链接样式：整行可点（块级）+ 去掉右外边距（竖排时由 gap 控距）*/
const sideNavLinkStyle: React.CSSProperties = {
  ...navLinkStyle,
  display: 'block',
  marginRight: 0,
};

export default function SideNav({ items, isAdmin }: SideNavProps) {
  const visibleItems = items.filter((i) => !i.adminOnly || isAdmin);

  return (
    <nav
      aria-label="主导航"
      data-testid="side-nav"
      style={{
        width: SIDE_NAV_WIDTH,
        // 不参与收缩 —— 否则长文案会把侧栏压窄
        flexShrink: 0,
        // 跟随滚动吸顶（flex 子项需 `align-self: flex-start` 才会生效）
        position: 'sticky',
        top: 0,
        alignSelf: 'flex-start',
      }}
    >
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          // 竖排 —— A1 断言「垂直排列」
          flexDirection: 'column',
          gap: SPACING.gapTight,
        }}
      >
        {visibleItems.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end
              style={({ isActive }) => ({
                ...sideNavLinkStyle,
                ...(isActive ? navLinkActiveStyle : {}),
              })}
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
