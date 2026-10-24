import React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useUserStore } from '../store/user';
import { COLORS, RADIUS, SPACING, TYPO } from '../theme/tokens';
import { navLinkActiveStyle, navLinkStyle } from '../theme/styles';
import type { NavItem } from '../components/SideNav';

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

const linkStyle: React.CSSProperties = navLinkStyle;

/**
 * 导航激活态样式（T63 · ui-spec §4「语义标签 / 导航激活态」）
 *
 * ⚠️ T76 起**样式本体已下沉到 `theme/styles.ts`**（`navLinkStyle` / `navLinkActiveStyle`）——
 *    顶栏平铺导航与桌面左侧栏共用同一份，避免两处各写一份导致漂移。
 */
const activeLinkStyle: React.CSSProperties = navLinkActiveStyle;

/**
 * 主导航入口清单（T76 ⑤ · ux_v2 §1-2 业务流顺序 · 裁决 D-11）
 *
 * 顺序 = **仪表盘 → 交易录入 → 条件选股 → K线图 → 策略信号 → 交易复盘 → 候选池 → 设置 → 管理员**
 *
 * ⚠️ T74 只加入口不重排；**T76 按 ux_v2 §1-2 重排**（原顺序把「策略信号」排在「K线图」之前，
 *    与业务流「记交易 → 看持仓 → 跑策略 → 看K线 → 选股 → 复盘」相反）。
 *    ux_v2 §1-2 建议的顺序是：仪表盘 → 交易录入 → 条件选股 → K线图 → 策略信号 → 交易复盘 → 管理员；
 *    T74 追加的「候选池」按 PRD §5.8 #7 放在「交易复盘」与「设置」之间。
 *
 * ⚠️ **这一份是顶栏与左侧栏的唯一起点** —— 两侧渲染的是同一个数组，
 *    故 A4「侧栏与顶栏顺序一致」是结构上必然成立，而不是靠两处手工同步。
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '仪表盘' },
  { to: '/trade', label: '交易录入' },
  { to: '/stockscan', label: '条件选股' },
  { to: '/kline', label: 'K线图' },
  { to: '/signals', label: '策略信号' },
  { to: '/review', label: '交易复盘' },
  { to: '/candidates', label: '候选池' },
  { to: '/settings', label: '设置' },
  { to: '/admin', label: '管理员', adminOnly: true },
];

/**
 * 移动端底部 Tab（PRD §5.8 #6：持仓 / K线 / 选股 / 复盘 / 设置）
 *
 * ⚠️ **顺序与桌面侧栏无关**（裁决 D-11：移动 Tab 顺序不动）——
 *    PRD §5.8 #6 的顺序是「持仓 / K线 / 选股 / 复盘 / 设置」，T74 补的「候选池」放在「复盘」与「设置」之间。
 * ⚠️ T74 补「候选池」入口（实施计划「移动端底部 Tab 栏 → 本计划只补候选池/设置入口」）：
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

/** 导航列表（`<ul>`）统一样式：去列表符号 + 横向排列 */
const navListStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexWrap: 'wrap',
  gap: SPACING.gapTight,
};

/** 移动端折叠菜单的列表样式：纵向排列 */
const mobileMenuListStyle: React.CSSProperties = {
  ...navListStyle,
  flexDirection: 'column',
  flexWrap: 'nowrap',
};

/** 顶栏 hamburger 按钮样式 */
const hamburgerButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: SPACING.gapTight,
  padding: SPACING.btnPadding,
  background: COLORS.cardBg,
  color: COLORS.brand,
  border: `1px solid ${COLORS.borderMedium}`,
  borderRadius: RADIUS.sm,
  cursor: 'pointer',
  fontSize: TYPO.bodySize,
};

