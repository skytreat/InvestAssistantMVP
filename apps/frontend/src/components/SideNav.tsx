import React from 'react';
import { NavLink } from 'react-router-dom';
import { SPACING } from '../theme/tokens';
import { navGroupTitleStyle, navLinkActiveStyle, navLinkStyle } from '../theme/styles';

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
  /**
   * 业务域分组标题（UX-12）
   *
   * 相邻且 `group` 相同的入口归入同一组；**不改变入口顺序**。
   * 未设置时归入一个无标题的分组。
   */
  group?: string;
}

/** 一个导航分组（`title` 为空表示无标题）*/
export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * 按 `group` 切分**连续区间**（UX-12）
 *
 * ⚠️ 只按相邻区间分组 —— 不排序、不重排、不跨区间合并，
 *    保证「只加分组标题、不改顺序」（owner 决策 Q6）。
 *    角色过滤后为空的组不会产生分组（调用方先过滤再分组）。
 */
export function groupNavItems(items: NavItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of items) {
    const title = item.group ?? '';
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.items.push(item);
    else groups.push({ title, items: [item] });
  }
  return groups;
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
  // 先按角色过滤，再分组 —— 否则「券商 / 管理」这类全 adminOnly 的组会给普通用户留下空标题
  const groups = groupNavItems(items.filter((i) => !i.adminOnly || isAdmin));

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
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.gapBase,
      }}
    >
      {groups.map((group, groupIndex) => (
        <div key={`${group.title || 'nav'}-${groupIndex}`}>
          {/* UX-12：分组标题是语义化 <h3>，不是入口（不可点击、不进 Tab 序列） */}
          {group.title !== '' && (
            <h3 style={{ ...navGroupTitleStyle, marginTop: groupIndex === 0 ? 0 : SPACING.gapBase }}>
              {group.title}
            </h3>
          )}
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
            {group.items.map((item) => (
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
        </div>
      ))}
    </nav>
  );
}
