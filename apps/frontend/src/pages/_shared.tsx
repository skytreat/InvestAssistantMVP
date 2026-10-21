import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useUserStore } from '../store/user';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';

/**
 * 共享样式对象 —— **re-export 自 `src/theme/styles.ts`（T66 分层收口）**
 *
 * ⚠️ 为什么要 re-export 而不是让各页直接改 import 路径？
 *    - 12+ 个页面在用这些样式对象，逐个改 import 属于**纯噪音 diff**；
 *    - 保持 `pages/_shared` 的既有导出**全部可用**（其它页面 / 测试都依赖这个入口）。
 *
 * ⚠️ **定义已经下沉到 `src/theme/styles.ts`** —— 因为组件层（`components/ConfirmDialog.tsx`）
 *    需要 `cardStyle` / `buttonStyle`，而**组件层不能反向依赖页面层**（依赖方向倒置）。
 *    `theme/styles.ts` 只 import `theme/tokens.ts` → **不会产生循环依赖**。
 */
export {
  pageContainerStyle,
  cardStyle,
  titleStyle,
  cardTitleStyle,
  tableStyle,
  thTdStyle,
  thStyle,
  inputStyle,
  buttonStyle,
  errorStyle,
  successStyle,
  formRowStyle,
  labelStyle,
} from '../theme/styles';

/** 移动端断点（与 G10a PRD §5.8 #6 底部 Tab 栏一致） */
export const MOBILE_BREAKPOINT = 768;

const linkStyle: React.CSSProperties = {
  padding: '8px 12px',
  marginRight: SPACING.gapTight,
  color: COLORS.brandLink,
  textDecoration: 'none',
  borderRadius: RADIUS.sm,
};

/**
 * 导航激活态样式（T63 · ui-spec §4「语义标签 / 导航激活态」）
 *
 * 复用既有 token，不引入新 hex：
 * - 底色 `COLORS.brandBg`（浅蓝）
 * - 文字 `COLORS.brandLink`（深蓝）
 * - 字重 600
 *
 * ⚠️ **react-router v6 没有 v5 的 `activeStyle` 属性** —— v6 用**函数式 `style`**
 * （`style={({ isActive }) => ({ ...base, ...(isActive ? active : {}) })}`）。
 */
const activeLinkStyle: React.CSSProperties = {
  background: COLORS.brandBg,
  color: COLORS.brandLink,
  fontWeight: 600,
};

/**
 * 桌面端导航项（PRD §5.8 #7 左侧导航栏）
 *
 * ⚠️ **T74 只加入口，不重排顺序** —— 导航按业务流程重排是 **T76** 的交付物
 *    （ux_v2 §1-2：仪表盘 → 交易录入 → 条件选股 → K线 → 策略信号 → 复盘 → 候选池 → 设置 → 管理员）。
 *    这里把「候选池」放在「交易复盘」与「设置」之间，与 PRD §5.8 #7 的相对次序一致，
 *    T76 重排时改动最小。
 */
const DESKTOP_NAV: { to: string; label: string; adminOnly?: boolean }[] = [
  { to: '/', label: '仪表盘' },
  { to: '/trade', label: '交易录入' },
  { to: '/signals', label: '策略信号' },
  { to: '/kline', label: 'K线图' },
  { to: '/stockscan', label: '条件选股' },
  { to: '/review', label: '交易复盘' },
  { to: '/candidates', label: '候选池' },
  { to: '/settings', label: '设置' },
  { to: '/admin', label: '管理员', adminOnly: true },
];

/**
 * 移动端底部 Tab（PRD §5.8 #6：持仓 / K线 / 选股 / 复盘 / 设置）
 *
 * ⚠️ **T74 补「候选池」入口**（实施计划「移动端底部 Tab 栏 → 本计划只补候选池/设置入口」）：
 *    「设置」此前已有，这里只补「候选池」，位置同样放在「复盘」与「设置」之间。
 */
const MOBILE_TAB: { to: string; label: string; icon: string; adminOnly?: boolean }[] = [
  { to: '/', label: '持仓', icon: '📊' },
  { to: '/kline', label: 'K线', icon: '📈' },
  { to: '/stockscan', label: '选股', icon: '🔍' },
  { to: '/review', label: '复盘', icon: '🧾' },
  { to: '/candidates', label: '候选池', icon: '📋' },
  { to: '/settings', label: '设置', icon: '⚙️' },
];

export function Navbar() {
  const { username, role, logout } = useUserStore();
  const navigate = useNavigate();
  const isAdmin = role === 'admin';
  const items = DESKTOP_NAV.filter((i) => !i.adminOnly || isAdmin);

  return (
    <>
      {/*
        T63 语义化：导航条外层由 `<div>` 改为 `<header>`（landmark）。
        ⚠️ App.tsx **不再**额外包一层 `<header>` —— HTML 规范禁止 header 嵌套 header，
        故「App 的 header」与「Navbar 的 header」是同一个元素（详见 App.tsx 注释）。
      */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: SPACING.navPadding,
          borderBottom: `1px solid ${COLORS.borderLight}`,
          background: COLORS.cardBg,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontWeight: 'bold', fontSize: 20 }}>InvestAssistant</span>
        <nav aria-label="主导航" style={{ marginLeft: 24, display: 'flex', flexWrap: 'wrap' }}>
          {items.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end
              style={({ isActive }) => ({ ...linkStyle, ...(isActive ? activeLinkStyle : {}) })}
            >
              {i.label}
            </NavLink>
          ))}
        </nav>
        <span style={{ marginLeft: 'auto', color: COLORS.textTertiary, fontSize: TYPO.smallSize }}>
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
      </header>
      {/*
        T95：全局合规声明已从 Navbar 下方**搬到 App.tsx 的 `<footer>`**
        （`components/ComplianceFooter.tsx`）—— PRD §5.9 要求「全站所有页面顶部或底部常驻」，
        页脚是更规范的位置，且能同时覆盖未登录的登录页。
      */}
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
      aria-label="底部导航"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        background: COLORS.cardBg,
        borderTop: `1px solid ${COLORS.borderLight}`,
        zIndex: 300,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {MOBILE_TAB.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end
          style={({ isActive }) => ({
            flex: 1,
            textAlign: 'center',
            padding: '8px 0',
            fontSize: TYPO.captionSize,
            color: COLORS.textSecondary,
            textDecoration: 'none',
            ...(isActive ? activeLinkStyle : {}),
          })}
        >
          <div style={{ fontSize: 20, lineHeight: '24px' }}>{t.icon}</div>
          {t.label}
        </NavLink>
      ))}
      {isAdmin && (
        <NavLink
          to="/admin"
          end
          style={({ isActive }) => ({
            flex: 1,
            textAlign: 'center',
            padding: '8px 0',
            fontSize: TYPO.captionSize,
            color: COLORS.textSecondary,
            textDecoration: 'none',
            ...(isActive ? activeLinkStyle : {}),
          })}
        >
          <div style={{ fontSize: 20, lineHeight: '24px' }}>🛠️</div>
          管理
        </NavLink>
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