export interface NavbarProps {
  /**
   * 是否渲染顶栏**平铺**导航
   *
   * - `true`（默认）—— 顶栏平铺入口（平板 768~1023px 的唯一入口；
   *   独立使用 `<Navbar />` 时也是它）；
   * - `false` —— 桌面 ≥1024px 由**左侧栏**承担导航，顶栏不再重复渲染同一批入口
   *   （`App.tsx` 按视口断点传入）。
   *
   * ⚠️ 默认值取 `true` 是为了**保持 `<Navbar />` 独立渲染时的既有行为**
   *    （既有用例直接渲染 `<Navbar />` 断言入口存在）。
   */
  showFlatNav?: boolean;
}

export function Navbar({ showFlatNav = true }: NavbarProps) {
  const { username, role, logout } = useUserStore();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = role === 'admin';
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const items = NAV_ITEMS.filter((i) => !i.adminOnly || isAdmin);

  /**
   * ESC 关闭折叠菜单（T76 ③）
   *
   * ⚠️ 监听挂在 `document` 上 —— 焦点在按钮上时按 ESC 也能收到（事件冒泡到 document）。
   */
  React.useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  /** 路由变化 → 收起折叠菜单（点了入口后菜单不该还挂着） */
  React.useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

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

        {/*
          T76 ③ · `<768px` 顶栏折叠为 hamburger 菜单
          ⚠️ **与桌面左侧栏互斥**：`<768px` 不渲染左侧栏（见 `App.tsx`），
             导航入口由本菜单承担（PRD §5.8 #1「桌面和手机功能对等」）。
        */}
        {isMobile && (
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label="打开导航菜单"
            onClick={() => setMenuOpen((v) => !v)}
            style={hamburgerButtonStyle}
          >
            ☰ 菜单
          </button>
        )}

        {/*
          顶栏平铺导航（平板 768~1023px 的唯一入口）
          ⚠️ `showFlatNav=false` 时不渲染 —— 桌面 ≥1024px 由左侧栏承担（避免同一批入口渲染两遍）。
        */}
        {!isMobile && showFlatNav && (
          <nav aria-label="主导航" style={{ marginLeft: 24, display: 'flex', flexWrap: 'wrap' }}>
            <ul style={navListStyle}>
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink
                    to={i.to}
                    end
                    style={({ isActive }) => ({ ...linkStyle, ...(isActive ? activeLinkStyle : {}) })}
                  >
                    {i.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}

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
        T76 ③ · `<768px` 折叠菜单本体
        ⚠️ 用 `hidden` 属性而不是条件渲染 —— `aria-controls="mobile-menu"` 指向的元素
           始终存在（收起时对读屏不可见），避免 axe 报「aria-controls 指向不存在的 id」。
        ⚠️ 菜单是 `<header>` 的**兄弟节点**（不是 header 的子节点）—— HTML 规范禁止
           `<header>` 内嵌 landmark（`<nav>`），放外面才合法。
      */}
      {isMobile && (
        <nav id="mobile-menu" aria-label="主导航" hidden={!menuOpen}>
          <ul style={mobileMenuListStyle}>
            {items.map((i) => (
              <li key={i.to}>
                <NavLink
                  to={i.to}
                  end
                  style={({ isActive }) => ({ ...linkStyle, ...(isActive ? activeLinkStyle : {}) })}
                >
                  {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}

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

/**
 * 视口宽度是否 ≥ 桌面断点（1024px · PRD §5.1「≥1024 桌面 / 768-1024 平板 / <768 手机」）
 *
 * ⚠️ **不是 CSS media query** —— 与 `useIsMobile` 同款「JS 判断 + resize 监听」：
 *    导航入口的**显隐**必须在**渲染期**决定（只渲染一份 DOM），
 *    否则读屏会把两份导航都读一遍（裁决 D-7 / 卡 1 交付 ⑥ 同款理由）。
 *    真正需要 `@media` 的只有「纯表现」的东西 —— 例如容器断点 padding，
 *    走 `styles/global.css` 的 `.page-container`（inline style 表达不了 media query）。
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth >= 1024,
  );

  React.useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isDesktop;
}

/** 移动端底部 TabBar 高度 —— 页面内容需要留出这段 padding */
export const MOBILE_TABBAR_HEIGHT = 62;
