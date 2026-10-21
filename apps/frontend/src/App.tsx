import React from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import TradeInput from './pages/TradeInput';
import Signals from './pages/Signals';
import Login from './pages/Login';
import StockScan from './pages/StockScan';
import Candidates from './pages/Candidates';
import Review from './pages/Review';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';
import { useUserStore } from './store/user';
import { Navbar } from './pages/_shared';
import ComplianceFooter from './components/ComplianceFooter';
import AdminGuard from './components/AdminGuard';
import SessionExpiredBanner from './components/SessionExpiredBanner';
import Spinner from './components/Spinner';
import TokenExpiryNotice from './components/TokenExpiryNotice';
import { onSessionExpired } from './api/client';
import { MAX_WIDTH, TYPO } from './theme/tokens';

/**
 * T66 · 路由级代码分割（SDD §2.12.5「Bundle 优化策略」）
 *
 * `Kline`（464+ 行，含 Canvas 手绘 K 线 + MACD/RSI 副图）与 `Admin`（324+ 行）
 * 体积都不小，且**都不是首屏必需** → 改为 `React.lazy` 动态 import，
 * 由 Vite 打成**独立 chunk**，只在真正访问该路由时才下载。
 *
 * ⚠️ **其它页面保持静态 import** —— 本任务只拆 Kline / Admin。
 *    Dashboard / TradeInput / Signals / StockScan / Review / Settings / Login
 *    仍是首屏可能立刻用到的，整包引入反而多一次请求。
 */
const Kline = React.lazy(() => import('./pages/Kline'));

/**
 * `Admin` 的 lazy import —— 🔴 **非 admin 不得触发 chunk 下载**（见 `AdminRoute` 注释）
 */
const Admin = React.lazy(() => import('./pages/Admin'));

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
 * 管理员路由（T66 · lazy 版）
 *
 * 🔴 **非 admin 不得触发 Admin chunk 下载**（信息泄露面）：
 * `React.lazy` 的动态 import 是在 **lazy 组件被 reconcile（渲染）** 时才触发的，
 * 而**不是**在 `<Admin />` 这个 JSX 元素被创建时触发。
 * `AdminGuard` 在角色不是 admin 时返回 `<Navigate to="/" replace />`，
 * **根本不渲染 children** → React 永远不会去 reconcile `<Admin />` → `import()` 永不执行 → chunk 不下载。
 *
 * ⚠️ 这条不变量**只靠「不渲染 children」成立**，所以 `AdminGuard` 内部**不能**改成
 *    「先渲染再判断」或「在 Admin 内部判断角色」——那样 chunk 就会先被下载。
 *    回归用例见 `tests/unit/lazyLoading.test.tsx`（「非 admin 不加载 Admin chunk」）。
 */
function AdminRoute() {
  return (
    <AdminGuard>
      <Admin />
    </AdminGuard>
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
        {/*
          T66 · `<Suspense>` 边界放在**路由出口处**（`<Outlet />` 外层），而不是 `<Routes>` 外层。
          - **为什么放这里**：`<Outlet />` 正是「会渲染 lazy 组件的那一层」。
            边界包住它 → 懒加载时**只替换主内容区**，导航栏 / 页脚保持在场（不整页闪烁）；
            若放在 `<Routes>` 外层，则整个路由树（含 Navbar / 页脚）都会被 fallback 顶掉 → 整页闪一下。
          - **为什么不会误伤普通页面**：`<Suspense>` **只有子组件真的 suspend 时才显示 fallback**。
            除 Kline / Admin 外全是静态 import，**永远不会 suspend** → 普通页面零影响、零闪烁。
          - **fallback 用 `<Spinner />`**（T65）：`role="status"` + `aria-live="polite"`，读屏可播报加载态。
        */}
        <React.Suspense fallback={<Spinner />}>
          <Outlet />
        </React.Suspense>
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
          {/* T74：候选池页（F-G3 · 候选池此前完全没有页面，后端路由也没被前端接上）*/}
          <Route path="/candidates" element={<Candidates />} />
          <Route path="/review" element={<Review />} />
          <Route path="/settings" element={<Settings />} />
          {/* T98：管理员路由受 AdminGuard 保护 —— 非 admin 不挂载 <Admin />，故不发 admin 请求 */}
          <Route path="/admin" element={<AdminRoute />} />
          {/* 未知路由显示 404 页，不再静默跳回仪表盘（拼错的路径本该显式报错） */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
