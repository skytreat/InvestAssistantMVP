import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { COLORS, RADIUS, TYPO } from '../theme/tokens';

/**
 * 404 页面（未知路由）
 *
 * 存在的原因：`App.tsx` 原先对未知路由用 `<Route path="*" element={<Navigate to="/" replace />} />`，
 * 会**静默跳回仪表盘** —— 任何拼错的路径（含未来新增页面的拼写错误）都看不到 404，
 * 表现为「点了没反应 / 回到了首页」，极难排查。
 *
 * T74 会新增 `/candidates` 路由；在此之前访问该路径将正确显示本页（而不是静默跳首页）。
 */

/** 已知路由（用于提示最接近的入口；T74 已新增候选池，故补上 '/candidates'） */
const KNOWN_ROUTES: { to: string; label: string }[] = [
  { to: '/', label: '仪表盘' },
  { to: '/trade', label: '交易录入' },
  { to: '/signals', label: '策略信号' },
  { to: '/kline', label: 'K 线图' },
  { to: '/stockscan', label: '条件选股' },
  { to: '/candidates', label: '候选池' },
  { to: '/review', label: '交易复盘' },
  { to: '/settings', label: '设置' },
];

export default function NotFound() {
  const location = useLocation();

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: RADIUS.md,
    background: COLORS.cardBg,
    padding: '32px 24px',
    maxWidth: 560,
    margin: '48px auto',
    textAlign: 'center',
  };

  const linkStyle: React.CSSProperties = {
    display: 'inline-block',
    padding: '8px 16px',
    margin: '4px',
    color: COLORS.brandLink,
    textDecoration: 'none',
    border: `1px solid ${COLORS.borderLight}`,
    borderRadius: RADIUS.sm,
  };

  return (
    <div style={{ fontFamily: TYPO.fontFamily }}>
      <h1 style={{ margin: '0 0 16px 0' }}>页面不存在</h1>
      <div style={cardStyle}>
        <p style={{ margin: '0 0 8px 0', fontSize: TYPO.bodySize, color: COLORS.textTertiary }}>
          找不到路径 <code style={{ color: COLORS.danger }}>{location.pathname}</code>
        </p>
        <p style={{ margin: '0 0 20px 0', fontSize: TYPO.smallSize, color: COLORS.textFaint }}>
          该地址不存在，或对应功能尚未上线。可以从下面的入口继续：
        </p>
        <div>
          {KNOWN_ROUTES.map((r) => (
            <Link key={r.to} to={r.to} style={linkStyle}>
              {r.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
