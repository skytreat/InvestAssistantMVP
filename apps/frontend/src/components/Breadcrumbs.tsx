import React from 'react';
import { Link } from 'react-router-dom';
import { COLORS, SPACING, TYPO } from '../theme/tokens';

/**
 * 面包屑（T79 ④ · ux_v2 §1-3）
 *
 * 深层页面（K 线、标的详情 Modal）用一条轻量导航展示「我在哪 / 怎么回去」。
 * - 祖先项可点击（`<Link>`），当前页用 `aria-current="page"` 且不可点击；
 * - 分隔符 `/` 对读屏隐藏（`aria-hidden`），避免被念成「斜杠」；
 * - 窄屏允许换行，不产生横向溢出。
 */
export interface BreadcrumbItem {
  label: string;
  /** 祖先项的目标路径；**当前页不传**（传了也不会渲染成链接） */
  to?: string;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  /** 导航的可访问名（默认「面包屑」） */
  label?: string;
}

export default function Breadcrumbs({ items, label = '面包屑' }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label={label} data-testid="breadcrumbs">
      <ol
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          listStyle: 'none',
          margin: `0 0 ${SPACING.gapBase}px`,
          padding: 0,
          fontSize: TYPO.smallSize,
        }}
      >
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;
          return (
            <li
              key={`${item.label}-${index}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}
            >
              {!isCurrent && item.to ? (
                <Link to={item.to} style={{ color: COLORS.brandLink, textDecoration: 'none' }}>
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isCurrent ? 'page' : undefined}
                  style={{ color: isCurrent ? COLORS.textPrimary : COLORS.textSecondary }}
                >
                  {item.label}
                </span>
              )}
              {!isCurrent && (
                <span aria-hidden="true" style={{ color: COLORS.textMuted }}>
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
