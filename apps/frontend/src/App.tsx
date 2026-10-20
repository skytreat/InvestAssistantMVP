import { Routes, Route } from 'react-router-dom';
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
import { MAX_WIDTH, TYPO } from './theme/tokens';

export default function App() {
  const token = useUserStore((s) => s.token);

  /**
   * 未登录：只渲染登录页。
   *
   * ⚠️ 登录页**不在**下方带 `<main>` 的布局里（它没有导航栏），故此处单独给一个 `<main>`，
   * 保证「文档内至多一个 main」在两个分支下都成立（登录分支 1 个 / 已登录分支 1 个，
   * 二者互斥，不会同时出现）。
   */
  if (!token) {
    return (
      <main>
        <Login />
      </main>
    );
  }

  return (
    <div style={{ fontFamily: TYPO.fontFamily, maxWidth: MAX_WIDTH, margin: '0 auto', padding: 20 }}>
      {/*
        T63 语义化骨架：header → main → footer。
        ⚠️ `<header>` 由 `<Navbar />` 自身渲染（见 `pages/_shared.tsx`），
        此处**不再**套一层 `<header>` —— HTML 规范禁止 `<header>` 嵌套 `<header>`。
      */}
      <Navbar />
      <hr style={{ margin: '16px 0' }} />
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/trade" element={<TradeInput />} />
          <Route path="/signals" element={<Signals />} />
          <Route path="/kline" element={<Kline />} />
          <Route path="/stockscan" element={<StockScan />} />
          <Route path="/review" element={<Review />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin" element={<Admin />} />
          {/* 未知路由显示 404 页，不再静默跳回仪表盘（拼错的路径本该显式报错） */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      {/*
        T63：`<footer>` 占位（当前为空）。
        T95 会把「隐私声明 / 插件安全承诺 / 合规声明」等内容搬进这里。
      */}
      <footer />
    </div>
  );
}
