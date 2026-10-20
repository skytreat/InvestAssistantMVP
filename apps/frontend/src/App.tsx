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
  if (!token) return <Login />;

  return (
    <div style={{ fontFamily: TYPO.fontFamily, maxWidth: MAX_WIDTH, margin: '0 auto', padding: 20 }}>
      <Navbar />
      <hr style={{ margin: '16px 0' }} />
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
    </div>
  );
}
