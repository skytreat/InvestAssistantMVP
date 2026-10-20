import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUserStore } from '../store/user';

/** 移动端断点（与 G10a PRD §5.8 #6 底部 Tab 栏一致） */
export const MOBILE_BREAKPOINT = 768;

const linkStyle: React.CSSProperties = {
  padding: '8px 12px',
  marginRight: 4,
  color: '#1e40af',
  textDecoration: 'none',
  borderRadius: 4,
};

/** 桌面端导航项（PRD §5.8 #7 左侧导航栏） */
const DESKTOP_NAV: { to: string; label: string; adminOnly?: boolean }[] = [
  { to: '/', label: '仪表盘' },
  { to: '/trade', label: '交易录入' },
  { to: '/signals', label: '策略信号' },
  { to: '/kline', label: 'K线图' },
  { to: '/stockscan', label: '条件选股' },
  { to: '/review', label: '交易复盘' },
  { to: '/settings', label: '设置' },
  { to: '/admin', label: '管理员', adminOnly: true },
];

/** 移动端底部 Tab（PRD §5.8 #6：持仓 / K线 / 选股 / 复盘 / 设置） */
const MOBILE_TAB: { to: string; label: string; icon: string; adminOnly?: boolean }[] = [
  { to: '/', label: '持仓', icon: '📊' },
  { to: '/kline', label: 'K线', icon: '📈' },
  { to: '/stockscan', label: '选股', icon: '🔍' },
  { to: '/review', label: '复盘', icon: '🧾' },
  { to: '/settings', label: '设置', icon: '⚙️' },
];

export function Navbar() {
  const { username, role, logout } = useUserStore();
  const navigate = useNavigate();
  const isAdmin = role === 'admin';
  const items = DESKTOP_NAV.filter((i) => !i.adminOnly || isAdmin);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
          background: '#fff',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 'bold', fontSize: 20 }}>InvestAssistant</span>
        <nav style={{ marginLeft: 24, display: 'flex', flexWrap: 'wrap' }}>
          {items.map((i) => (
            <Link key={i.to} to={i.to} style={linkStyle}>
              {i.label}
            </Link>
          ))}
        </nav>
        <span style={{ marginLeft: 'auto', color: '#666', fontSize: 13 }}>
          {username} ({isAdmin ? '管理员' : '普通用户'})
        </span>
        <button
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          退出登录
        </button>
      </div>
      {/* 全局合规声明 */}
      <div
        style={{
          background: '#fef3c7',
          color: '#92400e',
          fontSize: 12,
          textAlign: 'center',
          padding: '4px 0',
        }}
      >
        本工具不构成投资建议，数据仅供参考
      </div>
      {/* G10a 移动端底部 TabBar（<768px 显示，桌面隐藏） */}
      <MobileTabBar isAdmin={isAdmin} />
    </>
  );
}

/**
 * G10a 移动端底部 TabBar
 *
 * 用 media query 做不到（inline style 无 media query），改用 JS 视口宽度判断 + resize 监听。
 * 桌面端返回 null，不占据布局空间。
 */
function MobileTabBar({ isAdmin }: { isAdmin: boolean }) {
  const isMobile = useIsMobile();

  if (!isMobile) return null;

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        background: '#fff',
        borderTop: '1px solid #e5e7eb',
        zIndex: 300,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {MOBILE_TAB.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          style={{
            flex: 1,
            textAlign: 'center',
            padding: '8px 0',
            fontSize: 11,
            color: '#374151',
            textDecoration: 'none',
          }}
        >
          <div style={{ fontSize: 20, lineHeight: '24px' }}>{t.icon}</div>
          {t.label}
        </Link>
      ))}
      {isAdmin && (
        <Link
          to="/admin"
          style={{
            flex: 1,
            textAlign: 'center',
            padding: '8px 0',
            fontSize: 11,
            color: '#374151',
            textDecoration: 'none',
          }}
        >
          <div style={{ fontSize: 20, lineHeight: '24px' }}>🛠️</div>
          管理
        </Link>
      )}
    </nav>
  );
}

/** 视口宽度是否 < MOBILE_BREAKPOINT（SSR 安全，默认 false） */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );

  React.useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isMobile;
}

/** 移动端底部 TabBar 高度 —— 页面内容需要留出这段 padding */
export const MOBILE_TABBAR_HEIGHT = 62;

export const pageContainerStyle: React.CSSProperties = {
  padding: '24px',
  maxWidth: 1200,
  margin: '0 auto',
  // 给移动端底部 TabBar 让位
  paddingBottom: '86px',
};

/** 移动端紧凑容器（卡片间距收窄，表格允许横向滚动） */
export const mobileCardStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 12,
  marginBottom: 16,
  background: '#fff',
};

export const cardStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 16,
  marginBottom: 24,
  background: '#fff',
};

export const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 'bold',
  marginBottom: 16,
};

export const cardTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  marginBottom: 12,
  borderBottom: '1px solid #f3f4f6',
  paddingBottom: 8,
  color: '#1f2937',
};

export const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 14,
};

export const thTdStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  padding: '8px 10px',
  textAlign: 'left',
};

export const thStyle: React.CSSProperties = {
  ...thTdStyle,
  background: '#f9fafb',
  fontWeight: 600,
  color: '#374151',
};

export const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  fontSize: 14,
};

export const buttonStyle: React.CSSProperties = {
  padding: '6px 16px',
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
};

export const errorStyle: React.CSSProperties = {
  color: '#dc2626',
  fontSize: 14,
  marginTop: 8,
};

export const successStyle: React.CSSProperties = {
  color: '#16a34a',
  fontSize: 14,
  marginTop: 8,
};

export const formRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginBottom: 12,
};

export const labelStyle: React.CSSProperties = {
  minWidth: 80,
  color: '#374151',
  fontSize: 14,
};
