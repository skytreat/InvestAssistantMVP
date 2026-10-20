import React from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import TradeInput from './pages/TradeInput';
import Signals from './pages/Signals';
import Admin from './pages/Admin';
import Login from './pages/Login';
import Kline from './pages/Kline';
import StockScan from './pages/StockScan';
import Review from './pages/Review';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';
import { useUserStore } from './store/user';
import { Navbar } from './pages/_shared';
import ComplianceFooter from './components/ComplianceFooter';
import AdminGuard from './components/AdminGuard';
import SessionExpiredBanner from './components/SessionExpiredBanner';
import TokenExpiryNotice from './components/TokenExpiryNotice';
import { onSessionExpired } from './api/client';
import { MAX_WIDTH, TYPO } from './theme/tokens';

/**
 * 登录页路由（T64）
 *
 * ⚠️ 此前**未登录时整个 `<Routes>` 都没挂载**（`if (!token) return <main><Login/></main>`），
 *   导致 `<Navigate to="/login">` 渲染不出来 —— 401 后跳登录页是「假跳转」。
 *   现在 `/login` 是**真实路由**，`<Routes>` 永远挂载。
 */
function LoginRoute() {
  return (
    <>
      <main>
        <Login />
      </main>
      {/*
        T95：合规声明「全站所有页面顶部或底部常驻」（PRD §5.9）——
        **登录页也在「全站」内**，故未登录分支同样渲染。
      */}
      <ComplianceFooter />
    </>
  );
}

/**
 * 受保护区域的布局壳（T64 · SDD §2.12.2 `AuthGuard` 思路）
 *
 * - 未登录 → `<Navigate to="/login" state={{ from }} replace />`
 *   （`from` = 当前路径含 query → 登录后可回原页面，PRD §5.9）；
 * - 已登录 → 渲染导航栏 + `<main>` + 子路由 + 合规声明。
 */
function ProtectedShell({ expiredFrom }: { expiredFrom: string | null }) {
  const token = useUserStore((s) => s.token);
  const location = useLocation();

  // 「过期前所在的路径」优先于「当前路由路径」：
  // 会话过期是被动触发的，此刻路由可能还没跳走，用过期发生时的路径更贴近用户离开前的页面。
  const from = expiredFrom ?? `${location.pathname}${location.search}`;
  // ⚠️ `state` 必须**引用稳定** —— react-router 的 `<Navigate>` 把 `state` 放在 effect 依赖里，
  //   每次渲染都造新对象会导致「跳了又跳」的重复导航。
  const navState = React.useMemo(() => ({ from }), [from]);

  if (!token) {
    return <Navigate to="/login" state={navState} replace />;
  }

  return (
    <div style={{ fontFamily: TYPO.fontFamily, maxWidth: MAX_WIDTH, margin: '0 auto', padding: 20 }}>
      {/*
        T63 语义化骨架：header → main → footer。
        ⚠️ `<header>` 由 `<Navbar />` 自身渲染（见 `pages/_shared.tsx`），
        此处**不再**套一层 `<header>` —— HTML 规范禁止 `<header>` 嵌套 `<header>`。
      */}
      <Navbar />
      {/* T64 · PRD §5.9：token 临近过期（剩余 < 1 天）时的轻量提示 */}
      <TokenExpiryNotice />
      <hr style={{ margin: '16px 0' }} />
      <main>
        <Outlet />
      </main>
      {/*
        T95：全局合规声明常驻（PRD §5.9，逐字文案见 `components/ComplianceFooter.tsx`）。
        ⚠️ 「隐私声明（设置页）」与「插件安全承诺（设置页插件区）」属 T76 ⑥，尚未落地。
      */}
      <ComplianceFooter />
    </div>
  );
}

export default function App() {
  const token = useUserStore((s) => s.token);
  /** 会话过期时「离开前所在路径」；`null` = 当前没有过期事件 */
  const [expiredFrom, setExpiredFrom] = React.useState<string | null>(null);

  // ⚠️ `state` 引用稳定（见 ProtectedShell 的同名注释）：避免 `<Navigate>` 反复导航
  const navState = React.useMemo(() => (expiredFrom !== null ? { from: expiredFrom } : null), [expiredFrom]);

  // 订阅「会话过期」事件（T64 · `api/client.ts` 的 pub/sub）
  React.useEffect(() => onSessionExpired((from) => setExpiredFrom(from)), []);

  // 重新登录成功 → 撤下过期提示条（提示条的使命结束）
  React.useEffect(() => {
    if (token) setExpiredFrom(null);
  }, [token]);

  return (
    <>
      {/*
        会话过期提示条挂在 `<Routes>` **之外** → 跳到登录页后**仍然可见**
        （PRD §5.9：过期后自动跳转登录页并保留当前页面路径）。
      */}
      <SessionExpiredBanner from={expiredFrom} />
      {/*
        过期 → 跳登录页并**保留原路径**（`state.from`）。
        ⚠️ 条件渲染 + `state` 引用稳定（见上面的 `navState`）：
          「确实要跳」时才挂载，过期状态解除后干净卸载，不会反复导航。
      */}
      {navState !== null && <Navigate to="/login" state={navState} replace />}
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        {/*
          布局路由（无 path）+ 子路由 —— react-router v6 的标准「守卫壳」写法：
          `ProtectedShell` 渲染 `<Outlet />` 承载子路由。
          ⚠️ `/login` 与布局路由互斥 → 两个分支各自**互斥地**有一个 `<main>`
          （T63「文档内至多一个 main」的成果不丢）。
        */}
        <Route element={<ProtectedShell expiredFrom={expiredFrom} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/trade" element={<TradeInput />} />
          <Route path="/signals" element={<Signals />} />
          <Route path="/kline" element={<Kline />} />
          <Route path="/stockscan" element={<StockScan />} />
          <Route path="/review" element={<Review />} />
          <Route path="/settings" element={<Settings />} />
          {/* T98：管理员路由受 AdminGuard 保护 —— 非 admin 不挂载 <Admin />，故不发 admin 请求 */}
          <Route
            path="/admin"
            element={
              <AdminGuard>
                <Admin />
              </AdminGuard>
            }
          />
          {/* 未知路由显示 404 页，不再静默跳回仪表盘（拼错的路径本该显式报错） */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
